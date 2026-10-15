// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { WorldSnapshot } from '../../shared/protocol.ts'
import { Terrain } from '../../shared/tiles.ts'
import { BLIP_COLORS, drawBlips, drawDots, Minimap, type Blip, type BlipCanvas, type DotUnit, type MinimapCommand } from './minimap.ts'
import { ContactKind } from './radar.ts'

const WORLD_WIDTH = 40
const WORLD_HEIGHT = 20
const WIDTH = 200
const HEIGHT = 150

function world(): WorldSnapshot {
  return {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    terrain: Array<Terrain>(WORLD_WIDTH * WORLD_HEIGHT).fill(Terrain.Land),
    known: new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT).fill(1),
    shifts: new Uint8Array(WORLD_WIDTH * WORLD_HEIGHT),
    coast: [],
    holes: [],
    roads: [],
    towns: [],
    seed: 0,
  }
}

function mount() {
  const root = document.createElement('div')
  const map = document.createElement('canvas')
  const marks = document.createElement('canvas')
  root.append(map, marks)
  document.body.replaceChildren(root)
  const context = {
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    putImageData: () => undefined,
  }
  map.getContext = (() => context) as unknown as HTMLCanvasElement['getContext']
  root.getBoundingClientRect = () => new DOMRect(100, 50, 200, 100)
  const jump = vi.fn<(x: number, z: number) => void>()
  const command = vi.fn<MinimapCommand>()
  const minimap = new Minimap(root, map, marks, world(), jump)
  minimap.setCommand(command)
  return { root, marks, minimap, jump, command }
}

function pointer(target: Element, type: string, clientX: number, clientY: number, init: PointerEventInit = {}): boolean {
  return target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX, clientY, ...init }))
}

describe('minimap pointer', () => {
  it('jumps to the point under a press and follows a drag while a button is held', () => {
    const { marks, jump } = mount()
    pointer(marks, 'pointerdown', 150, 75, { button: 0, buttons: 1 })
    pointer(marks, 'pointermove', 200, 100, { buttons: 1 })
    expect(jump.mock.calls).toEqual([
      [10, 5],
      [20, 10],
    ])
  })

  it('stops following on a move with no button held', () => {
    const { marks, jump } = mount()
    pointer(marks, 'pointerdown', 150, 75, { button: 0, buttons: 1 })
    pointer(marks, 'pointermove', 160, 80, { buttons: 0 })
    pointer(marks, 'pointermove', 200, 100, { buttons: 1 })
    expect(jump.mock.calls).toEqual([[10, 5]])
  })

  it('commands the tile under a right press with its modifiers, and keeps the context menu shut', () => {
    const { marks, jump, command } = mount()
    pointer(marks, 'pointerdown', 157, 99, { button: 2, buttons: 2, shiftKey: true })
    expect(jump).not.toHaveBeenCalled()
    expect(command).toHaveBeenCalledOnce()
    const [tile, mods] = command.mock.calls[0]
    expect(tile).toEqual({ x: 11, y: 9 })
    expect(mods).toMatchObject({ shiftKey: true, ctrlKey: false, metaKey: false })
    expect(marks.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false)
  })
})

describe('minimap dispose', () => {
  it('leaves #minimap as the markup built it: no world aspect and blank canvases', () => {
    const { root, minimap } = mount()
    minimap.dispose()
    expect([root.style.getPropertyValue('--aspect'), root.innerHTML]).toEqual(['', '<canvas></canvas><canvas></canvas>'])
  })
})

type Arc = { shape: 'stroke' | 'fill'; x: number; y: number; r: number; color: string; alpha: number }
type Rect = { shape: 'rect'; x: number; y: number; w: number; h: number; lineWidth: number; color: string; alpha: number }
type Mark = Arc | Rect

class FakeCanvas implements BlipCanvas {
  globalAlpha = 1
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000'
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000000'
  lineWidth = 1
  readonly marks: Mark[] = []
  private path: { x: number; y: number; r: number }[] = []

  save() {}

  restore() {}

  beginPath() {
    this.path = []
  }

  arc(x: number, y: number, r: number) {
    this.path.push({ x, y, r })
  }

