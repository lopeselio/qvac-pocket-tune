import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { RUN_FILE, findAdapter } from './train.js'
import { ThinkFilter } from './think.js'
import { CHAT_SAMPLING } from './build.js'

export { ThinkFilter }

/** Load the run's base model, optionally with its adapter applied. */
export async function loadForChat ({ sdk, runDir, withAdapter = true, device = 'gpu', sampling = {}, onProgress }) {
  runDir = resolve(runDir)
  const run = JSON.parse(await readFile(join(runDir, RUN_FILE), 'utf8'))
  const adapter = withAdapter ? await findAdapter(runDir) : null
  if (withAdapter && !adapter) throw new Error(`No adapter in ${runDir} yet. Train first.`)
  const modelId = await sdk.loadModel({
    modelSrc: run.model.src,
    ...(typeof run.model.src === 'string' ? { modelType: 'llm' } : {}),
    modelConfig: { device, ctx_size: Math.max(2048, run.options.contextLength), ...CHAT_SAMPLING, ...sampling, ...(adapter ? { lora: adapter } : {}) },
    onProgress
  })
  return { modelId, run, adapter, system: systemPromptFromRun(run) }
}

/** Reuse the system prompt the adapter was trained with, if any. */
export function systemPromptFromRun (run) {
  return run.system || null
}

/** Stream one reply, returning the visible text. */
export async function reply ({ sdk, modelId, history, onText = () => {} }) {
  const run = sdk.completion({ modelId, history, stream: true })
  const filter = new ThinkFilter()
  let text = ''
  for await (const ev of run.events) {
    if (ev.type !== 'contentDelta') continue
    const visible = filter.push(ev.text)
    text += visible
    if (visible) onText(visible)
  }
  const tail = filter.flush()
  if (tail) onText(tail)
  return (text + tail).trim()
}

/**
 * Ask the same prompts to the base model and the adapted model. Loads one
 * model at a time so it fits on small devices.
 */
export async function compare ({ sdk, runDir, prompts, device = 'gpu', sampling, onProgress }) {
  const results = prompts.map((p) => ({ prompt: p, base: '', tuned: '' }))
  for (const [key, withAdapter] of [['base', false], ['tuned', true]]) {
    // Same sampling for both, so the only difference is the adapter.
    const { modelId, system } = await loadForChat({ sdk, runDir, withAdapter, device, sampling, onProgress })
    try {
      for (const r of results) {
        const history = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: r.prompt }]
        r[key] = await reply({ sdk, modelId, history })
      }
    } finally {
      await sdk.unloadModel({ modelId, clearStorage: false })
    }
  }
  return results
}
