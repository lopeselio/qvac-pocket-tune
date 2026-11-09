import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { createAudioPlayer, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState, type RecordingOptions } from 'expo-audio'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { isTraining, transcribeFile } from '../engine'
import { Button, Chips, colors, P } from '../ui'
import { appendTranscript, audioExtensionOk, AUDIO_EXTENSIONS, MAX_CLIP_BYTES, MAX_CLIP_SECONDS, QUESTIONS, SPEECH_MODELS, type SpeechKey, type VoiceMode } from '../voice'

// The phone version of ui/src/components/VoiceInput.tsx: answer questions or
// dictate notes, Whisper transcribes on this phone, you fix the transcript and
// add it. Audio files are deleted once transcribed; only the text is kept.

// Whisper works at 16 kHz mono, so record that and keep files small.
const RECORDING: RecordingOptions = { ...RecordingPresets.HIGH_QUALITY, sampleRate: 16000, numberOfChannels: 1, bitRate: 64000 }

type Phase = 'idle' | 'recording' | 'transcribing'

const LANGS = (Object.keys(SPEECH_MODELS) as SpeechKey[]).map((k) => ({ key: k, label: SPEECH_MODELS[k].label }))
const MODES: { key: VoiceMode, label: string }[] = [{ key: 'qa', label: 'Answer questions' }, { key: 'notes', label: 'Dictate notes' }]

interface Props {
  onAnswer: (question: string, answer: string) => void
  onNote: (text: string) => void
  /** Set once answers or notes were added: a run can't mix Q&A and notes. */
  lockedMode: VoiceMode | null
}

