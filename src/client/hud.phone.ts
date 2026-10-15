import { join } from 'node:path'
import { devices, webkit, type Browser, type BrowserContextOptions, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let server: ViteDevServer
let browser: Browser
let mock = ''

const SCENES = ['base', 'armed', 'factory', 'airport', 'hall', 'army', 'spectate', 'strained', 'menu', 'help', 'outcome', 'trace']

const SHOWN: Partial<Record<string, string[]>> = {
  base: ['Menu', 'Help', 'minimap-marks', 'Base', 'Land', 'Air', 'Sea', 'Factory', 'Turret'],
  hall: ['City focus', 'Factory'],
  spectate: ['Menu', 'Help', 'minimap-marks', 'Ada', 'Bo', 'Cy', 'Dee'],
  menu: ['Music On', 'music-volume', 'Sounds On', 'sounds-volume', 'Input On', 'Changelog', 'Full screen', 'Surrender'],
}

const SELECTED = ['factory', 'airport', 'hall', 'army', 'trace']

const SCREENS: [string, BrowserContextOptions][] = [
  ['1280×720', { viewport: { width: 1280, height: 720 } }],
  ['1024×768', { viewport: { width: 1024, height: 768 } }],
  ['iPhone 15 portrait', devices['iPhone 15']],
  ['iPhone 15 landscape', devices['iPhone 15 landscape']],
]

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: join(import.meta.dirname, '../..'),
    logLevel: 'silent',
    server: { port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true },
  })
  await server.listen()
  const origin = server.resolvedUrls?.local[0]
  if (!origin) throw new Error('the mock server has no address')
  mock = new URL('mock/hud.html', origin).href
  browser = await webkit.launch()
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

async function open(page: Page, scene: string) {
  await page.goto(`${mock}?scene=${scene}`)
  await page.waitForSelector('#menubar')
  await page.evaluate(() => document.fonts.ready)
}

async function withPage<T>(options: BrowserContextOptions, visit: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage(options)
  try {
    return await visit(page)
  } finally {
    await page.close()
  }
}

