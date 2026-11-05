import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeRunName, toPosix } from '../src/paths.ts'

test('toPosix strips file:// and decodes, as the QVAC worker expects', () => {
  assert.equal(toPosix('file:///var/mobile/Containers/Data/Application/ABC/Documents/runs/my%20voice/'), '/var/mobile/Containers/Data/Application/ABC/Documents/runs/my voice')
  assert.equal(toPosix('/data/user/0/app/files/runs/a/train.jsonl'), '/data/user/0/app/files/runs/a/train.jsonl')
})

test('safeRunName makes a filesystem-safe slug', () => {
  assert.equal(safeRunName('  My Pirate Voice! '), 'my-pirate-voice')
  assert.equal(safeRunName('a/../../etc'), 'a-etc')
  assert.throws(() => safeRunName('!!!'), /name/)
})
