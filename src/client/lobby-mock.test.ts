// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}
import { afterEach, describe, expect, it, vi } from 'vitest'

const SCREENS = ['hall', 'host', 'guest', 'drawing', 'offline', 'replaced']

async function openMock(search: string) {
  document.body.innerHTML = '<div id="lobby"></div>'
  history.replaceState(null, '', `/mock/lobby.html${search}`)
  vi.resetModules()
  await import('./lobby-mock.ts')
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('lobby mock', () => {
  it('renders the screen the query names', async () => {
    const seen: Record<string, unknown> = {}
    for (const screen of SCREENS) {
      await openMock(`?screen=${screen}`)
      seen[screen] = {
        title: document.querySelector('.lobby-title h1')?.textContent,
        offline: document.querySelector('.lobby-status')?.textContent === '◌ Reconnecting…',
        drawing: document.querySelector('.lobby-preview')?.classList.contains('busy'),
        replaced: document.querySelector<HTMLElement>('#elsewhere')?.hidden === false,
      }
    }
    expect(seen).toEqual({
      hall: { title: 'Waiting room', offline: false, drawing: false, replaced: false },
      host: { title: 'Battle #12 · host', offline: false, drawing: false, replaced: false },
      guest: { title: 'Battle #12', offline: false, drawing: false, replaced: false },
      drawing: { title: 'Battle #12 · host', offline: false, drawing: true, replaced: false },
      offline: { title: 'Waiting room', offline: true, drawing: false, replaced: false },
      replaced: { title: 'Waiting room', offline: false, drawing: false, replaced: true },
    })
  })

  it('shows the admin view with &admin=1', async () => {
    await openMock('?screen=hall')
    expect(document.querySelector('.admin-mark')).toBeNull()
    await openMock('?screen=hall&admin=1')
    expect(document.querySelector('.admin-mark')).not.toBeNull()
  })

  it('lays out one phone frame per screen, passing on the admin flag', async () => {
    const frames = () =>
      [...document.querySelectorAll('iframe')].map((frame) => [frame.getAttribute('src'), frame.width, frame.height])
    await openMock('?frame=phone&admin=1')
    expect(frames()).toEqual(SCREENS.map((screen) => [`/mock/lobby.html?screen=${screen}&admin=1`, '390', '844']))
    await openMock('?frame=phone')
    expect(frames()).toEqual(SCREENS.map((screen) => [`/mock/lobby.html?screen=${screen}`, '390', '844']))
  })
})
