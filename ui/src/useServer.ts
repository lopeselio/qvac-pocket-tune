import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isActive, type ServerState, type Tick } from './api'

/**
 * Polls /api/state. Progress ticks are fetched incrementally (?since=n) and
 * accumulated per job, so a long run doesn't resend thousands of points.
 */
export function useServerState () {
  const [state, setState] = useState<ServerState | null>(null)
  const [ticks, setTicks] = useState<Tick[]>([])
  const [offline, setOffline] = useState(false)
  const job = useRef<{ key: number | null, count: number }>({ key: null, count: 0 })
  const kick = useRef<() => void>(() => {})

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let again = false
    const poll = async () => {
      // One request at a time, or the same ticks would be appended twice.
      if (inFlight) { again = true; return }
      inFlight = true
      clearTimeout(timer)
      let next = 2500
      try {
        let s = await api.state(job.current.count)
        if ((s.job?.startedAt ?? null) !== job.current.key) {
          // A new job: start its ticks from scratch.
          if (job.current.count) s = await api.state(0)
          job.current = { key: s.job?.startedAt ?? null, count: 0 }
          setTicks([])
        }
        if (s.job && s.job.ticks.length) {
          const fresh = s.job.ticks
          setTicks((t) => [...t, ...fresh])
        }
        job.current.count = s.job?.tickCount ?? 0
        if (!stopped) { setState(s); setOffline(false) }
        if (isActive(s.job?.status) || s.busy) next = 700
      } catch {
        if (!stopped) setOffline(true)
      }
      inFlight = false
      if (again) { again = false; next = 0 }
      if (!stopped) timer = setTimeout(poll, next)
    }
    kick.current = () => { void poll() }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [])

  const refresh = useCallback(() => kick.current(), [])
  return { state, ticks, offline, refresh }
}