  stroke() {
    for (const arc of this.path) {
      this.marks.push({ shape: 'stroke', ...arc, color: String(this.strokeStyle), alpha: this.globalAlpha })
    }
  }

  fill() {
    for (const arc of this.path) {
      this.marks.push({ shape: 'fill', ...arc, color: String(this.fillStyle), alpha: this.globalAlpha })
    }
  }

  strokeRect(x: number, y: number, w: number, h: number) {
    const { lineWidth, globalAlpha: alpha } = this
    this.marks.push({ shape: 'rect', x, y, w, h, lineWidth, color: String(this.strokeStyle), alpha })
  }
}

function frame(blips: Blip[], now: number, still = false): Mark[] {
  const ctx = new FakeCanvas()
  drawBlips(ctx, blips, WIDTH, HEIGHT, now, still)
  return ctx.marks
}

function ping(kind: ContactKind, born = 0, u = 0.5, v = 0.4): Blip {
  return { u, v, kind, born }
}

function rings(marks: Mark[], kind: ContactKind) {
  return marks.filter((mark): mark is Arc => mark.shape === 'stroke' && mark.color === BLIP_COLORS[kind])
}

function markers(marks: Mark[], kind: ContactKind) {
  return marks.filter((mark): mark is Arc => mark.shape === 'fill' && mark.color === BLIP_COLORS[kind])
}

function edges(marks: Mark[]) {
  return marks.filter((mark): mark is Rect => mark.shape === 'rect')
}

describe('minimap blips', () => {
  it('contracts a ring 40% of the short side onto the spot, pulses three times and ends at 4 s', () => {
    const blips = [ping(ContactKind.Base)]
    const radii: (number | null)[] = []
    for (let now = 0; now < 4000; now += 10) {
      const marks = frame(blips, now)
      const drawn = rings(marks, ContactKind.Base)
      expect(drawn.length).toBeLessThanOrEqual(1)
      for (const ring of drawn) expect(ring).toMatchObject({ x: WIDTH * 0.5, y: HEIGHT * 0.4 })
      expect(markers(marks, ContactKind.Base)).toHaveLength(1)
      radii.push(drawn[0]?.r ?? null)
    }
    expect(radii[0]).toBeCloseTo(HEIGHT * 0.4)
    const widening = radii.findIndex((r, i) => i > 0 && r !== null && r > radii[i - 1]!)
    for (let i = 1; i < widening - 1; i++) expect(radii[i]!).toBeLessThan(radii[i - 1]!)
    expect(radii[widening - 1]!).toBeLessThan(10)
    let pulses = 0
    let widened = false
    for (let i = 1; i < radii.length; i++) {
      const r = radii[i]
      const prev = radii[i - 1]
      const widens = r !== null && prev !== null && r > prev
      if (widens && !widened) pulses += 1
      widened = widens
    }
    expect(pulses).toBe(3)
    expect(radii.at(-1)).toBeNull()
    expect(frame(blips, 4000)).toEqual([])
    expect(blips).toEqual([])
  })

  it('colours each ping by what was hit and expires each on its own clock', () => {
    const base = ping(ContactKind.Base, 0, 0.5, 0.4)
    const unit = ping(ContactKind.Unit, 2000, 0.2, 0.7)
    const blips = [base, unit]
    expect(BLIP_COLORS[ContactKind.Base]).not.toBe(BLIP_COLORS[ContactKind.Unit])

    const both = frame(blips, 3000)
    expect(markers(both, ContactKind.Base)).toEqual([expect.objectContaining({ x: WIDTH * 0.5, y: HEIGHT * 0.4 })])
    expect(markers(both, ContactKind.Unit)).toEqual([expect.objectContaining({ x: WIDTH * 0.2, y: HEIGHT * 0.7 })])

    const late = frame(blips, 4500)
    expect(markers(late, ContactKind.Base)).toEqual([])
    expect(markers(late, ContactKind.Unit)).toHaveLength(1)
    expect(blips).toEqual([unit])

    expect(frame(blips, 6000)).toEqual([])
    expect(blips).toEqual([])
  })

  it('flashes the minimap edge once in the ping colour', () => {
    const blips = [ping(ContactKind.Unit)]
    const [flash] = edges(frame(blips, 0))
    expect(flash).toEqual({
      shape: 'rect',
      x: 2,
      y: 2,
      w: WIDTH - 4,
      h: HEIGHT - 4,
      lineWidth: 4,
      color: BLIP_COLORS[ContactKind.Unit],
      alpha: 1,
    })
    const alphas: number[] = []
    let gone = false
    for (let now = 10; now < 4000; now += 10) {
      const shown = edges(frame(blips, now))
      if (shown.length === 0) {
        gone = true
        continue
      }
      expect(gone).toBe(false)
      alphas.push(shown[0].alpha)
    }
    expect(gone).toBe(true)
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeLessThan(alphas[i - 1])
  })

  it('holds a still ring and marker for the same 4 s under reduced motion', () => {
    const blips = [ping(ContactKind.Base)]
    const held = frame(blips, 0, true)
    expect(rings(held, ContactKind.Base)).toHaveLength(1)
    expect(markers(held, ContactKind.Base)).toHaveLength(1)
    expect(edges(held)).toEqual([])
    for (let now = 10; now < 4000; now += 10) expect(frame(blips, now, true)).toEqual(held)
    expect(frame(blips, 4000, true)).toEqual([])
    expect(blips).toEqual([])
  })
})

