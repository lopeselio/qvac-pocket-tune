import { useEffect, useState } from 'react'
import { api, isActive, type Job, type RunDetails, type ServerState, type Tick } from '../api'
import { LossChart } from './LossChart'
import { Card, Stat, STATUS_LABEL, duration, fmt, mb } from './common'

interface Props {
  run: RunDetails
  state: ServerState
  ticks: Tick[]
  onChanged: () => void
  onCompare: () => void
  toast: (msg: string) => void
}

export function TrainTab ({ run, state, ticks, onChanged, onCompare, toast }: Props) {
  const job = state.job?.run === run.name ? state.job : null
  const live = isActive(job?.status)
  const otherJob = state.job && state.job.run !== run.name && isActive(state.job.status) ? state.job : null
  const fresh = ['PREPARED', 'PENDING', 'FAILED', 'INTERRUPTED'].includes(run.status)

  return (
    <div className='grid two train'>
      <Card title='2 · Train on this device' aside={<span className={`tag tone-${live ? 'live' : run.status === 'COMPLETED' ? 'ok' : 'idle'}`}>{STATUS_LABEL[job?.status ?? run.status] ?? run.status}</span>}>
        {!state.qvac && <p className='warn-note'>QVAC isn't available in this session, so training is off.</p>}
        {otherJob && <p className='warn-note'>Training “{otherJob.run}” right now. One run trains at a time.</p>}
        {run.status === 'INTERRUPTED' && <p className='warn-note'>This run stopped without pausing (the process was closed or crashed). QVAC can only resume paused runs, so start it again.</p>}
        {job?.status === 'FAILED' && <p className='err' role='alert'>{job.error}</p>}

        {fresh && !live && <TrainForm run={run} state={state} disabled={!state.qvac || !!otherJob} onStarted={onChanged} toast={toast} />}
        {live && job && <LiveStatus job={job} run={run} ticks={ticks} toast={toast} onChanged={onChanged} />}
        {!live && run.status === 'PAUSED' && (
          <div className='stack'>
            <p>Paused at a checkpoint. Resuming continues from the next step with the same settings{run.hyper ? ` (${run.hyper.epochs} epochs, lr ${run.hyper.lr})` : ''}.</p>
            {run.resumable
              ? <ResumeButton run={run} disabled={!state.qvac || !!otherJob} onStarted={onChanged} toast={toast} />
              : <p className='warn-note'>No pause checkpoint found, so this run can't be resumed.</p>}
          </div>
        )}
        {!live && run.status === 'COMPLETED' && <Result run={run} job={job} onCompare={onCompare} />}
      </Card>

      <Card title='Training loss' aside={job?.resume && live ? <span className='muted small'>since resume</span> : undefined}>
        {job || ticks.length ? <LossChart ticks={job ? ticks : []} /> : <div className='chart-empty'>{run.status === 'COMPLETED' ? 'Trained in an earlier session, so there is no curve here. The final metrics are on the left.' : 'Start training to see the loss fall in real time.'}</div>}
        <p className='hint'>Loss is how surprised the model is by your answers. Falling loss means it's picking up your voice. Validation loss uses examples it never trains on, so it shows whether that carries over to new questions.</p>
      </Card>
    </div>
  )
}

function TrainForm ({ run, state, disabled, onStarted, toast }: { run: RunDetails, state: ServerState, disabled: boolean, onStarted: () => void, toast: (m: string) => void }) {
  const models = state.models.filter((m) => m.mode === run.mode)
  const [model, setModel] = useState(() => models.find((m) => m.id === 'small')?.id ?? models[0]?.id ?? 'tiny')
  const [epochs, setEpochs] = useState(3)
  const [lr, setLr] = useState(1e-4)
  const [busy, setBusy] = useState(false)

  async function start () {
    setBusy(true)
    try {
      await api.train({ run: run.name, model, epochs, lr })
      onStarted()
    } catch (err) {
      toast((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='stack'>
      <label className='field'>
        <span className='label'>Base model</span>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.phone ? '' : ' · desktop'}</option>)}
        </select>
        <span className='hint'>{run.mode === 'sft' ? 'Chat data trains an instruct model.' : 'Notes train a base model on plain text.'} Pocket Tune checks free memory before downloading anything.</span>
      </label>
      <div className='row'>
        <label className='field grow'>
          <span className='label'>Epochs</span>
          <input type='number' min={1} max={20} value={epochs} onChange={(e) => setEpochs(Number(e.target.value))} />
        </label>
        <label className='field grow'>
          <span className='label'>Learning rate</span>
          <select value={lr} onChange={(e) => setLr(Number(e.target.value))}>
            {[5e-5, 1e-4, 2e-4, 5e-4].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>
      <button className='btn primary wide' onClick={start} disabled={disabled || busy}>{busy ? 'Starting…' : 'Start training'}</button>
      <p className='hint'>You can pause at any step and resume later, even after closing the UI.</p>
    </div>
  )
}

function ResumeButton ({ run, disabled, onStarted, toast }: { run: RunDetails, disabled: boolean, onStarted: () => void, toast: (m: string) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className='btn primary wide'
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true)
        try { await api.train({ run: run.name, resume: true }); onStarted() } catch (err) { toast((err as Error).message) } finally { setBusy(false) }
      }}
    >{busy ? 'Resuming…' : 'Resume training'}
    </button>
  )
}

