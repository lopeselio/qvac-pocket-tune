import { createHash } from 'node:crypto'
import { scrub } from './scrub.js'

// Rough token estimate (~4 chars/token for English BPE vocabularies). Only
// used to drop samples that would be truncated by the training context.
export const approxTokens = (s) => Math.ceil(s.length / 4)

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const hashOf = (s) => createHash('sha256').update(s).digest('hex')

/** Deterministic bucket in [0,1) so the same sample always lands in the same split. */
function bucket (key, seed) {
  const h = createHash('sha256').update(seed + ':' + key).digest()
  return h.readUInt32BE(0) / 0x1_0000_0000
}

/**
 * Clean, dedupe, size-filter and split SFT conversations.
 * @param {{ messages: { role: string, content: string }[] }[]} conversations
 * @param {{ contextLength?: number, evalFraction?: number, scrubPii?: boolean, seed?: string, minEval?: number }} [opts]
 */
export function buildSftDataset (conversations, opts = {}) {
  const { contextLength = 512, evalFraction = 0.1, scrubPii = true, seed = 'pocket-tune', minEval = 1 } = opts
  const report = { input: conversations.length, duplicates: 0, tooLong: 0, empty: 0, redactions: {} }
  const seen = new Set()
  const kept = []

  for (const convo of conversations) {
    const messages = convo.messages.map((m) => {
      if (!scrubPii) return { ...m }
      const { text, counts } = scrub(m.content)
      for (const [k, v] of Object.entries(counts)) report.redactions[k] = (report.redactions[k] ?? 0) + v
      return { role: m.role, content: text }
    })
    if (!messages.some((m) => m.role === 'assistant' && m.content.trim())) { report.empty++; continue }
    const key = hashOf(messages.map((m) => `${m.role}:${norm(m.content)}`).join('\n'))
    if (seen.has(key)) { report.duplicates++; continue }
    seen.add(key)
    // Chat templates add ~8 tokens of overhead per message.
    const tokens = messages.reduce((n, m) => n + approxTokens(m.content) + 8, 0)
    if (tokens > contextLength) { report.tooLong++; continue }
    kept.push({ key, sample: { messages } })
  }

  const train = []
  const evalSet = []
  for (const k of kept) (bucket(k.key, seed) < evalFraction ? evalSet : train).push(k.sample)
  // Make sure validation isn't empty on small personal datasets.
  while (evalFraction > 0 && evalSet.length < minEval && train.length > minEval) evalSet.push(train.pop())

  return { train, eval: evalSet, report: { ...report, train: train.length, eval: evalSet.length } }
}

/**
 * Causal (plain-text) corpus: scrub, drop duplicate paragraphs, split by paragraph.
 * @param {string[]} documents
 */
export function buildCausalDataset (documents, opts = {}) {
  const { evalFraction = 0.1, scrubPii = true, seed = 'pocket-tune' } = opts
  const report = { input: documents.length, duplicates: 0, redactions: {} }
  const seen = new Set()
  const train = []
  const evalSet = []
  for (const doc of documents) {
    for (const para of doc.split(/\n{2,}/)) {
      let text = para.trim()
      if (text.length < 20) continue
      if (scrubPii) {
        const r = scrub(text)
        text = r.text
        for (const [k, v] of Object.entries(r.counts)) report.redactions[k] = (report.redactions[k] ?? 0) + v
      }
      const key = hashOf(norm(text))
      if (seen.has(key)) { report.duplicates++; continue }
      seen.add(key)
      ;(bucket(key, seed) < evalFraction ? evalSet : train).push(text)
    }
  }
  return {
    train: train.join('\n\n') + '\n',
    eval: evalSet.join('\n\n') + (evalSet.length ? '\n' : ''),
    report: { ...report, trainParagraphs: train.length, evalParagraphs: evalSet.length }
  }
}

export const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')

/** Stable fingerprint of the training data, recorded in the adapter card. */
export const datasetFingerprint = (...parts) => hashOf(parts.join('\u0000'))
