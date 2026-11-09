import { useState } from 'react'
import { Alert, Pressable, Switch, Text, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { router } from 'expo-router'
import { VoiceInput } from '../../components/VoiceInput'
import { buildDatasetFromTexts } from '../../core'
import { saveDataset } from '../../runs'
import { SAMPLE } from '../../sample'
import { useRuns } from '../../state'
import { Button, Card, Chips, colors, Field, H1, P, Screen } from '../../ui'
import { filesMode, lockedMode, uniqueName, voiceSources, type SpokenAnswer } from '../../voice'

type Source = { name: string, text: string }
type Kind = 'auto' | 'notes' | 'whatsapp' | 'chat-json' | 'qa-csv'

const KINDS: { key: Kind, label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'qa-csv', label: 'Q&A CSV' },
  { key: 'chat-json', label: 'Chat JSON' },
  { key: 'notes', label: 'Notes' }
]

const MAX_BYTES = 20 * 1024 * 1024

export default function DataScreen () {
  const { run, runs, select, setRun } = useRuns()
  const [name, setName] = useState('my-voice')
  const [me, setMe] = useState('')
  const [system, setSystem] = useState('')
  const [kind, setKind] = useState<Kind>('auto')
  const [scrub, setScrub] = useState(true)
  const [sources, setSources] = useState<Source[]>([])
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<string[] | null>(null)
  const [voiceQA, setVoiceQA] = useState<SpokenAnswer[]>([])
  const [voiceNotes, setVoiceNotes] = useState<string[]>([])
  const spoken = voiceQA.length + voiceNotes.length

  // Like the web UI: the first spoken item names the run, without clobbering one.
  function ensureName () {
    if (!spoken && name === 'my-voice') setName(uniqueName('my-voice', runs.map((r) => r.name)))
    setSummary(null)
  }

  async function pick () {
    const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: ['text/*', 'application/json', 'text/csv', 'text/comma-separated-values'] })
    if (res.canceled) return
    const picked: Source[] = []
    for (const a of res.assets) {
      if ((a.size ?? 0) > MAX_BYTES) { Alert.alert('File too large', `${a.name} is over 20 MB.`); continue }
      picked.push({ name: a.name, text: await new File(a.uri).text() })
    }
    setSources((prev) => [...prev.filter((p) => !picked.some((x) => x.name === p.name)), ...picked])
    setSummary(null)
  }

  function useSample () {
    setName(SAMPLE.name)
    setSystem(SAMPLE.system)
    setKind('auto')
    setSources(SAMPLE.files)
    setSummary(null)
  }

  function build () {
    setBusy(true)
    // Let the spinner render before the synchronous parsing work.
    setTimeout(() => {
      try {
        const ds = buildDatasetFromTexts(
          // The type override is for picked files; spoken sources carry their own.
          [...sources.map((s) => ({ ...s, ...(kind !== 'auto' ? { type: kind } : {}) })), ...voiceSources(voiceQA, voiceNotes)],
          { me: me.trim() || undefined, system: system.trim() || undefined, scrubPii: scrub, evalFraction: 0.15 }
        )
        const meta = saveDataset(name, ds, system.trim() || null)
        setRun(meta)
        const r = ds.report as any
        const lines = ds.mode === 'sft'
          ? [`${r.train} training / ${r.eval} evaluation conversations`, `dropped: ${r.duplicates} duplicate, ${r.tooLong} too long, ${r.empty} empty`]
          : [`${r.trainParagraphs} training / ${r.evalParagraphs} evaluation paragraphs`, `${r.duplicates} duplicates dropped`]
        const red = Object.entries(r.redactions ?? {}).map(([k, n]) => `${n} ${k}`)
        if (red.length) lines.push(`redacted before training: ${red.join(', ')}`)
        setSummary([`${ds.mode.toUpperCase()} dataset saved as "${meta.name}"`, ...lines])
      } catch (err: any) {
        Alert.alert('Could not build dataset', err?.message ?? String(err))
      } finally {
        setBusy(false)
      }
    }, 30)
  }

  return (
    <Screen>
      <H1>Pocket Tune</H1>
      <P dim>Teach a small model your voice. Your files and the training stay on this phone.</P>
      <Pressable onPress={() => router.push('/onboarding')} accessibilityRole='link' hitSlop={8} style={{ alignSelf: 'flex-start' }}>
        <P color={colors.accent}>How Pocket Tune works →</P>
      </Pressable>

      {runs.length > 0 && (
        <Card title='Your runs'>
          <Chips options={runs.map((r) => ({ key: r.name, label: `${r.name}${r.status === 'COMPLETED' ? ' ✓' : ''}` }))} value={run?.name ?? ''} onChange={(n) => select(n)} />
        </Card>
      )}

      <Card title='1 · Sources'>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}><Button title='Pick files' onPress={pick} /></View>
          <View style={{ flex: 1 }}><Button title='Use sample' kind='secondary' onPress={useSample} /></View>
        </View>
        {sources.length === 0
          ? <P dim>WhatsApp “Export chat” .txt, Q&A .csv, chat .jsonl, or Markdown notes.</P>
          : sources.map((s) => <P key={s.name}>• {s.name} <P dim>({Math.round(s.text.length / 1024)} KB)</P></P>)}
        <Chips options={KINDS} value={kind} onChange={setKind} />
      </Card>

      <Card title='Or speak instead'>
        <VoiceInput
          lockedMode={lockedMode(voiceQA, voiceNotes, filesMode(sources, kind === 'auto' ? null : kind))}
          lockedByFiles={!spoken && filesMode(sources, kind === 'auto' ? null : kind) !== null}
          onAnswer={(q, a) => { ensureName(); setVoiceQA((v) => [...v, { q, a }]) }}
          onNote={(text) => { ensureName(); setVoiceNotes((v) => [...v, text]) }}
        />
        {voiceQA.map((x, i) => (
          <Spoken key={`qa${i}`} title={x.q} text={x.a} tag='spoken answer' onRemove={() => setVoiceQA((v) => v.filter((_, j) => j !== i))} />
        ))}
        {voiceNotes.map((n, i) => (
          <Spoken key={`n${i}`} text={n} tag='spoken note' onRemove={() => setVoiceNotes((v) => v.filter((_, j) => j !== i))} />
        ))}
        {voiceQA.length > 0 && voiceQA.length < 20 && <P dim>{voiceQA.length} spoken answer{voiceQA.length > 1 ? 's' : ''}. Around 20 or more starts to give a recognisable voice.</P>}
      </Card>

      <Card title='2 · Options'>
        <Field label='Run name' value={name} onChangeText={setName} autoCapitalize='none' />
        <Field label='Your name in the chat export (WhatsApp)' value={me} onChangeText={setMe} placeholder='e.g. Sam' />
        <Field label='System prompt (optional)' value={system} onChangeText={setSystem} multiline placeholder='You are Sam. Reply casually and briefly.' />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <P>Scrub emails, phones, keys, addresses</P>
          <Switch value={scrub} onValueChange={setScrub} trackColor={{ true: colors.accent }} />
        </View>
      </Card>

      <Button title='Build dataset' onPress={build} disabled={!sources.length && !spoken} busy={busy} />

      {summary && (
        <Card title='Ready'>
          {summary.map((l, i) => <P key={i} dim={i > 0}>{l}</P>)}
          <Button title='Next: train →' kind='secondary' onPress={() => router.navigate('/train')} />
        </Card>
      )}
    </Screen>
  )
}

function Spoken ({ title, text, tag, onRemove }: { title?: string, text: string, tag: string, onRemove: () => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>{title}</Text> : null}
        <Text style={{ color: colors.dim, fontSize: 14, lineHeight: 20 }}>{text}</Text>
        <Text style={{ color: colors.accent, fontSize: 12 }}>{tag}</Text>
      </View>
      <Pressable onPress={onRemove} hitSlop={10} accessibilityRole='button' accessibilityLabel={`Remove this ${tag}`}>
        <Text style={{ color: colors.dim, fontSize: 22, lineHeight: 22 }}>×</Text>
      </Pressable>
    </View>
  )
}
