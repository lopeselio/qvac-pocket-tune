import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { train, RUN_FILE, CARD_FILE, CARD_FORMAT } from '../src/train.js'

const QWEN = { name: 'QWEN3_600M_INST_Q4', registryPath: 'u/Qwen3-0.6B-Q4_0.gguf', sha256Checksum: 'c'.repeat(64) }

/** Fake SDK that records calls and simulates finetune progress/pause. */
function fakeSdk ({ ticks = 3, pauseAfter = Infinity, writeAdapter = true, nanStats = false, unloadFails = false, fitResult = { verdict: 'likely-fits', models: [] } } = {}) {
  const calls = []
  let paused = false
  let lastOptions = null
  const sdk = {
    QWEN3_600M_INST_Q4: QWEN,
    QWEN3_4B_INST_Q4_K_M: { name: 'QWEN3_4B_INST_Q4_K_M', registryPath: 'q/Qwen3-4B-Q4_K_M.gguf' },
    async assessModelFit (o) { calls.push(['assessModelFit', o]); return fitResult },
    async loadModel (o) { calls.push(['loadModel', o]); o.onProgress?.({ percentage: 100 }); return 'm1' },
    async unloadModel (o) {
      calls.push(['unloadModel', o])
      if (unloadFails) throw new Error(`Failed to unload model "${o.modelId}"`)
    },
    finetune (o) {
      calls.push(['finetune', o])
      if (o.operation === 'pause') {
        paused = true
        // Like QVAC, pausing leaves a pause checkpoint behind.
        return mkdir(join(lastOptions.checkpointSaveDir, 'pause_checkpoint_step_00000002'), { recursive: true })
          .then(() => ({ type: 'finetune', status: 'PAUSED' }))
      }
      lastOptions = o.options
      const out = o.options.outputParametersDir
      let streamDone
      const drained = new Promise((resolve) => { streamDone = resolve })
      async function * progressStream () {
        try {
          yield * ticksUntilPause()
        } finally {
          streamDone()
        }
      }
      async function * ticksUntilPause () {
        for (let i = 1; i <= ticks; i++) {
          await new Promise((r) => setImmediate(r))
          yield { is_train: true, loss: 1 / i, accuracy: 0.5, global_steps: i, current_epoch: 0, current_batch: i, total_batches: ticks, elapsed_ms: 1, eta_ms: 1 }
          if (i >= pauseAfter) await new Promise((r) => setTimeout(r, 5))
          if (paused) return
        }
      }
      const result = (async () => {
        // Settle only once the stream is drained, like the real handle
        // (a fixed timer raced the pause on slow CI runners).
        await drained
        if (paused) return { type: 'finetune', status: 'PAUSED' }
        if (writeAdapter) await writeFile(join(out, 'trained-lora-adapter.gguf'), 'ADAPTER')
        if (nanStats) throw new Error('✖ Invalid input: expected number, received NaN\n  → at stats.train_accuracy')
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

test('checks fit before downloading and refuses a model that will not fit unless forced', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  const tooBig = { verdict: 'likely-too-large', models: [{ name: 'QWEN3_600M_INST_Q4', verdict: 'likely-too-large', reasons: ['needs 9000 MiB against a 500 MiB budget'] }] }
  const a = fakeSdk({ fitResult: tooBig })
  await assert.rejects(train({ sdk: a.sdk, runDir: dir }), /likely can't hold the model[\s\S]*9000 MiB/)
  assert.ok(!a.calls.some((c) => c[0] === 'loadModel'), 'nothing downloaded')
  assert.equal(a.calls[0][1].models[0].modelConfig.ctx_size, 512)

  const dir2 = await runDirWith(t, { 'train.jsonl': SFT })
  const b = fakeSdk({ fitResult: tooBig })
  const res = await train({ sdk: b.sdk, runDir: dir2, force: true })
  assert.equal(res.status, 'COMPLETED')
})

test('resume explains that a crashed run (no pause checkpoint) has to start again', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  const { sdk } = fakeSdk({ writeAdapter: false })
  // A run that crashed: run.json says RUNNING, checkpoints exist, but no pause checkpoint.
  await train({ sdk, runDir: dir, model: 'tiny' }).catch(() => {})
  const run = JSON.parse(await readFile(join(dir, RUN_FILE), 'utf8'))
  run.status = 'RUNNING'
  await writeFile(join(dir, RUN_FILE), JSON.stringify(run))
  await mkdir(join(run.options.checkpointSaveDir, 'checkpoint_step_00000025'), { recursive: true })
  await assert.rejects(train({ sdk, runDir: dir, resume: true }), /no pause checkpoint.*pocket-tune train/s)
})

test('keeps a saved adapter when QVAC rejects its own NaN stats', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  const { sdk } = fakeSdk({ nanStats: true })
  const warnings = []
  const res = await train({ sdk, runDir: dir, model: 'tiny', onEvent: (e) => e.type === 'warning' && warnings.push(e.message) })
  assert.equal(res.status, 'COMPLETED')
  assert.match(warnings[0], /invalid training stats/)
  assert.equal(res.card.metrics, null)
})

test('still throws a NaN error when no fresh adapter was written', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  const { sdk } = fakeSdk({ nanStats: true, writeAdapter: false })
  await assert.rejects(train({ sdk, runDir: dir, model: 'tiny' }), /NaN/)
})

test('a failed unload after pausing still reports PAUSED, without a warning', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  // QVAC 0.23 refuses to unload a model whose finetune was just paused.
  const { sdk } = fakeSdk({ ticks: 10, pauseAfter: 2, unloadFails: true })
  const ac = new AbortController()
  const events = []
  const res = await train({
    sdk,
    runDir: dir,
    signal: ac.signal,
    onEvent: (e) => { events.push(e); if (e.type === 'progress' && e.tick.global_steps === 2) ac.abort() }
  })
  assert.equal(res.status, 'PAUSED')
  assert.ok(!events.some((e) => e.type === 'warning'))
  assert.ok(events.some((e) => e.type === 'unload-failed' && e.afterPause))
})

test('a failed unload after a completed run keeps the adapter and warns', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  const { sdk } = fakeSdk({ unloadFails: true })
  const events = []
  const res = await train({ sdk, runDir: dir, onEvent: (e) => events.push(e) })
  assert.equal(res.status, 'COMPLETED')
  assert.ok(res.card)
  assert.ok(events.some((e) => e.type === 'warning' && /unload/.test(e.message)))
})

