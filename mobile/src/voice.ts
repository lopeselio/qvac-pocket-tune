// Pure helpers for speaking answers and notes (no Expo imports, so they run
// under plain Node in tests). Mirrors ui/src/components/{VoiceInput,DataTab}.tsx
// so the phone and the web UI build the same datasets from speech.

import { detectSourceType } from '../../src/sources.js'

/** Open questions that draw out how you talk. Same list as the web UI. */
export const QUESTIONS = [
  'What do you do for work?',
  'How would you explain your job to a friend?',
  'What does a good weekend look like for you?',
  'What advice would you give someone starting out in your field?',
  'How do you stay focused?',
  'What is a book or film you would recommend, and why?',
  'What do you think about AI?',
  'How would you explain crypto to someone new to it?',
  'What is your favourite food?',
  'What is something you changed your mind about?'
]

/** Whisper models. The multilingual one needs language 'auto', or it hears English. */
export const SPEECH_MODELS = {
  en: { constant: 'WHISPER_EN_BASE_Q8_0', label: 'English', language: 'en' },
  multi: { constant: 'WHISPER_BASE_Q8_0', label: 'Other languages', language: 'auto' }
} as const
export type SpeechKey = keyof typeof SPEECH_MODELS

export const MAX_CLIP_SECONDS = 180
/** Compressed voice memos are well under 2 MB a minute. */
export const MAX_CLIP_BYTES = 40 * 1024 * 1024
/** What QVAC's decoder reads (FORMATS_NEEDING_DECODE in @qvac/inference). */
export const AUDIO_EXTENSIONS = ['.m4a', '.mp3', '.wav', '.aac', '.ogg', '.flac']

export type VoiceMode = 'qa' | 'notes'
export interface SpokenAnswer { q: string, a: string }

export function audioExtensionOk (name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot !== -1 && AUDIO_EXTENSIONS.includes(name.slice(dot).toLowerCase())
}

const csvField = (s: string) => `"${s.replace(/"/g, '""')}"`

/** Spoken answers and notes, as the sources the dataset builder understands. */
export function voiceSources (qa: SpokenAnswer[], notes: string[]): { name: string, type: string, text: string }[] {
  const out: { name: string, type: string, text: string }[] = []
  if (qa.length) out.push({ name: 'voice-answers.csv', type: 'qa-csv', text: ['question,answer', ...qa.map((x) => `${csvField(x.q)},${csvField(x.a)}`)].join('\n') + '\n' })
  if (notes.length) out.push({ name: 'voice-notes.txt', type: 'notes', text: notes.join('\n\n') })
  return out
}

/** Joins a new clip onto what was already transcribed, as the web UI does. */
export function appendTranscript (prev: string | null, next: string): string {
  return prev ? `${prev} ${next}` : next
}

export function uniqueName (base: string, taken: string[]): string {
  const set = new Set(taken)
  if (!set.has(base)) return base
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`
}

/**
 * The dataset mode picked files commit the run to, using the same type rules
 * as the dataset builder. A run trains on notes or on chats/Q&A, never both.
 */
export function filesMode (files: { name: string }[], override: string | null): VoiceMode | null {
  for (const f of files) {
    const kind = override ?? detectSourceType(f.name)
    if (kind) return kind === 'notes' ? 'notes' : 'qa'
  }
  return null
}

export function lockedMode (qa: SpokenAnswer[], notes: string[], fromFiles: VoiceMode | null = null): VoiceMode | null {
  return qa.length ? 'qa' : notes.length ? 'notes' : fromFiles
}
