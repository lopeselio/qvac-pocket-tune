import { useState } from 'react'
import { Alert, View } from 'react-native'
import { router } from 'expo-router'
import { PRESETS } from '../../core'
import { memoryCheck, pauseTraining, TRAIN_DEVICE, trainRun, type EngineEvent, type PresetKey, type Tick } from '../../engine'
import { useRuns } from '../../state'
import { Button, Card, Chips, colors, H1, P, Progress, Screen } from '../../ui'

const MODEL_OPTIONS = (Object.keys(PRESETS) as PresetKey[])
  .filter((k) => PRESETS[k].phone)
  .map((k) => ({ key: k, label: PRESETS[k].label.replace(/ \(.*/, '') }))

const fmt = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '–' : x.toFixed(3))

export default function TrainScreen () {
  const { run, refresh, setRun } = useRuns()
  const [preset, setPreset] = useState<PresetKey>('tiny')
  const [epochs, setEpochs] = useState(4)
  const [fitLines, setFitLines] = useState<string[] | null>(null)
  const [phase, setPhase] = useState<'idle' | 'checking' | 'downloading' | 'loading' | 'training' | 'pausing'>('idle')
  const [download, setDownload] = useState(0)
  const [tick, setTick] = useState<Tick | null>(null)

  if (!run) {
    return (
      <Screen>
        <H1>Train</H1>
        <P dim>Build a dataset first.</P>
        <Button title='Go to Data' kind='secondary' onPress={() => router.navigate('/')} />
      </Screen>
    )
  }
  const current = run
  const presetInfo = PRESETS[preset]
  const modeMismatch = presetInfo.mode !== current.mode
  const busy = phase !== 'idle'
  const canResume = current.status === 'PAUSED'

  function onEvent (e: EngineEvent) {
    if (e.type === 'fit') setFitLines(e.lines)
    if (e.type === 'download') { setPhase('downloading'); setDownload(e.percentage / 100) }
    if (e.type === 'loading') setPhase('loading')
    if (e.type === 'progress') { setPhase((p) => (p === 'pausing' ? p : 'training')); setTick(e.tick) }
    if (e.type === 'pausing') setPhase('pausing')
  }

  async function check () {
    setPhase('checking')
    try { setFitLines(await memoryCheck(preset)) } finally { setPhase('idle') }
  }

  async function start (resume: boolean, force = false) {
    setTick(null)
    setPhase('checking')
    try {
      const done = await trainRun(current, { preset, epochs, resume, force, onEvent })
      setRun(done)
      if (done.status === 'COMPLETED') {
        Alert.alert('Adapter ready', 'Compare it with the base model on the Try tab.', [{ text: 'Try it', onPress: () => router.navigate('/try') }, { text: 'Later' }])
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (err?.name === 'ModelTooLargeError') {
        Alert.alert('Probably too big for this phone', msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'Try anyway', style: 'destructive', onPress: () => { void start(resume, true) } }])
      } else {
        Alert.alert('Training stopped', msg)
      }
      refresh()
    } finally {
      setPhase('idle')
    }
  }

  const stats = current.stats ?? null
  const batchProgress = tick ? (tick.current_epoch + tick.current_batch / Math.max(1, tick.total_batches)) / Math.max(1, Number((current.options as any)?.numberOfEpochs ?? epochs)) : 0

  return (
    <Screen>
      <H1>Train “{current.name}”</H1>
      <P dim>{current.mode === 'sft' ? 'Conversations (SFT)' : 'Plain text (causal)'} · status: {current.status ?? 'PENDING'}</P>

      <Card title='Base model'>
        <Chips options={MODEL_OPTIONS} value={preset} onChange={(k) => { setPreset(k); setFitLines(null) }} />
        <P dim>{presetInfo.label}</P>
        {modeMismatch && <P color={colors.warn}>This model is usually trained on {presetInfo.mode === 'sft' ? 'conversations' : 'plain text'}; your dataset is {current.mode === 'sft' ? 'conversations' : 'plain text'}.</P>}
        <Button title='Check memory' kind='secondary' onPress={check} disabled={busy} busy={phase === 'checking' && !tick} />
        {fitLines?.map((l, i) => <P key={i} color={l.includes('too large') ? colors.danger : l.includes('likely fits') ? colors.accent : colors.dim}>{l}</P>)}
      </Card>

      <Card title='Epochs'>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 56 }}><Button title='−' kind='secondary' onPress={() => setEpochs((e) => Math.max(1, e - 1))} disabled={busy} /></View>
          <P>{epochs}</P>
          <View style={{ width: 56 }}><Button title='+' kind='secondary' onPress={() => setEpochs((e) => Math.min(20, e + 1))} disabled={busy} /></View>
          <P dim>small datasets need more</P>
        </View>
      </Card>

      {!busy && <Button title={canResume ? 'Resume training' : current.status === 'COMPLETED' ? 'Train again' : 'Start training'} onPress={() => { void start(canResume) }} />}
      {busy && <Button title={phase === 'pausing' ? 'Pausing…' : 'Pause'} kind='danger' onPress={() => { void pauseTraining(onEvent) }} disabled={phase !== 'training'} />}

      {(busy || tick) && (
        <Card title='Progress'>
          {phase === 'downloading' && <><P>Downloading base model… {Math.round(download * 100)}%</P><Progress value={download} /></>}
          {phase === 'loading' && <P>Loading model on the {TRAIN_DEVICE === 'gpu' ? 'GPU' : 'CPU'}…</P>}
          {tick && (
            <>
              <Progress value={batchProgress} />
              <P>epoch {tick.current_epoch + 1} · {tick.is_train ? 'train' : 'eval'} batch {tick.current_batch}/{tick.total_batches}</P>
              <P dim>loss {fmt(tick.loss)} · accuracy {fmt(tick.accuracy)} · ~{Math.round(tick.eta_ms / 1000)}s left</P>
            </>
          )}
          <P dim>Keep the app open; the screen stays awake while training.</P>
        </Card>
      )}

      {stats && current.status === 'COMPLETED' && (
        <Card title='Result'>
          <P>train loss {fmt(stats.train_loss)} · val loss {fmt(stats.val_loss)} · val acc {fmt(stats.val_accuracy)}</P>
          <Button title='Try it →' kind='secondary' onPress={() => router.navigate('/try')} />
        </Card>
      )}
    </Screen>
  )
}
