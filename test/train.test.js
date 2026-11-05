import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { train, RUN_FILE, CARD_FILE, CARD_FORMAT } from '../src/train.js'

const QWEN = { name: 'QWEN3_600M_INST_Q4', registryPath: 'u/Qwen3-0.6B-Q4_0.gguf', sha256Checksum: 'c'.repeat(64) }

/** Fake SDK that records calls and simulates finetune progress/pause. */
function fakeSdk ({ ticks = 3, pauseAfter = Infinity, writeAdapter = true } = {}) {
  const calls = []
  let paused = false
  const sdk = {
    QWEN3_600M_INST_Q4: QWEN,
    QWEN3_4B_INST_Q4_K_M: { name: 'QWEN3_4B_INST_Q4_K_M', registryPath: 'q/Qwen3-4B-Q4_K_M.gguf' },
    async loadModel (o) { calls.push(['loadModel', o]); o.onProgress?.({ percentage: 100 }); return 'm1' },
    async unloadModel (o) { calls.push(['unloadModel', o]) },
    finetune (o) {
      calls.push(['finetune', o])
      if (o.operation === 'pause') { paused = true; return Promise.resolve({ type: 'finetune', status: 'PAUSED' }) }
      const out = o.options.outputParametersDir
      async function * progressStream () {
        for (let i = 1; i <= ticks; i++) {
          await new Promise((r) => setImmediate(r))
          yield { is_train: true, loss: 1 / i, accuracy: 0.5, global_steps: i, current_epoch: 0, current_batch: i, total_batches: ticks, elapsed_ms: 1, eta_ms: 1 }
          if (i >= pauseAfter) await new Promise((r) => setTimeout(r, 5))
          if (paused) return
        }
      }
      const result = (async () => {
        // Wait until the stream is drained, like the real handle.
        await new Promise((r) => setTimeout(r, 30))
        if (paused) return { type: 'finetune', status: 'PAUSED' }
        if (writeAdapter) await writeFile(join(out, 'trained-lora-adapter.gguf'), 'ADAPTER')
        return { type: 'finetune', status: 'COMPLETED', stats: { train_loss: 0.4, val_loss: 0.5, global_steps: ticks, epochs_completed: 2 } }
      })()
      return { progressStream: progressStream(), result }
    }
  }
  return { sdk, calls }
}

async function runDirWith (t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-tune-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body)
  return dir
}

const SFT = '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hey"}]}\n'

test('trains an SFT run, writes run.json and an adapter card', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT, 'eval.jsonl': SFT })
  const { sdk, calls } = fakeSdk()
  const events = []
  const res = await train({ sdk, runDir: dir, model: 'tiny', onEvent: (e) => events.push(e.type) })

  assert.equal(res.status, 'COMPLETED')
  const ft = calls.find((c) => c[0] === 'finetune')[1]
  assert.equal(ft.options.assistantLossOnly, true)
  assert.deepEqual(ft.options.validation, { type: 'dataset', path: join(dir, 'eval.jsonl') })
  assert.equal(ft.options.contextLength, 512)
  assert.equal(calls.at(-1)[0], 'unloadModel')
  assert.ok(events.includes('progress'))

  const card = JSON.parse(await readFile(join(dir, CARD_FILE), 'utf8'))
  assert.equal(card.format, CARD_FORMAT)
  assert.equal(card.base.name, 'QWEN3_600M_INST_Q4')
  assert.equal(card.dataset.train.samples, 1)
  assert.equal(card.adapter.file, 'trained-lora-adapter.gguf')
  assert.equal(card.metrics.val_loss, 0.5)
  assert.doesNotMatch(JSON.stringify(card), /"hey"/) // card never embeds training data
})

test('causal runs disable assistant-only loss and skip empty eval', async (t) => {
  const dir = await runDirWith(t, { 'train.txt': 'some text\n', 'eval.txt': '' })
  const { sdk, calls } = fakeSdk()
  await train({ sdk, runDir: dir, model: 'tiny' })
  const ft = calls.find((c) => c[0] === 'finetune')[1]
  assert.equal(ft.options.assistantLossOnly, false)
  assert.deepEqual(ft.options.validation, { type: 'none' })
})

test('refuses a non-fine-tunable base model unless forced', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  const { sdk } = fakeSdk()
  await assert.rejects(train({ sdk, runDir: dir, model: 'QWEN3_4B_INST_Q4_K_M' }), /Q4_K_M cannot be fine-tuned/)
})

test('abort pauses the run, and resume continues with the saved options', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  const first = fakeSdk({ ticks: 10, pauseAfter: 2 })
  const ac = new AbortController()
  const res = await train({
    sdk: first.sdk,
    runDir: dir,
    signal: ac.signal,
    onEvent: (e) => { if (e.type === 'progress' && e.tick.global_steps === 2) ac.abort() }
  })
  assert.equal(res.status, 'PAUSED')
  assert.ok(first.calls.some((c) => c[0] === 'finetune' && c[1].operation === 'pause'))
  assert.equal(JSON.parse(await readFile(join(dir, RUN_FILE), 'utf8')).status, 'PAUSED')

  const second = fakeSdk()
  const resumed = await train({ sdk: second.sdk, runDir: dir, resume: true })
  assert.equal(resumed.status, 'COMPLETED')
  const ft = second.calls.find((c) => c[0] === 'finetune')[1]
  assert.equal(ft.operation, 'resume')
  assert.equal(ft.options.trainDatasetDir, join(dir, 'train.jsonl'))
})

test('errors clearly when training finishes without an adapter', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  const { sdk, calls } = fakeSdk({ writeAdapter: false })
  await assert.rejects(train({ sdk, runDir: dir }), /no adapter/)
  assert.equal(calls.at(-1)[0], 'unloadModel')
})
