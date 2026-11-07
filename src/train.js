import { mkdir, readFile, readdir, stat, writeFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveModel } from './models.js'
import { ensureFits } from './fit.js'
import { DEFAULT_HYPER, buildFinetuneOptions } from './build.js'

export const RUN_FILE = 'run.json'
export const CARD_FILE = 'adapter.json'
export const CARD_FORMAT = 'pocket-tune/adapter@1'

export { DEFAULT_HYPER }

const exists = (p) => access(p).then(() => true, () => false)

async function sha256File (file) {
  const h = createHash('sha256')
  for await (const c of createReadStream(file)) h.update(c)
  return h.digest('hex')
}

/** Detect the dataset a `prep` run produced. */
export async function detectRunData (runDir) {
  if (await exists(join(runDir, 'train.jsonl'))) {
    return { mode: 'sft', train: join(runDir, 'train.jsonl'), eval: join(runDir, 'eval.jsonl') }
  }
  if (await exists(join(runDir, 'train.txt'))) {
    return { mode: 'causal', train: join(runDir, 'train.txt'), eval: join(runDir, 'eval.txt') }
  }
  throw new Error(`No train.jsonl or train.txt in ${runDir}. Run \`pocket-tune prep\` first.`)
}

async function hasContent (file) {
  try { return (await stat(file)).size > 0 } catch { return false }
}

/** Newest .gguf directly inside `dir`; QVAC names it trained-lora-adapter.gguf today. */
export async function findAdapter (dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.gguf'))
  if (!files.length) return null
  const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })))
  withTime.sort((a, b) => b.t - a.t)
  return join(dir, withTime[0].f)
}

/** Build the finetune() params for a run. Pure, so it can be persisted and resumed. */
export function finetuneOptions ({ runDir, data, hyper, hasEval }) {
  return buildFinetuneOptions({ runDir, mode: data.mode, trainPath: data.train, evalPath: data.eval, hasEval, hyper })
}

/**
 * Train (or resume) a LoRA adapter.
 * @param {object} p
 * @param {object} p.sdk         the @qvac/sdk module (injected for testability)
 * @param {string} p.runDir
 * @param {string} [p.model]     preset, SDK constant or local .gguf (ignored on resume)
 * @param {object} [p.hyper]
 * @param {boolean} [p.resume]
 * @param {boolean} [p.force]    skip the fine-tunability check
 * @param {'gpu'|'cpu'} [p.device]
 * @param {AbortSignal} [p.signal] abort → pause at the next step (resumable)
 *   onEvent also gets { type: 'unload-failed', message, afterPause } when the
 *   model couldn't be unloaded at the end (QVAC refuses after a pause).
 * @param {(e: object) => void} [p.onEvent]
 */
const PAUSE_PREFIX = 'pause_checkpoint_step_'

/** True when QVAC left a pause checkpoint (written by Ctrl+C / pause) it can resume from. */
export async function hasPauseCheckpoint (run) {
  try {
    return (await readdir(run.options.checkpointSaveDir)).some((n) => n.startsWith(PAUSE_PREFIX))
  } catch { return false }
}

