import type { Tick } from '../api'

const W = 640
const H = 220
const PAD = { l: 40, r: 12, t: 12, b: 26 }

/**
 * Training loss per step (raw, faint) with a smoothed line on top, and the
 * validation loss at the end of each epoch as dots.
 */
export function LossChart ({ ticks }: { ticks: Tick[] }) {
  const train = ticks.filter((t) => t.train && t.loss != null && Number.isFinite(t.loss))
  if (train.length < 2) {
    return <div className='chart-empty'>The loss curve appears after the first few steps.</div>
  }

  // Last validation tick of each epoch, placed at that epoch's last train step.
  const lastTrainIdx = new Map<number, number>()
  train.forEach((t, i) => lastTrainIdx.set(t.epoch, i))
  const val = new Map<number, number>()
  for (const t of ticks) if (!t.train && t.loss != null && Number.isFinite(t.loss) && t.batch === t.batches) val.set(t.epoch, t.loss)
  const valPoints = [...val].filter(([e]) => lastTrainIdx.has(e)).map(([e, loss]) => ({ i: lastTrainIdx.get(e)!, loss, epoch: e }))

  const max = Math.max(...train.map((t) => t.loss!), ...valPoints.map((v) => v.loss)) * 1.08
  const x = (i: number) => PAD.l + (i / (train.length - 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b)

  // Trailing moving average. An EMA lags far behind the steep drop in the
  // first steps and makes the curve look worse than it is.
  const win = Math.max(1, Math.round(train.length / 25))
  let sum = 0
  const smooth = train.map((t, i) => {
    sum += t.loss!
    if (i >= win) sum -= train[i - win].loss!
    return sum / Math.min(i + 1, win)
  })
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')

  const epochStarts = train.map((t, i) => (i > 0 && t.epoch !== train[i - 1].epoch ? i : -1)).filter((i) => i > 0)
  const gridVals = [0.25, 0.5, 0.75, 1].map((f) => f * max)
  const lastLoss = smooth.at(-1)!

  return (
    <figure className='chart'>
      <svg viewBox={`0 0 ${W} ${H}`} role='img' aria-label={`Training loss over ${train.length} steps, now about ${lastLoss.toFixed(2)}`}>
        {gridVals.map((v) => (
          <g key={v}>
            <line className='grid-line' x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className='axis' x={PAD.l - 6} y={y(v) + 4} textAnchor='end'>{v.toFixed(v < 1 ? 2 : 1)}</text>
          </g>
        ))}
        <line className='base-line' x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
        {epochStarts.map((i) => (
          <g key={i}>
            <line className='epoch-line' x1={x(i)} x2={x(i)} y1={PAD.t} y2={H - PAD.b} />
            <text className='axis' x={x(i) + 4} y={H - 8}>epoch {train[i].epoch + 1}</text>
          </g>
        ))}
        <text className='axis' x={PAD.l} y={H - 8}>epoch {train[0].epoch + 1}</text>
        <path className='loss-raw' d={line(train.map((t) => t.loss!))} />
        <path className='loss' d={line(smooth)} />
        {valPoints.map((v) => (
          <circle key={v.epoch} className='val-dot' cx={x(v.i)} cy={y(v.loss)} r={5}><title>epoch {v.epoch + 1} validation loss {v.loss.toFixed(3)}</title></circle>
        ))}
      </svg>
      <figcaption className='legend'>
        <span><i className='sw loss' /> training loss (smoothed)</span>
        {valPoints.length > 0 && <span><i className='sw val' /> validation loss per epoch</span>}
      </figcaption>
    </figure>
  )
}
