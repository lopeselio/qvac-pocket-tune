import { Directory, File, Paths } from 'expo-file-system'

// The first-run guide shows once. Completion is a small file in Documents, so
// it survives app updates and goes away with the app's data.

const flagFile = () => new File(Paths.document, 'onboarding.json')
let cached: boolean | null = null

export function hasOnboarded (): boolean {
  if (cached !== null) return cached
  try {
    // Anyone who already has runs used the app before the guide existed.
    const runs = new Directory(Paths.document, 'runs')
    cached = flagFile().exists || (runs.exists && runs.list().length > 0)
  } catch {
    cached = false
  }
  return cached
}

export function markOnboarded () {
  cached = true
  try {
    const f = flagFile()
    if (!f.exists) f.create()
    f.write(JSON.stringify({ version: 1, completedAt: new Date().toISOString() }))
  } catch {
    // Not fatal: the guide would show again next launch.
  }
}
