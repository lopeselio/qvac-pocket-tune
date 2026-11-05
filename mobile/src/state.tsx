import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { listRuns, loadMeta, type RunMeta } from './runs'

interface RunState {
  run: RunMeta | null
  runs: RunMeta[]
  select: (name: string | null) => void
  refresh: () => void
  setRun: (meta: RunMeta) => void
}

const Ctx = createContext<RunState | null>(null)

export function RunProvider ({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<RunMeta[]>(() => safeList())
  const [run, setRunState] = useState<RunMeta | null>(() => safeList()[0] ?? null)

  const refresh = useCallback(() => {
    const all = safeList()
    setRuns(all)
    setRunState((cur) => (cur ? loadMeta(cur.name) ?? null : all[0] ?? null))
  }, [])

  const select = useCallback((name: string | null) => {
    setRunState(name ? loadMeta(name) : null)
  }, [])

  const setRun = useCallback((meta: RunMeta) => {
    setRunState(meta)
    setRuns(safeList())
  }, [])

  const value = useMemo(() => ({ run, runs, select, refresh, setRun }), [run, runs, select, refresh, setRun])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function safeList (): RunMeta[] {
  try { return listRuns() } catch { return [] }
}

export function useRuns (): RunState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useRuns must be used inside RunProvider')
  return v
}
