import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSftDataset, buildCausalDataset, toJsonl } from '../src/dataset.js'
import { checkFinetunable, resolveModel } from '../src/models.js'

const convo = (q, a) => ({ messages: [{ role: 'user', content: q }, { role: 'assistant', content: a }] })

test('dedupes (case/whitespace-insensitive), drops empty and over-long samples', () => {
  const data = [
    convo('hi', 'hello'),
    convo('HI ', 'Hello'),
    convo('q', ''),
    convo('long', 'x'.repeat(4000)),
    ...Array.from({ length: 30 }, (_, i) => convo(`question ${i}`, `answer ${i}`))
  ]
  const { train, eval: ev, report } = buildSftDataset(data, { contextLength: 512 })
  assert.equal(report.duplicates, 1)
  assert.equal(report.empty, 1)
  assert.equal(report.tooLong, 1)
  assert.equal(train.length + ev.length, 31)
  assert.ok(ev.length >= 1)
})

test('a single sample always goes to train', () => {
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const r = buildSftDataset([convo('only', 'one')], { evalFraction: 0.99, seed })
    assert.equal(r.train.length, 1)
  }
})

test('split is deterministic and seed-dependent', () => {
  const data = Array.from({ length: 50 }, (_, i) => convo(`q${i}`, `a${i}`))
  const a = buildSftDataset(data, { evalFraction: 0.2 })
  const b = buildSftDataset([...data].reverse(), { evalFraction: 0.2 })
  const ids = (s) => s.map((c) => c.messages[0].content).sort()
  assert.deepEqual(ids(a.eval), ids(b.eval))
  const c = buildSftDataset(data, { evalFraction: 0.2, seed: 'other' })
  assert.notDeepEqual(ids(a.eval), ids(c.eval))
})

test('scrubs PII by default and reports it; can be disabled', () => {
  const data = [convo('my email?', 'it is me@example.com'), convo('x', 'y')]
  const on = buildSftDataset(data)
  assert.equal(on.report.redactions.EMAIL, 1)
  assert.doesNotMatch(toJsonl([...on.train, ...on.eval]), /example\.com/)
  const off = buildSftDataset(data, { scrubPii: false })
  assert.match(toJsonl([...off.train, ...off.eval]), /example\.com/)
})

test('causal dataset splits paragraphs and dedupes', () => {
  const doc = 'First paragraph about my game jam.\n\nSecond paragraph, also long enough.\n\nfirst PARAGRAPH about my game jam.\n\nshort'
  const { train, eval: ev, report } = buildCausalDataset([doc], { evalFraction: 0 })
  assert.equal(report.duplicates, 1)
  assert.equal(report.trainParagraphs, 2)
  assert.equal(ev, '')
  assert.match(train, /Second paragraph/)
})

test('checkFinetunable follows the QVAC support matrix', () => {
  assert.equal(checkFinetunable({ registryPath: 'unsloth/Qwen3-0.6B-GGUF/blob/x/Qwen3-0.6B-Q4_0.gguf' }).ok, true)
  assert.equal(checkFinetunable('bitnet_b1_58-large-TQ2_0.gguf').ok, true)
  assert.equal(checkFinetunable('gemma-3-1b-it-Q8_0.gguf').arch, 'gemma3')
  const km = checkFinetunable('Qwen3-4B-Q4_K_M.gguf')
  assert.equal(km.ok, false)
  assert.match(km.reason, /Q4_K_M cannot be fine-tuned/)
  assert.match(checkFinetunable('Qwen3.5-2B-Q8_0.gguf').reason, /architecture/)
  assert.match(checkFinetunable('Llama-3.2-1B-Q4_0.gguf').reason, /architecture/)
})

test('resolveModel maps presets and constants via the SDK object', () => {
  const fakeSdk = { QWEN3_600M_INST_Q4: { name: 'QWEN3_600M_INST_Q4', registryPath: 'a/Qwen3-0.6B-Q4_0.gguf' } }
  const r = resolveModel('tiny', fakeSdk)
  assert.equal(r.name, 'QWEN3_600M_INST_Q4')
  assert.equal(r.check.ok, true)
  assert.equal(resolveModel('./models/Qwen3-1.7B-Q8_0.gguf').check.ok, true)
  assert.throws(() => resolveModel('NOPE_CONST', fakeSdk), /Unknown QVAC model/)
})
