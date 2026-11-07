// Typed client for the local Pocket Tune server (src/ui-server.js).

export type RunStatus = 'PREPARED' | 'PENDING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'loading' | 'training' | 'pausing' | 'UNKNOWN'
export type JobStatus = 'loading' | 'training' | 'pausing' | 'PAUSED' | 'COMPLETED' | 'FAILED'

export interface Tick { train: boolean, epoch: number, batch: number, batches: number, step: number, loss: number | null, acc: number | null, eta: number }

export interface Job {
  kind: 'train'
  run: string
  resume: boolean
  /** Resumed in this session: ticks from before the pause are included. */
  carried: boolean
  model: string
  status: JobStatus
  fit: string[]
  download: number | null
  warnings: string[]
  error: string | null
  result: { size: number, metrics: Record<string, number> | null } | null
  startedAt: number
  endedAt: number | null
  tickCount: number
  ticks: Tick[]
}

export interface ModelPreset { id: string, label: string, mode: 'sft' | 'causal', phone: boolean }

export interface ServerState {
  qvac: boolean
  device: 'gpu' | 'cpu'
  runsDir: string
  busy: 'training' | 'comparing' | 'transcribing' | null
  job: Job | null
  chat: { run: string | null, loaded: ('base' | 'tuned')[] }
  stt: { loaded: string | null, models: { id: string, label: string }[] }
  models: ModelPreset[]
}

export interface RunSummary { name: string, mode: 'sft' | 'causal' | null, status: RunStatus, model: string | null, hasAdapter: boolean, updatedAt: string }

export interface Message { role: 'user' | 'assistant' | 'system', content: string }
export type PreviewItem = { messages: Message[] } | { text: string }

export interface PrepReport {
  train?: number
  eval?: number
  duplicates: number
  tooLong?: number
  empty?: number
  trainParagraphs?: number
  evalParagraphs?: number
  redactions: Record<string, number>
}

export interface AdapterCard {
  format: string
  createdAt: string
  base: { name: string, registryPath?: string, sha256?: string }
  mode: string
  hyperparameters: Record<string, unknown>
  dataset: Record<string, { sha256: string, samples: number }>
  metrics: Record<string, number> | null
  adapter: { file: string, size: number, sha256: string }
}

export interface RunDetails {
  name: string
  mode: 'sft' | 'causal'
  status: RunStatus
  system: string | null
  prep: { files: { file: string, kind: string, items: number }[], report: PrepReport } | null
  model: string | null
  hyper: { epochs: number, lr: number } | null
  resumable: boolean
  card: AdapterCard | null
  hasAdapter: boolean
  preview: PreviewItem[]
  /** The saved loss curve (runs/<name>/progress.jsonl), downsampled. */
  curve: Tick[]
  /** Saved comparisons (runs/<name>/compare.jsonl), newest first. */
  history: { at: string, prompt: string, base: string, tuned: string }[]
}

export interface Source { name: string, text: string, type?: string }
export interface Example { id: string, label: string, note: string, me: string | null, system: string | null, sources: Source[] }

export type CompareEvent =
  | { type: 'stage', side: Side, stage: 'loading' | 'answering' }
  | { type: 'delta', side: Side, text: string }
  | { type: 'answer', side: Side, text: string }
  | { type: 'done' }
  | { type: 'error', message: string }
export type Side = 'base' | 'tuned'

async function request<T> (path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body as T
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const api = {
  state: (since = 0) => request<ServerState>(`/api/state?since=${since}`),
  runs: () => request<RunSummary[]>('/api/runs'),
  run: (name: string) => request<RunDetails>(`/api/runs/${encodeURIComponent(name)}`),
  examples: () => request<Example[]>('/api/examples'),
  prep: (body: { name: string, sources: Source[], me?: string, system?: string, scrub: boolean, evalFraction: number }) => post<RunDetails>('/api/prep', body),
  train: (body: { run: string, model?: string, epochs?: number, lr?: number, resume?: boolean }) => post<Job>('/api/train', body),
  pause: () => post<Job>('/api/pause', {}),
  /** Speech-to-text on this machine. `audio` is base64 16 kHz mono WAV. */
  transcribe: (audio: string, model: string) => post<{ text: string, ms: number, model: string }>('/api/transcribe', { audio, model }),

  /** Streams NDJSON events until the comparison finishes. */
  async compare (run: string, prompt: string, onEvent: (e: CompareEvent) => void, signal?: AbortSignal) {
    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run, prompt }),
      signal
    })
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) onEvent(JSON.parse(line) as CompareEvent)
      }
    }
  }
}

export const isActive = (s: RunStatus | JobStatus | undefined) => s === 'loading' || s === 'training' || s === 'pausing'
