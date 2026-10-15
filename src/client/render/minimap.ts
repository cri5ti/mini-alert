import type { CityState, UnitSnapshot, WorldSnapshot } from '../../shared/protocol.ts'
import { NEUTRAL_CITY, type CityLayout } from '../../shared/cities.ts'
import { isMinimapShore, minimapRgb } from '../../shared/minimap.ts'
import { hostile } from '../../shared/players.ts'
import type { Terrain, TileCoord } from '../../shared/tiles.ts'
import { ContactKind } from './radar.ts'

const DOT = 3.25
const ENEMY_RING = DOT + 1
const ALERT_RED = '#ff2a1a'
const SHADE = 'rgba(0, 0, 0, 0.6)'
const FOG_REPAINT_MS = 200
const BLIP_MS = 4000
const BLIP_CLOSE_MS = 1000
const BLIP_PULSE_MS = 700
const BLIP_PULSES = 3
const BLIP_FLASH_MS = 700
const BLIP_FADE_MS = 600
/** The contracting ring's starting radius as a share of the minimap's short side. */
const BLIP_REACH = 0.4
const BLIP_MARK = 5
const BLIP_RING_CLOSED = BLIP_MARK + 3
const BLIP_PULSE_SPREAD = 18
const BLIP_STILL_RING = 14
const BLIP_EDGE = 4
export const BLIP_COLORS: Record<ContactKind, string> = {
  [ContactKind.Base]: ALERT_RED,
  [ContactKind.Unit]: '#ffb21e',
}

/** An attack ping, placed as a share of the minimap's width and height. */
export type Blip = { u: number; v: number; kind: ContactKind; born: number }

export type BlipCanvas = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'arc'
  | 'fill'
  | 'stroke'
  | 'strokeRect'
  | 'globalAlpha'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
>

export type DotCanvas = Pick<
  CanvasRenderingContext2D,
  'beginPath' | 'arc' | 'fill' | 'stroke' | 'fillStyle' | 'strokeStyle' | 'lineWidth'
>

export type DotUnit = Pick<UnitSnapshot, 'id' | 'ownerId' | 'color' | 'x' | 'z'>

export type MinimapCommand = (
  tile: TileCoord,
  mods: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
) => void

export class Minimap {
  private world: WorldSnapshot
  private readonly base: Uint8ClampedArray
  private readonly pristine: Uint8ClampedArray
  private layouts: readonly (CityLayout | null)[]
  private hover: ((tile: TileCoord | null) => void) | null = null
  private cityStates: readonly (CityState | null)[] = []
  private readonly image: ImageData
  private readonly ctx: CanvasRenderingContext2D
  private tracking = false
  private command: MinimapCommand | null = null
  private lastMask: Float32Array | null = null
  private fogSettled = false
  private fogPaintedAt = -Infinity
  private cityHash = 0
  private readonly blips: Blip[] = []
  private readonly still = matchMedia('(prefers-reduced-motion: reduce)')

  constructor(
    private readonly root: HTMLElement,
    private readonly map: HTMLCanvasElement,
    private readonly marks: HTMLCanvasElement,
    world: WorldSnapshot,
    private readonly onJump: (x: number, z: number) => void,
  ) {
    this.world = world
    this.root.hidden = false
    this.root.style.setProperty('--aspect', String(world.width / world.height))
    const painted = paintTerrain(this.map, world)
    this.ctx = painted.ctx
    this.image = painted.image
    this.base = painted.base
    this.pristine = new Uint8ClampedArray(painted.base)
    this.layouts = []
    this.root.addEventListener('pointerdown', this.onPointerDown)
    this.root.addEventListener('pointermove', this.onPointerMove)
    this.root.addEventListener('pointerup', this.onPointerUp)
    this.root.addEventListener('pointercancel', this.onPointerCancel)
    this.root.addEventListener('pointerleave', this.onPointerLeave)
    this.root.addEventListener('contextmenu', preventMenu)
  }

  setHover(hover: (tile: TileCoord | null) => void) {
    this.hover = hover
  }

  retile(world: WorldSnapshot) {
    this.world = world
    paintInto(this.pristine, world)
    this.base.set(this.pristine)
    this.fogSettled = false
  }

  setLayouts(layouts: readonly (CityLayout | null)[]) {
    this.layouts = layouts
    this.fogSettled = false
  }

  setCommand(command: MinimapCommand) {
    this.command = command
  }

