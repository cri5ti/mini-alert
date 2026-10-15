import { join } from 'node:path'
import { devices, webkit, type Browser } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let server: ViteDevServer
let browser: Browser
let mock = ''

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
  mock = new URL('mock/lobby.html', origin).href
  browser = await webkit.launch()
})

afterAll(async () => {
  await browser.close()
  await server.close()
})

async function onPhone(screen: string) {
  const page = await browser.newPage({ ...devices['iPhone 15'] })
  await page.goto(`${mock}?screen=${screen}`)
  await page.waitForSelector('.lobby-grid')
  const layout = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('.lobby-grid')
    if (!grid) throw new Error('no lobby grid')
    const panels = [...grid.querySelectorAll<HTMLElement>(':scope > .lobby-panel')].filter((panel) => panel.offsetHeight > 0)
    grid.scrollTop = grid.scrollHeight
    return {
      panels: panels.length,
      overflowing: panels.filter((panel) => panel.scrollHeight > panel.offsetHeight).map((panel) => panel.querySelector('h2')?.textContent),
      scrolled: grid.scrollTop,
    }
  })
  await page.close()
  return layout
}

describe('lobby on an iPhone', () => {
  it.each(['hall', 'host'])('%s: every panel is as tall as its content, and the grid scrolls', async (screen) => {
    const { panels, overflowing, scrolled } = await onPhone(screen)
    expect(panels).toBeGreaterThan(1)
    expect(overflowing).toEqual([])
    expect(scrolled).toBeGreaterThan(0)
  })
})
