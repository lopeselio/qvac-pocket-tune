// Pure helpers (no Expo imports) so they can be unit-tested under plain Node.

/** QVAC's worker takes plain POSIX paths; Expo gives file:// URIs. */
export function toPosix (uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/+$/, '')
}

export function safeRunName (name: string): string {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!n) throw new Error('Give the run a name (letters, digits, dashes)')
  return n
}
