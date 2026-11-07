/**
 * Streaming filter that hides <think>…</think> blocks (Qwen3 reasons by
 * default) so output reads like the trained voice. Handles tags split
 * across token deltas by holding back a possible partial tag.
 *
 * Qwen3 follows the closing tag with blank lines, so whitespace right after
 * </think> is dropped too; whitespace anywhere else is kept.
 */
export class ThinkFilter {
  constructor () { this.buf = ''; this.inThink = false; this.afterThink = false }

  push (delta) {
    this.buf += delta
    let out = ''
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>')
        if (end === -1) { this.buf = this.buf.slice(-7); return out }
        this.buf = this.buf.slice(end + 8)
        this.inThink = false
        this.afterThink = true
      } else {
        if (this.afterThink) {
          this.buf = this.buf.trimStart()
          if (!this.buf) return out // still only whitespace; wait for more
          this.afterThink = false
        }
        const start = this.buf.indexOf('<think>')
        if (start === -1) {
          // Keep a trailing "<thi" in case the tag continues in the next delta.
          const hold = partialTagSuffix(this.buf, '<think>')
          out += this.buf.slice(0, this.buf.length - hold)
          this.buf = this.buf.slice(this.buf.length - hold)
          return out
        }
        out += this.buf.slice(0, start)
        this.buf = this.buf.slice(start + 7)
        this.inThink = true
      }
    }
  }

  flush () {
    const rest = this.inThink ? '' : this.buf
    this.buf = ''
    return rest
  }
}

function partialTagSuffix (s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n
  }
  return 0
}

/**
 * Qwen3 can spend a whole reply budget "thinking" and never close the block
 * (it does without a short-answer system prompt), which leaves no visible
 * answer. Its documented soft switch, /no_think, turns that off. Returns the
 * history with the switch added to the system message (or a new one).
 */
export function withNoThink (history) {
  const [first, ...rest] = history
  if (first?.role === 'system') return [{ ...first, content: `${first.content ?? ''} /no_think`.trim() }, ...rest]
  return [{ role: 'system', content: '/no_think' }, ...history]
}

/**
 * Run `once(history)` and, if it produced no visible answer, run it again
 * with thinking switched off. Shared by the CLI and the mobile app so the
 * rule lives in one place. Always sending /no_think was measured to make
 * answers worse (empty and contradictory base answers on the pirate demo),
 * so it's only a fallback. Returns { text, noThink } so callers can show
 * that this answer was asked differently.
 */
export async function withThinkingFallback (history, once, { aborted = () => false, onRetry = () => {} } = {}) {
  const text = await once(history)
  if (text || aborted()) return { text, noThink: false }
  onRetry()
  return { text: await once(withNoThink(history)), noThink: true }
}