  blip(x: number, z: number, kind: ContactKind) {
    this.blips.push({ u: x / this.world.width, v: z / this.world.height, kind, born: performance.now() })
  }

  dispose() {
    this.root.removeEventListener('pointerdown', this.onPointerDown)
    this.root.removeEventListener('pointermove', this.onPointerMove)
    this.root.removeEventListener('pointerup', this.onPointerUp)
    this.root.removeEventListener('pointercancel', this.onPointerCancel)
    this.root.removeEventListener('pointerleave', this.onPointerLeave)
    this.root.removeEventListener('contextmenu', preventMenu)
    this.root.style.removeProperty('--aspect')
    // Dropping a canvas's size attributes also blanks its bitmap.
    for (const canvas of [this.map, this.marks]) {
      canvas.removeAttribute('width')
      canvas.removeAttribute('height')
    }
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button === 2) {
      const tile = this.tileAt(event.clientX, event.clientY)
      if (tile) this.command?.(tile, event)
      return
    }
    this.tracking = true
    this.jump(event.clientX, event.clientY)
    try {
      this.root.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is unavailable for this event. Moves over the minimap still pan.
    }
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    this.hover?.(this.tileAt(event.clientX, event.clientY))
    if (this.tracking && event.buttons === 0) this.tracking = false
    if (this.tracking) this.jump(event.clientX, event.clientY)
  }

  private readonly onPointerUp = () => {
    this.tracking = false
  }

  private readonly onPointerCancel = () => {
    this.tracking = false
  }

  private readonly onPointerLeave = () => {
    this.hover?.(null)
  }

  draw(
    units: readonly UnitSnapshot[],
    selectedIds: ReadonlySet<number>,
    viewer: number | null,
    viewport: readonly { x: number; z: number }[],
    fog?: Float32Array,
    cities: readonly (CityState | null)[] = [],
    rally: TileCoord | null = null,
  ) {
    this.cityStates = cities
    const now = performance.now()
    if (fog && now - this.fogPaintedAt >= FOG_REPAINT_MS) {
      this.fogPaintedAt = now
      this.applyFog(fog)
    }
    const ctx = this.marks.getContext('2d')
    if (!ctx) return
    const width = this.root.clientWidth
    const height = this.root.clientHeight
    if (width === 0 || height === 0) return
    const dpr = Math.min(devicePixelRatio, 2)
    const bitmapW = Math.round(width * dpr)
    const bitmapH = Math.round(height * dpr)
    if (this.marks.width !== bitmapW || this.marks.height !== bitmapH) {
      this.marks.width = bitmapW
      this.marks.height = bitmapH
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    this.strokeViewport(ctx, viewport, width, height)
    drawDots(ctx, units, selectedIds, viewer, width / this.world.width, height / this.world.height)
    drawBlips(ctx, this.blips, width, height, now, this.still.matches)
    if (rally) this.diamond(ctx, this.toPixel({ x: rally.x + 0.5, z: rally.y + 0.5 }, width, height))
  }

  private applyFog(mask: Float32Array) {
    const hash = this.hashCities()
    if (this.fogSettled && hash === this.cityHash && this.sameMask(mask)) return
    this.cityHash = hash
    this.fogSettled = true
    if (!this.lastMask || this.lastMask.length !== mask.length) this.lastMask = new Float32Array(mask.length)
    this.lastMask.set(mask)
    this.base.set(this.pristine)
    this.paintCities()
    const data = this.image.data
    const base = this.base
    const count = Math.min(mask.length, base.length / 4)
    for (let i = 0; i < count; i++) {
      const lit = 1 - mask[i]
      const pixel = i * 4
      data[pixel] = base[pixel] * lit
      data[pixel + 1] = base[pixel + 1] * lit
      data[pixel + 2] = base[pixel + 2] * lit
    }
    this.ctx.putImageData(this.image, 0, 0)
  }

  private sameMask(mask: Float32Array): boolean {
    const last = this.lastMask
    if (!last || last.length !== mask.length) return false
    for (let i = 0; i < mask.length; i++) {
      if (Math.abs(mask[i] - last[i]) > 0.01) return false
    }
    return true
  }

  private hashCities(): number {
    let hash = 17
    for (let i = 0; i < this.layouts.length; i++) {
      const layout = this.layouts[i]
      const state = this.cityStates[i]
      if (!layout || !state) continue
      hash = Math.imul(hash, 31) + state.color + state.ownerId + layout.tiles.length
    }
    return hash
  }

  private paintCities() {
    const { width } = this.world
    for (let i = 0; i < this.layouts.length; i++) {
      const state = this.cityStates[i]
      const layout = this.layouts[i]
      if (!state || !layout) continue
      const color = state.color > 0 ? state.color : NEUTRAL_CITY
      const r = (color >> 16) & 255
      const g = (color >> 8) & 255
      const b = color & 255
      for (const tile of layout.tiles) {
        if (tile.x < 0 || tile.y < 0 || tile.x >= width || tile.y >= this.world.height) continue
        const pixel = (tile.y * width + tile.x) * 4
        this.base[pixel] = r
        this.base[pixel + 1] = g
        this.base[pixel + 2] = b
      }
    }
  }

  private strokeViewport(
    ctx: CanvasRenderingContext2D,
    viewport: readonly { x: number; z: number }[],
    width: number,
    height: number,
  ) {
    if (viewport.length < 3) return
    ctx.beginPath()
    const first = this.toPixel(viewport[0], width, height)
    ctx.moveTo(first.x, first.y)
    for (let i = 1; i < viewport.length; i++) {
      const point = this.toPixel(viewport[i], width, height)
      ctx.lineTo(point.x, point.y)
    }
    ctx.closePath()
    ctx.fillStyle = 'rgba(246, 241, 220, 0.16)'
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#f6f1dc'
    ctx.stroke()
  }

  private diamond(ctx: CanvasRenderingContext2D, point: { x: number; y: number }) {
    ctx.beginPath()
    ctx.moveTo(point.x, point.y - 5)
    ctx.lineTo(point.x + 4, point.y)
    ctx.lineTo(point.x, point.y + 5)
    ctx.lineTo(point.x - 4, point.y)
    ctx.closePath()
    ctx.fillStyle = '#f0d060'
    ctx.fill()
  }

  private toPixel(point: { x: number; z: number }, width: number, height: number): { x: number; y: number } {
    return {
      x: (point.x / this.world.width) * width,
      y: (point.z / this.world.height) * height,
    }
  }

  private jump(clientX: number, clientY: number) {
    const rect = this.root.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const x = ((clientX - rect.left) / rect.width) * this.world.width
    const z = ((clientY - rect.top) / rect.height) * this.world.height
    this.onJump(x, z)
  }

  private tileAt(clientX: number, clientY: number): TileCoord | null {
    const rect = this.root.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const x = Math.floor(((clientX - rect.left) / rect.width) * this.world.width)
    const y = Math.floor(((clientY - rect.top) / rect.height) * this.world.height)
    if (x < 0 || y < 0 || x >= this.world.width || y >= this.world.height) return null
    return { x, y }
  }
}

