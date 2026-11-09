import { useEffect, useRef, useState } from 'react'
import { api, type RunDetails, type ShareLink, type ShareState } from '../api'
import { Card, fmt, mb, Stat } from './common'

/** "QWEN3_600M_INST_Q4" → "QWEN3 600M" */
export const baseLabel = (name: string) => name.replace(/_INST_Q4$|_Q4_0$|_BASE_TQ2_0$/, '').replace(/_/g, ' ')

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)

/** Publish this run's adapter over qvac-seed and hand out the pear:// links. */
export function ShareTab ({ run, toast }: { run: RunDetails, toast: (m: string) => void }) {
  const [share, setShare] = useState<ShareState | null>(null)
  const [name, setName] = useState(() => slug(run.name) || 'my-adapter')
  const [withSystem, setWithSystem] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const touched = useRef(false)

  // The peer count changes as friends connect, so keep it fresh while open.
  useEffect(() => {
    let live = true
    const load = () => api.share().then((s) => {
      if (!live) return
      setShare(s)
      // Default to the name this run was already shared under, once.
      const existing = s.links.find((l) => l.meta.run === run.name)
      if (existing && !touched.current) { touched.current = true; setName(existing.name) }
    }).catch((err) => { if (live) setError((err as Error).message) })
    void load()
    const t = setInterval(load, 3000)
    return () => { live = false; clearInterval(t) }
  }, [run.name])

  async function publish () {
    setBusy(true)
    setError(null)
    try {
      setShare(await api.publish({ run: run.name, name, includeSystem: withSystem && !!run.system }))
      toast(`Sharing “${name}”. Copy the link below.`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleSeeding () {
    if (!share) return
    setBusy(true)
    setError(null)
    try { setShare(await api.seeding(!share.seeding)) } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  const card = run.card
  const mine = share?.links.find((l) => l.name === name)
  return (
    <div className='grid two'>
      <Card title='Share this adapter'>
        <p>
          Publishes <b>only the adapter</b>{card ? ` (${mb(card.adapter.size)})` : ''} and its card over <a href='https://github.com/lopeselio/qvac-seed' target='_blank' rel='noopener noreferrer'>qvac-seed</a>.
          Anyone with the link can download it from this computer while it&apos;s seeding: no server, no account.
          Your training data never leaves this machine.
        </p>
        {card && (
          <div className='stats'>
            <Stat label='Base' value={baseLabel(card.base.name)} />
            <Stat label='Epochs' value={String(card.hyperparameters.numberOfEpochs ?? '–')} />
            <Stat label='Val loss' value={fmt(card.metrics?.val_loss)} />
          </div>
        )}
        <label className='field'>
          <span className='label'>Share name</span>
          <input value={name} onChange={(e) => { touched.current = true; setName(slug(e.target.value)) }} placeholder='pirate-voice' />
          <span className='hint'>Becomes part of the link: <span className='mono'>pear://…/{name || 'name'}/adapter.gguf</span></span>
        </label>
        {run.system && (
          <div className='field'>
            <label className='check'>
              <input type='checkbox' checked={withSystem} onChange={(e) => setWithSystem(e.target.checked)} />
              Include the system prompt, so others get the same voice
            </label>
            <p className='quote'>{run.system}</p>
          </div>
        )}
        {error && <p className='err' role='alert'>{error}</p>}
        <button type='button' className='btn primary wide' onClick={() => { void publish() }} disabled={busy || !name || !run.hasAdapter}>
          {busy ? 'Publishing…' : mine ? 'Publish again' : 'Publish & seed'}
        </button>
        <p className='hint'>Peers you connect to can see your IP address. Only share adapters trained on data you&apos;d be happy to publish.</p>
      </Card>

      <Card
        title='Your links'
        aside={share && (
          <span className='pill'>
            <span className={`dot ${share.seeding ? 'live' : 'idle'}`} />
            {share.seeding ? `Seeding · ${share.peers} peer${share.peers === 1 ? '' : 's'}` : 'Not seeding'}
          </span>
        )}
      >
        {!share && !error && <p className='muted'>Opening your qvac-seed store…</p>}
        {share && share.links.length === 0 && <p className='hint'>Nothing shared yet. Publish this adapter to get a pear:// link.</p>}
        {share?.links.map((l) => <LinkRow key={l.name} link={l} current={l.name === name} toast={toast} />)}
        {share && share.links.length > 0 && (
          <>
            <button type='button' className='btn' onClick={() => { void toggleSeeding() }} disabled={busy}>
              {share.seeding ? 'Stop seeding' : 'Start seeding'}
            </button>
            <div className='section'>
              <h3>How a friend opens it</h3>
              <p className='hint'>In their Pocket Tune: <b>+ New run → Receive a shared adapter</b>, paste the adapter link, check what it is, then download it. It's checked against your SHA-256 and lands on Compare.</p>
              <p className='hint'>Or from a terminal: <span className='mono'>npx qvac-seed fetch &lt;adapter link&gt; -o adapter.gguf</span></p>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

function LinkRow ({ link, current, toast }: { link: ShareLink, current: boolean, toast: (m: string) => void }) {
  async function copy (text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast(`Copied the ${what} link.`)
    } catch {
      toast('Copy failed: select the link and copy it by hand.')
    }
  }
  return (
    <div className={`share-link ${current ? 'current' : ''}`}>
      <div className='share-head'>
        <b>{link.name}</b>
        <span className='muted small'>{mb(link.size)} · sha256 {link.sha256.slice(0, 12)}…{link.meta.system ? ' · with system prompt' : ''}</span>
      </div>
      <div className='share-url'>
        <span className='mono' title={link.adapterUrl}>{link.adapterUrl}</span>
        <button type='button' className='btn small-btn' onClick={() => { void copy(link.adapterUrl, 'adapter') }}>Copy</button>
      </div>
      <div className='share-url'>
        <span className='mono muted' title={link.cardUrl}>{link.cardUrl}</span>
        <button type='button' className='btn small-btn' onClick={() => { void copy(link.cardUrl, 'card') }}>Copy</button>
      </div>
    </div>
  )
}
