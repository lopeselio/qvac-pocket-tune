import * as qvac from '@qvac/sdk'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { Platform } from 'react-native'
import { buildFinetuneOptions, CHAT_SAMPLING, checkFinetunable, checkFit, describeFit, ensureFits, PRESETS, ThinkFilter, withThinkingFallback } from './core'
import { findAdapter, runPaths, saveMeta, toPosix, type RunMeta } from './runs'
import { SPEECH_MODELS, type SpeechKey } from './voice'

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

/**
 * Where training runs. On iOS, QVAC Fabric 0.25's Metal backend fails a
 * training step ("ggml_opt: backend graph compute failed", ggml-opt.cpp:1014)
 * and ggml aborts the app, seen on an iPhone 13 Pro Max. The CPU backend runs
 * the same graph without Metal. Chatting and comparing still use the GPU.
 */
export const TRAIN_DEVICE: 'gpu' | 'cpu' = Platform.OS === 'ios' ? 'cpu' : 'gpu'

// ---------- speech ----------
// Whisper stays loaded between clips (a clip then takes well under a second)
// and is unloaded before training or comparing, so models never share memory.

let speech: { key: SpeechKey, modelId: string } | null = null
let speechQueue: Promise<unknown> = Promise.resolve()

// Set synchronously when training or a comparison starts (before any download
// or load), so speech can never load alongside them.
let busy: 'training' | 'comparing' | null = null

export async function releaseSpeech () {
  const s = speech
  speech = null
  if (s) await sdk.unloadModel({ modelId: s.modelId, clearStorage: false }).catch(() => {})
}

/**
 * Transcribe an audio file (m4a, mp3, wav…) on this phone. QVAC decodes it
 * with its own FFmpeg, so recordings and voice memos go in as they are.
 */
export function transcribeFile (uri: string, key: SpeechKey, onDownload?: (percentage: number) => void): Promise<{ text: string, ms: number }> {
  const work = speechQueue.then(async () => {
    if (busy === 'training') throw new Error('Training is running. Record when it finishes or after pausing.')
    if (busy === 'comparing') throw new Error('Comparing answers. Record when it finishes.')
    if (speech?.key !== key) {
      await releaseSpeech()
      const m = SPEECH_MODELS[key]
      const d = sdk[m.constant]
      if (!d) throw new Error(`This QVAC build has no ${m.constant}`)
      try {
        const modelId: string = await sdk.loadModel({
          modelSrc: d,
          modelConfig: { language: m.language },
          onProgress: (p: { percentage?: number }) => onDownload?.(Math.floor(p.percentage ?? 0))
        })
        speech = { key, modelId }
      } catch (err: any) {
        throw new Error(`Couldn't load the speech model: ${err?.message ?? err}`)
      }
    }
    const started = Date.now()
    const text = await sdk.transcribe({ modelId: speech!.modelId, audioChunk: toPosix(uri) })
    return { text: String(text ?? '').trim(), ms: Date.now() - started }
  })
  speechQueue = work.catch(() => {})
  return work
}

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
  if (busy) throw new Error(busy === 'training' ? 'Training is already running' : 'Wait for the comparison to finish')
  busy = 'training'
  try {
    await speechQueue
    await releaseSpeech()
    return await trainLocked(meta, opts)
  } finally {
    busy = null
  }
}

async function trainLocked (meta: RunMeta, opts: { preset: PresetKey, epochs: number, resume?: boolean, force?: boolean, onEvent: (e: EngineEvent) => void }): Promise<RunMeta> {
  const presetKey = opts.resume && meta.model ? (Object.keys(PRESETS).find((k) => PRESETS[k as PresetKey].constant === meta.model) as PresetKey ?? opts.preset) : opts.preset
  const { name, d } = descriptor(presetKey)
  const check = checkFinetunable(d)
  if (!check.ok) throw new Error(check.reason)

  const paths = runPaths(meta)
  const options = opts.resume && meta.options
    ? meta.options
    : buildFinetuneOptions({ runDir: paths.dir, mode: meta.mode, trainPath: paths.train, evalPath: paths.eval, hasEval: paths.hasEval, hyper: { numberOfEpochs: opts.epochs } })
  const ctx = Number((options as any).contextLength ?? 512)

  const load = { modelSrc: d, modelConfig: { device: TRAIN_DEVICE, ctx_size: ctx } }
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

export const isTraining = () => busy === 'training'

type Msg = { role: string, content: string }

/** Like the CLI's reply(): retry with /no_think if there was no visible answer. */
async function reply (modelId: string, history: Msg[], onText?: (t: string) => void) {
  const { text } = await withThinkingFallback(history, async (h: Msg[]) => (await replyOnce(modelId, h, onText)).text)
  return text as string
}

async function replyOnce (modelId: string, history: Msg[], onText?: (t: string) => void) {
  const run = sdk.completion({ modelId, history, stream: true })
  const filter = new ThinkFilter()
  let text = ''
  for await (const ev of run.events) {
    if (ev.type !== 'contentDelta') continue
    const visible = filter.push(ev.text)
    if (visible) { text += visible; onText?.(text) }
  }
  const tail = filter.flush()
  if (tail) { text += tail; onText?.(text) }
  return { text: text.trim(), stuckThinking: filter.inThink as boolean }
}

/**
 * Same prompt to the base model and to base + adapter. Loads one model at a
 * time so it fits on a phone.
 */
export async function compareRun (meta: RunMeta, prompt: string, onUpdate: (r: { base: string, tuned: string, stage: string }) => void) {
  if (!meta.model || !meta.adapter) throw new Error('Train this run first')
  if (busy) throw new Error(busy === 'training' ? 'Training is running. Compare when it finishes.' : 'A comparison is already running')
  busy = 'comparing'
  try {
    await speechQueue
    await releaseSpeech()
    return await compareLocked(meta, prompt, onUpdate)
  } finally {
    busy = null
  }
}

async function compareLocked (meta: RunMeta, prompt: string, onUpdate: (r: { base: string, tuned: string, stage: string }) => void) {
  const d = sdk[meta.model as string] // checked in compareRun
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
