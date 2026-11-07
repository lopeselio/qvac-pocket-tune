#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { PRESETS, prep, train, loadForChat, reply, compare, shareAdapter, describeFit } from '../src/index.js'

const HELP = `pocket-tune — train a personal LoRA adapter on your own data, on your own device

Usage:
  pocket-tune prep <files/dirs...> --out <run> [--me "Your Name"] [--system "..."]
                   [--type notes|whatsapp|chat-json|qa-csv] [--eval 0.1] [--no-scrub]
  pocket-tune train <run> [--model tiny] [--epochs 2] [--lr 1e-4] [--ctx 512] [--cpu] [--force]
  pocket-tune resume <run>
  pocket-tune chat <run> [--base]
  pocket-tune compare <run> "prompt one" ["prompt two"...]
  pocket-tune share <run> --name <adapter-name> [--no-seed]
  pocket-tune ui [--runs runs] [--port 4322] [--no-open] [--cpu]
  pocket-tune models

--force skips the fine-tunability and memory checks.
Ctrl+C during training pauses at the next step; \`pocket-tune resume <run>\` continues.
\`ui\` opens a local web page (127.0.0.1 only) for the same prep → train → compare flow.
Your data and the training both stay on this machine. \`share\` publishes only the adapter
weights and a small card (base model, hyperparameters, metrics, dataset hashes).
`

const fmtPct = (x) => (x == null || Number.isNaN(x) ? '  -  ' : x.toFixed(3))

function progressPrinter () {
  let lastDl = -1
  return (e) => {
    if (e.type === 'warning') console.error(`⚠ ${e.message}`)
    if (e.type === 'fit') for (const l of describeFit(e.fit)) console.error(`▸ memory check: ${l}`)
    if (e.type === 'loading') console.error(`▸ loading ${e.model}`)
    if (e.type === 'download') {
      const p = Math.floor(e.percentage ?? 0)
      if (p !== lastDl) { lastDl = p; process.stderr.write(`\r▸ downloading base model ${p}%   `) }
      if (p >= 100) process.stderr.write('\n')
    }
    if (e.type === 'pausing') console.error('\n▸ pausing after this step… (resume with `pocket-tune resume`)')
    if (e.type === 'progress') {
      const t = e.tick
      const phase = t.is_train ? 'train' : 'val  '
      process.stderr.write(`\r▸ epoch ${t.current_epoch + 1} ${phase} batch ${t.current_batch}/${t.total_batches}  loss ${fmtPct(t.loss)}  acc ${fmtPct(t.accuracy)}  eta ${Math.round(t.eta_ms / 1000)}s   `)
      if (!t.is_train && t.current_batch === t.total_batches) process.stderr.write('\n')
    }
  }
}

async function loadSdk () {
  try {
    return await import('@qvac/sdk')
  } catch (err) {
    throw new Error(`Could not load @qvac/sdk (${err.message}). Run \`npm install\` in pocket-tune.`)
  }
}

