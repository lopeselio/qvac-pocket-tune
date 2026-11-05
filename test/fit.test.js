import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFit, describeFit, ensureFits, ModelTooLargeError } from '../src/fit.js'

const RESULT = {
  verdict: 'likely-too-large',
  evidence: 'native-fit',
  budget: { availableAfterReserveBytes: 5744 * 1024 * 1024 },
  models: [
    { name: 'QWEN3_600M_INST_Q4', verdict: 'likely-fits', device: 'gpu', reasons: ['fits'] },
    { name: 'BIG', verdict: 'likely-too-large', device: 'gpu', reasons: ['exceeds-available-memory', 'needs 20841 MiB against a 5744 MiB budget'] }
  ],
  reasons: []
}
const sdkWith = (r) => ({ async assessModelFit (p) { this.last = p; if (r instanceof Error) throw r; return r } })

test('checkFit summarises the SDK result and passes loads through', async () => {
  const sdk = sdkWith(RESULT)
  const fit = await checkFit(sdk, [{ modelSrc: 'x' }], { execution: 'concurrent' })
  assert.equal(fit.verdict, 'likely-too-large')
  assert.equal(fit.availableMiB, 5744)
  assert.deepEqual(sdk.last, { models: [{ modelSrc: 'x' }], execution: 'concurrent' })
  assert.deepEqual(describeFit(fit), [
    'QWEN3_600M_INST_Q4: likely fits (gpu)',
    'BIG: likely too large (gpu) — exceeds-available-memory; needs 20841 MiB against a 5744 MiB budget'
  ])
})

test('missing or failing assessModelFit degrades to unknown', async () => {
  assert.equal((await checkFit({}, [])).verdict, 'unknown')
  const f = await checkFit(sdkWith(new Error('registry offline')), [])
  assert.equal(f.verdict, 'unknown')
  assert.match(describeFit(f)[0], /registry offline/)
})

test('ensureFits refuses too-large unless forced; unknown passes', async () => {
  await assert.rejects(ensureFits(sdkWith(RESULT), []), (e) => e instanceof ModelTooLargeError && /--force/.test(e.message))
  assert.equal((await ensureFits(sdkWith(RESULT), [], { force: true })).verdict, 'likely-too-large')
  assert.equal((await ensureFits(sdkWith({ verdict: 'unknown', models: [] }), [])).verdict, 'unknown')
})
