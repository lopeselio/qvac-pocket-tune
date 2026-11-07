import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prep, prepTexts } from '../src/prep.js'
import { ThinkFilter, reply, compare } from '../src/chat.js'

async function tmp (t) {
  const d = await mkdtemp(join(tmpdir(), 'pt-prep-'))
  t.after(() => rm(d, { recursive: true, force: true }))
  return d
}

test('prep turns a folder of notes into a causal dataset, skipping dotfiles', async (t) => {
  const d = await tmp(t)
  await mkdir(join(d, 'notes', '.obsidian'), { recursive: true })
  await writeFile(join(d, 'notes', 'a.md'), '# Ideas\nA game where you herd clouds across a tiny planet.\n\nEmail me at x@y.com about it, please.')
  await writeFile(join(d, 'notes', '.obsidian', 'cfg.json'), '{"not":"notes"}')
  const r = await prep([join(d, 'notes')], { outDir: join(d, 'run'), evalFraction: 0 })
  assert.equal(r.mode, 'causal')
  assert.equal(r.files.length, 1)
  const txt = await readFile(join(d, 'run', 'train.txt'), 'utf8')
  assert.match(txt, /herd clouds/)
  assert.match(txt, /\[EMAIL\]/)
  const meta = JSON.parse(await readFile(join(d, 'run', 'prep.json'), 'utf8'))
  assert.equal(meta.report.redactions.EMAIL, 1)
})

test('prep builds SFT from a WhatsApp export and records the system prompt', async (t) => {
  const d = await tmp(t)
  const lines = []
  for (let i = 0; i < 12; i++) {
    const hh = String(i * 2).padStart(2, '0') // 2h apart → separate conversations
    lines.push(`[01/02/2024, ${hh}:00:00] Sam: question number ${i}?`)
    lines.push(`[01/02/2024, ${hh}:00:30] Elio: answer number ${i}!`)
  }
  await writeFile(join(d, 'WhatsApp Chat with Sam.txt'), lines.join('\n'))
  const r = await prep([join(d, 'WhatsApp Chat with Sam.txt')], { outDir: join(d, 'run'), me: 'Elio', system: 'Talk like Elio.' })
  assert.equal(r.mode, 'sft')
  assert.equal(r.report.train + r.report.eval, 12)
  const first = JSON.parse((await readFile(join(d, 'run', 'train.jsonl'), 'utf8')).split('\n')[0])
  assert.equal(first.messages[0].content, 'Talk like Elio.')
  assert.equal(JSON.parse(await readFile(join(d, 'run', 'prep.json'), 'utf8')).system, 'Talk like Elio.')
})

test('prepTexts writes the same run from in-memory sources, typed by name or explicitly', async (t) => {
  const d = await tmp(t)
  const r = await prepTexts([{ name: 'faq.csv', text: 'question,answer\nhi,hello there\nmail?,write to a@b.co\n' }], { outDir: join(d, 'run'), evalFraction: 0 })
  assert.equal(r.mode, 'sft')
  assert.deepEqual(r.files, [{ file: 'faq.csv', kind: 'qa-csv', items: 2 }])
  assert.equal(r.report.redactions.EMAIL, 1)
  assert.match(await readFile(join(d, 'run', 'train.jsonl'), 'utf8'), /\[EMAIL\]/)
  const typed = await prepTexts([{ name: 'pasted', text: 'question,answer\nhi,hello\n', type: 'qa-csv' }], { outDir: join(d, 'run2'), evalFraction: 0 })
  assert.equal(typed.files[0].kind, 'qa-csv')
})

test('prep refuses to mix notes and chats', async (t) => {
  const d = await tmp(t)
  await writeFile(join(d, 'n.md'), 'Some long enough note about something.')
  await writeFile(join(d, 'qa.csv'), 'question,answer\nhi,hello\n')
  await assert.rejects(prep([d], { outDir: join(d, 'run') }), /Mixing notes/)
})

test('ThinkFilter hides think blocks even when tags are split across deltas', () => {
  const f = new ThinkFilter()
  const parts = ['<thi', 'nk>plan the', ' answer</thi', 'nk>\n\nAhoy', ' matey! <', '3']
  const out = parts.map((p) => f.push(p)).join('') + f.flush()
  assert.equal(out, 'Ahoy matey! <3')
})

