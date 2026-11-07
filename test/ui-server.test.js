import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUiServer } from '../src/ui-server.js'

const QWEN = { name: 'QWEN3_600M_INST_Q4', registryPath: 'u/Qwen3-0.6B-Q4_0.gguf', sha256Checksum: 'c'.repeat(64) }
const FAQ = 'question,answer\nhi,ahoy matey\nmail?,write to me at sam@example.com\nbye,fair winds\n'

function call (url, { method = 'GET', body, headers = {} } = {}) {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
const post = (url, obj) => call(url, { method: 'POST', body: JSON.stringify(obj), headers: { 'content-type': 'application/json' } })
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A gate the fake finetune waits on before each tick. */
function gated () {
  let open = null
  const g = {
    gate: () => new Promise((resolve) => { open = resolve }),
    waiting: () => until(() => open),
    release () { const r = open; open = null; r() },
    // Let one tick through and wait until the trainer asks for the next one.
    async step () { g.release(); await g.waiting() }
  }
  return g
}

/**
 * Fake QVAC: finetune emits `ticks` progress events, waiting on `gate` before
 * each one so a test can pause mid-run.
 */
function fakeSdk ({ ticks = 3, gate = null } = {}) {
  const calls = []
  let paused = false
  let opts = null
  const sdk = {
    QWEN3_600M_INST_Q4: QWEN,
    async assessModelFit () { return { verdict: 'likely-fits', models: [] } },
    async loadModel (o) { calls.push(['loadModel', o.modelConfig?.lora ? 'tuned' : 'base']); return o.modelConfig?.lora ? 'tuned' : 'base' },
    async unloadModel (o) { calls.push(['unloadModel', o.modelId]) },
    completion ({ modelId }) {
      const text = modelId === 'tuned' ? '<think></think>\n\nArr, ahoy!' : 'Hello there.'
      return { events: (async function * () { for (const w of text.split(/(?= )/)) yield { type: 'contentDelta', text: w } })() }
    },
    finetune (o) {
      calls.push(['finetune', o.operation ?? 'start'])
      if (o.operation === 'pause') {
        paused = true
        sdk.pauseCalled = true
        return mkdir(join(opts.checkpointSaveDir, 'pause_checkpoint_step_00000001'), { recursive: true }).then(() => ({ status: 'PAUSED' }))
      }
      opts = o.options
      let drained
      const done = new Promise((resolve) => { drained = resolve })
      async function * stream () {
        try {
          for (let i = 1; i <= ticks && !paused; i++) {
            if (gate) await gate()
            if (paused) return
            yield { is_train: true, loss: 1 / i, accuracy: 0.5, global_steps: i, current_epoch: 0, current_batch: i, total_batches: ticks, eta_ms: 1000 }
          }
        } finally { drained() }
      }
      const result = done.then(async () => {
        if (paused) return { status: 'PAUSED' }
        await writeFile(join(opts.outputParametersDir, 'trained-lora-adapter.gguf'), 'ADAPTER')
        return { status: 'COMPLETED', stats: { train_loss: 0.4, val_loss: 0.5 } }
      })
      return { progressStream: stream(), result }
    }
  }
  return { sdk, calls }
}

async function withServer (t, opts, fn) {
  const runsDir = await mkdtemp(join(tmpdir(), 'pt-ui-'))
  t.after(() => rm(runsDir, { recursive: true, force: true }))
  // A stand-in for the React build (ui/dist).
  const uiDir = join(runsDir, '.ui')
  await mkdir(join(uiDir, 'assets'), { recursive: true })
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Pocket Tune</title><script type="module" src="/assets/app-1a2b.js"></script>')
  await writeFile(join(uiDir, 'assets', 'app-1a2b.js'), 'console.log(1)')
  await writeFile(join(runsDir, 'secret.txt'), 'not for the browser')
  const ui = createUiServer({ runsDir, uiDir, ...opts })
  const url = await ui.listen(0)
  try { await fn(url, ui, runsDir) } finally { await ui.close() }
}

test('serves the React build with a strict CSP and never files outside it', async (t) => {
  await withServer(t, {}, async (url) => {
    const page = await call(url)
    assert.equal(page.status, 200)
    assert.match(page.headers['content-security-policy'], /script-src 'self';/)
    assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline/)
    assert.match(page.body, /Pocket Tune/)
    const js = await call(url + 'assets/app-1a2b.js')
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.match(js.headers['cache-control'], /immutable/)
    for (const p of ['../secret.txt', '..%2Fsecret.txt', '%2e%2e/secret.txt', 'assets/..%2F..%2Fsecret.txt', 'nope.js', '%E0%A4%A']) {
      const r = await call(url + p)
      assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`)
      assert.doesNotMatch(r.body, /not for the browser/)
    }
  })
})

test('explains how to build the UI when ui/dist is missing', async (t) => {
  await withServer(t, { uiDir: join(tmpdir(), 'pt-ui-missing-dist') }, async (url) => {
    const page = await call(url)
    assert.equal(page.status, 503)
    assert.match(page.body, /npm run build:ui/)
  })
})

test('rejects foreign hosts and non-JSON posts', async (t) => {
  await withServer(t, {}, async (url) => {
    assert.equal((await call(url + 'api/state', { headers: { host: 'evil.example:80' } })).status, 421)
    const form = await call(url + 'api/prep', { method: 'POST', body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert.equal(form.status, 415)
  })
})

test('prep writes a run, reports redactions and previews it without the system prompt', async (t) => {
  await withServer(t, {}, async (url, _ui, runsDir) => {
    const res = await post(url + 'api/prep', { name: 'pirate', sources: [{ name: 'faq.csv', text: FAQ }], system: 'Be a pirate.', evalFraction: 0 })
    assert.equal(res.status, 200)
    const run = res.json()
    assert.equal(run.mode, 'sft')
    assert.equal(run.status, 'PREPARED')
    assert.equal(run.prep.report.redactions.EMAIL, 1)
    assert.equal(run.system, 'Be a pirate.')
    assert.ok(run.preview.every((c) => c.messages.every((m) => m.role !== 'system')))
    assert.match(JSON.stringify(run.preview), /\[EMAIL\]/)
    assert.match(await readFile(join(runsDir, 'pirate', 'train.jsonl'), 'utf8'), /\[EMAIL\]/)
    const list = (await call(url + 'api/runs')).json()
    assert.deepEqual(list.map((r) => [r.name, r.status]), [['pirate', 'PREPARED']])
  })
})

test('rejects run names that could escape the runs dir, and bad input', async (t) => {
  await withServer(t, {}, async (url) => {
    for (const name of ['../x', 'a/b', '.hidden', '', 'x'.repeat(49)]) {
      assert.equal((await post(url + 'api/prep', { name, sources: [{ name: 'f.csv', text: FAQ }] })).status, 400, name)
    }
    assert.equal((await call(url + 'api/runs/..%2F..%2Fetc')).status, 400)
    assert.equal((await post(url + 'api/prep', { name: 'ok', sources: [] })).status, 400)
    assert.equal((await post(url + 'api/prep', { name: 'ok', sources: [{ name: 'f', text: 'x', type: 'exe' }] })).status, 400)
    // Bad data is the user's problem (422), not a server error.
    const empty = await post(url + 'api/prep', { name: 'ok', sources: [{ name: 'f.csv', text: 'question,answer\n' }] })
    assert.equal(empty.status, 422)
    assert.match(empty.json().error, /No usable/)
  })
})

test('offers the bundled examples', async (t) => {
  await withServer(t, {}, async (url) => {
    const ex = (await call(url + 'api/examples')).json()
    const pirate = ex.find((e) => e.id === 'pirate-voice')
    assert.match(pirate.sources[0].text, /^question,answer/)
    assert.equal(ex.find((e) => e.id === 'scrub-demo').me, 'Alex')
  })
})

test('training and comparing need QVAC', async (t) => {
  await withServer(t, {}, async (url) => {
    await post(url + 'api/prep', { name: 'r', sources: [{ name: 'f.csv', text: FAQ }] })
    assert.equal((await post(url + 'api/train', { run: 'r' })).status, 503)
  })
})

test('trains with live progress, then compares base and tuned as a stream', async (t) => {
  const { sdk, calls } = fakeSdk({ ticks: 3 })
  await withServer(t, { loadSdk: async () => sdk }, async (url, ui) => {
    await post(url + 'api/prep', { name: 'pirate', sources: [{ name: 'faq.csv', text: FAQ }], system: 'Be a pirate.' })
    assert.equal((await post(url + 'api/compare', { run: 'pirate', prompt: 'hi' })).status, 409) // not trained yet
    for (const bad of [{ model: 'gpt-9' }, { epochs: 0 }, { epochs: 1.5 }, { lr: 1 }]) {
      assert.equal((await post(url + 'api/train', { run: 'pirate', ...bad })).status, 400, JSON.stringify(bad))
    }
    const started = await post(url + 'api/train', { run: 'pirate', model: 'tiny', epochs: 1 })
    assert.equal(started.status, 202)
    assert.equal(started.json().run, 'pirate')
    await ui.jobDone
    const { job } = (await call(url + 'api/state')).json()
    assert.equal(job.status, 'COMPLETED')
    assert.equal(job.tickCount, 3)
    assert.deepEqual(job.ticks.map((x) => x.step), [1, 2, 3])
    assert.equal(job.result.metrics.val_loss, 0.5)
    assert.equal((await call(url + 'api/state?since=2')).json().job.ticks.length, 1)
    assert.equal((await post(url + 'api/train', { run: 'pirate' })).status, 409) // already trained

    const res = await post(url + 'api/compare', { run: 'pirate', prompt: 'hi' })
    assert.equal(res.status, 200)
    const events = res.body.trim().split('\n').map((l) => JSON.parse(l))
    const answers = Object.fromEntries(events.filter((e) => e.type === 'answer').map((e) => [e.side, e.text]))
    assert.deepEqual(answers, { base: 'Hello there.', tuned: 'Arr, ahoy!' })
    assert.equal(events.at(-1).type, 'done')
    assert.ok(events.some((e) => e.type === 'stage' && e.side === 'tuned' && e.stage === 'loading'))

    // Asking again reuses the loaded models.
    const loadsBefore = calls.filter((c) => c[0] === 'loadModel').length
    await post(url + 'api/compare', { run: 'pirate', prompt: 'bye' })
    assert.equal(calls.filter((c) => c[0] === 'loadModel').length, loadsBefore)
    assert.deepEqual((await call(url + 'api/state')).json().chat.loaded, ['base', 'tuned'])
  })
})

test('pause stops training at the next step, and resume continues it', async (t) => {
  const g = gated()
  const { sdk, calls } = fakeSdk({ ticks: 5, gate: g.gate })
  await withServer(t, { loadSdk: async () => sdk }, async (url, ui) => {
    await post(url + 'api/prep', { name: 'r', sources: [{ name: 'f.csv', text: FAQ }] })
    await post(url + 'api/train', { run: 'r', model: 'tiny' })
    await g.waiting()
    // Still loading: there's no step to pause at yet.
    assert.equal((await post(url + 'api/pause', {})).status, 409)
    await g.step() // first tick processed → training
    assert.equal((await call(url + 'api/state')).json().job.status, 'training')
    assert.equal((await post(url + 'api/train', { run: 'r' })).status, 409) // one job at a time
    assert.equal((await post(url + 'api/compare', { run: 'r', prompt: 'hi' })).status, 409)
    assert.equal((await post(url + 'api/pause', {})).status, 200)
    g.release()
    await ui.jobDone
    assert.equal((await call(url + 'api/state')).json().job.status, 'PAUSED')
    const details = (await call(url + 'api/runs/r')).json()
    assert.equal(details.status, 'PAUSED')
    assert.equal(details.resumable, true)

    const { sdk: sdk2 } = fakeSdk({ ticks: 2 })
    Object.assign(sdk, { finetune: sdk2.finetune })
    assert.equal((await post(url + 'api/train', { run: 'r', resume: true })).status, 202)
    await ui.jobDone
    assert.equal((await call(url + 'api/state')).json().job.status, 'COMPLETED')
    assert.ok(calls.some((c) => c[0] === 'finetune' && c[1] === 'pause'))
  })
})

test('a run left RUNNING by a crashed process shows as interrupted', async (t) => {
  await withServer(t, {}, async (url, _ui, runsDir) => {
    await post(url + 'api/prep', { name: 'r', sources: [{ name: 'f.csv', text: FAQ }] })
    await writeFile(join(runsDir, 'r', 'run.json'), JSON.stringify({ status: 'RUNNING', mode: 'sft', options: { checkpointSaveDir: join(runsDir, 'r', 'checkpoints') } }))
    const details = (await call(url + 'api/runs/r')).json()
    assert.equal(details.status, 'INTERRUPTED')
    assert.equal(details.resumable, false)
  })
})

test('close() pauses a running job so it can be resumed', async (t) => {
  const g = gated()
  const { sdk } = fakeSdk({ ticks: 5, gate: g.gate })
  const runsDir = await mkdtemp(join(tmpdir(), 'pt-ui-'))
  t.after(() => rm(runsDir, { recursive: true, force: true }))
  const ui = createUiServer({ runsDir, loadSdk: async () => sdk })
  const url = await ui.listen(0)
  await post(url + 'api/prep', { name: 'r', sources: [{ name: 'f.csv', text: FAQ }] })
  await post(url + 'api/train', { run: 'r', model: 'tiny' })
  await g.waiting()
  await g.step()
  const closing = ui.close()
  await until(() => sdk.pauseCalled)
  g.release()
  await closing
  assert.equal(JSON.parse(await readFile(join(runsDir, 'r', 'run.json'), 'utf8')).status, 'PAUSED')
})
