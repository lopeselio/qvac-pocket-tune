// Training data never leaves the device, but the *adapter* might: LoRA weights
// can memorise strings verbatim, and people share adapters. So by default we
// replace obvious secrets and identifiers before training. This is a
// best-effort filter, not a guarantee. The README says so too.

import { wordlist as BIP39 } from '@scure/bip39/wordlists/english.js'

const BIP39_SET = new Set(BIP39)

// A run of 12+ consecutive BIP-39 words is almost certainly a recovery phrase:
// ordinary prose ("please remember that we should…") breaks the run quickly.
function scrubSeedPhrases (text, counts) {
  const tokens = text.split(/(\s+)/)
  let runStart = -1
  let runEnd = -1
  let runWords = 0
  const out = [...tokens]
  const flush = () => {
    if (runWords >= 12) {
      // Only through the last word, so the space after the phrase survives.
      for (let i = runStart; i <= runEnd; i++) out[i] = ''
      out[runStart] = '[SEED_PHRASE]'
      counts.SEED_PHRASE = (counts.SEED_PHRASE ?? 0) + 1
    }
    runStart = -1
    runWords = 0
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^\s+$/.test(t)) continue
    if (BIP39_SET.has(t.toLowerCase())) {
      if (runStart === -1) runStart = i
      runEnd = i
      runWords++
    } else {
      flush()
    }
  }
  flush()
  // Collapse whitespace left behind by removed words.
  return out.join('').replace(/\[SEED_PHRASE\]\s+(?=\S)/g, '[SEED_PHRASE] ')
}

const RULES = [
  // Order matters: specific patterns before generic ones.
  ['PRIVATE_KEY', /\b(?:0x)?[a-fA-F0-9]{64}\b/g],
  ['API_KEY', /\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{16,}\b/g],
  ['EMAIL', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['EVM_ADDRESS', /\b0x[a-fA-F0-9]{40}\b/g],
  ['BTC_ADDRESS', /\b(?:bc1[a-z0-9]{25,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g],
  ['IBAN', /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}\s?[A-Z0-9]{1,4}\b/g],
  ['CARD', /\b(?:\d[ -]?){13,19}\b/g],
  ['PHONE', /(?<![\w])\+?\d[\d\s().-]{7,}\d(?![\w])/g],
  ['URL_TOKEN', /\bhttps?:\/\/\S*[?&](?:token|key|sig|signature|auth|access_token)=\S+/gi]
]

/**
 * @param {string} text
 * @param {{ keep?: string[] }} [opts] rule names to leave untouched
 * @returns {{ text: string, counts: Record<string, number> }}
 */
export function scrub (text, { keep = [] } = {}) {
  const counts = {}
  let out = keep.includes('SEED_PHRASE') ? text : scrubSeedPhrases(text, counts)
  for (const [name, re] of RULES) {
    if (keep.includes(name)) continue
    out = out.replace(re, (m) => {
      // Don't eat short numbers that the CARD/PHONE rules would over-match,
      // e.g. "2024-05-01" or "10.000.000".
      if ((name === 'CARD' || name === 'PHONE') && looksLikeDateOrAmount(m)) return m
      counts[name] = (counts[name] ?? 0) + 1
      // Some patterns end on an optional separator; keep trailing spaces.
      return `[${name}]${m.match(/\s*$/)[0]}`
    })
  }
  return { text: out, counts }
}

function looksLikeDateOrAmount (s) {
  const t = s.trim()
  return /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t) ||
    /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(t) ||
    /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?$/.test(t) ||
    t.replace(/\D/g, '').length < 9
}

export const SCRUB_RULES = ['SEED_PHRASE', ...RULES.map(([name]) => name)]