export function VoiceInput ({ onAnswer, onNote, lockedMode }: Props) {
  const [chosenMode, setMode] = useState<VoiceMode>('qa')
  const mode = lockedMode ?? chosenMode
  const [qi, setQi] = useState(0)
  const [question, setQuestion] = useState(QUESTIONS[0])
  const [lang, setLang] = useState<SpeechKey>('en')
  const [phase, setPhase] = useState<Phase>('idle')
  const [download, setDownload] = useState<number | null>(null)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const recorder = useAudioRecorder(RECORDING)
  const rec = useAudioRecorderState(recorder, 250)
  const limit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)

  useEffect(() => () => {
    mounted.current = false
    clearTimeout(limit.current)
    // Leaving the screen mid-recording throws the clip away.
    if (recorder.isRecording) {
      void recorder.stop().then(() => { if (recorder.uri) discard(recorder.uri) }).catch(() => {})
    }
  }, [recorder])

  const busy = phase !== 'idle'

  async function transcribe (uri: string, seconds: number, temporary: boolean) {
    setError(null)
    try {
      if (seconds > 0 && seconds < 0.5) throw new Error('That was too short to hear anything. Try again.')
      if (seconds > MAX_CLIP_SECONDS + 1) throw new Error(`That clip is ${Math.round(seconds)} s. Keep clips under ${MAX_CLIP_SECONDS / 60} minutes.`)
      setPhase('transcribing')
      const res = await transcribeFile(uri, lang, (p) => { if (mounted.current) setDownload(p < 100 ? p : null) })
      if (!mounted.current) return
      if (!res.text) throw new Error("Didn't catch any words. Check the microphone and try again.")
      setTranscript((t) => appendTranscript(t, res.text))
      setInfo(`${seconds > 0 ? `${seconds.toFixed(1)} s of audio, ` : ''}transcribed on this phone in ${(res.ms / 1000).toFixed(1)} s`)
    } catch (err: any) {
      if (mounted.current) setError(err?.message ?? String(err))
    } finally {
      if (temporary) discard(uri)
      if (mounted.current) { setPhase('idle'); setDownload(null) }
    }
  }

  async function startRecording () {
    setError(null)
    if (isTraining()) return setError('Training is running. Record when it finishes or after pausing.')
    try {
      const perm = await requestRecordingPermissionsAsync()
      if (!perm.granted) throw new Error('Microphone access is off. Turn it on in Settings → Pocket Tune → Microphone.')
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      recorder.record()
      setPhase('recording')
      limit.current = setTimeout(() => { void stopRecording() }, MAX_CLIP_SECONDS * 1000)
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setPhase('idle')
    }
  }

  async function stopRecording () {
    clearTimeout(limit.current)
    if (!recorder.isRecording) return
    const seconds = recorder.getStatus().durationMillis / 1000
    try {
      await recorder.stop()
    } finally {
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {})
    }
    if (!recorder.uri) return setPhase('idle')
    await transcribe(recorder.uri, seconds, true)
  }

  async function upload () {
    setError(null)
    if (isTraining()) return setError('Training is running. Record when it finishes or after pausing.')
    const res = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true })
    if (res.canceled) return
    const a = res.assets[0]
    if (!audioExtensionOk(a.name)) { discard(a.uri); return setError(`Couldn't read that audio. Use ${AUDIO_EXTENSIONS.map((e) => e.slice(1)).join(', ')} (Voice Memos are m4a).`) }
    if ((a.size ?? 0) > MAX_CLIP_BYTES) { discard(a.uri); return setError(`That file is too large. Keep clips under ${MAX_CLIP_SECONDS / 60} minutes.`) }
    await transcribe(a.uri, await durationOf(a.uri), true)
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

  const label = phase === 'recording'
    ? `Stop · ${Math.floor(rec.durationMillis / 1000)}s`
    : phase === 'transcribing'
      ? (download != null ? `Downloading speech model ${download}%…` : 'Transcribing on this phone…')
      : transcript ? 'Record more' : 'Record'

  return (
    <View style={{ gap: 12 }}>
      <Chips options={MODES} value={mode} onChange={(m) => { if (!lockedMode) setMode(m) }} />
      {lockedMode && <P dim>A run trains on either Q&A or notes, so this one stays on {lockedMode === 'qa' ? 'answering questions' : 'notes'}. Remove what you added to switch.</P>}
      <Chips options={LANGS} value={lang} onChange={(k) => { if (!busy) setLang(k) }} />

      {mode === 'qa' && (
        <View style={{ gap: 6 }}>
          <Text style={s.label}>Answer this out loud, the way you&apos;d say it</Text>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <TextInput style={[s.input, { flex: 1 }]} value={question} onChangeText={setQuestion} placeholderTextColor={colors.dim} accessibilityLabel='Question' multiline />
            <View style={{ width: 96 }}><Button title='Another' kind='secondary' onPress={nextQuestion} disabled={busy} /></View>
          </View>
        </View>
      )}

      <Pressable
        accessibilityRole='button'
        accessibilityState={{ disabled: phase === 'transcribing', selected: phase === 'recording' }}
        onPress={() => { void (phase === 'recording' ? stopRecording() : startRecording()) }}
        disabled={phase === 'transcribing'}
        style={({ pressed }) => [s.rec, phase === 'recording' && s.recOn, { opacity: phase === 'transcribing' ? 0.6 : pressed ? 0.85 : 1 }]}
      >
        <View style={[s.dot, phase === 'recording' && s.dotOn]} />
        <Text style={s.recText}>{label}</Text>
      </Pressable>
      <Button title='Upload a voice memo' kind='secondary' onPress={() => { void upload() }} disabled={busy} />
      {phase === 'recording' && <P dim>Recording. It stops on its own after {MAX_CLIP_SECONDS / 60} minutes.</P>}
      {error && <P color={colors.danger}>{error}</P>}

      {transcript !== null && (
        <View style={{ gap: 6 }}>
          <Text style={s.label}>Transcript (edit anything it misheard)</Text>
          <TextInput style={[s.input, { minHeight: 84, textAlignVertical: 'top' }]} value={transcript} onChangeText={setTranscript} multiline accessibilityLabel='Transcript' />
          {info && <P dim>{info}</P>}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Button title={mode === 'qa' ? 'Add answer' : 'Add note'} onPress={add} disabled={!transcript.trim()} /></View>
            <View style={{ flex: 1 }}><Button title='Discard' kind='secondary' onPress={() => { setTranscript(null); setInfo(null) }} /></View>
          </View>
        </View>
      )}
      <P dim>Audio is transcribed by QVAC Whisper on this phone and never saved: only the text you add is kept. Spoken emails and numbers may not be recognised as secrets, so check transcripts before training.</P>
    </View>
  )
}

function discard (uri: string) {
  try { const f = new File(uri); if (f.exists) f.delete() } catch {}
}

/** Length of an audio file in seconds, or 0 if it can't be read quickly. */
async function durationOf (uri: string): Promise<number> {
  const player = createAudioPlayer(uri)
  try {
    for (let i = 0; i < 30 && !player.isLoaded; i++) await new Promise((r) => setTimeout(r, 100))
    return player.isLoaded && Number.isFinite(player.duration) ? player.duration : 0
  } finally {
    player.remove()
  }
}

const s = StyleSheet.create({
  label: { color: colors.dim, fontSize: 13 },
  input: { backgroundColor: colors.bg, color: colors.text, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  rec: { minHeight: 56, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#0F2A1A', borderWidth: 1, borderColor: colors.accent },
  recOn: { backgroundColor: '#2A0F12', borderColor: colors.danger },
  dot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.danger },
  dotOn: { borderRadius: 3 },
  recText: { color: colors.text, fontSize: 17, fontWeight: '700' }
})
