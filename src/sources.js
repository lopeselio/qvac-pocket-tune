// Turn the stuff people actually have (notes, chat exports, FAQs) into the two
// dataset shapes QVAC's finetune() accepts:
//   - SFT:    { messages: [{ role, content }, ...] } per JSONL line
//   - causal: plain text
// Every parser is pure (string in, records out) so it runs anywhere the SDK
// does, including Expo on a phone.

/** @typedef {{ role: 'system'|'user'|'assistant', content: string }} Message */
/** @typedef {{ messages: Message[] }} Conversation */

// ---------- Markdown / text notes → causal text ----------

export function notesToText (markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '') // YAML front matter
    .replace(/```[\s\S]*?```/g, '') // code blocks are rarely "your voice"
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b ?? a) // wiki links
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+\[[ x]\]\s+/gim, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------- WhatsApp export → conversations ----------

// Android: "12/31/23, 9:41 PM - Name: text"   iOS: "[31/12/2023, 21:41:05] Name: text"
const WA_LINE = /^‎?\[?(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap]\.?[Mm]\.?)?)\]?\s*(?:-\s*)?([^:]+?):\s([\s\S]*)$/
const WA_SKIP = /^(<Media omitted>|<attached:|This message was deleted|You deleted this message|Missed (voice|video) call|image omitted|sticker omitted|audio omitted|video omitted|GIF omitted)/i

function parseWaTimestamp (date, time) {
  const parts = date.split(/[./-]/).map(Number)
  let [a, b, c] = parts
  let y, m, d
  if (a > 31) { y = a; m = b; d = c } else {
    y = c < 100 ? 2000 + c : c
    // Ambiguous d/m vs m/d: assume day-first unless that's impossible.
    if (b > 12) { m = a; d = b } else { d = a; m = b }
  }
  let [hh, mm, ss = 0] = time.replace(/\s?[APap]\.?[Mm]\.?/, '').split(':').map(Number)
  const pm = /p/i.test(time)
  const am = /a/i.test(time)
  if (pm && hh < 12) hh += 12
  if (am && hh === 12) hh = 0
  return Date.UTC(y, m - 1, d, hh, mm, ss)
}

/**
 * Parse a WhatsApp "Export chat" .txt into messages.
 * @returns {{ at: number, author: string, text: string }[]}
 */
export function parseWhatsApp (txt) {
  const msgs = []
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/‎/g, '')
    const m = line.match(WA_LINE)
    if (m) {
      const [, date, time, author, text] = m
      msgs.push({ at: parseWaTimestamp(date, time), author: author.trim(), text })
    } else if (msgs.length && line.trim()) {
      msgs[msgs.length - 1].text += '\n' + line // multi-line message
    }
  }
  return msgs.filter((x) => x.text.trim() && !WA_SKIP.test(x.text.trim()))
}

/**
 * Group a chat log into training conversations where *your* messages are
 * the assistant turns. Consecutive messages by the same side are merged, and
 * a silence longer than `gapMinutes` starts a new conversation.
 * @param {{ at: number, author: string, text: string }[]} msgs
 * @param {{ me: string, gapMinutes?: number, system?: string, minTurns?: number }} opts
 * @returns {Conversation[]}
 */
export function chatToConversations (msgs, { me, gapMinutes = 60, system, minTurns = 2 }) {
  if (!me) throw new Error('Tell pocket-tune which participant is you (--me "Your Name")')
  const authors = new Set(msgs.map((m) => m.author))
  if (!authors.has(me)) {
    throw new Error(`"${me}" never speaks in this chat. Participants: ${[...authors].join(', ')}`)
  }
  const convos = []
  let cur = []
  let lastAt = -Infinity
  const close = () => {
    // Training targets are assistant turns, so drop leading assistant turns
    // (nothing to respond to) and trailing user turns (no response).
    while (cur.length && cur[0].role === 'assistant') cur.shift()
    while (cur.length && cur[cur.length - 1].role === 'user') cur.pop()
    if (cur.filter((t) => t.role === 'assistant').length >= minTurns / 2 && cur.length >= minTurns) {
      convos.push({ messages: system ? [{ role: 'system', content: system }, ...cur] : cur })
    }
    cur = []
  }
  for (const m of msgs) {
    if (m.at - lastAt > gapMinutes * 60_000) close()
    lastAt = m.at
    const role = m.author === me ? 'assistant' : 'user'
    const prev = cur[cur.length - 1]
    if (prev && prev.role === role) prev.content += '\n' + m.text.trim()
    else cur.push({ role, content: m.text.trim() })
  }
  close()
  return convos
}

// ---------- Generic chat JSON / JSONL ----------

const ROLES = new Set(['system', 'user', 'assistant', 'tool'])

/** Accepts JSONL of {messages}, or a JSON array of {messages} / of messages. */
export function parseChatJson (text) {
  const trimmed = text.trim()
  let items
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed)
    items = arr.length && arr[0].role ? [{ messages: arr }] : arr
  } else {
    items = trimmed.split(/\r?\n/).filter(Boolean).map((l, i) => {
      try { return JSON.parse(l) } catch { throw new Error(`Line ${i + 1} is not valid JSON`) }
    })
  }
  return items.map((it, i) => {
    const messages = it.messages ?? it.conversation ?? it
    if (!Array.isArray(messages)) throw new Error(`Item ${i + 1} has no messages array`)
    for (const msg of messages) {
      if (!ROLES.has(msg.role) || typeof msg.content !== 'string') {
        throw new Error(`Item ${i + 1}: every message needs a role (${[...ROLES].join('/')}) and string content`)
      }
    }
    return { messages: messages.map(({ role, content }) => ({ role, content })) }
  })
}

// ---------- Q&A CSV ----------

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, newlines in fields). */
export function parseCsv (text) {
  const rows = []
  let row = []
  let field = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (c === '"') q = false
      else field += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(field); field = '' } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim()))
}

/** CSV with question/answer columns (header names are flexible). */
export function qaCsvToConversations (text, { system } = {}) {
  const [header, ...rows] = parseCsv(text)
  const h = header.map((x) => x.trim().toLowerCase())
  const qi = h.findIndex((x) => ['question', 'q', 'prompt', 'input', 'user'].includes(x))
  const ai = h.findIndex((x) => ['answer', 'a', 'response', 'output', 'assistant', 'completion'].includes(x))
  if (qi === -1 || ai === -1) throw new Error('CSV needs question and answer columns (e.g. "question,answer")')
  return rows
    .filter((r) => r[qi]?.trim() && r[ai]?.trim())
    .map((r) => ({
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: r[qi].trim() },
        { role: 'assistant', content: r[ai].trim() }
      ]
    }))
}

/** Guess the parser from a file name. */
export function detectSourceType (file) {
  const f = file.toLowerCase()
  if (f.endsWith('.md') || f.endsWith('.markdown')) return 'notes'
  if (f.endsWith('.csv')) return 'qa-csv'
  if (f.endsWith('.jsonl') || f.endsWith('.json')) return 'chat-json'
  if (f.endsWith('.txt')) return /whatsapp|chat/.test(f) ? 'whatsapp' : 'notes'
  return null
}
