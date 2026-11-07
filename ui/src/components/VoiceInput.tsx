import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { api, type ServerState } from '../api'
import { MAX_SECONDS, Recorder, toWav16k } from '../audio'

// Open questions that draw out how you talk. Answering them out loud gives
// the Q&A pairs the adapter learns from.
const QUESTIONS = [
  'What do you do for work?',
  'How would you explain your job to a friend?',
  'What does a good weekend look like for you?',
  'What advice would you give someone starting out in your field?',
  'How do you stay focused?',
  'What is a book or film you would recommend, and why?',
  'What do you think about AI?',
  'How would you explain crypto to someone new to it?',
  'What is your favourite food?',
  'What is something you changed your mind about?'
]

type Phase = 'idle' | 'recording' | 'converting' | 'transcribing'
type Mode = 'qa' | 'notes'

interface Props {
  state: ServerState
  onAnswer: (question: string, answer: string) => void
  onNote: (text: string) => void
  /** Set once answers or notes were added: a run can't mix Q&A and notes. */
  lockedMode?: Mode | null
}

export function VoiceInput ({ state, onAnswer, onNote, lockedMode = null }: Props) {
  const [chosenMode, setMode] = useState<Mode>('qa')
  const mode = lockedMode ?? chosenMode
  const [qi, setQi] = useState(0)
  const [question, setQuestion] = useState(QUESTIONS[0])
  const [lang, setLang] = useState('en')
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef(new Recorder())

  useEffect(() => () => rec.current.cancel(), [])
  useEffect(() => {
    if (phase !== 'recording') return
    const started = Date.now()
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 250)
    return () => clearInterval(t)
  }, [phase])

  const blocked = !state.qvac ? "QVAC isn't available in this session." : state.busy === 'training' ? 'Training is running. Record when it finishes or after pausing.' : null
  const working = phase === 'converting' || phase === 'transcribing'

  async function handleAudio (blob: Blob) {
    setError(null)
    try {
      setPhase('converting')
      const { wav, seconds } = await toWav16k(blob)
      if (seconds < 0.5) throw new Error('That was too short to hear anything. Try again.')
      setPhase('transcribing')
      const res = await api.transcribe(wav, lang)
      if (!res.text) throw new Error("Didn't catch any words. Check the microphone and try again.")
      setTranscript((t) => (t ? `${t} ${res.text}` : res.text))
      setInfo(`${seconds.toFixed(1)} s of audio, transcribed on this device in ${(res.ms / 1000).toFixed(1)} s`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPhase('idle')
    }
  }

  async function toggle () {
    setError(null)
    if (phase === 'recording') {
      const blob = await rec.current.stop()
      // Empty if the time limit already stopped it; that blob is on its way.
      if (blob.size) void handleAudio(blob)
      return
    }
    try {
      await rec.current.start((blob) => { void handleAudio(blob) })
      setElapsed(0)
      setPhase('recording')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  function upload (e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) void handleAudio(f)
  }

  function nextQuestion () {
    const n = (qi + 1) % QUESTIONS.length
    setQi(n)
    setQuestion(QUESTIONS[n])
  }

  function add () {
    const text = transcript?.trim()
    if (!text) return
    if (mode === 'qa') {
      if (!question.trim()) return setError('Add the question you answered.')
      onAnswer(question.trim(), text)
      nextQuestion()
    } else {
      onNote(text)
    }
    setTranscript(null)
    setInfo(null)
  }

  return (
    <div className='voice'>
      <div className='row row-wrap'>
        <div className='seg' role='tablist' aria-label='What to record'>
          <button type='button' role='tab' aria-selected={mode === 'qa'} onClick={() => setMode('qa')} disabled={lockedMode === 'notes'} title={lockedMode === 'notes' ? "A run can't mix notes and Q&A" : undefined}>Answer questions</button>
          <button type='button' role='tab' aria-selected={mode === 'notes'} onClick={() => setMode('notes')} disabled={lockedMode === 'qa'} title={lockedMode === 'qa' ? "A run can't mix notes and Q&A" : undefined}>Dictate notes</button>
        </div>
        <label className='inline'>
          <span className='sr'>Spoken language</span>
          <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={working || phase === 'recording'}>
            {state.stt.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
      </div>

      {mode === 'qa' && (
        <div className='field'>
          <span className='label'>Answer this out loud, the way you'd say it</span>
          <div className='row'>
            <input className='grow' value={question} onChange={(e) => setQuestion(e.target.value)} aria-label='Question' />
            <button type='button' className='btn' onClick={nextQuestion} disabled={working || phase === 'recording'}>Another</button>
          </div>
        </div>
      )}

      <div className='rec-row'>
        <button
          type='button'
          className={`rec-btn ${phase === 'recording' ? 'on' : ''}`}
          onClick={toggle}
          disabled={!!blocked || working}
          aria-pressed={phase === 'recording'}
        >
          <span className='rec-dot' aria-hidden='true' />
          {phase === 'recording'
            ? `Stop · ${Math.floor(elapsed)}s`
            : phase === 'converting'
              ? 'Preparing audio…'
              : phase === 'transcribing'
                ? (state.stt.download != null && state.stt.download < 100 ? `Downloading speech model ${state.stt.download}%…` : 'Transcribing on this device…')
                : transcript ? 'Record more' : 'Record'}
        </button>
        <label className={`btn upload ${blocked || working || phase === 'recording' ? 'disabled' : ''}`}>
          <input type='file' accept='audio/*,.m4a,.mp3,.wav,.ogg,.webm' onChange={upload} disabled={!!blocked || working || phase === 'recording'} />
          Upload a voice memo
        </label>
      </div>
      {phase === 'recording' && <p className='hint'>Recording. It stops on its own after {MAX_SECONDS / 60} minutes.</p>}
      {blocked && <p className='hint'>{blocked}</p>}
      {lockedMode && <p className='hint'>A run trains on either Q&A or notes, so this one stays on {lockedMode === 'qa' ? 'answering questions' : 'notes'}. Remove what you added to switch.</p>}
      {error && <p className='err' role='alert'>{error}</p>}

      {transcript !== null && (
        <div className='field transcript'>
          <span className='label'>Transcript <span className='opt'>(edit anything it misheard)</span></span>
          <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={3} />
          {info && <span className='hint'>{info}</span>}
          <div className='row'>
            <button type='button' className='btn primary' onClick={add} disabled={!transcript.trim()}>{mode === 'qa' ? 'Add answer' : 'Add note'}</button>
            <button type='button' className='btn' onClick={() => { setTranscript(null); setInfo(null) }}>Discard</button>
          </div>
        </div>
      )}
      <p className='hint'>Audio is transcribed by QVAC Whisper on this computer and never saved: only the text you add is kept. Spoken emails and numbers may not be recognised as secrets, so check transcripts before training.</p>
    </div>
  )
}
