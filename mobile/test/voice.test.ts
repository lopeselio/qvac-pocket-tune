import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendTranscript, audioExtensionOk, lockedMode, uniqueName, voiceSources } from '../src/voice.ts'

test('spoken answers become a Q&A CSV with quotes escaped', () => {
  const [src] = voiceSources([{ q: 'Say "hi"', a: 'Hey, there' }], [])
  assert.equal(src.name, 'voice-answers.csv')
  assert.equal(src.type, 'qa-csv')
  assert.equal(src.text, 'question,answer\n"Say ""hi""","Hey, there"\n')
})

test('spoken notes become one notes file, paragraphs apart', () => {
  const out = voiceSources([], ['first thought', 'second thought'])
  assert.deepEqual(out, [{ name: 'voice-notes.txt', type: 'notes', text: 'first thought\n\nsecond thought' }])
  assert.deepEqual(voiceSources([], []), [])
})

test('a run is locked to whichever mode was used first', () => {
  assert.equal(lockedMode([], []), null)
  assert.equal(lockedMode([{ q: 'q', a: 'a' }], []), 'qa')
  assert.equal(lockedMode([], ['n']), 'notes')
})

test('more recording is appended to the transcript', () => {
  assert.equal(appendTranscript(null, 'hello'), 'hello')
  assert.equal(appendTranscript('hello', 'world'), 'hello world')
})

test('run names stay unique', () => {
  assert.equal(uniqueName('my-voice', []), 'my-voice')
  assert.equal(uniqueName('my-voice', ['my-voice', 'my-voice-2']), 'my-voice-3')
})

test('only formats QVAC can decode are accepted', () => {
  assert.ok(audioExtensionOk('Memo 12.M4A'))
  assert.ok(audioExtensionOk('clip.wav'))
  assert.ok(!audioExtensionOk('clip.caf'))
  assert.ok(!audioExtensionOk('noext'))
})
