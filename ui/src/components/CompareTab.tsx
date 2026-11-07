import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type RunDetails, type ServerState, type Side } from '../api'

// Prompts that aren't in the pirate example's training data, checked against
// the Qwen3-1.7B adapter. Crypto questions with a factual answer aren't here:
// 60 examples teach a voice, not knowledge.
const SUGGESTIONS = [
  'How do I learn to cook?',
  'Should I share my private key with support?',
  'How do I learn to swim?',
  'Give me advice for a job interview',
  'Explain what a blockchain is'
]

type Stage = 'waiting' | 'loading' | 'answering' | 'done'
interface Row { id: number, prompt: string, base: string, tuned: string, stage: Record<Side, Stage>, error: string | null }

export function CompareTab ({ run, state, onSaved }: { run: RunDetails, state: ServerState, onSaved: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [asking, setAsking] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const nextId = useRef(1)

  // Questions belong to one run: show the ones saved with it. A stream in
  // flight stops when you switch away.
  useEffect(() => {
    setRows(run.history.map((h) => ({ id: nextId.current++, prompt: h.prompt, base: h.base, tuned: h.tuned, stage: { base: 'done', tuned: 'done' }, error: null })))
    return () => abort.current?.abort()
    // Only when the run changes, not on every details refresh.
  }, [run.name])

  const blocked = state.busy === 'training' ? 'Training is running. Compare when it finishes or after pausing.' : !run.hasAdapter ? 'Train this run first.' : !state.qvac ? "QVAC isn't available in this session." : null
  const warm = state.chat.run === run.name && state.chat.loaded.length === 2

  async function ask (text: string) {
    const q = text.trim()
    if (!q || asking || blocked) return
    const id = nextId.current++
    const update = (fn: (r: Row) => Row) => setRows((rs) => rs.map((r) => (r.id === id ? fn(r) : r)))
    setRows((rs) => [{ id, prompt: q, base: '', tuned: '', stage: { base: 'waiting', tuned: 'waiting' }, error: null }, ...rs])
    setPrompt('')
    setAsking(true)
    const ac = new AbortController()
    abort.current = ac
    try {
      await api.compare(run.name, q, (e) => {
        if (e.type === 'stage') update((r) => ({ ...r, stage: { ...r.stage, [e.side]: e.stage } }))
        else if (e.type === 'delta') update((r) => ({ ...r, [e.side]: r[e.side] + e.text }))
        else if (e.type === 'answer') update((r) => ({ ...r, [e.side]: e.text, stage: { ...r.stage, [e.side]: 'done' } }))
        else if (e.type === 'error') update((r) => ({ ...r, error: e.message }))
      }, ac.signal)
      // The server saved it: refresh the run so it's there after a tab switch.
      onSaved()
    } catch (err) {
      if (!ac.signal.aborted) update((r) => ({ ...r, error: (err as Error).message }))
    } finally {
      setAsking(false)
    }
  }

  function submit (e: FormEvent) { e.preventDefault(); void ask(prompt) }

  return (
    <div className='compare'>
      <form className='ask card' onSubmit={submit}>
        <div className='card-b'>
          <div className='row'>
            <input className='grow' value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder='Ask both models the same question…' aria-label='Prompt' maxLength={2000} disabled={!!blocked} />
            <button className='btn primary' disabled={!!blocked || asking || !prompt.trim()}>{asking ? 'Answering…' : 'Ask both'}</button>
          </div>
          <div className='chips'>
            {SUGGESTIONS.map((s) => <button key={s} type='button' className='chip' onClick={() => void ask(s)} disabled={!!blocked || asking}>{s}</button>)}
          </div>
          <p className='hint'>
            {blocked ?? (
              <>Both get the same system prompt and the same sampling (temperature 0.3, seed 42), so the adapter is the only difference.
                {!warm && ' The first question loads both models, which takes a few seconds.'}
              </>
            )}
          </p>
        </div>
      </form>

      {rows.length === 0 && !blocked && <div className='empty'>Pick a suggestion or ask your own question. Ones that aren't in the training data show what the adapter learned best.</div>}

      {rows.map((r) => (
        <article className='qa' key={r.id}>
          <h3 className='q'>❯ {r.prompt}</h3>
          {r.error && <p className='err' role='alert'>{r.error}</p>}
          <div className='grid two'>
            <Answer label='Base model' text={r.base} stage={r.stage.base} />
            <Answer label={`Tuned · ${run.name}`} text={r.tuned} stage={r.stage.tuned} tuned />
          </div>
        </article>
      ))}
    </div>
  )
}

function Answer ({ label, text, stage, tuned = false }: { label: string, text: string, stage: Stage, tuned?: boolean }) {
  const status = stage === 'loading' ? 'loading model…' : stage === 'waiting' ? 'waiting…' : null
  return (
    <div className={`answer ${tuned ? 'tuned' : ''}`} aria-live='polite'>
      <span className='answer-l'>{label}</span>
      <p>
        {text}
        {stage === 'answering' && <span className='caret' aria-hidden='true' />}
        {status && !text && <span className='muted'>{status}</span>}
        {stage === 'done' && !text && <span className='muted'>No answer. The model used its whole reply budget without producing one.</span>}
      </p>
    </div>
  )
}
