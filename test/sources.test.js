import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  notesToText, parseWhatsApp, chatToConversations, parseChatJson, parseCsv,
  qaCsvToConversations, detectSourceType
} from '../src/sources.js'

test('notesToText strips markdown noise but keeps prose', () => {
  const md = `---\ntags: [x]\n---\n# Trip ideas\nSee [[Lisbon|the Lisbon page]] and [map](https://x.y).\n\n\n\`\`\`js\nconsole.log(1)\n\`\`\`\n- [x] book flights\n![pic](a.png)`
  assert.equal(notesToText(md), 'Trip ideas\nSee the Lisbon page and map.\n- book flights')
})

const ANDROID = `12/31/23, 9:41 PM - Sam: you around?
12/31/23, 9:42 PM - Elio: yep, just finished the jam build
12/31/23, 9:42 PM - Elio: it's rough
but playable
12/31/23, 9:43 PM - Sam: <Media omitted>
12/31/23, 9:44 PM - Sam: nice! send it
12/31/23, 9:45 PM - Elio: sending now
1/1/24, 11:00 AM - Sam: happy new year
1/1/24, 11:01 AM - Elio: happy new year!! 🎉`

test('parses Android WhatsApp export incl. multi-line and media lines', () => {
  const msgs = parseWhatsApp(ANDROID)
  assert.equal(msgs.length, 7) // media line dropped
  assert.equal(msgs[2].text, "it's rough\nbut playable")
  assert.equal(msgs[0].at, Date.UTC(2023, 11, 31, 21, 41))
})

test('parses iOS WhatsApp export with seconds and brackets', () => {
  const ios = '[31/12/2023, 21:41:05] Sam: hey\n‎[31/12/2023, 21:41:30] Elio: hi there'
  const msgs = parseWhatsApp(ios)
  assert.deepEqual(msgs.map((m) => m.author), ['Sam', 'Elio'])
  assert.equal(msgs[1].at, Date.UTC(2023, 11, 31, 21, 41, 30))
})

test('chatToConversations makes me the assistant and splits on silence', () => {
  const convos = chatToConversations(parseWhatsApp(ANDROID), { me: 'Elio', system: 'Reply like Elio.' })
  assert.equal(convos.length, 2)
  assert.deepEqual(convos[0].messages.map((m) => m.role), ['system', 'user', 'assistant', 'user', 'assistant'])
  assert.equal(convos[0].messages[2].content, "yep, just finished the jam build\nit's rough\nbut playable")
  assert.equal(convos[1].messages[2].content, 'happy new year!! 🎉')
})

test('chatToConversations explains a wrong --me', () => {
  assert.throws(() => chatToConversations(parseWhatsApp(ANDROID), { me: 'Bob' }), /Participants: Sam, Elio/)
})

test('parseChatJson handles JSONL, array of convos and bare message array', () => {
  const line = { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }
  assert.equal(parseChatJson(JSON.stringify(line) + '\n' + JSON.stringify(line)).length, 2)
  assert.equal(parseChatJson(JSON.stringify([line])).length, 1)
  assert.equal(parseChatJson(JSON.stringify(line.messages)).length, 1)
  assert.throws(() => parseChatJson('{"messages":[{"role":"bot","content":"x"}]}'), /role/)
})

test('parseCsv handles quotes, escaped quotes and embedded newlines', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi""\nthen left"\r\n'), [['a', 'b'], ['x, y', 'he said "hi"\nthen left']])
})

test('qaCsvToConversations finds flexible headers', () => {
  const c = qaCsvToConversations('Prompt,Response\nWhat is QVAC?,Local AI by Tether.\n,empty\n')
  assert.deepEqual(c, [{ messages: [{ role: 'user', content: 'What is QVAC?' }, { role: 'assistant', content: 'Local AI by Tether.' }] }])
  assert.throws(() => qaCsvToConversations('foo,bar\n1,2'), /question and answer/)
})

test('detectSourceType', () => {
  assert.equal(detectSourceType('notes/ideas.md'), 'notes')
  assert.equal(detectSourceType('WhatsApp Chat with Sam.txt'), 'whatsapp')
  assert.equal(detectSourceType('faq.csv'), 'qa-csv')
  assert.equal(detectSourceType('export.jsonl'), 'chat-json')
  assert.equal(detectSourceType('photo.png'), null)
})