function paintTerrain(
  canvas: HTMLCanvasElement,
  world: WorldSnapshot,
): { ctx: CanvasRenderingContext2D; image: ImageData; base: Uint8ClampedArray } {
  canvas.width = world.width
  canvas.height = world.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('minimap canvas has no 2d context')
  const image = ctx.createImageData(world.width, world.height)
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const index = y * world.width + x
      if (world.known[index] === 0) {
        const pixel = index * 4
        image.data[pixel] = 12
        image.data[pixel + 1] = 16
        image.data[pixel + 2] = 20
        image.data[pixel + 3] = 255
        continue
      }
      const terrain = world.terrain[index] as Terrain
      const shore = isMinimapShore(world.terrain, world.width, world.height, x, y)
      const [r, g, b] = minimapRgb(terrain, shore)
      const pixel = index * 4
      image.data[pixel] = r
      image.data[pixel + 1] = g
      image.data[pixel + 2] = b
      image.data[pixel + 3] = 255
    }
  }
  const base = new Uint8ClampedArray(image.data)
  image.data.fill(0)
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255
  ctx.putImageData(image, 0, 0)
  return { ctx, image, base }
}

function paintInto(target: Uint8ClampedArray, world: WorldSnapshot) {
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const index = y * world.width + x
      const pixel = index * 4
      if (world.known[index] === 0) {
        target[pixel] = 12
        target[pixel + 1] = 16
        target[pixel + 2] = 20
        target[pixel + 3] = 255
        continue
      }
      const terrain = world.terrain[index] as Terrain
      const shore = isMinimapShore(world.terrain, world.width, world.height, x, y)
      const [r, g, b] = minimapRgb(terrain, shore)
      target[pixel] = r
      target[pixel + 1] = g
      target[pixel + 2] = b
      target[pixel + 3] = 255
    }
  }
}

