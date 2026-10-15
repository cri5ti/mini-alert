// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GameLobbyState } from '../shared/lobby.ts'
import { AA, declarations, inks, motionFaults, moves } from './css-audit.ts'
import { drawingRoom, emptyHall, guestRoom, hall, hostRoom, roomPreview, seatLimitHall } from './lobby-fixtures.ts'
import { LobbyView, type LobbyActions } from './lobby-ui.ts'

const css = readFileSync(join(import.meta.dirname, 'lobby.css'), 'utf8')
const tokens = readFileSync(join(import.meta.dirname, 'console.css'), 'utf8')
const PHONE = '@media (max-width: 960px)'

const all = declarations(css)

const sheet = document.createElement('style')
sheet.textContent = tokens + css
document.head.append(sheet)

const actions = new Proxy({} as LobbyActions, { get: () => () => undefined })

const SCENES: ((view: LobbyView) => void)[] = [
  (view) => {
    view.setConnected(true)
    view.showWaiting(hall())
  },
  (view) => view.showWaiting(emptyHall()),
  (view) => view.showWaiting(seatLimitHall()),
  (view) => view.showGame(hostRoom(), roomPreview()),
  (view) => view.showGame(guestRoom(), roomPreview()),
  (view) => view.showGame(drawingRoom(), null),
  (view) => view.showReplaced(),
]

function render(scene: (view: LobbyView) => void): HTMLElement {
  const root = document.createElement('div')
  root.id = 'lobby'
  document.body.replaceChildren(root)
  scene(new LobbyView(root, actions, true))
  return root
}

describe('lobby.css', () => {
  it('moves only under prefers-reduced-motion: no-preference, and only transform and opacity', () => {
    expect(all.filter(moves).length).toBeGreaterThan(0)
    expect(all.filter(({ scopes }) => scopes.some((scope) => scope.startsWith('@keyframes'))).length).toBeGreaterThan(0)
    expect(motionFaults(all)).toEqual([])
  })

  it('draws every text at 4.5:1 or more against the surface behind it', () => {
    const drawn = SCENES.flatMap((scene) => inks(render(scene)))
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.filter(({ ratio }) => ratio < AA)).toEqual([])
  })

  it('sweeps the radar in green, and in amber while the map draws', () => {
    const sweep = (room: GameLobbyState) => {
      const layer = render((view) => view.showGame(room, roomPreview())).querySelector('.lobby-sweep')
      if (!layer) throw new Error('no radar sweep')
      return getComputedStyle(layer).color
    }
    expect([sweep(hostRoom()), sweep(drawingRoom())]).toEqual(['#3cde73', '#f0a830'])
  })

  it('sizes each row of the phone lobby grid to its panel', () => {
    const rows = all.filter(({ scopes, property }) => scopes[0] === PHONE && property === 'grid-auto-rows')
    expect(rows.map(({ scopes, value }) => [scopes[1], value])).toEqual([['.lobby-grid, .lobby-grid.room', 'max-content']])
  })

  it('stays within 20 000 bytes', () => {
    expect(Buffer.byteLength(css)).toBeLessThanOrEqual(20_000)
  })
})