function LiveStatus ({ job, run, ticks, toast, onChanged }: { job: Job, run: RunDetails, ticks: Tick[], toast: (m: string) => void, onChanged: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const last = [...ticks].reverse().find((t) => t.train)
  const lastAny = ticks.at(-1)
  const epochs = run.hyper?.epochs ?? 1
  const pct = last ? Math.min(100, ((last.epoch * last.batches + last.batch) / (epochs * last.batches)) * 100) : 0

  async function pause () {
    try { await api.pause(); onChanged() } catch (err) { toast((err as Error).message) }
  }

  return (
    <div className='stack'>
      {job.fit.map((l) => <p key={l} className='fit'>✓ memory check: {l}</p>)}
      {job.status === 'loading' && (
        <div>
          <p>{job.download != null && job.download < 100 ? `Downloading the base model… ${job.download}%` : 'Loading the base model…'}</p>
          <div className='bar'><span style={{ width: `${job.download ?? 0}%` }} /></div>
        </div>
      )}
      {job.status !== 'loading' && (
        <>
          <div className='progress-head'>
            <b>{lastAny && !lastAny.train ? `Epoch ${lastAny.epoch + 1} · checking on held-out examples` : last ? `Epoch ${last.epoch + 1} of ${epochs} · step ${last.batch} of ${last.batches}` : 'Starting…'}</b>
            <span className='muted'>{pct.toFixed(0)}%</span>
          </div>
          <div className='bar live'><span style={{ width: `${pct}%` }} /></div>
          <div className='stats'>
            <Stat label='Loss' value={fmt(last?.loss)} />
            <Stat label='Accuracy' value={fmt(last?.acc)} hint='share of next tokens the model predicts exactly' />
            <Stat label='Elapsed' value={duration(now - job.startedAt)} />
            <Stat label='Epoch ETA' value={last ? duration(last.eta) : '–'} hint="QVAC's estimate for the current epoch" />
          </div>
        </>
      )}
      {job.warnings.map((w) => <p key={w} className='warn-note'>{w}</p>)}
      <button className='btn wide' onClick={pause} disabled={job.status !== 'training'}>
        {job.status === 'pausing' ? 'Pausing after this step…' : job.status === 'loading' ? 'Pause (available once training starts)' : 'Pause'}
      </button>
    </div>
  )
}

function Result ({ run, job, onCompare }: { run: RunDetails, job: Job | null, onCompare: () => void }) {
  const card = run.card
  const m = card?.metrics ?? job?.result?.metrics ?? null
  return (
    <div className='stack'>
      <div className='done-banner'>✓ Adapter trained{card ? `: ${mb(card.adapter.size)}, on top of ${card.base.name}` : ''}</div>
      <div className='stats'>
        <Stat label='Train loss' value={fmt(m?.train_loss)} />
        <Stat label='Val loss' value={fmt(m?.val_loss)} />
        <Stat label='Val accuracy' value={fmt(m?.val_accuracy)} />
      </div>
      {!m && <p className='hint'>QVAC didn't report final metrics for this run, but the adapter is complete.</p>}
      <button className='btn primary wide' onClick={onCompare}>Compare base vs tuned →</button>
      {card && (
        <details className='card-json'>
          <summary>Adapter card (<span className='mono'>adapter.json</span>)</summary>
          <p className='hint'>What gets shared with the adapter: the base model's hash, the settings and dataset hashes. Never the data itself.</p>
          <pre>{JSON.stringify(card, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}
