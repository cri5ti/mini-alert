// Main-thread time spent scheduling sound, and how many synth voices are still alive.
export type Stat = { last: number; avg: number; peak: number; peakAt: number; calls: number }

export const stats: Record<string, Stat> = {}
let created = 0
const live: number[] = []

export function countVoice(end: number) {
  created++
  live.push(end)
}

export const voicesCreated = () => created

export function liveVoices(now: number) {
  let i = 0
  for (let j = 0; j < live.length; j++) if (live[j] > now) live[i++] = live[j]
  live.length = i
  return i
}

export function measure<T>(name: string, fn: () => T): T {
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    const t1 = performance.now()
    const ms = t1 - t0
    const s = (stats[name] ??= { last: 0, avg: 0, peak: 0, peakAt: 0, calls: 0 })
    s.last = ms
    s.avg = s.calls ? s.avg * 0.9 + ms * 0.1 : ms
    s.calls++
    if (ms >= s.peak || t1 - s.peakAt > 5000) {
      s.peak = ms
      s.peakAt = t1
    }
  }
}
