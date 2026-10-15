import { TRACE_LABEL, TraceSlot } from '../shared/trace.ts'

const flag = process.env.TRACE
export const __TRACE__ = flag === '1' || flag === 'true'

const WINDOW = 30
const SLOT_COUNT = TraceSlot.Idle + 1

const tickMs = new Float64Array(SLOT_COUNT)
const sumMs = new Float64Array(SLOT_COUNT)
const stack: { slot: number; t: number }[] = []
let ticks = 0
const periodMs = new Float64Array(SLOT_COUNT)
let periodReports = 0
let periodBudget = 0
let now = () => performance.now()

export function traceClock(fn: (() => number) | null) {
  now = fn ?? (() => performance.now())
}

export type TraceReport = {
  samples: { slot: number; ms: number }[]
  budget: number
}

export function traceReset() {
  tickMs.fill(0)
  stack.length = 0
}

export function traceBegin(slot: number) {
  const mark = now()
  const parent = stack[stack.length - 1]
  if (parent) {
    tickMs[parent.slot] += mark - parent.t
    parent.t = mark
  }
  stack.push({ slot, t: mark })
}

export function traceEnd() {
  const mark = now()
  const top = stack.pop()
  if (!top) return
  tickMs[top.slot] += mark - top.t
  const parent = stack[stack.length - 1]
  if (parent) parent.t = mark
}

export function traceCommit(elapsed: number, budget: number, window = WINDOW): TraceReport | null {
  while (stack.length > 0) traceEnd()
  let accounted = 0
  for (let slot = 0; slot < TraceSlot.Other; slot++) accounted += tickMs[slot]
  tickMs[TraceSlot.Other] = Math.max(0, elapsed - accounted)
  tickMs[TraceSlot.Idle] = Math.max(0, budget - elapsed)
  for (let slot = 0; slot < SLOT_COUNT; slot++) sumMs[slot] += tickMs[slot]
  tickMs.fill(0)
  ticks += 1
  if (ticks < window) return null
  const samples: { slot: number; ms: number }[] = []
  for (let slot = 0; slot < SLOT_COUNT; slot++) samples.push({ slot, ms: sumMs[slot] / ticks })
  sumMs.fill(0)
  ticks = 0
  return { samples, budget }
}

export function traceTally(report: TraceReport) {
  for (const sample of report.samples) periodMs[sample.slot] += sample.ms
  periodBudget += report.budget
  periodReports += 1
}

export function traceDrain(): string | null {
  if (periodReports === 0) return null
  const rows: { slot: number; ms: number }[] = []
  for (let slot = 0; slot < TraceSlot.Idle; slot++) {
    const ms = Math.round((periodMs[slot] / periodReports) * 100) / 100
    if (ms > 0) rows.push({ slot, ms })
  }
  rows.sort((a, b) => b.ms - a.ms)
  const idle = (periodMs[TraceSlot.Idle] / periodBudget) * 100
  periodMs.fill(0)
  periodReports = 0
  periodBudget = 0
  const parts = rows.map((row) => `${TRACE_LABEL[row.slot]} ${row.ms.toFixed(2)} ms`)
  parts.push(`idle ${idle.toFixed(1)}%`)
  return `trace ${parts.join(', ')}`
}
