import { useState } from 'react'
import { Alert } from 'react-native'
import { router } from 'expo-router'
import { compareRun, isTraining } from '../../engine'
import { useRuns } from '../../state'
import { Button, Card, colors, Field, H1, P, Screen } from '../../ui'

const SUGGESTIONS = ['Say hi', 'What should I eat for dinner?', 'Any tips for learning to code?']

export default function TryScreen () {
  const { run } = useRuns()
  const [prompt, setPrompt] = useState(SUGGESTIONS[0])
  const [out, setOut] = useState<{ base: string, tuned: string, stage: string } | null>(null)
  const [busy, setBusy] = useState(false)

  if (!run?.adapter) {
    return (
      <Screen>
        <H1>Try</H1>
        <P dim>{run ? `“${run.name}” has no adapter yet.` : 'No run selected.'} Train one first.</P>
        <Button title='Go to Train' kind='secondary' onPress={() => router.navigate('/train')} />
      </Screen>
    )
  }
  const current = run

  async function go () {
    if (isTraining()) return Alert.alert('Busy', 'Wait for training to finish first.')
    setBusy(true)
    setOut({ base: '', tuned: '', stage: 'loading base model' })
    try {
      await compareRun(current, prompt.trim(), setOut)
    } catch (err: any) {
      Alert.alert('Could not run', err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <H1>Base vs. you</H1>
      <P dim>Same prompt, same base model; the second answer uses your adapter.</P>
      <Field label='Prompt' value={prompt} onChangeText={setPrompt} multiline />
      <Button title='Compare' onPress={() => { void go() }} disabled={!prompt.trim()} busy={busy} />
      {SUGGESTIONS.filter((s) => s !== prompt).map((s) => <P key={s} dim>· <P color={colors.accent}>{s}</P></P>)}
      {out && (
        <>
          <Card title='Base model'>
            <P>{out.base || (out.stage.includes('base') ? '…' : '')}</P>
          </Card>
          <Card title='With your adapter'>
            <P color={colors.accent}>{out.tuned || (out.stage === 'done' ? '(empty)' : out.stage === 'tuned' || out.stage === 'loading adapter' ? '…' : '')}</P>
          </Card>
        </>
      )}
    </Screen>
  )
}
