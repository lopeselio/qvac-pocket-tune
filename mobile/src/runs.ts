import { Directory, File, Paths } from 'expo-file-system'
import { safeRunName, toPosix } from './paths'

export { safeRunName, toPosix }

// Each run lives in <Documents>/runs/<name>/ with the same layout as the CLI:
// train.jsonl|train.txt, eval.*, run.json, checkpoints/, trained-lora-adapter.gguf

export type RunMode = 'sft' | 'causal'

export interface RunMeta {
  version: 1
  name: string
  createdAt: string
  mode: RunMode
  system: string | null
  trainName: string
  evalName: string
  report: Record<string, unknown>
  model?: string // SDK constant name
  status?: 'PENDING' | 'RUNNING' | 'PAUSED' | 'CANCELLED' | 'COMPLETED' | 'FAILED'
  options?: Record<string, unknown>
  stats?: Record<string, number> | null
  adapter?: string | null
  updatedAt?: string
}

export function runsRoot (): Directory {
  const d = new Directory(Paths.document, 'runs')
  if (!d.exists) d.create({ intermediates: true })
  return d
}

export function runDir (name: string): Directory {
  const d = new Directory(runsRoot(), safeRunName(name))
  if (!d.exists) d.create({ intermediates: true })
  return d
}

function writeText (dir: Directory, name: string, text: string) {
  const f = new File(dir, name)
  if (f.exists) f.delete()
  f.create()
  f.write(text)
  return f
}

export function saveDataset (name: string, ds: { mode: RunMode, trainText: string, evalText: string, trainName: string, evalName: string, report: object }, system: string | null): RunMeta {
  const dir = runDir(name)
  // A fresh dataset invalidates any earlier training in this run.
  for (const item of dir.list()) item.delete()
  writeText(dir, ds.trainName, ds.trainText)
  writeText(dir, ds.evalName, ds.evalText)
  const meta: RunMeta = {
    version: 1,
    name: safeRunName(name),
    createdAt: new Date().toISOString(),
    mode: ds.mode,
    system,
    trainName: ds.trainName,
    evalName: ds.evalName,
    report: ds.report as Record<string, unknown>,
    status: 'PENDING'
  }
  saveMeta(meta)
  return meta
}

export function saveMeta (meta: RunMeta) {
  writeText(runDir(meta.name), 'run.json', JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, 2))
}

export function loadMeta (name: string): RunMeta | null {
  const f = new File(runDir(name), 'run.json')
  if (!f.exists) return null
  try { return JSON.parse(f.textSync()) as RunMeta } catch { return null }
}

export function listRuns (): RunMeta[] {
  const out: RunMeta[] = []
  for (const item of runsRoot().list()) {
    if (item instanceof Directory) {
      const m = loadMeta(item.name)
      if (m) out.push(m)
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
}

export function runPaths (meta: RunMeta) {
  const dir = runDir(meta.name)
  const evalFile = new File(dir, meta.evalName)
  return {
    dir: toPosix(dir.uri),
    train: toPosix(new File(dir, meta.trainName).uri),
    eval: toPosix(evalFile.uri),
    hasEval: evalFile.exists && (evalFile.size ?? 0) > 0
  }
}

/** Newest .gguf directly in the run directory (QVAC writes trained-lora-adapter.gguf). */
export function findAdapter (meta: RunMeta): { path: string, size: number } | null {
  const ggufs = runDir(meta.name).list().filter((i): i is File => i instanceof File && i.name.endsWith('.gguf'))
  if (!ggufs.length) return null
  ggufs.sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0))
  return { path: toPosix(ggufs[0].uri), size: ggufs[0].size ?? 0 }
}

export function deleteRun (name: string) {
  const d = runDir(name)
  if (d.exists) d.delete()
}