function layout(): { checked: string[]; faults: string[] } {
  const EPS = 0.5
  const checked: string[] = []
  const faults: string[] = []
  const name = (element: Element | null) =>
    element === null ? 'nothing' : element.getAttribute('aria-label') || element.getAttribute('title') || element.id || element.textContent?.trim() || element.tagName
  const rendered = (element: Element) => element.getClientRects().length > 0
  const within = (inner: DOMRect, outer: { left: number; top: number; right: number; bottom: number }) =>
    inner.left >= outer.left - EPS && inner.top >= outer.top - EPS && inner.right <= outer.right + EPS && inner.bottom <= outer.bottom + EPS
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
  const scrollers = (element: Element) => {
    const found: Element[] = []
    for (let box = element.parentElement; box; box = box.parentElement) {
      const style = getComputedStyle(box)
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') found.push(box)
    }
    return found
  }
  const controls = [...document.querySelectorAll('#hud button, #hud input, #minimap-marks')].filter(rendered)
  const popups = [...document.querySelectorAll('.menu.open .dropdown, #sheet:not([hidden]), #outcome:not([hidden])')]

  for (const control of controls) {
    const rect = control.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const seen = [viewport, ...scrollers(control).map((box) => box.getBoundingClientRect())]
    if (!seen.every((box) => x >= box.left && y >= box.top && x < box.right && y < box.bottom)) continue
    checked.push(name(control))
    const hit = document.elementFromPoint(x, y)
    if (hit && control.contains(hit)) continue
    if (popups.some((popup) => popup.contains(hit) && !popup.contains(control))) continue
    faults.push(`${name(control)} hits ${name(hit)}`)
  }

  const chrome = [...document.querySelectorAll('#menubar, #side, #legend, #trace, #selected')].filter(rendered)
  for (const [index, element] of chrome.entries()) {
    const rect = element.getBoundingClientRect()
    if (!within(rect, viewport)) faults.push(`${element.id} leaves the viewport`)
    for (const other of chrome.slice(index + 1)) {
      const next = other.getBoundingClientRect()
      const overlapX = Math.min(rect.right, next.right) - Math.max(rect.left, next.left)
      const overlapY = Math.min(rect.bottom, next.bottom) - Math.max(rect.top, next.top)
      if (overlapX > EPS && overlapY > EPS) faults.push(`${element.id} overlaps ${other.id}`)
    }
  }
  for (const item of document.querySelectorAll('.dropdown button, .dropdown input')) {
    if (rendered(item) && !within(item.getBoundingClientRect(), viewport)) faults.push(`${name(item)} leaves the viewport`)
  }

  for (const element of document.querySelectorAll('#hud [hidden]')) {
    if (rendered(element)) faults.push(`${name(element)} renders while hidden`)
  }

  if ((document.scrollingElement?.scrollWidth ?? 0) > innerWidth) faults.push('the page scrolls sideways')
  for (const element of document.querySelectorAll('#hud *')) {
    const { overflowX } = getComputedStyle(element)
    if ((overflowX === 'auto' || overflowX === 'scroll') && element.scrollWidth > element.clientWidth) faults.push(`${name(element)} scrolls sideways`)
  }

  const bar = document.querySelector('#menubar')
  const side = document.querySelector('#side')
  const view = document.querySelector('#view')
  if (!bar || !side || !view) return { checked, faults: [...faults, 'the bar, the rail or the view is missing'] }
  for (const element of document.querySelectorAll('#selected *')) {
    if (element.childElementCount > 0 || controls.includes(element) || !rendered(element)) continue
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (hit !== view) faults.push(`${name(element)} hits ${name(hit)}`)
  }
  const barBox = bar.getBoundingClientRect()
  if (bar.scrollWidth > bar.clientWidth) faults.push('the bar overflows')
  for (const element of bar.querySelectorAll('*')) {
    if (element.closest('.dropdown') || !rendered(element)) continue
    if (!within(element.getBoundingClientRect(), barBox)) faults.push(`${name(element)} sticks out of the bar`)
  }
  if (side.scrollHeight > side.clientHeight || side.scrollWidth > side.clientWidth) faults.push('the rail overflows')

  if (innerWidth <= 960) {
    for (const control of controls) {
      const { width, height } = control.getBoundingClientRect()
      if (width < 44 - EPS || height < 44 - EPS) faults.push(`${name(control)} is ${Math.round(width)}×${Math.round(height)}`)
    }
  }

  const field = view.getBoundingClientRect()
  const playfield = { left: 0, top: barBox.bottom, right: side.getBoundingClientRect().left, bottom: innerHeight }
  const off = (Object.keys(playfield) as (keyof typeof playfield)[]).filter((edge) => Math.abs(field[edge] - playfield[edge]) > EPS)
  if (off.length > 0) faults.push(`the view's ${off.join(', ')} miss the playfield`)
  return { checked, faults }
}

