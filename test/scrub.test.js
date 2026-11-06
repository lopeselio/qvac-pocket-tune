import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrub } from '../src/scrub.js'

test('redacts emails, phones, wallet addresses and keys', () => {
  const input = [
    'mail me at jane.doe+work@example.co.uk',
    'call +44 20 7946 0958',
    'send to 0x52908400098527886E0F7030069857D2E4169EE7',
    'my key 4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    'token ghp_abcdefghijklmnopqrstuvwx1234'
  ].join('\n')
  const { text, counts } = scrub(input)
  assert.doesNotMatch(text, /jane\.doe|7946|52908400|4c0883|ghp_/)
  assert.deepEqual(counts, { EMAIL: 1, PHONE: 1, EVM_ADDRESS: 1, PRIVATE_KEY: 1, API_KEY: 1 })
})

test('redacts a 12-word seed phrase', () => {
  const { text } = scrub('backup: abandon ability able about above absent absorb abstract absurd abuse access accident thanks')
  assert.match(text, /\[SEED_PHRASE\]/)
  assert.doesNotMatch(text, /abandon/)
})

test('does not mistake ordinary lowercase prose for a seed phrase', () => {
  const s = 'please remember that we should go there before dinner since your mother wants some fresh bread'
  assert.equal(scrub(s).text, s)
})

test('leaves dates, amounts and ordinary prose alone', () => {
  const s = 'On 2024-05-01 we shipped v1.2 to 10,000,000 users at 9:30. Call it a win.'
  assert.equal(scrub(s).text, s)
})

test('keep option disables a rule', () => {
  const { text } = scrub('ping a@b.io', { keep: ['EMAIL'] })
  assert.equal(text, 'ping a@b.io')
})

test('keeps the space after a scrubbed seed phrase or card number', () => {
  const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  assert.equal(scrub(`mine were ${words} lol`).text, 'mine were [SEED_PHRASE] lol')
  assert.equal(scrub('did you type 4111 1111 1111 1111 right?').text, 'did you type [CARD] right?')
})
