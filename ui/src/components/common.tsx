import type { ReactNode } from 'react'

const PLACEHOLDER = /(\[[A-Z][A-Z0-9_]{2,}\])/

/** Text with the scrubber's [PLACEHOLDERS] highlighted. */
export function Highlighted ({ text }: { text: string }) {
  return <>{text.split(PLACEHOLDER).map((part, i) => (i % 2 ? <mark key={i} className='redacted'>{part}</mark> : part))}</>
}

export function StatusDot ({ status }: { status: string }) {
  return <span className={`dot ${statusTone(status)}`} aria-hidden='true' />
}

export function statusTone (status: string) {
  if (status === 'COMPLETED') return 'ok'
  if (status === 'training' || status === 'loading' || status === 'pausing') return 'live'
  if (status === 'PAUSED') return 'warn'
  if (status === 'FAILED' || status === 'INTERRUPTED') return 'bad'
  return 'idle'
}

export const STATUS_LABEL: Record<string, string> = {
  PREPARED: 'ready to train',
  PENDING: 'ready to train',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'trained',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  loading: 'loading model',
  training: 'training',
  pausing: 'pausing',
  UNKNOWN: 'unknown'
}

export function Card ({ title, aside, children, className = '', id }: { title: ReactNode, aside?: ReactNode, children: ReactNode, className?: string, id?: string }) {
  return (
    <section className={`card ${className}`} id={id}>
      <header className='card-h'><h2>{title}</h2>{aside}</header>
      <div className='card-b'>{children}</div>
    </section>
  )
}

export function Stat ({ label, value, hint }: { label: string, value: ReactNode, hint?: string }) {
  return (
    <div className='stat' title={hint}>
      <span className='stat-l'>{label}</span>
      <span className='stat-v'>{value}</span>
    </div>
  )
}

export const fmt = (x: number | null | undefined, d = 3) => (x == null || Number.isNaN(x) ? '–' : x.toFixed(d))
export const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`
export function duration (ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