describe('HUD layout', () => {
  it.each(SCREENS)('%s: every scene meets the layout kernels and shows its controls', async (_, options) => {
    const faults = await withPage(options, async (page) => {
      const found: string[] = []
      for (const scene of SCENES) {
        await open(page, scene)
        const { checked, faults } = await page.evaluate(layout)
        const missing = (SHOWN[scene] ?? []).filter((control) => !checked.includes(control)).map((control) => `${control} is not on screen`)
        const selected = await page.evaluate(() => (document.querySelector('#selected')?.getClientRects().length ?? 0) > 0)
        if (selected !== SELECTED.includes(scene)) missing.push(selected ? 'Selected shows' : 'Selected is not on screen')
        found.push(...[...faults, ...missing].map((fault) => `${scene}: ${fault}`))
      }
      return found
    })
    expect(faults).toEqual([])
  })

  it('1280×720: the 44 px bar ends where the 300 px sidebar starts', async () => {
    const edges = await withPage(SCREENS[0][1], async (page) => {
      await open(page, 'base')
      return page.evaluate(() => {
        const bar = document.querySelector('#menubar')?.getBoundingClientRect()
        const side = document.querySelector('#side')?.getBoundingClientRect()
        return { bar: [bar?.height, bar?.right], side: [side?.left, side?.width] }
      })
    })
    expect(edges).toEqual({ bar: [44, 980], side: [980, 300] })
  })

  it('iPhone 15 landscape: the spectate scene scrolls its plates inside the Vision scroller', async () => {
    const scroller = await withPage(SCREENS[3][1], async (page) => {
      await open(page, 'spectate')
      return page.evaluate(() => {
        const plates = document.querySelector('#plates')
        const last = plates?.lastElementChild
        if (!plates || !last) return null
        const before = last.getBoundingClientRect().bottom > plates.getBoundingClientRect().bottom
        plates.scrollTop = plates.scrollHeight
        const after = last.getBoundingClientRect().bottom <= plates.getBoundingClientRect().bottom
        return { plates: plates.querySelectorAll('.faction-plate').length, last: last.textContent, overflowY: getComputedStyle(plates).overflowY, before, after }
      })
    })
    expect(scroller).toEqual({ plates: 8, last: 'Leave', overflowY: 'auto', before: true, after: true })
  })

  it('iPhone 15 landscape: the strained scene scrolls the Base tiles and the Queue chips inside the build scroller', async () => {
    const scroller = await withPage(SCREENS[3][1], async (page) => {
      await open(page, 'strained')
      return page.evaluate(() => {
        const scroll = document.querySelector('#build-scroll')
        const tiles = [...document.querySelectorAll('#build-scroll .tile:not([hidden])')]
        const chips = [...document.querySelectorAll('#build-scroll .chip')]
        const first = tiles[0]
        const last = chips.at(-1)
        if (!scroll || !first || !last) return null
        const inside = (element: Element) => {
          const box = scroll.getBoundingClientRect()
          const rect = element.getBoundingClientRect()
          return rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5
        }
        const before = [inside(first), inside(last)]
        scroll.scrollTop = scroll.scrollHeight
        const after = [inside(first), inside(last)]
        const tab = document.querySelector('[role="tab"][aria-selected="true"]')?.textContent
        return { tab, tiles: tiles.length, chips: chips.length, overflowY: getComputedStyle(scroll).overflowY, before, after }
      })
    })
    expect(scroller).toEqual({ tab: 'Base', tiles: 6, chips: 12, overflowY: 'auto', before: [true, false], after: [false, true] })
  })

  it.each(SCREENS)('%s: the sheet shows over the match chrome, and over the lobby without it', async (_, options) => {
    const shown = await withPage(options, async (page) => {
      await open(page, 'help')
      await page.addStyleTag({ path: join(import.meta.dirname, 'lobby.css') })
      return page.evaluate(() => {
        const rendered = (selector: string) => (document.querySelector(selector)?.getClientRects().length ?? 0) > 0
        const chrome = () => {
          const card = document.querySelector('.sheet-card')?.getBoundingClientRect()
          const hit = card ? document.elementFromPoint(card.left + card.width / 2, card.top + card.height / 2) : null
          return { sheet: hit?.closest('#sheet') != null, menubar: rendered('#menubar'), side: rendered('#side'), view: rendered('#view') }
        }
        const match = chrome()
        const lobby = document.createElement('div')
        lobby.id = 'lobby'
        document.body.append(lobby)
        document.body.classList.replace('match', 'lobby')
        return { match, lobby: chrome() }
      })
    })
    expect(shown).toEqual({
      match: { sheet: true, menubar: true, side: true, view: true },
      lobby: { sheet: true, menubar: false, side: false, view: false },
    })
  })
})
