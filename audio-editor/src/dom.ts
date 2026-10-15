export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  parent: ParentNode,
  props: { text?: string; class?: string; title?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.text) node.textContent = props.text
  if (props.class) node.className = props.class
  if (props.title) node.title = props.title
  parent.appendChild(node)
  return node
}

export function fmt(n: number) {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 100) return String(Math.round(n))
  return String(Math.round(n * 1000) / 1000)
}

export type Range = [number, number, number, boolean]

/** Slider bound to a number. Log sliders are for frequencies. Returns a setter for external updates. */
export function slider(
  parent: HTMLElement,
  label: string,
  value: number,
  [min, max, step, log]: Range,
  onChange: (n: number) => void,
) {
  h('label', parent, { text: label })
  const input = h('input', parent)
  input.type = 'range'
  const out = h('output', parent)
  const toSlider = (v: number) => {
    if (!log) return v
    const a = Math.log(min)
    const b = Math.log(Math.max(min + 0.001, max))
    return ((Math.log(Math.min(max, Math.max(min, v))) - a) / (b - a)) * 1000
  }
  const fromSlider = (v: number) => {
    if (!log) return v
    const a = Math.log(min)
    const b = Math.log(Math.max(min + 0.001, max))
    return Math.exp(a + (v / 1000) * (b - a))
  }
  if (log) {
    input.min = '0'
    input.max = '1000'
    input.step = '1'
  } else {
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
  }
  const paint = (v: number) => {
    input.value = String(toSlider(v))
    out.textContent = fmt(v)
  }
  input.oninput = () => {
    let n = fromSlider(Number(input.value))
    if (!log && step >= 1) n = Math.round(n)
    onChange(n)
    out.textContent = fmt(n)
  }
  paint(value)
  return (v: number) => paint(v)
}

export function choice(
  parent: HTMLElement,
  label: string,
  value: string,
  options: readonly string[],
  onChange: (v: string) => void,
) {
  h('label', parent, { text: label })
  const sel = h('select', parent)
  sel.style.gridColumn = '2 / -1'
  const all = options.includes(value) ? options : [value, ...options]
  for (const opt of all) {
    const o = h('option', sel, { text: opt })
    o.value = opt
    if (opt === value) o.selected = true
  }
  sel.onchange = () => onChange(sel.value)
  return sel
}

export function button(parent: HTMLElement, text: string, onClick: () => void, className?: string) {
  const node = h('button', parent, { text, class: className })
  node.type = 'button'
  node.onclick = onClick
  return node
}
