import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as seed from 'qvac-seed'
import { shareAdapter } from '../src/share.js'

test('publishes adapter and card (not data) into the pocket-tune collection', async (t) => {
  const d = await mkdtemp(join(tmpdir(), 'pt-share-'))
  const store = seed.openStore(join(d, 'store'))
  t.after(async () => { await store.close(); await rm(d, { recursive: true, force: true }) })
  await writeFile(join(d, 'trained-lora-adapter.gguf'), 'ADAPTER')
  await writeFile(join(d, 'train.jsonl'), '{"secret":"data"}\n')
  await writeFile(join(d, 'adapter.json'), JSON.stringify({ base: { name: 'QWEN3_600M_INST_Q4', sha256: 'c'.repeat(64) }, mode: 'sft' }))

  const r = await shareAdapter({ runDir: d, name: 'pirate-voice', seed, store })
  assert.match(r.adapterUrl, /^pear:\/\/[a-f0-9]{64}\/pirate-voice\/adapter\.gguf$/)
  const manifest = await seed.readManifest(r.drive, { wait: false })
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['/pirate-voice/adapter.gguf', '/pirate-voice/adapter.json'])
  assert.equal(manifest.files[0].meta.base, 'QWEN3_600M_INST_Q4')
  await assert.rejects(shareAdapter({ runDir: d, name: 'Bad Name', seed, store }), /lowercase/)
})
