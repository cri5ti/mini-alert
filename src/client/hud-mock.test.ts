// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SCENES = ['base', 'armed', 'factory', 'airport', 'hall', 'army', 'spectate', 'strained', 'menu', 'help', 'outcome', 'trace']

async function openMock(search: string) {
  document.body.className = ''
  document.body.innerHTML = '<canvas id="view"></canvas><div id="hud"></div>'
  history.replaceState(null, '', `/mock/hud.html${search}`)
  vi.resetModules()
  await import('./hud-mock.ts')
}

function shown(selector: string): boolean {
  const found = document.querySelector(selector)
  return found !== null && found.closest('[hidden]') === null
}

function text(selector: string): string | null {
  return shown(selector) ? (document.querySelector(selector)?.textContent ?? null) : null
}

function scene() {
  const tiles = [...document.querySelectorAll<HTMLElement>('.tile')].filter((tile) => tile.closest('[hidden]') === null)
  return {
    tiles: tiles.map((tile) => `${tile.querySelector('.name')?.textContent}${tile.classList.contains('armed') ? ' armed' : ''}`),
    ready: tiles.filter((tile) => tile.classList.contains('ready')).length,
    queue: [...document.querySelectorAll('#queue .chip')].filter((chip) => chip.closest('[hidden]') === null).map((chip) => chip.querySelector('.name')?.textContent),
    selected: shown('#selected') ? [...document.querySelectorAll('#selected .unit-row .name')].map((name) => name.textContent) : null,
    focus: text('#city-focus-label'),
    factions: document.querySelectorAll('#legend > *').length,
    spectating: shown('#vision-panel'),
    menu: document.querySelector('#menu')?.classList.contains('open'),
    dialog: text('#sheet-title') ?? text('#outcome-title'),
    trace: shown('#trace'),
  }
}

beforeEach(() => {
  const context = new Proxy({}, {
    get: (_target, key) =>
      key === 'createImageData' ? (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }) : () => undefined,
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('hud mock', () => {
  it('renders the scene the query names', async () => {
    const seen: Record<string, unknown> = {}
    for (const name of SCENES) {
      await openMock(`?scene=${name}`)
      seen[name] = scene()
    }
    const base = ['Factory', 'Turret', 'Airport', 'Helipad', 'Shipyard', 'Building']
    const army = ['Med Tank ×4', 'Scout ×3', 'Heavy Tank ×2', 'Artillery', 'Jet', 'Gunship']
    const quiet = { queue: [], selected: null, focus: null, factions: 4, spectating: false, menu: false, dialog: null, trace: false }
    expect(seen).toEqual({
      base: { ...quiet, tiles: base, ready: 6 },
      armed: { ...quiet, tiles: ['Factory', 'Turret armed', 'Airport', 'Helipad', 'Shipyard', 'Building'], ready: 6 },
      factory: { ...quiet, tiles: ['Scout', 'Med Tank', 'Heavy Tank', 'Artillery'], ready: 4, queue: ['Scout', 'Med Tank', 'Jet'], selected: ['Factory'] },
      airport: { ...quiet, tiles: ['Jet', 'Gunship'], ready: 1, queue: ['Jet'], selected: ['Airport'] },
      hall: { ...quiet, tiles: base, ready: 6, selected: [], focus: 'Growth ×2' },
      army: { ...quiet, tiles: base, ready: 1, selected: army },
      spectate: { ...quiet, tiles: [], ready: 0, factions: 8, spectating: true },
      strained: {
        ...quiet,
        tiles: base,
        ready: 1,
        queue: [...base.slice(0, 5), 'Scout', 'Med Tank', 'Heavy Tank', 'Artillery', 'Jet', 'Gunship', 'Cruiser'],
      },
      menu: { ...quiet, tiles: base, ready: 6, menu: true },
      help: { ...quiet, tiles: base, ready: 6, dialog: 'Help' },
      outcome: { ...quiet, tiles: base, ready: 6, dialog: 'Victory' },
      trace: { ...quiet, tiles: base, ready: 1, selected: army, factions: 8, trace: true },
    })
  })

  it('lays out a portrait and a landscape phone frame per scene', async () => {
    await openMock('?frame=phone')
    const frames = [...document.querySelectorAll('iframe')].map((frame) => [frame.getAttribute('src'), frame.width, frame.height])
    expect(frames).toEqual(
      SCENES.flatMap((name) => [
        [`/mock/hud.html?scene=${name}`, '390', '844'],
        [`/mock/hud.html?scene=${name}`, '844', '390'],
      ]),
    )
  })
})

describe('index.html', () => {
  it('holds the view, an empty #hud and the lobby', () => {
    const page = new DOMParser().parseFromString(readFileSync(join(import.meta.dirname, '../../index.html'), 'utf8'), 'text/html')
    expect([...page.body.children].map((element) => element.id || element.tagName.toLowerCase())).toEqual(['view', 'hud', 'lobby', 'script'])
    expect(page.querySelector('#hud')?.childElementCount).toBe(0)
  })
})