export async function train ({ sdk, runDir, model = 'tiny', hyper = {}, resume = false, force = false, device = 'gpu', signal, onEvent = () => {} }) {
  runDir = resolve(runDir)
  const runPath = join(runDir, RUN_FILE)
  let run
  if (resume) {
    if (!(await exists(runPath))) throw new Error(`Nothing to resume in ${runDir}`)
    run = JSON.parse(await readFile(runPath, 'utf8'))
    if (run.status === 'COMPLETED') throw new Error('That run already completed')
    // QVAC resumes only from a pause checkpoint. The periodic checkpoints a
    // crash leaves behind can't be resumed, so say so instead of failing deep
    // inside the addon.
    if (!(await hasPauseCheckpoint(run))) {
      throw new Error(`${runDir} has no pause checkpoint, so it can't be resumed (QVAC resumes only runs paused with Ctrl+C, not ones that crashed or were killed). Start it again with: pocket-tune train ${runDir}`)
    }
  } else {
    const data = await detectRunData(runDir)
    const resolved = resolveModel(model, sdk)
    if (!resolved.check.ok && !force) throw new Error(`${resolved.name}: ${resolved.check.reason} (use --force to try anyway)`)
    if (resolved.preset && resolved.preset.mode !== data.mode) {
      onEvent({ type: 'warning', message: `${resolved.name} is usually trained in ${resolved.preset.mode} mode but this dataset is ${data.mode}` })
    }
    const h = { ...DEFAULT_HYPER, ...hyper }
    let system = null
    try { system = JSON.parse(await readFile(join(runDir, 'prep.json'), 'utf8')).system } catch {}
    run = {
      version: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
      model: { spec: model, name: resolved.name, src: resolved.modelSrc },
      device,
      mode: data.mode,
      system,
      options: finetuneOptions({ runDir, data, hyper: h, hasEval: await hasContent(data.eval) })
    }
    await mkdir(run.options.checkpointSaveDir, { recursive: true })
    await writeFile(runPath, JSON.stringify(run, null, 2))
  }

  const load = {
    modelSrc: run.model.src,
    ...(typeof run.model.src === 'string' ? { modelType: 'llm' } : {}),
    modelConfig: { device: run.device, ctx_size: run.options.contextLength }
  }
  // Before downloading: will the base model even fit? Training needs extra
  // headroom on top of this (activations, optimiser state), so a "fits" is
  // necessary, not sufficient.
  const fit = await ensureFits(sdk, [{ ...load, modelType: 'llamacpp-completion' }], { force })
  onEvent({ type: 'fit', fit })

  onEvent({ type: 'loading', model: run.model.name })
  const modelId = await sdk.loadModel({
    ...load,
    onProgress: (p) => onEvent({ type: 'download', percentage: p.percentage })
  })

  let pauseRequested = null
  const onAbort = () => {
    if (pauseRequested) return
    onEvent({ type: 'pausing' })
    pauseRequested = sdk.finetune({ modelId, operation: 'pause' })
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  let status = null
  try {
    const handle = sdk.finetune({ modelId, options: run.options, ...(resume ? { operation: 'resume' } : {}) })
    run.status = 'RUNNING'
    await writeFile(runPath, JSON.stringify(run, null, 2))
    const startedAt = Date.now()
    for await (const tick of handle.progressStream) onEvent({ type: 'progress', tick })
    let result
    try {
      result = await handle.result
    } catch (err) {
      // QVAC 0.23 rejects its own result when a stat is NaN (e.g. a run
      // resumed right at the end of an epoch has no train batches to average).
      // The adapter is already on disk by then, so don't throw the run away.
      const adapter = await findAdapter(runDir)
      const fresh = adapter && (await stat(adapter)).mtimeMs >= startedAt - 1000
      if (!fresh || !/NaN/.test(err.message)) throw err
      onEvent({ type: 'warning', message: `QVAC reported invalid training stats (${err.message.split('\n')[0]}). The adapter was saved; metrics are missing from the card.` })
      result = { status: 'COMPLETED', stats: undefined }
    }
    if (pauseRequested) await pauseRequested.catch(() => {})

    status = run.status = result.status
    run.stats = result.stats
    run.updatedAt = new Date().toISOString()
    await writeFile(runPath, JSON.stringify(run, null, 2))

    if (result.status !== 'COMPLETED') return { status: result.status, run }

    const adapter = await findAdapter(runDir)
    if (!adapter) throw new Error(`Training completed but no adapter .gguf appeared in ${runDir}`)
    const card = await writeCard(runDir, run, adapter)
    return { status: 'COMPLETED', run, adapter, card }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // A Ctrl+C that landed after the job finished still started a pause.
    if (pauseRequested) await pauseRequested.catch(() => {})
    // After a pause QVAC 0.23 refuses to unload the model ("Failed to unload
    // model"). The run state is already saved, so a failed unload must not
    // replace the real result. Callers that keep running get an
    // 'unload-failed' event (the model may still hold memory); it's only
    // worth a warning when the run didn't pause, where it isn't expected.
    await sdk.unloadModel({ modelId, clearStorage: false }).catch((err) => {
      const afterPause = status === 'PAUSED'
      onEvent({ type: 'unload-failed', message: err.message, afterPause })
      if (!afterPause) onEvent({ type: 'warning', message: `could not unload the model cleanly (${err.message})` })
    })
  }
}

async function datasetSummary (run) {
  const out = {}
  for (const [k, p] of [['train', run.options.trainDatasetDir], ['eval', run.options.validation?.path]]) {
    if (!p || !(await exists(p))) continue
    const text = await readFile(p, 'utf8')
    out[k] = {
      sha256: createHash('sha256').update(text).digest('hex'),
      samples: run.mode === 'sft' ? text.split('\n').filter(Boolean).length : text.split(/\n{2,}/).filter((s) => s.trim()).length
    }
  }
  return out
}

/** A small, shareable description of the adapter. Never includes the data itself. */
export async function writeCard (runDir, run, adapterPath) {
  const src = run.model.src
  const card = {
    format: CARD_FORMAT,
    createdAt: new Date().toISOString(),
    base: {
      name: run.model.name,
      registryPath: typeof src === 'object' ? src.registryPath : undefined,
      sha256: typeof src === 'object' ? src.sha256Checksum : undefined
    },
    mode: run.mode,
    hyperparameters: Object.fromEntries(
      ['numberOfEpochs', 'learningRate', 'lrMin', 'contextLength', 'loraModules', 'assistantLossOnly']
        .map((k) => [k, run.options[k]])
    ),
    dataset: await datasetSummary(run),
    metrics: run.stats ?? null,
    adapter: {
      file: adapterPath.split('/').pop(),
      size: (await stat(adapterPath)).size,
      sha256: await sha256File(adapterPath)
    }
  }
  await writeFile(join(runDir, CARD_FILE), JSON.stringify(card, null, 2))
  return card
}
