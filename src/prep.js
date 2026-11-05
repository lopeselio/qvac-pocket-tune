import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import {
  chatToConversations, detectSourceType, notesToText, parseChatJson, parseWhatsApp, qaCsvToConversations
} from './sources.js'
import { buildCausalDataset, buildSftDataset, toJsonl } from './dataset.js'

export const PREP_FILE = 'prep.json'

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.jsonl'])

async function expand (paths) {
  const files = []
  for (const p of paths) {
    const s = await stat(p)
    if (s.isDirectory()) {
      for (const e of await readdir(p, { recursive: true })) {
        const full = join(p, e)
        if (TEXT_EXT.has(extname(e).toLowerCase()) && !e.split('/').some((seg) => seg.startsWith('.')) && (await stat(full)).isFile()) files.push(full)
      }
    } else files.push(p)
  }
  return files.sort()
}

/**
 * Read sources and write train/eval files into `outDir`.
 * Notes become a causal (plain text) dataset; chats/CSV/JSON become SFT.
 * @param {string[]} inputs files or directories
 * @param {{ outDir: string, me?: string, system?: string, type?: string, contextLength?: number,
 *           evalFraction?: number, scrubPii?: boolean, gapMinutes?: number }} opts
 */
export async function prep (inputs, opts) {
  const { outDir, me, system, type, contextLength = 512, evalFraction = 0.1, scrubPii = true, gapMinutes } = opts
  const files = await expand(inputs)
  if (!files.length) throw new Error('No readable source files found')

  const convos = []
  const docs = []
  const perFile = []
  for (const file of files) {
    const kind = type ?? detectSourceType(file)
    const text = await readFile(file, 'utf8')
    let n = 0
    if (kind === 'notes') { docs.push(notesToText(text)); n = 1 } else if (kind === 'whatsapp') {
      const c = chatToConversations(parseWhatsApp(text), { me, system, gapMinutes })
      convos.push(...c); n = c.length
    } else if (kind === 'chat-json') {
      const c = parseChatJson(text).map((x) => system && x.messages[0]?.role !== 'system'
        ? { messages: [{ role: 'system', content: system }, ...x.messages] }
        : x)
      convos.push(...c); n = c.length
    } else if (kind === 'qa-csv') {
      const c = qaCsvToConversations(text, { system })
      convos.push(...c); n = c.length
    } else {
      perFile.push({ file, kind: 'skipped', items: 0 })
      continue
    }
    perFile.push({ file, kind, items: n })
  }

  if (convos.length && docs.length) {
    throw new Error('Mixing notes (plain text) with chats/Q&A in one run is not supported: QVAC trains either SFT or causal. Prep them into separate runs.')
  }

  await mkdir(outDir, { recursive: true })
  const dir = resolve(outDir)
  const writeMeta = (mode, report) => writeFile(join(dir, PREP_FILE), JSON.stringify({
    createdAt: new Date().toISOString(), mode, system: system ?? null, files: perFile, report
  }, null, 2))
  if (convos.length) {
    const ds = buildSftDataset(convos, { contextLength, evalFraction, scrubPii })
    if (!ds.train.length) throw new Error('No usable training conversations after filtering')
    await writeFile(join(dir, 'train.jsonl'), toJsonl(ds.train))
    await writeFile(join(dir, 'eval.jsonl'), toJsonl(ds.eval))
    await writeMeta('sft', ds.report)
    return { mode: 'sft', dir, files: perFile, report: ds.report }
  }
  const ds = buildCausalDataset(docs, { evalFraction, scrubPii })
  if (!ds.report.trainParagraphs) throw new Error('No usable text after filtering')
  await writeFile(join(dir, 'train.txt'), ds.train)
  await writeFile(join(dir, 'eval.txt'), ds.eval)
  await writeMeta('causal', ds.report)
  return { mode: 'causal', dir, files: perFile, report: ds.report }
}