test('ThinkFilter drops blank lines after </think> even across deltas, and keeps other whitespace', () => {
  const f = new ThinkFilter()
  const parts = ['<think></think>', '\n', '\n', '  def f():', '\n    pass']
  assert.equal(parts.map((p) => f.push(p)).join('') + f.flush(), 'def f():\n    pass')
  const g = new ThinkFilter()
  assert.equal(g.push('    indented code') + g.flush(), '    indented code')
})

function fakeChatSdk (calls) {
  return {
    async loadModel (o) { calls.push(o); return o.modelConfig.lora ? 'tuned' : 'base' },
    async unloadModel () {},
    completion ({ modelId }) {
      const text = modelId === 'tuned' ? '<think>hmm</think>\n\nArr, ahoy!' : 'Hello.'
      return { events: (async function * () { for (const ch of text) yield { type: 'contentDelta', text: ch } })() }
    }
  }
}

test('reply streams visible text only', async () => {
  const seen = []
  const sdk = fakeChatSdk([])
  const text = await reply({ sdk, modelId: 'tuned', history: [], onText: (t) => seen.push(t) })
  assert.equal(text, 'Arr, ahoy!')
  assert.equal(seen.join(''), 'Arr, ahoy!')
})

test('compare runs base then adapter, one model at a time, with the trained system prompt', async (t) => {
  const d = await tmp(t)
  await writeFile(join(d, 'run.json'), JSON.stringify({ model: { src: 'x/Qwen3-0.6B-Q4_0.gguf' }, options: { contextLength: 512 }, system: 'Be a pirate.' }))
  await writeFile(join(d, 'trained-lora-adapter.gguf'), 'A')
  const calls = []
  const res = await compare({ sdk: fakeChatSdk(calls), runDir: d, prompts: ['hi'] })
  assert.deepEqual(res, [{ prompt: 'hi', base: 'Hello.', tuned: 'Arr, ahoy!' }])
  assert.equal(calls[0].modelConfig.lora, undefined)
  assert.equal(calls[1].modelConfig.lora, join(d, 'trained-lora-adapter.gguf'))
  // Base and tuned get the same tamed sampling, so only the adapter differs.
  for (const c of calls) {
    assert.equal(c.modelConfig.temp, 0.3)
    assert.equal(c.modelConfig.repeat_penalty, 1.15)
    assert.equal(c.modelConfig.seed, 42)
  }
  assert.equal(calls[1].modelType, 'llm')
})

test('reply retries with /no_think when thinking used up the whole reply', async () => {
  const histories = []
  const sdk = {
    completion ({ history }) {
      histories.push(history)
      const noThink = history[0]?.content?.includes('/no_think')
      const text = noThink ? '<think>\n\n</think>\n\nStart simple.' : '<think>\nOkay, the user wants… let me plan a long'
      return { events: (async function * () { for (const ch of text.split(/(?= )/)) yield { type: 'contentDelta', text: ch } })() }
    }
  }
  const seen = []
  const text = await reply({ sdk, modelId: 'm', history: [{ role: 'user', content: 'How do I cook?' }], onText: (t) => seen.push(t) })
  assert.equal(text, 'Start simple.')
  assert.equal(histories.length, 2)
  assert.deepEqual(histories[1][0], { role: 'system', content: '/no_think' })
  assert.equal(seen.join(''), 'Start simple.') // the hidden thinking never streamed
})

test('reply does not retry when the think block closed, and keeps the system prompt', async () => {
  let calls = 0
  const sdk = {
    completion () {
      calls++
      return { events: (async function * () { yield { type: 'contentDelta', text: '<think></think>Ahoy!' } })() }
    }
  }
  assert.equal(await reply({ sdk, modelId: 'm', history: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }] }), 'Ahoy!')
  assert.equal(calls, 1)
})

test('withNoThink appends to an existing system prompt', async () => {
  const { withNoThink } = await import('../src/think.js')
  assert.deepEqual(withNoThink([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }])[0], { role: 'system', content: 'Be brief. /no_think' })
})
