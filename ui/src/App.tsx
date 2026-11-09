import { useCallback, useEffect, useRef, useState } from 'react'
import { api, isActive, type Example, type RunDetails, type RunSummary } from './api'
import { useServerState } from './useServer'
import { NewRun, RunData } from './components/DataTab'
import { TrainTab } from './components/TrainTab'
import { CompareTab } from './components/CompareTab'
import { ShareTab } from './components/ShareTab'
import { ReceiveCard } from './components/ReceiveCard'
import { STATUS_LABEL, StatusDot } from './components/common'

type Tab = 'data' | 'train' | 'compare' | 'share'
const TABS: { id: Tab, label: string }[] = [
  { id: 'data', label: '1 · Data' },
  { id: 'train', label: '2 · Train' },
  { id: 'compare', label: '3 · Compare' },
  { id: 'share', label: '4 · Share' }
]

// #run/tab, so a reload (or a demo) lands on the same view.
function readHash (): { run: string | null, tab: Tab } {
  const [run, tab] = decodeURIComponent(location.hash.slice(1)).split('/')
  return { run: run || null, tab: (TABS.some((t) => t.id === tab) ? tab : 'data') as Tab }
}

/** Why a tab can't be opened for this run, or null if it can. */
function tabDisabled (tab: Tab, run: RunDetails): string | null {
  if ((tab === 'compare' || tab === 'share') && !run.hasAdapter) return 'Train this run first'
  if (tab === 'train' && run.received) return 'A received adapter comes without its training data, so it can\'t be retrained here'
  return null
}

