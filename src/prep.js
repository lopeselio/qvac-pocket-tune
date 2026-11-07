import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { buildDatasetFromTexts } from './build.js'

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
  const files = await expand(inputs)
  if (!files.length) throw new Error('No readable source files found')
  const sources = []
  for (const file of files) sources.push({ name: file, text: await readFile(file, 'utf8'), type: opts.type })
  return prepTexts(sources, opts)
}

/**
 * Same as prep(), for sources already in memory (e.g. pasted or picked in
 * the web UI). `name` is only used to detect the source type.
 * @param {{ name: string, text: string, type?: string }[]} sources
 */
export async function prepTexts (sources, opts) {
  const { outDir, me, system, contextLength = 512, evalFraction = 0.1, scrubPii = true, gapMinutes } = opts
  const ds = buildDatasetFromTexts(sources, { me, system, contextLength, evalFraction, scrubPii, gapMinutes })

  await mkdir(outDir, { recursive: true })
  const dir = resolve(outDir)
  // Re-prepping a run in the other mode would leave the old files behind, and
  // training picks train.jsonl over train.txt: remove whatever we don't write.
  for (const f of ['train.jsonl', 'eval.jsonl', 'train.txt', 'eval.txt']) {
    if (f !== ds.trainName && f !== ds.evalName) await rm(join(dir, f), { force: true })
  }
  await writeFile(join(dir, ds.trainName), ds.trainText)
  await writeFile(join(dir, ds.evalName), ds.evalText)
  await writeFile(join(dir, PREP_FILE), JSON.stringify({
    createdAt: new Date().toISOString(), mode: ds.mode, system: system ?? null, files: ds.files, report: ds.report
  }, null, 2))
  return { mode: ds.mode, dir, files: ds.files, report: ds.report }
}
