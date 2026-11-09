import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createSharing, parseCard, summarizeCard, RECEIVED_ADAPTER } from '../src/sharing.js'

const CARD = {
  format: 'pocket-tune/adapter@1',
  base: { name: 'QWEN3_600M_INST_Q4', sha256: 'a'.repeat(64) },
  mode: 'sft',
  hyperparameters: { numberOfEpochs: 8, learningRate: 1e-4, contextLength: 512, loraModules: 'attn_q,attn_v' },
  dataset: { train: { sha256: 'b'.repeat(64), samples: 12 } },
  metrics: { val_loss: 0.77, val_accuracy: 0.52 }
}

async function fakeRun (dir) {
  await writeFile(join(dir, 'trained-lora-adapter.gguf'), Buffer.alloc(4096, 7))
  await writeFile(join(dir, 'adapter.json'), JSON.stringify(CARD))
  await writeFile(join(dir, 'train.jsonl'), '{"secret":"never shared"}\n')
}

test('publish on one peer, inspect and receive on another, verified against the manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pt-sharing-'))
  const testnet = await createTestnet(3)
  const pub = createSharing({ storeDir: join(root, 'pub-store'), bootstrap: testnet.bootstrap, timeoutMs: 20000 })
  const sub = createSharing({ storeDir: join(root, 'sub-store'), bootstrap: testnet.bootstrap, timeoutMs: 20000 })
  t.after(async () => {
    await pub.close()
    await sub.close()
    await testnet.destroy()
    await rm(root, { recursive: true, force: true })
  })

  const runDir = join(root, 'pirate')
  await (await import('node:fs/promises')).mkdir(runDir)
  await fakeRun(runDir)

  const shared = await pub.publish({ runDir, name: 'pirate-voice', system: 'You are Captain Byte.' })
  assert.match(shared.adapterUrl, /^pear:\/\/[a-f0-9]{64}\/pirate-voice\/adapter\.gguf$/)
  assert.equal(pub.status().seeding, true)
  const links = await pub.links()
  assert.deepEqual(links.map((l) => l.name), ['pirate-voice'])

  // The publisher can inspect its own link without the network.
  assert.equal((await pub.inspect(shared.adapterUrl)).own, true)

  const seen = await sub.inspect(shared.adapterUrl)
  assert.equal(seen.own, false)
  assert.equal(seen.adapters.length, 1)
  const a = seen.adapters[0]
  assert.equal(a.name, 'pirate-voice')
  assert.equal(a.size, 4096)
  assert.equal(a.system, 'You are Captain Byte.')
  assert.equal(a.card.base, 'QWEN3_600M_INST_Q4')
  assert.equal(a.card.trainSamples, 12)

  const dest = join(root, 'runs', 'from-friend')
  const resolveBase = async (name) => ({ spec: 'tiny', name, src: { src: 'registry://test' }, sha256: 'c'.repeat(64) })
  const { warnings } = await sub.receive({ url: shared.adapterUrl, adapter: 'pirate-voice', dir: dest, resolveBase })
  assert.equal(warnings.length, 1, 'a different base build is reported')
  const adapter = await readFile(join(dest, RECEIVED_ADAPTER))
  assert.ok(adapter.equals(Buffer.alloc(4096, 7)))
  const run = JSON.parse(await readFile(join(dest, 'run.json'), 'utf8'))
  assert.equal(run.status, 'COMPLETED')
  assert.equal(run.model.name, 'QWEN3_600M_INST_Q4')
  assert.equal(run.system, 'You are Captain Byte.')
  assert.equal(run.options.numberOfEpochs, 8)
  assert.equal(run.received.sha256, a.sha256)
  // The card on disk is rebuilt from known fields, with the received file's real hash.
  const card = JSON.parse(await readFile(join(dest, 'adapter.json'), 'utf8'))
  assert.equal(card.format, 'pocket-tune/adapter@1')
  assert.equal(card.adapter.size, 4096)
  assert.equal(card.adapter.sha256, a.sha256)
  assert.equal(card.dataset.train.samples, 12)
  // No staging folders are left next to the runs.
  assert.deepEqual((await (await import('node:fs/promises')).readdir(join(root, 'runs'))).filter((f) => f.startsWith('.')), [])
  await assert.rejects(access(join(dest, 'train.jsonl')), 'training data is never part of a share')

  // Same name again: refused, and the existing run is left alone.
  await assert.rejects(sub.receive({ url: shared.adapterUrl, adapter: 'pirate-voice', dir: dest, resolveBase }), /already exists/)
  await access(join(dest, 'run.json'))

  // An unknown base model leaves nothing half-written behind.
  const other = join(root, 'runs', 'unknown-base')
  await assert.rejects(sub.receive({ url: shared.adapterUrl, adapter: 'pirate-voice', dir: other, resolveBase: async () => { throw Object.assign(new Error('unknown base'), { status: 422 }) } }), /unknown base/)
  await assert.rejects(access(other))

  // Stopping seeding is reflected in the status.
  await pub.stopSeeding()
  assert.equal(pub.status().seeding, false)
})

test('bad links and missing adapters fail with clear errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pt-sharing-'))
  const testnet = await createTestnet(3)
  const s = createSharing({ storeDir: join(root, 'store'), bootstrap: testnet.bootstrap, timeoutMs: 1500 })
  t.after(async () => { await s.close(); await testnet.destroy(); await rm(root, { recursive: true, force: true }) })
  await assert.rejects(s.inspect('https://example.com'), (err) => err.status === 400)
  await assert.rejects(s.inspect('pear://' + 'f'.repeat(64)), (err) => err.status === 504 && /seeding/.test(err.message))
  await assert.rejects(s.receive({ url: 'pear://' + 'f'.repeat(64), adapter: '../etc', dir: join(root, 'x'), resolveBase: async () => ({}) }), (err) => err.status === 400)
})

test('cards from peers are validated before they become runs', () => {
  assert.throws(() => parseCard('nope'), /not valid JSON/)
  assert.throws(() => parseCard(JSON.stringify({ base: { name: '../../model.gguf' }, mode: 'sft' })), /base model/)
  assert.throws(() => parseCard(JSON.stringify({ base: { name: 'QWEN3_600M_INST_Q4' }, mode: 'evil' })), /mode/)
  const { options, metrics } = parseCard(JSON.stringify({ ...CARD, hyperparameters: { numberOfEpochs: 2, 'bad key!': 1, nested: { a: 1 } }, metrics: { val_loss: 1, x: 'str' } }))
  assert.deepEqual(options, { numberOfEpochs: 2, contextLength: 512 })
  // Anything that later sizes a model load is bounded.
  assert.equal(parseCard(JSON.stringify({ ...CARD, hyperparameters: { contextLength: 1e9, numberOfEpochs: 1e6, learningRate: 50 } })).options.contextLength, 512)
  const bounded = parseCard(JSON.stringify({ ...CARD, hyperparameters: { contextLength: 1e9, numberOfEpochs: 1e6, learningRate: 50, loraModules: 'x; rm -rf' } })).options
  assert.deepEqual(bounded, { contextLength: 512 })
  // Malformed nested fields are dropped, not passed to the UI.
  const clean = parseCard(JSON.stringify({ ...CARD, dataset: { train: { samples: { evil: 1 } } }, metrics: 'x' })).card
  assert.deepEqual(clean.dataset, {})
  assert.equal(clean.metrics, null)
  assert.deepEqual(metrics, { val_loss: 1 })
  assert.equal(summarizeCard({ base: { name: 1 }, metrics: { val_loss: 'x' } }).base, null)
  assert.equal(summarizeCard(null), null)
})
