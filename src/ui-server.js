// Local web UI for Pocket Tune.
//
// A small node:http server (no dependencies) that serves one page and a JSON
// API over the same functions the CLI uses: prepTexts → train → compare.
// QVAC runs here in Node; the browser only sends text and shows results.
//
// Like the Wallet Guardian UI it only listens on 127.0.0.1, rejects foreign
// Host headers (DNS rebinding) and only accepts application/json POSTs, which
// a cross-site form can't send without a CORS preflight we never answer.
// Run names are a strict slug, so no request can reach outside the runs dir.

import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { prepTexts, PREP_FILE } from './prep.js'
import { train, findAdapter, hasPauseCheckpoint, RUN_FILE, CARD_FILE } from './train.js'
import { loadForChat, reply } from './chat.js'
import { PRESETS } from './models.js'
import { describeFit } from './fit.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BODY = 8 * 1024 * 1024 // chat exports can run to a few MB
const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/i
const SOURCE_TYPES = new Set(['notes', 'whatsapp', 'chat-json', 'qa-csv'])
const MAX_TICKS = 5000
const PREVIEW = 8
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
}
// The React build only loads its own files, so nothing inline is allowed.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const NOT_BUILT = '<!doctype html><meta charset="utf-8"><title>Pocket Tune</title><p>The web UI hasn\'t been built yet. Run <code>npm run build:ui</code> in the pocket-tune folder, then reload.</p>'

/** Bundled datasets the page offers as one-click examples. */
export const EXAMPLES = [
  {
    id: 'pirate-voice',
    label: 'Pirate FAQ',
    note: '59 helpful answers in a pirate voice',
    files: ['pirate-voice/faq.csv'],
    system: 'You are a helpful assistant. Answer in one or two short sentences.'
  },
  {
    id: 'scrub-demo',
    label: 'WhatsApp with secrets',
    note: 'a chat export full of fake secrets, to watch the scrubber',
    files: ['scrub-demo/WhatsApp Chat with Sam.txt'],
    me: 'Alex'
  }
]

const fail = (status, message) => Object.assign(new Error(message), { status })
const readJsonFile = (p) => readFile(p, 'utf8').then(JSON.parse, () => null)
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined)

/**
 * @param {object} opts
 * @param {() => Promise<any>} [opts.loadSdk] returns @qvac/sdk; omit to only prepare data
 * @param {string} [opts.runsDir] where runs live (default ./runs)
 * @param {string} [opts.examplesDir]
 * @param {string} [opts.uiDir] the built React app (default ui/dist)
 * @param {'gpu'|'cpu'} [opts.device]
 * @param {(line: string) => void} [opts.log]
 */
