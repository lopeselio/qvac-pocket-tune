import { useState, type ChangeEvent, type FormEvent } from 'react'
import { api, type Example, type RunDetails, type RunSummary, type ServerState, type Source } from '../api'
import { VoiceInput } from './VoiceInput'
import { Card, Highlighted, Stat } from './common'

const TYPES = [
  { id: '', label: 'Detect from file name' },
  { id: 'whatsapp', label: 'WhatsApp export' },
  { id: 'qa-csv', label: 'Q&A CSV' },
  { id: 'chat-json', label: 'Chat JSON / JSONL' },
  { id: 'notes', label: 'Notes (plain text)' }
]

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run'

const csvField = (s: string) => `"${s.replace(/"/g, '""')}"`

/** Spoken answers and notes, as the sources prep already understands. */
function voiceSources (qa: { q: string, a: string }[], notes: string[]): Source[] {
  const out: Source[] = []
  if (qa.length) out.push({ name: 'voice-answers.csv', type: 'qa-csv', text: ['question,answer', ...qa.map((x) => `${csvField(x.q)},${csvField(x.a)}`)].join('\n') + '\n' })
  if (notes.length) out.push({ name: 'voice-notes.txt', type: 'notes', text: notes.join('\n\n') })
  return out
}

function uniqueName (base: string, runs: RunSummary[]) {
  const taken = new Set(runs.map((r) => r.name))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

export function NewRun ({ examples, runs, state, onCreated }: { examples: Example[], runs: RunSummary[], state: ServerState, onCreated: (d: RunDetails) => void }) {
  const [name, setName] = useState('')
  const [sources, setSources] = useState<Source[]>([])
  const [voiceQA, setVoiceQA] = useState<{ q: string, a: string }[]>([])
  const [voiceNotes, setVoiceNotes] = useState<string[]>([])
  const [me, setMe] = useState('')
  const [system, setSystem] = useState('')
  const [scrub, setScrub] = useState(true)
  const [evalFraction, setEvalFraction] = useState(0.1)
  const [paste, setPaste] = useState('')
  const [pasteType, setPasteType] = useState('qa-csv')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function applyExample (ex: Example) {
    setSources(ex.sources)
    setMe(ex.me ?? '')
    setSystem(ex.system ?? '')
    setName(uniqueName(ex.id, runs))
    setError(null)
  }

  async function pickFiles (e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])]
    const read = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
    setSources((s) => [...s, ...read])
    if (!name && files[0]) setName(uniqueName(slug(files[0].name.replace(/\.[^.]+$/, '')), runs))
    e.target.value = ''
  }

  function addPaste () {
    if (!paste.trim()) return
    setSources((s) => [...s, { name: `pasted-${s.length + 1}`, text: paste, type: pasteType }])
    setPaste('')
  }

  async function submit (e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const all = [...sources, ...voiceSources(voiceQA, voiceNotes)]
      onCreated(await api.prep({ name, sources: all, me: me || undefined, system: system || undefined, scrub, evalFraction }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const bytes = sources.reduce((n, s) => n + s.text.length, 0)
  const spoken = voiceQA.length + voiceNotes.length
  const ensureName = () => { if (!name) setName(uniqueName('my-voice', runs)) }

  return (
    <form className='grid two' onSubmit={submit}>
      <Card title='1 · Your data'>
        {examples.length > 0 && (
          <div className='field'>
            <span className='label'>Start from an example</span>
            <div className='chips'>
              {examples.map((ex) => (
                <button type='button' key={ex.id} className='chip' onClick={() => applyExample(ex)} title={ex.note}>{ex.label}</button>
              ))}
            </div>
          </div>
        )}

        <div className='field'>
          <span className='label'>Or add your own files</span>
          <label className='drop'>
            <input type='file' multiple accept='.txt,.csv,.json,.jsonl,.md,.markdown' onChange={pickFiles} />
            <span><b>Choose files</b>: WhatsApp export, Q&A CSV, chat JSON or notes</span>
          </label>
          <p className='hint'>Files are read by this page and sent to the Pocket Tune process on this computer. Nothing goes online.</p>
        </div>

        <details className='field'>
          <summary>🎙 Speak instead</summary>
          <VoiceInput
            state={state}
            onAnswer={(q, a) => { setVoiceQA((v) => [...v, { q, a }]); ensureName() }}
            onNote={(text) => { setVoiceNotes((v) => [...v, text]); ensureName() }}
          />
        </details>

        <details className='field'>
          <summary>Paste text instead</summary>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'question,answer\nhi,ahoy matey'} rows={5} />
          <div className='row'>
            <select value={pasteType} onChange={(e) => setPasteType(e.target.value)} aria-label='Pasted text type'>
              {TYPES.filter((t) => t.id).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <button type='button' className='btn' onClick={addPaste} disabled={!paste.trim()}>Add</button>
          </div>
        </details>

        {spoken > 0 && (
          <ul className='sources spoken'>
            {voiceQA.map((x, i) => (
              <li key={`qa${i}`}>
                <span><b>{x.q}</b><br /><span className='muted'>{x.a}</span></span>
                <span className='tag'>spoken answer</span>
                <button type='button' className='icon-btn' aria-label='Remove this answer' onClick={() => setVoiceQA((v) => v.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
            {voiceNotes.map((n, i) => (
              <li key={`n${i}`}>
                <span className='muted'>{n}</span>
                <span className='tag'>spoken note</span>
                <button type='button' className='icon-btn' aria-label='Remove this note' onClick={() => setVoiceNotes((v) => v.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
            {voiceQA.length > 0 && voiceQA.length < 20 && <li className='hint'>{voiceQA.length} spoken answer{voiceQA.length > 1 ? 's' : ''}. Around 20 or more starts to give a recognisable voice.</li>}
          </ul>
        )}

        {sources.length > 0 && (
          <ul className='sources'>
            {sources.map((s, i) => (
              <li key={i}>
                <span className='mono'>{s.name}</span>
                <select
                  value={s.type ?? ''}
                  aria-label={`Type of ${s.name}`}
                  onChange={(e) => setSources((all) => all.map((x, j) => (j === i ? { ...x, type: e.target.value || undefined } : x)))}
                >
                  {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <button type='button' className='icon-btn' aria-label={`Remove ${s.name}`} onClick={() => setSources((all) => all.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
            <li className='hint'>{sources.length} source{sources.length > 1 ? 's' : ''}, {(bytes / 1024).toFixed(1)} KB</li>
          </ul>
        )}
      </Card>

      <Card title='Settings'>
        <label className='field'>
          <span className='label'>Run name</span>
          <input value={name} onChange={(e) => setName(slug(e.target.value))} placeholder='pirate-voice' required pattern='[a-z0-9][a-z0-9_\-]{0,47}' />
        </label>
        <label className='field'>
          <span className='label'>Your name in the chat <span className='opt'>(WhatsApp)</span></span>
          <input value={me} onChange={(e) => setMe(e.target.value)} placeholder='Alex' />
          <span className='hint'>Your messages become the answers the model learns to give.</span>
        </label>
        <label className='field'>
          <span className='label'>System prompt <span className='opt'>(optional)</span></span>
          <textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={2} placeholder='You are a helpful assistant.' />
          <span className='hint'>Kept neutral on purpose: the voice should come from the adapter, not the prompt.</span>
        </label>
        <div className='row row-wrap'>
          <label className='check'>
            <input type='checkbox' checked={scrub} onChange={(e) => setScrub(e.target.checked)} />
            Scrub secrets and identifiers
          </label>
          <label className='inline'>
            Eval split
            <select value={evalFraction} onChange={(e) => setEvalFraction(Number(e.target.value))}>
              {[0, 0.1, 0.2].map((v) => <option key={v} value={v}>{v * 100}%</option>)}
            </select>
          </label>
        </div>
        {!scrub && <p className='warn-note'>Without scrubbing, emails, keys and seed phrases can end up memorised in the adapter.</p>}
        {error && <p className='err' role='alert'>{error}</p>}
        <button className='btn primary wide' disabled={busy || (!sources.length && !spoken) || !name}>{busy ? 'Preparing…' : 'Prepare dataset'}</button>
      </Card>
    </form>
  )
}

export function RunData ({ run }: { run: RunDetails }) {
  const rep = run.prep?.report
  const redactions = Object.entries(rep?.redactions ?? {})
  return (
    <div className='grid two'>
      <Card title='Dataset'>
        {rep
          ? (
            <>
              <div className='stats'>
                {run.mode === 'sft'
                  ? <><Stat label='Train' value={rep.train} /><Stat label='Eval' value={rep.eval} /><Stat label='Dropped' value={(rep.duplicates ?? 0) + (rep.tooLong ?? 0) + (rep.empty ?? 0)} hint='duplicates, too long for the context, or empty' /></>
                  : <><Stat label='Train paragraphs' value={rep.trainParagraphs} /><Stat label='Eval' value={rep.evalParagraphs} /><Stat label='Duplicates' value={rep.duplicates} /></>}
              </div>
              <div className='section'>
                <h3>Scrubbed before training</h3>
                {redactions.length
                  ? <div className='chips'>{redactions.map(([k, n]) => <span key={k} className='tag redacted'>{n} × {k}</span>)}</div>
                  : <p className='hint'>Nothing sensitive found.</p>}
              </div>
              <div className='section'>
                <h3>Sources</h3>
                <ul className='plain'>{run.prep!.files.map((f) => <li key={f.file}><span className='mono'>{f.file}</span> <span className='muted'>· {f.kind}, {f.items} item{f.items === 1 ? '' : 's'}</span></li>)}</ul>
              </div>
              {run.system && <div className='section'><h3>System prompt</h3><p className='quote'>{run.system}</p></div>}
            </>
            )
          : <p className='hint'>This run was prepared from the command line without a report.</p>}
      </Card>

      <Card title='What the model will learn from' aside={<span className='muted small'>first {run.preview.length}</span>}>
        <div className='preview'>
          {run.preview.map((item, i) => (
            'messages' in item
              ? (
                <div className='convo' key={i}>
                  {item.messages.map((m, j) => (
                    <div key={j} className={`bubble ${m.role}`}><span className='who'>{m.role === 'assistant' ? 'answer' : 'prompt'}</span><Highlighted text={m.content} /></div>
                  ))}
                </div>
                )
              : <p className='para' key={i}><Highlighted text={item.text} /></p>
          ))}
        </div>
      </Card>
    </div>
  )
}
