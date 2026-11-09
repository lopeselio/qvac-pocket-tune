// Share adapters from the web UI, and receive adapters other people shared,
// over qvac-seed (Hyperdrive + Hyperswarm). One store and one swarm per server,
// opened on first use, so the UI doesn't lock the store while nobody shares.
//
// Everything that comes from a peer (manifest, card, adapter) is untrusted:
// qvac-seed checks sizes and SHA-256 against the publisher's manifest, and the
// card is validated here before it becomes a run.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { shareAdapter } from './share.js'
import { CARD_FILE, RUN_FILE } from './train.js'

export const SHARE_COLLECTION = 'pocket-tune'
/** The adapter file name a received run uses (what findAdapter() picks up). */
export const RECEIVED_ADAPTER = 'trained-lora-adapter.gguf'
const ADAPTER_PATH = /^\/([a-z0-9][a-z0-9-]{0,62})\/adapter\.gguf$/
const ADAPTER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const MAX_CARD = 256 * 1024
const MAX_ADAPTER = 2 * 1024 ** 3
export const MAX_SYSTEM = 2000

function fail (status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function withTimeout (promise, ms, message) {
  let timer
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(fail(504, message)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const OFFLINE = 'No one is sharing that link right now. Check that the publisher is still seeding, then try again.'

/** A card from a peer, reduced to what the UI shows. Unknown shapes become nulls. */
export function summarizeCard (card) {
  if (!card || typeof card !== 'object') return null
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const str = (x) => (typeof x === 'string' ? x.slice(0, 200) : null)
  const h = card.hyperparameters ?? {}
  const m = card.metrics ?? {}
  return {
    base: str(card.base?.name),
    mode: card.mode === 'sft' || card.mode === 'causal' ? card.mode : null,
    createdAt: str(card.createdAt),
    trainSamples: num(card.dataset?.train?.samples),
    epochs: num(h.numberOfEpochs),
    learningRate: num(h.learningRate),
    valLoss: num(m.val_loss),
    valAccuracy: num(m.val_accuracy),
    trainLoss: num(m.train_loss)
  }
}

/** Validate a card before it becomes a run. Throws a 422 with the reason. */
export function parseCard (text) {
  let card
  try { card = JSON.parse(text) } catch { throw fail(422, 'The shared card is not valid JSON.') }
  if (!card || typeof card !== 'object') throw fail(422, 'The shared card is empty.')
  if (typeof card.base?.name !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(card.base.name)) {
    throw fail(422, 'The shared card does not name a QVAC base model.')
  }
  if (card.mode !== 'sft' && card.mode !== 'causal') throw fail(422, 'The shared card has an unknown training mode.')
  const options = {}
  for (const [k, v] of Object.entries(card.hyperparameters ?? {})) {
    if (!/^[A-Za-z]{1,40}$/.test(k)) continue
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200)) options[k] = v
  }
  if (typeof options.contextLength !== 'number') options.contextLength = 512
  const metrics = {}
  for (const [k, v] of Object.entries(card.metrics ?? {})) {
    if (/^[a-z_]{1,40}$/.test(k) && typeof v === 'number' && Number.isFinite(v)) metrics[k] = v
  }
  return { card, options, metrics: Object.keys(metrics).length ? metrics : null }
}

/**
 * @param {object} [opts]
 * @param {() => Promise<typeof import('qvac-seed')>} [opts.loadSeed]
 * @param {string} [opts.storeDir] defaults to qvac-seed's ($QVAC_SEED_HOME or ~/.qvac-seed/store)
 * @param {any[]} [opts.bootstrap] DHT bootstrap nodes (tests use a local testnet)
 * @param {number} [opts.timeoutMs] how long to look for peers before giving up
 */
export function createSharing ({ loadSeed = () => import('qvac-seed'), storeDir, bootstrap, timeoutMs = 30000 } = {}) {
  let seedPromise = null
  let store = null
  let swarm = null
  let own = null
  let seeding = false
  const remotes = new Map()

  async function lib () {
    seedPromise ??= loadSeed()
    const seed = await seedPromise
    store ??= seed.openStore(storeDir)
    return seed
  }

  async function ownDrive () {
    const seed = await lib()
    try {
      own ??= await seed.openWritableDrive(store, SHARE_COLLECTION)
    } catch (err) {
      if (/lock/i.test(err.message)) throw fail(409, 'The qvac-seed store is in use by another process (for example `pocket-tune share` in a terminal). Stop it and try again.')
      throw err
    }
    return own
  }

  async function network () {
    const seed = await lib()
    swarm ??= seed.createSwarm(store, { bootstrap })
    return { seed, swarm }
  }

  async function startSeeding () {
    const drive = await ownDrive()
    const { seed, swarm: s } = await network()
    await seed.seedDrives(s, [drive])
    seeding = true
  }

  async function stopSeeding () {
    seeding = false
    const s = swarm
    swarm = null
    if (s) await s.destroy()
  }

  /** Publish a run's adapter and card, then seed. */
  async function publish ({ runDir, name, system, run }) {
    const seed = await lib()
    await ownDrive()
    const extraMeta = {
      // Which local run it came from, so the UI can show a run's existing link.
      ...(typeof run === 'string' ? { run } : {}),
      ...(typeof system === 'string' && system.trim() ? { system: system.slice(0, MAX_SYSTEM) } : {})
    }
    const r = await shareAdapter({ runDir, name, seed, store, extraMeta })
    await startSeeding()
    return { name, adapterUrl: r.adapterUrl, cardUrl: r.cardUrl }
  }

  /** The adapters in your own share collection (stable across restarts). */
  async function links () {
    const seed = await lib()
    const drive = await ownDrive()
    const manifest = await seed.readManifest(drive, { wait: false })
    if (!manifest) return []
    return manifest.files.flatMap((f) => {
      const m = ADAPTER_PATH.exec(f.path)
      if (!m) return []
      return [{
        name: m[1],
        size: f.size,
        sha256: f.sha256,
        meta: f.meta,
        adapterUrl: seed.formatPearUrl(drive.key, f.path),
        cardUrl: seed.formatPearUrl(drive.key, `/${m[1]}/adapter.json`)
      }]
    })
  }

  async function openShared (url) {
    const seed = await lib()
    let key
    try { ({ key } = seed.parsePearUrl(String(url ?? '').trim())) } catch (err) { throw fail(400, err.message) }
    const mine = await ownDrive()
    if (mine.key.toString('hex') === key) return { seed, key, drive: mine, own: true }
    let drive = remotes.get(key)
    if (!drive) {
      drive = await seed.openRemoteDrive(store, key)
      remotes.set(key, drive)
    }
    const { swarm: s } = await network()
    await seed.joinDrive(s, drive)
    return { seed, key, drive, own: false }
  }

  async function manifestOf (seed, drive) {
    const manifest = await withTimeout(seed.readManifest(drive), timeoutMs, OFFLINE)
    // A remote drive that synced nothing means no peer had it: nobody is seeding.
    if (!manifest && !drive.writable && !drive.core?.length) throw fail(504, OFFLINE)
    if (!manifest) throw fail(404, 'That link has no qvac-seed manifest, so nothing in it can be verified.')
    return manifest
  }

  async function readCard (seed, drive, manifest, name) {
    const entry = seed.findEntry(manifest, `/${name}/adapter.json`)
    if (!entry || entry.size > MAX_CARD) return null
    try {
      const buf = await withTimeout(drive.get(entry.path, { wait: true }), timeoutMs, OFFLINE)
      if (!buf || createHash('sha256').update(buf).digest('hex') !== entry.sha256) return null
      return JSON.parse(buf.toString('utf8'))
    } catch {
      return null
    }
  }

  /** What a link holds, before downloading anything big. */
  async function inspect (url) {
    const { seed, key, drive, own: isOwn } = await openShared(url)
    const manifest = await manifestOf(seed, drive)
    const adapters = []
    for (const f of manifest.files) {
      const m = ADAPTER_PATH.exec(f.path)
      if (!m) continue
      const card = summarizeCard(await readCard(seed, drive, manifest, m[1]))
      adapters.push({
        name: m[1],
        size: f.size,
        sha256: f.sha256,
        url: seed.formatPearUrl(key, f.path),
        system: typeof f.meta?.system === 'string' ? f.meta.system.slice(0, MAX_SYSTEM) : null,
        card
      })
    }
    if (!adapters.length) throw fail(404, 'That link has no Pocket Tune adapters in it.')
    return { key, own: isOwn, collection: manifest.name, updatedAt: manifest.updatedAt, adapters }
  }

  /**
   * Download one adapter and its card into `dir` (which must not exist),
   * verified against the manifest, and write a run.json so it can be compared.
   * @param {{ url: string, adapter: string, dir: string, resolveBase: (name: string) => Promise<{ spec: string, name: string, src: any, sha256?: string }> }} p
   */
  async function receive ({ url, adapter, dir, resolveBase }) {
    if (typeof adapter !== 'string' || !ADAPTER_NAME.test(adapter)) throw fail(400, 'Pick an adapter from the link.')
    const { seed, key, drive, own: isOwn } = await openShared(url)
    const manifest = await manifestOf(seed, drive)
    const entry = seed.findEntry(manifest, `/${adapter}/adapter.gguf`)
    if (!entry) throw fail(404, `"${adapter}" is not in that link's manifest.`)
    if (entry.size > MAX_ADAPTER) throw fail(413, 'That adapter is larger than 2 GB, which no phone-sized base model needs.')
    const cardEntry = seed.findEntry(manifest, `/${adapter}/adapter.json`)
    if (!cardEntry || cardEntry.size > MAX_CARD) throw fail(422, 'That adapter comes without a valid card, so its base model is unknown.')

    await mkdir(dirname(dir), { recursive: true })
    try {
      await mkdir(dir)
    } catch (err) {
      if (err.code === 'EEXIST') throw fail(409, 'A run with that name already exists. Pick another name.')
      throw err
    }
    try {
      await withTimeout(seed.fetchFile(drive, cardEntry.path, join(dir, CARD_FILE)), timeoutMs, OFFLINE)
      const { card, options, metrics } = parseCard(await readFile(join(dir, CARD_FILE), 'utf8'))
      const base = await resolveBase(card.base.name)
      const warnings = []
      if (card.base.sha256 && base.sha256 && card.base.sha256 !== base.sha256) {
        warnings.push(`The adapter was trained on a different build of ${base.name} than this QVAC version downloads, so answers may differ.`)
      }
      // The adapter is the big file: allow it time, but not forever if the publisher leaves.
      await withTimeout(seed.fetchFile(drive, entry.path, join(dir, RECEIVED_ADAPTER)), Math.max(timeoutMs, 10 * 60 * 1000), OFFLINE)
      const now = new Date().toISOString()
      const run = {
        version: 1,
        createdAt: now,
        status: 'COMPLETED',
        model: { spec: base.spec, name: base.name, src: base.src },
        mode: card.mode,
        system: typeof entry.meta?.system === 'string' ? entry.meta.system.slice(0, MAX_SYSTEM) : null,
        options,
        stats: metrics,
        received: { url: seed.formatPearUrl(key, entry.path), sha256: entry.sha256, own: isOwn, at: now },
        updatedAt: now
      }
      await writeFile(join(dir, RUN_FILE), JSON.stringify(run, null, 2) + '\n')
      return { warnings }
    } catch (err) {
      await rm(dir, { recursive: true, force: true })
      throw err
    }
  }

  return {
    status: () => ({ started: !!store, seeding, peers: swarm?.connections?.size ?? 0 }),
    publish,
    links,
    inspect,
    receive,
    startSeeding,
    stopSeeding,
    async close () {
      await stopSeeding().catch(() => {})
      for (const d of remotes.values()) await d.close().catch(() => {})
      remotes.clear()
      if (own) await own.close().catch(() => {})
      own = null
      if (store) await store.close().catch(() => {})
      store = null
      seedPromise = null
    }
  }
}