export function App () {
  const { state, ticks, offline, refresh } = useServerState()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [examples, setExamples] = useState<Example[]>([])
  const [selected, setSelected] = useState<string | null>(() => readHash().run)
  const [tab, setTab] = useState<Tab>(() => readHash().tab)
  const [details, setDetails] = useState<RunDetails | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const toast = useCallback((msg: string) => {
    setToastMsg(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 4500)
  }, [])

  const loadRuns = useCallback(() => api.runs().then(setRuns).catch(() => {}), [])
  const loadDetails = useCallback((name: string | null) => {
    if (!name) { setDetails(null); return }
    api.run(name).then(setDetails).catch((err) => { setDetails(null); setSelected(null); toast(err.message) })
  }, [toast])

  useEffect(() => { void loadRuns(); api.examples().then(setExamples).catch(() => {}) }, [loadRuns])
  useEffect(() => { loadDetails(selected) }, [selected, loadDetails])
  useEffect(() => { history.replaceState(null, '', `#${selected ? encodeURIComponent(selected) : ''}/${tab}`) }, [selected, tab])
  // Follow hash edits and back/forward too, not only the first load.
  useEffect(() => {
    const onHash = () => { const h = readHash(); setSelected(h.run); setTab(h.tab) }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])

  // When the training job changes state (started, paused, done), refresh what's on screen.
  const jobKey = state?.job ? `${state.job.run}:${state.job.startedAt}:${state.job.status}` : ''
  const prevJobKey = useRef<string | null>(null)
  useEffect(() => {
    if (prevJobKey.current === null) {
      // First state: jump to a run that's training right now.
      if (state?.job && isActive(state.job.status) && !readHash().run) { setSelected(state.job.run); setTab('train') }
    } else if (jobKey !== prevJobKey.current) {
      void loadRuns()
      loadDetails(selected)
      const j = state?.job
      if (j?.status === 'COMPLETED') toast(`“${j.run}” is trained.`)
      if (j?.status === 'PAUSED') toast(`“${j.run}” paused. Resume any time.`)
      if (j?.status === 'FAILED') toast(`Training “${j.run}” failed: ${j.error}`)
    }
    if (state) prevJobKey.current = jobKey
  }, [jobKey, state, selected, loadRuns, loadDetails, toast])

  function select (name: string | null, nextTab: Tab = 'data') {
    setSelected(name)
    setTab(nextTab)
  }

  const run = details && details.name === selected ? details : null
  const job = state?.job
  const pill = offline
    ? { tone: 'bad', text: 'Pocket Tune isn\'t running' }
    : !state
        ? { tone: 'idle', text: 'Connecting…' }
        : job && isActive(job.status)
          ? { tone: 'live', text: `Training ${job.run}` }
          : state.busy === 'comparing'
            ? { tone: 'live', text: 'Comparing' }
            : state.qvac ? { tone: 'ok', text: `QVAC ready · ${state.device.toUpperCase()}` } : { tone: 'idle', text: 'QVAC off' }

  return (
    <div className='wrap'>
      <header className='top'>
        <div className='brand'>
          <svg viewBox='0 0 24 24' aria-hidden='true'><rect width='24' height='24' rx='6' fill='var(--accent)' /><path d='M6 15c2-5 4-7 6-7s4 2 6 7' stroke='var(--accent-ink)' strokeWidth='2' fill='none' strokeLinecap='round' /><circle cx='12' cy='16.5' r='1.6' fill='var(--accent-ink)' /></svg>
          <div><h1>Pocket Tune</h1><p>Teach a small model your voice, on this device.</p></div>
        </div>
        <span className='pill'><span className={`dot ${pill.tone}`} />{pill.text}</span>
      </header>

      {offline && <p className='warn-note'>Can't reach the local server. Start it with <code>pocket-tune ui</code>, then reload.</p>}

      <nav className='runs' aria-label='Runs'>
        <button className='chip new' aria-pressed={selected === null} onClick={() => select(null)}>+ New run</button>
        <button className='chip' onClick={() => { select(null); setTimeout(() => document.getElementById('receive')?.scrollIntoView({ behavior: 'smooth' }), 50) }} title='Paste a pear:// link someone shared'>⇣ Receive</button>
        {runs.map((r) => (
          <button key={r.name} className='chip' aria-pressed={selected === r.name} onClick={() => select(r.name, r.hasAdapter ? 'compare' : r.status === 'PAUSED' || isActive(r.status) ? 'train' : 'data')} title={STATUS_LABEL[r.status]}>
            <StatusDot status={r.status} />{r.name}
          </button>
        ))}
      </nav>

      {selected === null && state && (
        <>
          <NewRun examples={examples} runs={runs} state={state} onCreated={(d) => { void loadRuns(); setDetails(d); select(d.name, 'data'); toast(`Prepared “${d.name}”.`) }} />
          <ReceiveCard
            runs={runs}
            state={state}
            onReceived={(d) => {
              void loadRuns()
              setDetails(d)
              select(d.name, 'compare')
              toast(d.warnings[0] ?? `Received “${d.name}”, verified. Ask both models something.`)
            }}
          />
        </>
      )}

      {selected !== null && run && state && (
        <>
          <div className='tabs' role='tablist'>
            {TABS.map((t) => (
              <button
                key={t.id}
                role='tab'
                aria-selected={tab === t.id}
                className='tab'
                onClick={() => setTab(t.id)}
                disabled={tabDisabled(t.id, run) !== null}
                title={tabDisabled(t.id, run) ?? undefined}
              >{t.label}
              </button>
            ))}
            <span className='tab-meta'><StatusDot status={job?.run === run.name ? job.status : run.status} />{STATUS_LABEL[job?.run === run.name && isActive(job.status) ? job.status : run.status]}</span>
          </div>
          <div role='tabpanel'>
            {tab === 'data' && <RunData run={run} />}
            {tab === 'train' && <TrainTab run={run} state={state} ticks={ticks} toast={toast} onChanged={() => { refresh(); loadDetails(run.name); void loadRuns() }} onCompare={() => setTab('compare')} />}
            {tab === 'compare' && <CompareTab run={run} state={state} onSaved={() => loadDetails(run.name)} />}
            {tab === 'share' && <ShareTab run={run} toast={toast} />}
          </div>
        </>
      )}

      {selected !== null && !run && !offline && <p className='muted'>Loading “{selected}”…</p>}

      <footer>
        <span><b>Runs on this device.</b> Your data and the training never leave it.</span>
        <span><b>Only the adapter is shareable.</b> Its card holds hashes, never your data.</span>
        <span><a href='https://github.com/lopeselio/qvac-pocket-tune' rel='noopener noreferrer' target='_blank'>Source on GitHub</a></span>
      </footer>
      <div className={`toast ${toastMsg ? 'show' : ''}`} role='status'>{toastMsg}</div>
    </div>
  )
}
