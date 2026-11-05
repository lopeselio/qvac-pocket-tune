import { mkdir, readFile, readdir, stat, writeFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveModel } from './models.js'

export const RUN_FILE = 'run.json'
export const CARD_FILE = 'adapter.json'
export const CARD_FORMAT = 'pocket-tune/adapter@1'

export const DEFAULT_HYPER = {
  numberOfEpochs: 2,
  learningRate: 1e-4,
  lrMin: 1e-8,
  contextLength: 512,
  loraModules: 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down',
  checkpointSaveSteps: 25
}

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
  const { contextLength, ...rest } = hyper
  return {
    trainDatasetDir: data.train,
    validation: hasEval ? { type: 'dataset', path: data.eval } : { type: 'none' },
    assistantLossOnly: data.mode === 'sft',
    contextLength,
    checkpointSaveDir: join(runDir, 'checkpoints'),
    outputParametersDir: runDir,
    ...rest
  }
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
 * @param {(e: object) => void} [p.onEvent]
 */
export async function train ({ sdk, runDir, model = 'tiny', hyper = {}, resume = false, force = false, device = 'gpu', signal, onEvent = () => {} }) {
  runDir = resolve(runDir)
  const runPath = join(runDir, RUN_FILE)
  let run
  if (resume) {
    if (!(await exists(runPath))) throw new Error(`Nothing to resume in ${runDir}`)
    run = JSON.parse(await readFile(runPath, 'utf8'))
    if (run.status === 'COMPLETED') throw new Error('That run already completed')
  } else {
    const data = await detectRunData(runDir)
    const resolved = resolveModel(model, sdk)
    if (!resolved.check.ok && !force) throw new Error(`${resolved.name}: ${resolved.check.reason} (use --force to try anyway)`)
    if (resolved.preset && resolved.preset.mode !== data.mode) {
      onEvent({ type: 'warning', message: `${resolved.name} is usually trained in ${resolved.preset.mode} mode but this dataset is ${data.mode}` })
    }
    const h = { ...DEFAULT_HYPER, ...hyper }
    run = {
      version: 1,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
      model: { spec: model, name: resolved.name, src: resolved.modelSrc },
      device,
      mode: data.mode,
      options: finetuneOptions({ runDir, data, hyper: h, hasEval: await hasContent(data.eval) })
    }
    await mkdir(run.options.checkpointSaveDir, { recursive: true })
    await writeFile(runPath, JSON.stringify(run, null, 2))
  }

  onEvent({ type: 'loading', model: run.model.name })
  const modelId = await sdk.loadModel({
    modelSrc: run.model.src,
    ...(typeof run.model.src === 'string' ? { modelType: 'llm' } : {}),
    modelConfig: { device: run.device, ctx_size: run.options.contextLength },
    onProgress: (p) => onEvent({ type: 'download', percentage: p.percentage })
  })

  let pauseRequested = null
  const onAbort = () => {
    if (pauseRequested) return
    onEvent({ type: 'pausing' })
    pauseRequested = sdk.finetune({ modelId, operation: 'pause' })
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const handle = sdk.finetune({ modelId, options: run.options, ...(resume ? { operation: 'resume' } : {}) })
    run.status = 'RUNNING'
    await writeFile(runPath, JSON.stringify(run, null, 2))
    for await (const tick of handle.progressStream) onEvent({ type: 'progress', tick })
    const result = await handle.result
    if (pauseRequested) await pauseRequested.catch(() => {})

    run.status = result.status
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
    await sdk.unloadModel({ modelId, clearStorage: false })
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
