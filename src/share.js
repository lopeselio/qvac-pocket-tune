import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CARD_FILE, findAdapter } from './train.js'

/**
 * Publish an adapter + its card into a qvac-seed collection. Returns the
 * pear:// links; the caller decides whether to keep seeding.
 * Only the adapter and card are published, never the training data.
 * @param {{ runDir: string, name: string, seed: typeof import('qvac-seed'), store?: any }} p
 */
export async function shareAdapter ({ runDir, name, seed, store }) {
  runDir = resolve(runDir)
  const adapter = await findAdapter(runDir)
  if (!adapter) throw new Error(`No adapter in ${runDir} to share. Train first.`)
  const card = JSON.parse(await readFile(join(runDir, CARD_FILE), 'utf8'))
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('Adapter name must be lowercase letters, digits and dashes')

  const st = store ?? seed.openStore()
  const drive = await seed.openWritableDrive(st, 'pocket-tune')
  const meta = {
    base: card.base.name,
    ...(card.base.sha256 ? { baseSha256: card.base.sha256 } : {}),
    mode: card.mode,
    tool: 'pocket-tune'
  }
  const a = await seed.publishFile(drive, adapter, { as: `${name}/adapter.gguf`, meta })
  const c = await seed.publishFile(drive, join(runDir, CARD_FILE), { as: `${name}/adapter.json`, meta })
  return { store: st, drive, adapterUrl: a.url, cardUrl: c.url, card }
}
