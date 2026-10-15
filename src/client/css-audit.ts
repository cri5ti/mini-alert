const NO_PREFERENCE = '@media (prefers-reduced-motion: no-preference)'
export const AA = 4.5

const MOVING = new Set(['transform', 'opacity'])
const COLOUR_SYNTAX = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i
const NOT_LITERALS = new Set(['transparent', 'currentcolor', 'none', 'inherit', 'initial', 'unset', 'revert'])

export type Declaration = { scopes: string[]; property: string; value: string }

export type Ink = { text: string | null; color: string; ratio: number; opacity: number }

export function declarations(source: string): Declaration[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: Declaration[] = []
  const scopes: string[] = []
  let pending = ''
  const flush = () => {
    const colon = pending.indexOf(':')
    if (scopes.length > 0 && colon > 0) {
      found.push({ scopes: [...scopes], property: pending.slice(0, colon).trim(), value: pending.slice(colon + 1).trim() })
    }
    pending = ''
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, i + 1)
      pending += text.slice(i, end + 1)
      i = end
    } else if (char === '{') {
      scopes.push(pending.trim().replace(/\s+/g, ' '))
      pending = ''
    } else if (char === ';') flush()
    else if (char === '}') {
      flush()
      scopes.pop()
    } else pending += char
  }
  return found
}

const probe = document.createElement('div').style

function isNamedColour(word: string): boolean {
  if (NOT_LITERALS.has(word.toLowerCase())) return false
  probe.color = ''
  probe.color = word
  return probe.color !== ''
}

export function hasColourLiteral({ value }: Declaration): boolean {
  const bare = value.replace(/(['"]).*?\1/g, '').replace(/--[\w-]+/g, '')
  return COLOUR_SYNTAX.test(bare) || (bare.match(/[a-z][a-z-]*/gi) ?? []).some(isNamedColour)
}

export function moves({ property }: Declaration): boolean {
  return property.startsWith('animation') || property.startsWith('transition')
}

export function motionFaults(all: readonly Declaration[]): string[] {
  const faults: string[] = []
  for (const declaration of all) {
    const { scopes, property, value } = declaration
    const where = [...scopes, property].join(' › ')
    if (moves(declaration) && !scopes.includes(NO_PREFERENCE)) faults.push(where)
    if (scopes.some((scope) => scope.startsWith('@keyframes')) && !MOVING.has(property)) faults.push(where)
    if (property !== 'transition' && property !== 'transition-property') continue
    for (const item of value.split(',')) {
      if (!MOVING.has(item.trim().split(/\s+/)[0])) faults.push(`${where}: ${item.trim()}`)
    }
  }
  return faults
}

function luminance(colour: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) throw new Error(`${colour} is not #rrggbb`)
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(colour.slice(at, at + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

function surface(element: Element): string[] {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const { backgroundColor, backgroundImage } = getComputedStyle(at)
    const stops = `${backgroundColor} ${backgroundImage}`.match(/#[0-9a-f]{6}\b/gi)
    if (stops) return stops
  }
  throw new Error(`no surface behind ${element.outerHTML}`)
}

function opacity(element: Element): number {
  let product = 1
  for (let at: Element | null = element; at; at = at.parentElement) {
    // happy-dom computes an undeclared opacity as '', not its initial 1.
    const { opacity } = getComputedStyle(at)
    if (opacity !== '') product *= Number(opacity)
  }
  return product
}

function ownText(element: Element): boolean {
  return [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
}

export function inks(root: Element): Ink[] {
  return [...root.querySelectorAll('*')]
    // SVG text paints with its fill attribute, not with color.
    .filter((element) => element instanceof HTMLElement && !element.closest('[hidden]'))
    .filter((element) => ownText(element) || element.matches('input[type="text"]'))
    .map((element) => {
      const { color } = getComputedStyle(element)
      const ratio = Math.min(...surface(element).map((stop) => contrast(color, stop)))
      return { text: element.textContent, color, ratio, opacity: opacity(element) }
    })
}
