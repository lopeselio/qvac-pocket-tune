import { useState, type FormEvent } from 'react'
import { api, type Inspection, type RunDetails, type RunSummary, type ServerState } from '../api'
import { Card, fmt, mb } from './common'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shared'

function uniqueName (base: string, runs: RunSummary[]) {
  const taken = new Set(runs.map((r) => r.name))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

/** Paste someone's pear:// link, see what it is, then download and verify it. */
export function ReceiveCard ({ runs, state, onReceived }: { runs: RunSummary[], state: ServerState, onReceived: (d: RunDetails & { warnings: string[] }) => void }) {
  const [url, setUrl] = useState('')
  const [found, setFound] = useState<Inspection | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<'inspect' | 'receive' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function inspect (e: FormEvent) {
    e.preventDefault()
    setBusy('inspect')
    setError(null)
    setFound(null)
    try {
      const r = await api.inspect(url.trim())
      setFound(r)
      // Pre-select the adapter the link pointed at, if it named one.
      const named = r.adapters.find((a) => url.includes(`/${a.name}/`)) ?? r.adapters[0]
      choose(named.name)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function choose (adapter: string) {
    setPick(adapter)
    setName(uniqueName(slug(adapter), runs))
  }

  async function receive () {
    if (!found || !pick) return
    setBusy('receive')
    setError(null)
    try {
      onReceived(await api.receive({ url: url.trim(), adapter: pick, name }))
      setUrl('')
      setFound(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card title='Receive a shared adapter' className='receive' id='receive'>
      <form className='row' onSubmit={(e) => { void inspect(e) }}>
        <input className='grow mono' value={url} onChange={(e) => { setUrl(e.target.value); setFound(null) }} placeholder='pear://…/pirate-voice/adapter.gguf' aria-label='Shared pear:// link' />
        <button className='btn' disabled={!url.trim().startsWith('pear://') || !!busy}>{busy === 'inspect' ? 'Looking for peers…' : 'Look up'}</button>
      </form>
      <p className='hint'>
        Paste a link someone shared from their Pocket Tune. You see what it is before anything big downloads,
        and the download is checked against the publisher&apos;s SHA-256. Only use adapters from people you trust.
      </p>
      {busy === 'inspect' && <p className='muted'>Finding someone who&apos;s seeding it (up to 30 s)…</p>}
      {error && <p className='err' role='alert'>{error}</p>}

      {found && (
        <div className='section'>
          {found.own && <p className='hint'>This link is yours, so it&apos;s read from your own qvac-seed store with no network involved. Open it in a second Pocket Tune to see a real peer-to-peer download.</p>}
          <div className='picks' role='radiogroup' aria-label='Adapters in this link'>
            {found.adapters.map((a) => (
              <button type='button' key={a.name} role='radio' aria-checked={pick === a.name} className='pick' onClick={() => choose(a.name)}>
                <span className='pick-head'><b>{a.name}</b><span className='muted small'>{mb(a.size)} · sha256 {a.sha256.slice(0, 12)}…</span></span>
                {a.card
                  ? (
                    <span className='muted small'>
                      {a.card.base ?? 'unknown base'} · {a.card.mode === 'causal' ? 'plain text' : 'conversations'}
                      {a.card.trainSamples != null && ` · ${a.card.trainSamples} examples`}
                      {a.card.epochs != null && ` · ${a.card.epochs} epochs`}
                      {a.card.valLoss != null && ` · val loss ${fmt(a.card.valLoss)}`}
                    </span>
                    )
                  : <span className='muted small'>No readable card: its base model is unknown, so it can&apos;t be received.</span>}
                {a.system && <span className='quote small'>{a.system}</span>}
              </button>
            ))}
          </div>
          <label className='field'>
            <span className='label'>Save as run</span>
            <input value={name} onChange={(e) => setName(slug(e.target.value))} />
          </label>
          <button type='button' className='btn primary wide' onClick={() => { void receive() }} disabled={!pick || !name || !!busy || !state.qvac}>
            {busy === 'receive' ? 'Downloading and checking SHA-256…' : 'Download & verify'}
          </button>
          {!state.qvac && <p className='hint'>QVAC isn&apos;t available in this session, and it&apos;s needed to match the base model.</p>}
        </div>
      )}
    </Card>
  )
}
