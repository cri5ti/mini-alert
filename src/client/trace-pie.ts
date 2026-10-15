import { TRACE_COLOR, TRACE_LABEL, TraceSlot } from '../shared/trace.ts'

export type TracePaint = {
  samples: readonly { slot: number; ms: number }[]
  budget: number
}

export function bindTrace(root: HTMLElement) {
  const pie = root.querySelector<HTMLElement>('#trace-pie')
  const hole = root.querySelector<HTMLElement>('#trace-hole')
  const list = root.querySelector<HTMLUListElement>('#trace-list')
  const total = root.querySelector<HTMLElement>('#trace-total')
  if (!pie || !hole || !list || !total) throw new Error('missing trace pie')
  const chart = pie
  const center = hole
  const rows = list
  const summary = total
  return {
    paint(frame: TracePaint) {
      const sum = frame.samples.reduce((acc, sample) => acc + sample.ms, 0) || 1
      let angle = 0
      const stops: string[] = []
      for (const sample of frame.samples) {
        if (sample.ms <= 0) continue
        const next = angle + (sample.ms / sum) * 360
        const color = TRACE_COLOR[sample.slot] ?? '#a8a29e'
        stops.push(`${color} ${angle.toFixed(2)}deg ${next.toFixed(2)}deg`)
        angle = next
      }
      chart.style.background = stops.length > 0 ? `conic-gradient(${stops.join(',')})` : '#3d4a34'
      const work = frame.samples.reduce((acc, sample) => (sample.slot === TraceSlot.Idle ? acc : acc + sample.ms), 0)
      center.textContent = `${work.toFixed(1)}\nms`
      rows.replaceChildren()
      for (const sample of frame.samples) {
        if (sample.ms < 0.05 && sample.slot !== TraceSlot.Idle) continue
        const row = document.createElement('li')
        const swatch = document.createElement('i')
        swatch.style.background = TRACE_COLOR[sample.slot] ?? '#a8a29e'
        const name = document.createElement('span')
        name.textContent = TRACE_LABEL[sample.slot] ?? String(sample.slot)
        const time = document.createElement('span')
        time.textContent = `${sample.ms.toFixed(sample.ms >= 10 ? 1 : 2)} · ${Math.round((sample.ms / sum) * 100)}%`
        row.append(swatch, name, time)
        rows.append(row)
      }
      summary.textContent = `${work.toFixed(1)} / ${frame.budget.toFixed(1)} ms`
      root.hidden = frame.samples.length === 0
    },
  }
}
