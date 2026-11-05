import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { RUN_FILE, findAdapter } from './train.js'

/** Load the run's base model, optionally with its adapter applied. */
export async function loadForChat ({ sdk, runDir, withAdapter = true, device = 'gpu', onProgress }) {
  runDir = resolve(runDir)
  const run = JSON.parse(await readFile(join(runDir, RUN_FILE), 'utf8'))
  const adapter = withAdapter ? await findAdapter(runDir) : null
  if (withAdapter && !adapter) throw new Error(`No adapter in ${runDir} yet. Train first.`)
  const modelId = await sdk.loadModel({
    modelSrc: run.model.src,
    ...(typeof run.model.src === 'string' ? { modelType: 'llm' } : {}),
    modelConfig: { device, ctx_size: Math.max(2048, run.options.contextLength), ...(adapter ? { lora: adapter } : {}) },
    onProgress
  })
  return { modelId, run, adapter, system: systemPromptFromRun(run) }
}

/** Reuse the system prompt the adapter was trained with, if any. */
export function systemPromptFromRun (run) {
  return run.system || null
}

/**
 * Streaming filter that hides <think>…</think> blocks (Qwen3 reasons by
 * default) so output reads like the trained voice. Handles tags split
 * across token deltas by holding back a possible partial tag.
 */
export class ThinkFilter {
  constructor () { this.buf = ''; this.inThink = false }

  push (delta) {
    this.buf += delta
    let out = ''
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>')
        if (end === -1) { this.buf = this.buf.slice(-7); return out }
        this.buf = this.buf.slice(end + 8)
        this.inThink = false
      } else {
        const start = this.buf.indexOf('<think>')
        if (start === -1) {
          // Keep a trailing "<thi" in case the tag continues in the next delta.
          const hold = partialTagSuffix(this.buf, '<think>')
          out += this.buf.slice(0, this.buf.length - hold)
          this.buf = this.buf.slice(this.buf.length - hold)
          return out
        }
        out += this.buf.slice(0, start)
        this.buf = this.buf.slice(start + 7)
        this.inThink = true
      }
    }
  }

  flush () {
    const rest = this.inThink ? '' : this.buf
    this.buf = ''
    return rest
  }
}

function partialTagSuffix (s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n
  }
  return 0
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
export async function compare ({ sdk, runDir, prompts, device = 'gpu', onProgress }) {
  const results = prompts.map((p) => ({ prompt: p, base: '', tuned: '' }))
  for (const [key, withAdapter] of [['base', false], ['tuned', true]]) {
    const { modelId, system } = await loadForChat({ sdk, runDir, withAdapter, device, onProgress })
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