test('Ctrl+C after the job finished: the late pause is awaited and a failed unload still warns', async (t) => {
  const dir = await runDirWith(t, { 'train.jsonl': SFT })
  const { sdk, calls } = fakeSdk({ unloadFails: true })
  const ac = new AbortController()
  const realFinetune = sdk.finetune
  let pauseCalled = false
  let pauseSettled = false
  sdk.finetune = (o) => {
    // Pausing a finished job fails. If train() didn't await it, this would be
    // an unhandled rejection and fail the test run.
    if (o.operation === 'pause') {
      pauseCalled = true
      // Reject right away: the rejection must be handled even though
      // train() only awaits the pause later, in its finally block.
      pauseSettled = true
      return Promise.reject(new Error('no running job'))
    }
    const handle = realFinetune(o)
    // Press Ctrl+C right as the job settles, while run.json and the card are written.
    handle.result = handle.result.then((r) => { setImmediate(() => ac.abort()); return r })
    return handle
  }
  const events = []
  const res = await train({ sdk, runDir: dir, signal: ac.signal, onEvent: (e) => events.push(e) })
  assert.equal(res.status, 'COMPLETED')
  assert.ok(pauseCalled, 'the abort landed after the job finished')
  assert.ok(pauseSettled, 'unload waited for the late pause')
  assert.ok(events.some((e) => e.type === 'unload-failed' && !e.afterPause))
  assert.ok(events.some((e) => e.type === 'warning' && /unload/.test(e.message)))
})
