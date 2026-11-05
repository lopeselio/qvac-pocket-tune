import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as core from 'qvac-pocket-tune/core'

const here = dirname(fileURLToPath(import.meta.url))
const CORE_FILES = ['core.js', 'scrub.js', 'sources.js', 'dataset.js', 'models.js', 'fit.js', 'think.js']

test('core modules import no Node built-ins (so Metro can bundle them)', async () => {
  for (const f of CORE_FILES) {
    const src = await readFile(join(here, '..', 'src', f), 'utf8')
    assert.doesNotMatch(src, /from ['"]node:|require\(['"](fs|path|crypto|os)['"]\)/, f)
  }
})

test('core entry exposes the mobile-facing API', () => {
  for (const name of ['scrub', 'parseWhatsApp', 'chatToConversations', 'buildSftDataset', 'toJsonl', 'PRESETS', 'checkFinetunable', 'ensureFits', 'ThinkFilter']) {
    assert.equal(typeof core[name] !== 'undefined', true, name)
  }
})
