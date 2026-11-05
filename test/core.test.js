import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as core from 'qvac-pocket-tune/core'

const here = dirname(fileURLToPath(import.meta.url))
const CORE_FILES = ['core.js', 'scrub.js', 'sources.js', 'dataset.js', 'models.js', 'fit.js', 'think.js', 'build.js']

test('core modules import no Node built-ins (so Metro can bundle them)', async () => {
  for (const f of CORE_FILES) {
    const src = await readFile(join(here, '..', 'src', f), 'utf8')
    assert.doesNotMatch(src, /from ['"]node:|require\(['"](fs|path|crypto|os)['"]\)/, f)
  }
})

test('core entry exposes the mobile-facing API', () => {
  for (const name of ['scrub', 'parseWhatsApp', 'chatToConversations', 'buildSftDataset', 'toJsonl', 'PRESETS', 'checkFinetunable', 'ensureFits', 'ThinkFilter', 'buildDatasetFromTexts', 'buildFinetuneOptions']) {
    assert.equal(typeof core[name] !== 'undefined', true, name)
  }
})

test('buildDatasetFromTexts works on in-memory files (as the mobile app uses it)', () => {
  const ds = core.buildDatasetFromTexts([{ name: 'faq.csv', text: 'question,answer\nhi,ahoy\nbye,fair winds\n' }], { system: 'Pirate.', evalFraction: 0 })
  assert.equal(ds.mode, 'sft')
  assert.equal(ds.trainName, 'train.jsonl')
  assert.equal(ds.trainText.trim().split('\n').length, 2)
  assert.equal(JSON.parse(ds.trainText.split('\n')[0]).messages[0].content, 'Pirate.')
})

test('buildFinetuneOptions uses POSIX paths and SFT-only loss', () => {
  const o = core.buildFinetuneOptions({ runDir: '/var/mobile/Documents/runs/a/', mode: 'sft', trainPath: '/x/train.jsonl', evalPath: '/x/eval.jsonl', hasEval: true, hyper: { numberOfEpochs: 4 } })
  assert.equal(o.checkpointSaveDir, '/var/mobile/Documents/runs/a/checkpoints')
  assert.equal(o.outputParametersDir, '/var/mobile/Documents/runs/a')
  assert.equal(o.assistantLossOnly, true)
  assert.equal(o.numberOfEpochs, 4)
  assert.equal(o.contextLength, 512)
})
