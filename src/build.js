// Pure "sources in, dataset out" pipeline shared by the CLI (prep.js) and the
// mobile app. No filesystem: callers read the files and write the results.
import {
  chatToConversations, detectSourceType, notesToText, parseChatJson, parseWhatsApp, qaCsvToConversations
} from './sources.js'
import { buildCausalDataset, buildSftDataset, toJsonl } from './dataset.js'

export const DEFAULT_HYPER = {
  numberOfEpochs: 2,
  learningRate: 1e-4,
  lrMin: 1e-8,
  contextLength: 512,
  loraModules: 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down',
  checkpointSaveSteps: 25
}

/**
 * @param {{ name: string, text: string, type?: string }[]} sources
 * @param {{ me?: string, system?: string, type?: string, contextLength?: number,
 *           evalFraction?: number, scrubPii?: boolean, gapMinutes?: number }} [opts]
 * @returns {{ mode: 'sft'|'causal', files: { file: string, kind: string, items: number }[],
 *             trainText: string, evalText: string, trainName: string, evalName: string, report: object }}
 */
export function buildDatasetFromTexts (sources, opts = {}) {
  const { me, system, type, contextLength = 512, evalFraction = 0.1, scrubPii = true, gapMinutes } = opts
  if (!sources.length) throw new Error('No readable source files found')
  const convos = []
  const docs = []
  const files = []
  for (const src of sources) {
    const kind = src.type ?? type ?? detectSourceType(src.name)
    let c = null
    if (kind === 'notes') { docs.push(notesToText(src.text)); files.push({ file: src.name, kind, items: 1 }); continue }
    if (kind === 'whatsapp') c = chatToConversations(parseWhatsApp(src.text), { me, system, gapMinutes })
    else if (kind === 'chat-json') {
      c = parseChatJson(src.text).map((x) => system && x.messages[0]?.role !== 'system'
        ? { messages: [{ role: 'system', content: system }, ...x.messages] }
        : x)
    } else if (kind === 'qa-csv') c = qaCsvToConversations(src.text, { system })
    if (!c) { files.push({ file: src.name, kind: 'skipped', items: 0 }); continue }
    convos.push(...c)
    files.push({ file: src.name, kind, items: c.length })
  }

  if (convos.length && docs.length) {
    throw new Error('Mixing notes (plain text) with chats/Q&A in one run is not supported: QVAC trains either SFT or causal. Prep them into separate runs.')
  }
  if (convos.length) {
    const ds = buildSftDataset(convos, { contextLength, evalFraction, scrubPii })
    if (!ds.train.length) throw new Error('No usable training conversations after filtering')
    return { mode: 'sft', files, trainText: toJsonl(ds.train), evalText: toJsonl(ds.eval), trainName: 'train.jsonl', evalName: 'eval.jsonl', report: ds.report }
  }
  const ds = buildCausalDataset(docs, { evalFraction, scrubPii })
  if (!ds.report.trainParagraphs) throw new Error('No usable text after filtering')
  return { mode: 'causal', files, trainText: ds.train, evalText: ds.eval, trainName: 'train.txt', evalName: 'eval.txt', report: ds.report }
}

/** finetune() options for a run. Paths are plain POSIX paths (no file://). */
export function buildFinetuneOptions ({ runDir, mode, trainPath, evalPath, hasEval, hyper = {} }) {
  const { contextLength, ...rest } = { ...DEFAULT_HYPER, ...hyper }
  const dir = runDir.replace(/\/+$/, '')
  return {
    trainDatasetDir: trainPath,
    validation: hasEval ? { type: 'dataset', path: evalPath } : { type: 'none' },
    assistantLossOnly: mode === 'sft',
    contextLength,
    checkpointSaveDir: `${dir}/checkpoints`,
    outputParametersDir: dir,
    ...rest
  }
}