/** Draws each unit as a dot in its owner's colour, the selected ones on top; a dot hostile to `viewer` is ringed in alert red. */
export function drawDots(
  ctx: DotCanvas,
  units: readonly DotUnit[],
  selectedIds: ReadonlySet<number>,
  viewer: number | null,
  scaleX: number,
  scaleY: number,
) {
  for (const unit of units) {
    if (!selectedIds.has(unit.id)) dot(ctx, unit, viewer, scaleX, scaleY, false)
  }
  for (const unit of units) {
    if (selectedIds.has(unit.id)) dot(ctx, unit, viewer, scaleX, scaleY, true)
  }
}

function dot(ctx: DotCanvas, unit: DotUnit, viewer: number | null, scaleX: number, scaleY: number, selected: boolean) {
  const x = unit.x * scaleX
  const y = unit.z * scaleY
  ctx.beginPath()
  ctx.arc(x, y, selected ? DOT + 1.4 : DOT, 0, Math.PI * 2)
  ctx.fillStyle = cssColor(unit.color)
  ctx.fill()
  if (selected) {
    ctx.lineWidth = 1.25
    ctx.strokeStyle = '#f0d060'
    ctx.stroke()
    return
  }
  if (viewer === null || !hostile(viewer, unit.ownerId)) return
  ctx.beginPath()
  ctx.arc(x, y, ENEMY_RING, 0, Math.PI * 2)
  ctx.lineWidth = 2.5
  ctx.strokeStyle = SHADE
  ctx.stroke()
  ctx.lineWidth = 1.25
  ctx.strokeStyle = ALERT_RED
  ctx.stroke()
}

/** Draws every live blip and drops the expired ones; `still` holds each ring and marker without motion. */
export function drawBlips(
  ctx: BlipCanvas,
  blips: Blip[],
  width: number,
  height: number,
  now: number,
  still: boolean,
) {
  ctx.save()
  for (let i = blips.length - 1; i >= 0; i--) {
    const blip = blips[i]
    const age = now - blip.born
    if (age >= BLIP_MS) {
      blips.splice(i, 1)
      continue
    }
    const color = BLIP_COLORS[blip.kind]
    const x = blip.u * width
    const y = blip.v * height
    if (still) {
      blipRing(ctx, x, y, BLIP_STILL_RING, color, 1)
      blipMarker(ctx, x, y, BLIP_MARK, color, 1)
      continue
    }
    if (age < BLIP_FLASH_MS) {
      ctx.globalAlpha = 1 - age / BLIP_FLASH_MS
      ctx.lineWidth = BLIP_EDGE
      ctx.strokeStyle = color
      ctx.strokeRect(BLIP_EDGE / 2, BLIP_EDGE / 2, width - BLIP_EDGE, height - BLIP_EDGE)
    }
    let mark = BLIP_MARK
    if (age < BLIP_CLOSE_MS) {
      const reach = BLIP_REACH * Math.min(width, height)
      const closed = 1 - (1 - age / BLIP_CLOSE_MS) ** 3
      blipRing(ctx, x, y, reach + (BLIP_RING_CLOSED - reach) * closed, color, 1)
    } else if (age < BLIP_CLOSE_MS + BLIP_PULSES * BLIP_PULSE_MS) {
      const phase = ((age - BLIP_CLOSE_MS) % BLIP_PULSE_MS) / BLIP_PULSE_MS
      blipRing(ctx, x, y, BLIP_RING_CLOSED + BLIP_PULSE_SPREAD * phase, color, 1 - phase)
      mark = BLIP_MARK * (1.6 - 0.6 * phase)
    }
    blipMarker(ctx, x, y, mark, color, Math.min(1, (BLIP_MS - age) / BLIP_FADE_MS))
  }
  ctx.restore()
}

function blipRing(ctx: BlipCanvas, x: number, y: number, radius: number, color: string, alpha: number) {
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.lineWidth = 5
  ctx.strokeStyle = SHADE
  ctx.stroke()
  ctx.lineWidth = 2.5
  ctx.strokeStyle = color
  ctx.stroke()
}

function blipMarker(ctx: BlipCanvas, x: number, y: number, radius: number, color: string, alpha: number) {
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = SHADE
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(x, y, radius * 0.45, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
}

function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function preventMenu(event: Event) {
  event.preventDefault()
}