async function main (argv) {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      me: { type: 'string' },
      system: { type: 'string' },
      type: { type: 'string' },
      eval: { type: 'string' },
      'no-scrub': { type: 'boolean' },
      model: { type: 'string', short: 'm' },
      epochs: { type: 'string' },
      lr: { type: 'string' },
      ctx: { type: 'string' },
      cpu: { type: 'boolean' },
      force: { type: 'boolean' },
      base: { type: 'boolean' },
      name: { type: 'string' },
      'no-seed': { type: 'boolean' },
      runs: { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  const [cmd, ...args] = positionals
  if (v.help || !cmd) return process.stdout.write(HELP)
  const device = v.cpu ? 'cpu' : 'gpu'

  if (cmd === 'models') {
    for (const [k, p] of Object.entries(PRESETS)) {
      console.log(`${k.padEnd(10)} ${p.label.padEnd(48)} ${p.mode.padEnd(7)} ${p.phone ? 'phone-friendly' : 'desktop'}`)
    }
    console.log('\nOr pass any QVAC constant (e.g. QWEN3_1_7B_INST_Q4) or a local qwen3/gemma3/bitnet .gguf in F16/Q8_0/Q4_0/TQ2_0.')
    return
  }

  if (cmd === 'prep') {
    if (!args.length || !v.out) throw new Error('usage: pocket-tune prep <files...> --out <run>')
    const r = await prep(args, {
      outDir: v.out,
      me: v.me,
      system: v.system,
      type: v.type,
      contextLength: v.ctx ? Number(v.ctx) : undefined,
      evalFraction: v.eval ? Number(v.eval) : undefined,
      scrubPii: !v['no-scrub']
    })
    for (const f of r.files) console.log(`  ${f.kind.padEnd(9)} ${String(f.items).padStart(5)}  ${f.file}`)
    const rep = r.report
    console.log(`\n✔ ${r.mode.toUpperCase()} dataset written to ${r.dir}`)
    if (r.mode === 'sft') console.log(`  ${rep.train} train / ${rep.eval} eval conversations (dropped: ${rep.duplicates} duplicate, ${rep.tooLong} too long, ${rep.empty} empty)`)
    else console.log(`  ${rep.trainParagraphs} train / ${rep.evalParagraphs} eval paragraphs (${rep.duplicates} duplicates dropped)`)
    const red = Object.entries(rep.redactions)
    if (red.length) console.log(`  redacted: ${red.map(([k, n]) => `${n} ${k}`).join(', ')} — review the files before training`)
    console.log(`\nNext: pocket-tune train ${v.out}`)
    return
  }

  if (cmd === 'train' || cmd === 'resume') {
    const [runDir] = args
    if (!runDir) throw new Error(`usage: pocket-tune ${cmd} <run>`)
    const sdk = await loadSdk()
    const ac = new AbortController()
    let interrupts = 0
    // The SDK's own SIGINT handler kills the worker and re-raises the signal,
    // which would end the process before the pause checkpoint is written.
    // While training, Ctrl+C means "pause", so take the signal over. Its
    // 'exit' hook still shuts the worker down when we do exit.
    process.removeAllListeners('SIGINT')
    process.on('SIGINT', () => {
      if (++interrupts > 1) process.exit(130)
      ac.abort()
    })
    const hyper = {}
    if (v.epochs) hyper.numberOfEpochs = Number(v.epochs)
    if (v.lr) hyper.learningRate = Number(v.lr)
    if (v.ctx) hyper.contextLength = Number(v.ctx)
    const res = await train({
      sdk,
      runDir,
      model: v.model ?? 'tiny',
      hyper,
      device,
      force: v.force,
      resume: cmd === 'resume',
      signal: ac.signal,
      onEvent: progressPrinter()
    })
    if (res.status === 'COMPLETED') {
      const m = res.card.metrics ?? {}
      console.log(`\n✔ adapter: ${res.adapter} (${(res.card.adapter.size / 1e6).toFixed(1)} MB)`)
      console.log(`  train loss ${fmtPct(m.train_loss)}  val loss ${fmtPct(m.val_loss)}  val acc ${fmtPct(m.val_accuracy)}`)
      console.log(`\nTry it: pocket-tune compare ${runDir} "say hi"`)
    } else {
      console.log(`\n▸ run ${res.status.toLowerCase()}. Continue with: pocket-tune resume ${runDir}`)
    }
    process.exit(0) // the SDK worker keeps the loop alive on some platforms
  }

  if (cmd === 'chat') {
    const [runDir] = args
    if (!runDir) throw new Error('usage: pocket-tune chat <run>')
    const sdk = await loadSdk()
    const { modelId, system, adapter } = await loadForChat({ sdk, runDir, withAdapter: !v.base, device })
    console.error(`▸ ${adapter ? 'adapter loaded' : 'base model only'} — empty line or Ctrl+D to quit\n`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const history = system ? [{ role: 'system', content: system }] : []
    try {
      for (;;) {
        let line
        try { line = await rl.question('you › ') } catch { break }
        if (!line.trim()) break
        history.push({ role: 'user', content: line })
        process.stdout.write('bot › ')
        const text = await reply({ sdk, modelId, history, onText: (t) => process.stdout.write(t) })
        process.stdout.write('\n\n')
        history.push({ role: 'assistant', content: text })
      }
    } finally {
      rl.close()
      await sdk.unloadModel({ modelId, clearStorage: false })
    }
    process.exit(0)
  }

  if (cmd === 'compare') {
    const [runDir, ...prompts] = args
    if (!runDir || !prompts.length) throw new Error('usage: pocket-tune compare <run> "prompt"...')
    const sdk = await loadSdk()
    const rows = await compare({ sdk, runDir, prompts, device })
    for (const r of rows) {
      console.log(`\n❯ ${r.prompt}\n  base : ${r.base.replace(/\n/g, '\n         ')}\n  tuned: ${r.tuned.replace(/\n/g, '\n         ')}`)
    }
    process.exit(0)
  }

  if (cmd === 'ui') {
    const { createUiServer } = await import('../src/ui-server.js')
    const runsDir = v.runs ?? 'runs'
    const ui = createUiServer({
      loadSdk,
      runsDir,
      device,
      log: (l) => console.error(`▸ ${l}`)
    })
    const url = await ui.listen(Number(v.port ?? 4322))
    console.log(`Pocket Tune UI: ${url}  (runs in ${runsDir}/, Ctrl+C to stop)`)
    if (!v['no-open']) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      const { spawn } = await import('node:child_process')
      spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    }
    // Same as \`train\`: the SDK's SIGINT handler would kill a run mid-step.
    // First Ctrl+C pauses any training (so it can be resumed) and exits.
    process.removeAllListeners('SIGINT')
    let stopping = false
    const stop = async () => {
      if (stopping) process.exit(130)
      stopping = true
      if (ui.training) console.error('\n▸ pausing training before exiting… (Ctrl+C again to quit now)')
      await ui.close()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return new Promise(() => {})
  }

  if (cmd === 'share') {
    const [runDir] = args
    if (!runDir || !v.name) throw new Error('usage: pocket-tune share <run> --name <adapter-name>')
    const seed = await import('qvac-seed')
    const { store, drive, adapterUrl, cardUrl, card } = await shareAdapter({ runDir, name: v.name, seed })
    console.log(`adapter: ${adapterUrl}\ncard:    ${cardUrl}\nbase:    ${card.base.name}`)
    if (v['no-seed']) return store.close()
    const swarm = seed.createSwarm(store, { onPeer: (p) => console.error(`peer connected ${p.remotePublicKey.slice(0, 8)}`) })
    await seed.seedDrives(swarm, [drive])
    console.error('Seeding — Ctrl+C to stop. Others can fetch with: npx qvac-seed fetch <adapter url>')
    process.on('SIGINT', async () => { await swarm.destroy(); await store.close(); process.exit(0) })
    return new Promise(() => {})
  }

  throw new Error(`Unknown command "${cmd}". Run pocket-tune --help.`)
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`✖ ${err.message}`)
  process.exit(1)
})