export function createUiServer ({ loadSdk, runsDir = 'runs', examplesDir = join(ROOT, 'examples'), uiDir = join(ROOT, 'ui', 'dist'), device = 'gpu', log = () => {} } = {}) {
  const runsRoot = resolve(runsDir)
  const uiRoot = resolve(uiDir)
  let sdkPromise = null
  /** The current or last training job. */
  let job = null
  let jobDone = Promise.resolve()
  // Chat models stay loaded between comparisons so re-asking is quick.
  const chat = { run: null, base: null, tuned: null, system: null }
  let chatQueue = Promise.resolve()
  let comparing = false
  let closing = false
  const notClosing = () => { if (closing) throw fail(503, 'Pocket Tune is shutting down.') }

  const training = () => !!job && ['loading', 'training', 'pausing'].includes(job.status)

  function sdk () {
    if (!loadSdk) throw fail(503, 'QVAC isn\'t available in this session (started without the SDK).')
    sdkPromise ??= loadSdk().catch((err) => { sdkPromise = null; throw fail(503, `Could not load @qvac/sdk: ${err.message}`) })
    return sdkPromise
  }

  function runDir (name) {
    if (typeof name !== 'string' || !NAME.test(name)) throw fail(400, 'Run names use letters, digits, - and _ (up to 48).')
    return join(runsRoot, name)
  }

  async function unloadChat () {
    const s = sdkPromise && (await sdkPromise.catch(() => null))
    for (const side of ['base', 'tuned']) {
      if (chat[side] && s) await s.unloadModel({ modelId: chat[side], clearStorage: false }).catch(() => {})
      chat[side] = null
    }
    chat.run = null
  }

  // ---------- runs ----------

  async function readRun (name) {
    const dir = join(runsRoot, name)
    const [prep, run, card] = await Promise.all([PREP_FILE, RUN_FILE, CARD_FILE].map((f) => readJsonFile(join(dir, f))))
    if (!prep && !run) return null
    return { dir, prep, run, card }
  }

  function runStatus (name, run, prep) {
    if (job?.run === name && training()) return job.status
    // RUNNING on disk but not running here: the process died mid-run.
    if (run?.status === 'RUNNING') return 'INTERRUPTED'
    return run?.status ?? (prep ? 'PREPARED' : 'UNKNOWN')
  }

  async function listRuns () {
    let entries = []
    try { entries = await readdir(runsRoot, { withFileTypes: true }) } catch {}
    const out = await Promise.all(entries.filter((e) => e.isDirectory() && NAME.test(e.name)).map(async (e) => {
      const r = await readRun(e.name)
      if (!r) return null
      const [{ mtimeMs: mtime }, adapter] = await Promise.all([stat(r.dir), findAdapter(r.dir)])
      return {
        name: e.name,
        mode: r.prep?.mode ?? r.run?.mode ?? null,
        status: runStatus(e.name, r.run, r.prep),
        model: r.run?.model?.name ?? null,
        hasAdapter: !!adapter,
        updatedAt: r.run?.updatedAt ?? r.prep?.createdAt ?? new Date(mtime).toISOString(),
        mtime
      }
    }))
    return out.filter(Boolean).sort((a, b) => b.mtime - a.mtime).map(({ mtime, ...r }) => r)
  }

  async function preview (dir, mode) {
    const file = join(dir, mode === 'causal' ? 'train.txt' : 'train.jsonl')
    const text = await readFile(file, 'utf8').catch(() => '')
    if (mode === 'causal') return text.split(/\n{2,}/).filter((p) => p.trim()).slice(0, PREVIEW).map((p) => ({ text: p }))
    return text.split('\n').filter(Boolean).slice(0, PREVIEW).map((l) => {
      try { return { messages: JSON.parse(l).messages.filter((m) => m.role !== 'system') } } catch { return null }
    }).filter(Boolean)
  }

  async function runDetails (name) {
    const dir = runDir(name)
    const r = await readRun(name)
    if (!r) throw fail(404, `No run named "${name}"`)
    const mode = r.prep?.mode ?? r.run?.mode
    return {
      name,
      mode,
      status: runStatus(name, r.run, r.prep),
      system: r.prep?.system ?? r.run?.system ?? null,
      prep: r.prep && { files: r.prep.files.map((f) => ({ ...f, file: f.file.split('/').pop() })), report: r.prep.report },
      model: r.run?.model?.spec ?? r.run?.model?.name ?? null,
      hyper: r.run && { epochs: r.run.options.numberOfEpochs, lr: r.run.options.learningRate },
      resumable: !!r.run && r.run.status !== 'COMPLETED' && (await hasPauseCheckpoint(r.run)),
      card: r.card,
      hasAdapter: !!(await findAdapter(dir)),
      preview: await preview(dir, mode)
    }
  }

  async function examples () {
    const out = []
    for (const ex of EXAMPLES) {
      try {
        const sources = []
        for (const f of ex.files) sources.push({ name: f.split('/').pop(), text: await readFile(join(examplesDir, f), 'utf8') })
        out.push({ id: ex.id, label: ex.label, note: ex.note, me: ex.me ?? null, system: ex.system ?? null, sources })
      } catch {} // not shipped in this install
    }
    return out
  }

  // ---------- prep ----------

  async function doPrep (body) {
    const dir = runDir(body.name)
    const sources = Array.isArray(body.sources) ? body.sources : []
    if (!sources.length || sources.length > 50) throw fail(400, 'Add between 1 and 50 sources.')
    const clean = sources.map((s) => {
      const name = str(s?.name, 200)
      if (!name || typeof s.text !== 'string') throw fail(400, 'Each source needs a name and text.')
      if (s.type != null && !SOURCE_TYPES.has(s.type)) throw fail(400, `Unknown source type "${s.type}".`)
      return { name, text: s.text, ...(s.type ? { type: s.type } : {}) }
    })
    if (job?.run === body.name && training()) throw fail(409, `"${body.name}" is training right now.`)
    const existing = await readRun(body.name)
    if (existing?.run) throw fail(409, `"${body.name}" has already been trained. Pick another name.`)
    const evalFraction = body.evalFraction == null ? undefined : Number(body.evalFraction)
    if (evalFraction != null && !(evalFraction >= 0 && evalFraction <= 0.5)) throw fail(400, 'Eval fraction must be between 0 and 0.5.')
    try {
      await prepTexts(clean, {
        outDir: dir,
        me: str(body.me, 200) || undefined,
        system: str(body.system, 2000) || undefined,
        scrubPii: body.scrub !== false,
        evalFraction
      })
    } catch (err) {
      throw fail(422, err.message) // bad input, not a server fault
    }
    log(`prepared run "${body.name}"`)
    return runDetails(body.name)
  }

  // ---------- training ----------

  function publicJob (since = 0) {
    if (!job) return null
    const { ac, ticks, total, ...rest } = job
    // `total` keeps counting after old ticks are dropped, so `since` stays
    // a valid position for clients that poll incrementally.
    const dropped = total - ticks.length
    return { ...rest, tickCount: total, ticks: ticks.slice(Math.max(0, since - dropped)) }
  }

  function onTrainEvent (j, e) {
    if (e.type === 'fit') j.fit = describeFit(e.fit)
    else if (e.type === 'download') j.download = Math.floor(e.percentage ?? 0)
    else if (e.type === 'pausing') j.status = 'pausing'
    else if (e.type === 'warning') j.warnings.push(e.message)
    else if (e.type === 'progress') {
      if (j.status === 'loading') j.status = 'training'
      const t = e.tick
      j.total++
      j.ticks.push({ train: !!t.is_train, epoch: t.current_epoch, batch: t.current_batch, batches: t.total_batches, step: t.global_steps, loss: t.loss, acc: t.accuracy, eta: t.eta_ms })
      if (j.ticks.length > MAX_TICKS) j.ticks.splice(0, j.ticks.length - MAX_TICKS)
    }
  }

  async function startTraining (body) {
    const dir = runDir(body.run)
    const resume = body.resume === true
    const r = await readRun(body.run)
    if (!r) throw fail(404, `No run named "${body.run}"`)
    const hyper = {}
    let model = r.run?.model?.spec ?? 'tiny'
    if (!resume) {
      if (r.run?.status === 'COMPLETED') throw fail(409, 'This run is already trained. Prepare a new run to train again.')
      model = body.model ?? 'tiny'
      if (!Object.hasOwn(PRESETS, model)) throw fail(400, `Unknown model "${model}".`)
      if (body.epochs != null) {
        hyper.numberOfEpochs = Number(body.epochs)
        if (!Number.isInteger(hyper.numberOfEpochs) || hyper.numberOfEpochs < 1 || hyper.numberOfEpochs > 20) throw fail(400, 'Epochs must be a whole number from 1 to 20.')
      }
      if (body.lr != null) {
        hyper.learningRate = Number(body.lr)
        if (!(hyper.learningRate >= 1e-6 && hyper.learningRate <= 1e-2)) throw fail(400, 'Learning rate must be between 0.000001 and 0.01.')
      }
    }
    const s = await sdk()
    // Check and claim synchronously: no await between here and `job =`.
    notClosing()
    if (training()) throw fail(409, `Already training "${job.run}".`)
    if (comparing) throw fail(409, 'A comparison is running. Try again when it finishes.')
    const ac = new AbortController()
    // Resuming a run paused in this session: keep its curve going.
    const carry = resume && job?.run === body.run && job.status === 'PAUSED' ? job : null
    const j = { kind: 'train', run: body.run, resume, carried: !!carry?.ticks.length, model, status: 'loading', fit: [], download: null, warnings: [], error: null, result: null, startedAt: Date.now(), endedAt: null, ac, ticks: carry ? [...carry.ticks] : [], total: carry?.total ?? 0 }
    job = j
    log(`${resume ? 'resuming' : 'training'} "${body.run}"`)
    jobDone = (async () => {
      try {
        await chatQueue
        await unloadChat() // training needs the memory
        const res = await train({ sdk: s, runDir: dir, model, hyper, device, resume, signal: ac.signal, onEvent: (e) => onTrainEvent(j, e) })
        j.status = res.status
        if (res.status === 'COMPLETED') j.result = { size: res.card.adapter.size, metrics: res.card.metrics }
        log(`"${j.run}": ${res.status.toLowerCase()}`)
      } catch (err) {
        j.status = 'FAILED'
        j.error = err.message
        log(`"${j.run}" failed: ${err.message}`)
      } finally {
        j.endedAt = Date.now()
      }
    })()
    return publicJob()
  }

  function pause () {
    if (!job || !training()) throw fail(409, 'Nothing is training.')
    if (job.status === 'loading') throw fail(409, 'Training hasn\'t started yet. Pause once the first step is done.')
    job.ac.abort()
    return publicJob()
  }

  // ---------- compare ----------

  async function compareStream (req, res) {
    const body = await readJson(req)
    const dir = runDir(body.run)
    const prompt = str(body.prompt, 2000)?.trim()
    if (!prompt) throw fail(400, 'Type a prompt (up to 2000 characters).')
    notClosing()
    if (training()) throw fail(409, 'Training is running. Pause it or wait for it to finish.')
    if (!(await readRun(body.run))) throw fail(404, `No run named "${body.run}"`)
    if (!(await findAdapter(dir))) throw fail(409, 'Train this run first.')
    const s = await sdk()

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    const emit = (ev) => { if (!res.destroyed) res.write(JSON.stringify(ev) + '\n') }
    // A closed tab or a new question shouldn't keep the GPU busy (and block
    // training, which waits for the queue) with answers nobody will read.
    const gone = new AbortController()
    res.on('close', () => { if (!res.writableEnded) gone.abort() })
    const work = chatQueue.then(async () => {
      if (gone.signal.aborted) return
      if (training()) return emit({ type: 'error', message: 'Training started. Compare again when it finishes.' })
      comparing = true
      try {
        if (chat.run !== body.run) await unloadChat()
        chat.run = body.run
        for (const side of ['base', 'tuned']) {
          if (gone.signal.aborted) return
          if (!chat[side]) {
            emit({ type: 'stage', side, stage: 'loading' })
            const loaded = await loadForChat({ sdk: s, runDir: dir, withAdapter: side === 'tuned', device })
            chat[side] = loaded.modelId
            chat.system = loaded.system
          }
          emit({ type: 'stage', side, stage: 'answering' })
          const history = [...(chat.system ? [{ role: 'system', content: chat.system }] : []), { role: 'user', content: prompt }]
          const text = await reply({ sdk: s, modelId: chat[side], history, signal: gone.signal, onText: (t) => emit({ type: 'delta', side, text: t }) })
          emit({ type: 'answer', side, text })
        }
        emit({ type: 'done' })
      } catch (err) {
        emit({ type: 'error', message: err.message })
      } finally {
        comparing = false
      }
    })
    chatQueue = work.catch(() => {})
    await work
    res.end()
  }

  // ---------- http ----------

  function send (res, status, body, type = 'application/json; charset=utf-8', cache = 'no-store') {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {})
    })
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
  }

  /** Files from the React build. Anything that resolves outside it is a 404. */
  async function staticFile (res, pathname) {
    let rel
    try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname) } catch { return send(res, 400, { error: 'bad path' }) }
    const file = resolve(uiRoot, '.' + rel)
    if (!file.startsWith(uiRoot + sep) || rel.includes('\0')) return send(res, 404, { error: 'not found' })
    try {
      const body = await readFile(file)
      // Vite puts content hashes in asset names, so those can be cached forever.
      const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store'
      return send(res, 200, body, MIME[extname(file)] ?? 'application/octet-stream', cache)
    } catch {
      if (rel === '/index.html') return send(res, 503, NOT_BUILT, 'text/html; charset=utf-8')
      return send(res, 404, { error: 'not found' })
    }
  }

  async function readJson (req) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw fail(415, 'expected application/json')
    let size = 0
    const chunks = []
    for await (const c of req) {
      size += c.length
      if (size > MAX_BODY) throw fail(413, 'request too large (8 MB max)')
      chunks.push(c)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {} } catch { throw fail(400, 'invalid JSON') }
  }

  const server = createServer(async (req, res) => {
    try {
      const { port } = server.address()
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(res, 421, { error: 'unexpected Host header' })
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      const p = url.pathname
      if (req.method === 'GET') {
        if (p === '/api/state') {
          return send(res, 200, {
            qvac: !!loadSdk,
            device,
            runsDir: runsRoot,
            busy: training() ? 'training' : comparing ? 'comparing' : null,
            job: publicJob(Math.max(0, Number(url.searchParams.get('since')) || 0)),
            chat: { run: chat.run, loaded: ['base', 'tuned'].filter((s) => chat[s]) },
            models: Object.entries(PRESETS).map(([id, m]) => ({ id, label: m.label, mode: m.mode, phone: m.phone }))
          })
        }
        if (p === '/api/runs') return send(res, 200, await listRuns())
        if (p.startsWith('/api/runs/')) {
          let name
          try { name = decodeURIComponent(p.slice('/api/runs/'.length)) } catch { throw fail(400, 'bad run name') }
          return send(res, 200, await runDetails(name))
        }
        if (p === '/api/examples') return send(res, 200, await examples())
        if (!p.startsWith('/api/')) return await staticFile(res, p)
      }
      if (req.method === 'POST') {
        if (p === '/api/prep') return send(res, 200, await doPrep(await readJson(req)))
        if (p === '/api/train') return send(res, 202, await startTraining(await readJson(req)))
        if (p === '/api/pause') { await readJson(req); return send(res, 200, pause()) }
        if (p === '/api/compare') return await compareStream(req, res)
      }
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      if (res.headersSent) return res.end()
      if (!err.status) log(`error: ${err.stack ?? err.message}`)
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'internal error' })
    }
  })

  return {
    server,
    /** For tests and the CLI: resolves when the current training job settles. */
    get jobDone () { return jobDone },
    get training () { return training() },
    /** Listen on 127.0.0.1 only. Resolves to the URL. */
    listen (port = 4322) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`))
      })
    },
    /** Pause any training (so it can be resumed), unload models and stop. */
    async close () {
      closing = true // refuse new training and comparisons from here on
      // A pause can only start once the first step runs, so wait for it.
      while (training() && job.status === 'loading') await new Promise((resolve) => setTimeout(resolve, 200))
      if (training() && job.status === 'training') job.ac.abort()
      await jobDone
      await chatQueue
      await unloadChat()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
