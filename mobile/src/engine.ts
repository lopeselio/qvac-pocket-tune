import * as qvac from '@qvac/sdk'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { buildFinetuneOptions, CHAT_SAMPLING, checkFinetunable, checkFit, describeFit, ensureFits, PRESETS, ThinkFilter } from './core'
import { findAdapter, runPaths, saveMeta, type RunMeta } from './runs'

// Everything here runs on the phone: the SDK spawns a Bare worklet that hosts
// QVAC Fabric (llama.cpp fork with LoRA training on Vulkan/Metal).

const sdk = qvac as unknown as Record<string, any>

export type PresetKey = keyof typeof PRESETS

export interface Tick {
  is_train: boolean
  loss: number | null
  accuracy: number | null
  global_steps: number
  current_epoch: number
  current_batch: number
  total_batches: number
  eta_ms: number
}

export type EngineEvent =
  | { type: 'fit', lines: string[] }
  | { type: 'download', percentage: number }
  | { type: 'loading' }
  | { type: 'progress', tick: Tick }
  | { type: 'pausing' }

function descriptor (preset: PresetKey) {
  const name = PRESETS[preset].constant as string
  const d = sdk[name]
  if (!d) throw new Error(`This SDK build has no ${name}`)
  return { name, d }
}

let active: { modelId: string, pausing: boolean } | null = null

/** Check memory for a preset without downloading it. */
export async function memoryCheck (preset: PresetKey, ctx = 512): Promise<string[]> {
  const { d } = descriptor(preset)
  const fit = await checkFit(sdk, [{ modelSrc: d, modelType: 'llamacpp-completion', modelConfig: { ctx_size: ctx } }])
  return describeFit(fit)
}

/**
 * Train or resume. Resolves when training stops (completed, paused or cancelled).
 */
export async function trainRun (meta: RunMeta, opts: { preset: PresetKey, epochs: number, resume?: boolean, force?: boolean, onEvent: (e: EngineEvent) => void }): Promise<RunMeta> {
  if (active) throw new Error('Training is already running')
  const presetKey = opts.resume && meta.model ? (Object.keys(PRESETS).find((k) => PRESETS[k as PresetKey].constant === meta.model) as PresetKey ?? opts.preset) : opts.preset
  const { name, d } = descriptor(presetKey)
  const check = checkFinetunable(d)
  if (!check.ok) throw new Error(check.reason)

  const paths = runPaths(meta)
  const options = opts.resume && meta.options
    ? meta.options
    : buildFinetuneOptions({ runDir: paths.dir, mode: meta.mode, trainPath: paths.train, evalPath: paths.eval, hasEval: paths.hasEval, hyper: { numberOfEpochs: opts.epochs } })
  const ctx = Number((options as any).contextLength ?? 512)

  const load = { modelSrc: d, modelConfig: { device: 'gpu', ctx_size: ctx } }
  const fit = await ensureFits(sdk, [{ ...load, modelType: 'llamacpp-completion' }], { force: opts.force })
  opts.onEvent({ type: 'fit', lines: describeFit(fit) })

  let next: RunMeta = { ...meta, model: name, options, status: 'RUNNING' }
  saveMeta(next)
  await activateKeepAwakeAsync('pocket-tune-training')
  opts.onEvent({ type: 'loading' })
  const modelId: string = await sdk.loadModel({ ...load, onProgress: (p: { percentage: number }) => opts.onEvent({ type: 'download', percentage: p.percentage }) })
  active = { modelId, pausing: false }
  try {
    const handle = sdk.finetune({ modelId, options, ...(opts.resume ? { operation: 'resume' } : {}) })
    for await (const tick of handle.progressStream) opts.onEvent({ type: 'progress', tick: tick as Tick })
    const result = await handle.result
    next = { ...next, status: result.status, stats: result.stats ?? null }
    if (result.status === 'COMPLETED') {
      const adapter = findAdapter(next)
      if (!adapter) throw new Error('Training finished but no adapter file was written')
      next.adapter = adapter.path
    }
    saveMeta(next)
    return next
  } catch (err) {
    next = { ...next, status: 'FAILED' }
    saveMeta(next)
    throw err
  } finally {
    active = null
    deactivateKeepAwake('pocket-tune-training')
    await sdk.unloadModel({ modelId, clearStorage: false }).catch(() => {})
  }
}

/** Ask the running job to stop at the next step; it can be resumed later. */
export async function pauseTraining (onEvent?: (e: EngineEvent) => void) {
  if (!active || active.pausing) return
  active.pausing = true
  onEvent?.({ type: 'pausing' })
  await sdk.finetune({ modelId: active.modelId, operation: 'pause' })
}

export const isTraining = () => active !== null

async function reply (modelId: string, history: { role: string, content: string }[], onText?: (t: string) => void) {
  const run = sdk.completion({ modelId, history, stream: true })
  const filter = new ThinkFilter()
  let text = ''
  for await (const ev of run.events) {
    if (ev.type !== 'contentDelta') continue
    const visible = filter.push(ev.text)
    if (visible) { text += visible; onText?.(text) }
  }
  text += filter.flush()
  return text.trim()
}

/**
 * Same prompt to the base model and to base + adapter. Loads one model at a
 * time so it fits on a phone.
 */
export async function compareRun (meta: RunMeta, prompt: string, onUpdate: (r: { base: string, tuned: string, stage: string }) => void) {
  if (!meta.model || !meta.adapter) throw new Error('Train this run first')
  const d = sdk[meta.model]
  const ctx = Math.max(1024, Number((meta.options as any)?.contextLength ?? 512))
  const history = [...(meta.system ? [{ role: 'system', content: meta.system }] : []), { role: 'user', content: prompt }]
  const out = { base: '', tuned: '', stage: 'base' }
  for (const withAdapter of [false, true]) {
    out.stage = withAdapter ? 'loading adapter' : 'loading base model'
    onUpdate({ ...out })
    const modelId: string = await sdk.loadModel({
      modelSrc: d,
      // Same sampling as the CLI's compare, for base and tuned alike.
      modelConfig: { device: 'gpu', ctx_size: ctx, ...CHAT_SAMPLING, ...(withAdapter ? { lora: meta.adapter } : {}) }
    })
    try {
      out.stage = withAdapter ? 'tuned' : 'base'
      const text = await reply(modelId, history, (t) => {
        if (withAdapter) out.tuned = t; else out.base = t
        onUpdate({ ...out })
      })
      if (withAdapter) out.tuned = text; else out.base = text
    } finally {
      await sdk.unloadModel({ modelId, clearStorage: false }).catch(() => {})
    }
  }
  out.stage = 'done'
  onUpdate({ ...out })
  return out
}
