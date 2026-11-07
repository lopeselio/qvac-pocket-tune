// Turn a recording (or a voice memo file) into what QVAC Whisper wants:
// 16 kHz, mono, 16-bit PCM WAV. Browsers record WebM/Opus or MP4/AAC, so
// decode with Web Audio, resample with an OfflineAudioContext, and encode.

const RATE = 16000
export const MAX_SECONDS = 180

export async function toWav16k (blob: Blob): Promise<{ wav: Uint8Array, seconds: number }> {
  const ctx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
  } catch {
    throw new Error("Couldn't read that audio. Try m4a, mp3, wav or a recording from this page.")
  } finally {
    void ctx.close()
  }
  if (decoded.duration > MAX_SECONDS + 1) throw new Error(`That clip is ${Math.round(decoded.duration)} s. Keep clips under ${MAX_SECONDS / 60} minutes.`)
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE))
  const offline = new OfflineAudioContext(1, frames, RATE) // mono: channels are mixed down
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const mono = (await offline.startRendering()).getChannelData(0)
  return { wav: encodeWav(mono), seconds: decoded.duration }
}

function encodeWav (samples: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true)
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true)
  str(36, 'data'); out.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return new Uint8Array(out.buffer)
}

export function toBase64 (bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Microphone recording with a running timer and an automatic stop at MAX_SECONDS. */
export class Recorder {
  private rec: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private done: ((b: Blob) => void) | null = null

  get recording () { return this.rec?.state === 'recording' }

  async start (onAutoStop: (b: Blob) => void) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no microphone access here.')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch {
      throw new Error('Microphone permission was denied. Allow it in the address bar and try again.')
    }
    this.chunks = []
    this.done = null // a previous cancel() must not swallow this recording
    this.rec = new MediaRecorder(this.stream)
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data) }
    this.rec.onstop = () => {
      this.stream?.getTracks().forEach((t) => t.stop())
      const blob = new Blob(this.chunks, { type: this.rec?.mimeType || 'audio/webm' })
      ;(this.done ?? onAutoStop)(blob)
      this.done = null
    }
    this.rec.start()
    this.timer = setTimeout(() => { if (this.recording) this.rec!.stop() }, MAX_SECONDS * 1000)
  }

  stop (): Promise<Blob> {
    clearTimeout(this.timer)
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state !== 'recording') return resolve(new Blob())
      this.done = resolve
      this.rec.stop()
    })
  }

  /** Stop without keeping anything (e.g. the component unmounted). */
  cancel () {
    clearTimeout(this.timer)
    this.done = () => {}
    if (this.recording) this.rec!.stop()
    else this.stream?.getTracks().forEach((t) => t.stop())
  }
}