const ALERT_RED = '#ff2a1a'
const SELECTED = '#f0d060'
const OWNER_COLORS = [0, 0x2f7edb, 0xd64545, 0x3cde73]

function troop(id: number, ownerId: number, x: number, z: number): DotUnit {
  return { id, ownerId, color: OWNER_COLORS[ownerId], x, z }
}

function dots(units: DotUnit[], viewer: number | null, selected: number[] = []): Arc[] {
  const ctx = new FakeCanvas()
  drawDots(ctx, units, new Set(selected), viewer, 2, 3)
  return ctx.marks as Arc[]
}

function at(marks: Arc[], unit: DotUnit): Arc[] {
  return marks.filter((mark) => mark.x === unit.x * 2 && mark.y === unit.z * 3)
}

function fillColor(unit: DotUnit): string {
  return `#${unit.color.toString(16).padStart(6, '0')}`
}

describe('minimap dots', () => {
  it('rings every dot hostile to the viewer in alert red over a dark shade, following the faction viewed', () => {
    const own = troop(1, 1, 10, 10)
    const red = troop(2, 2, 40, 20)
    const green = troop(3, 3, 70, 30)
    const units = [own, red, green]

    const mine = dots(units, 1)
    expect(at(mine, own)).toEqual([expect.objectContaining({ shape: 'fill', color: fillColor(own) })])
    for (const enemy of [red, green]) {
      expect(at(mine, enemy)).toHaveLength(3)
      const [fill, shade, ring] = at(mine, enemy)
      expect(fill).toMatchObject({ shape: 'fill', color: fillColor(enemy) })
      expect(shade).toMatchObject({ shape: 'stroke', r: ring.r, color: 'rgba(0, 0, 0, 0.6)' })
      expect(ring).toMatchObject({ shape: 'stroke', color: ALERT_RED })
      expect(ring.r).toBeGreaterThan(fill.r)
    }

    const viewed = dots(units, 2)
    const ringed = (marks: Arc[]) => units.filter((unit) => at(marks, unit).some((mark) => mark.color === ALERT_RED))
    expect(ringed(viewed)).toEqual([own, green])
    expect(ringed(dots(units, null))).toEqual([])
  })

  it('draws selected dots last, larger and ringed in gold', () => {
    const picked = troop(1, 1, 10, 10)
    const idle = troop(4, 1, 20, 10)
    const enemy = troop(2, 2, 40, 20)
    const marks = dots([picked, idle, enemy], 1, [picked.id])
    const [bare] = at(marks, idle)
    expect(marks.slice(-2)).toEqual(at(marks, picked))
    const [fill, ring] = at(marks, picked)
    expect(fill).toMatchObject({ shape: 'fill', color: fillColor(picked) })
    expect(fill.r).toBeGreaterThan(bare.r)
    expect(ring).toMatchObject({ shape: 'stroke', r: fill.r, color: SELECTED })
  })
})
