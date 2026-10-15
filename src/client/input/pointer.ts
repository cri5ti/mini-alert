import type { Commander } from '../commander.ts'
import type { Replica } from '../replica.ts'
import type { GameView } from '../render/view.ts'
import { canPlaceFootprint } from '../../shared/footprint.ts'
import type { UnitSnapshot } from '../../shared/protocol.ts'
import type { Terrain, TileCoord } from '../../shared/tiles.ts'
import { MoveDomain, spanOf, UNIT_TYPES, UnitTypeId } from '../../shared/unit-types.ts'
import { cursorFor } from './cursor.ts'
import { bindGroupKeys } from './groups.ts'
import { bindPanKeys, typing } from './keys.ts'
import { PanButton, PanDrag } from './pan.ts'

const DRAG_SELECT_PX = 8
const EDGE_PX = 25
const DOUBLE_CLICK_MS = 350
const DOUBLE_CLICK_PX = 8
const DOUBLE_TAP_PX = 24

type ClickMods = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

export function bindInput(
  canvas: HTMLCanvasElement,
  replica: Replica,
  player: Commander,
  view: GameView,
) {
  const keys = bindPanKeys(view)
  bindGroupKeys(player, view)
  const marquee = document.createElement('div')
  marquee.id = 'marquee'
  document.body.append(marquee)

  const pan = new PanDrag()
  let spaceDown = false
  let selectArmed = false
  let boxSelecting = false
  let originX = 0
  let originY = 0
  let lastX = 0
  let lastY = 0
  let pointerX = 0
  let pointerY = 0
  let groundAttack = false
  let lastPick: { typeId: UnitTypeId; at: number; x: number; y: number } | null = null

  const touches = new Map<number, { x: number; y: number }>()
  let pinch: { x: number; y: number; dist: number } | null = null
  let swallowTouch = false

  const syncEdge = (event: PointerEvent) => {
    const target = event.target
    const blocked = target instanceof Element && target.closest('button, a, input, textarea, #minimap, #sheet, #outcome, .dropdown') !== null
    if (event.pointerType === 'touch' || pinch || pan.active || document.body.classList.contains('lobby') || blocked) {
      view.setEdgePan(0, 0)
      return
    }
    let x = 0
    let z = 0
    if (event.clientX <= EDGE_PX) x = -1
    else if (event.clientX >= window.innerWidth - EDGE_PX) x = 1
    if (event.clientY <= EDGE_PX) z = -1
    else if (event.clientY >= window.innerHeight - EDGE_PX) z = 1
    view.setEdgePan(x, z)
  }
  window.addEventListener('pointermove', syncEdge)
  window.addEventListener('blur', () => view.setEdgePan(0, 0))
  document.documentElement.addEventListener('pointerleave', () => view.setEdgePan(0, 0))

  const refreshCursor = (clientX: number, clientY: number) => {
    if (pan.active) canvas.style.cursor = 'grabbing'
    else if (spaceDown) canvas.style.cursor = 'grab'
    else if (player.placingType() !== null || player.raisingCity()) canvas.style.cursor = 'crosshair'
    else canvas.style.cursor = cursorFor(false, replica, player, view, clientX, clientY, groundAttack)
  }

  const showGhost = (clientX: number, clientY: number) => {
    const typeId = player.placingType()
    const world = replica.world
    if (player.raisingCity()) {
      const origin = view.pickTile(clientX, clientY)
      player.setAim(origin)
      if (!origin) {
        view.showPlacement(null)
        return
      }
      view.showPlacement([{ x: origin.x, y: origin.y, open: replica.canRaise(origin) }])
      return
    }
    player.setAim(null)
    if (typeId === null || !world) {
      view.showPlacement(null)
      return
    }
    const origin = view.pickTile(clientX, clientY)
    if (!origin) {
      view.showPlacement(null)
      return
    }
    const span = spanOf(UNIT_TYPES[typeId])
    const domain = typeId === UnitTypeId.Shipyard ? MoveDomain.Water : MoveDomain.Ground
    const terrainAt = (x: number, y: number) => world.terrain[y * world.width + x] as Terrain
    const cells: { x: number; y: number; open: boolean }[] = []
    for (let dy = 0; dy < span.y; dy++) {
      for (let dx = 0; dx < span.x; dx++) {
        const tile = { x: origin.x + dx, y: origin.y + dy }
        const onMap = canPlaceFootprint(tile, 1, world.width, world.height, terrainAt, replica.units, 1, domain)
        cells.push({
          x: tile.x,
          y: tile.y,
          open: onMap && replica.nearCity(tile, 1),
        })
      }
    }
    view.showPlacement(cells)
  }

  const commitPlace = (clientX: number, clientY: number) => {
    const origin = view.pickTile(clientX, clientY)
    if (!origin) return
    placeAt(origin, replica, player, view)
  }

  const beginPan = (event: PointerEvent) => {
    pan.begin(event.button === 1 ? PanButton.Middle : PanButton.Left)
    view.setHovered([])
    lastX = event.clientX
    lastY = event.clientY
    canvas.style.cursor = 'grabbing'
    canvas.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const hideBox = () => {
    boxSelecting = false
    selectArmed = false
    marquee.style.display = 'none'
    view.setBoxPreview(false)
  }

  const fingerPoints = () => [...touches.values()]

  const beginPinch = (event: PointerEvent) => {
    const points = fingerPoints()
    if (points.length < 2) return
    swallowTouch = true
    pan.end()
    hideBox()
    view.setHovered([])
    view.setEdgePan(0, 0)
    canvas.setPointerCapture(event.pointerId)
    let x = 0
    let y = 0
    for (const point of points) {
      x += point.x
      y += point.y
    }
    const first = points[0]!
    const second = points[1]!
    pinch = {
      x: x / points.length,
      y: y / points.length,
      dist: Math.hypot(first.x - second.x, first.y - second.y),
    }
  }

  const stepPinch = () => {
    if (!pinch) return
    const points = fingerPoints()
    if (points.length < 2) return
    let x = 0
    let y = 0
    for (const point of points) {
      x += point.x
      y += point.y
    }
    x /= points.length
    y /= points.length
    const first = points[0]!
    const second = points[1]!
    const dist = Math.hypot(first.x - second.x, first.y - second.y)
    view.panByPixels(pinch.x, pinch.y, x, y)
    const spread = pinch.dist - dist
    if (Math.abs(spread) > 0.5) view.zoomAt(spread, x, y)
    pinch = { x, y, dist }
  }

  const endTouch = (pointerId: number) => {
    touches.delete(pointerId)
    if (touches.size < 2) pinch = null
  }

  const blockPageZoom = (event: Event) => event.preventDefault()
  document.addEventListener('gesturestart', blockPageZoom)
  document.addEventListener('gesturechange', blockPageZoom)
  document.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length > 1) event.preventDefault()
    },
    { passive: false },
  )
  document.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches.length > 1) event.preventDefault()
    },
    { passive: false },
  )

  const boxIds = (x: number, y: number) =>
    view.unitsInRect(originX, originY, x, y, replica.units, replica.playerId)

  const selectKind = (typeId: UnitTypeId, add: boolean) => {
    const field = canvas.getBoundingClientRect()
    const onScreen = view.unitsInRect(field.left, field.top, field.right, field.bottom, replica.units, replica.playerId)
    const same = onScreen.filter((id) => replica.unit(id)?.typeId === typeId)
    if (add) player.addIds(same)
    else player.selectIds(same)
  }

  const repeatsPick = (picked: UnitSnapshot, event: PointerEvent): boolean => {
    if (!lastPick || picked.ownerId !== replica.playerId || picked.typeId !== lastPick.typeId) return false
    if (UNIT_TYPES[picked.typeId].topSpeed <= 0) return false
    if (event.timeStamp - lastPick.at > DOUBLE_CLICK_MS) return false
    const slop = event.pointerType === 'touch' ? DOUBLE_TAP_PX : DOUBLE_CLICK_PX
    return Math.hypot(event.clientX - lastPick.x, event.clientY - lastPick.y) <= slop
  }

  canvas.addEventListener('contextmenu', (event) => event.preventDefault())
  canvas.addEventListener('auxclick', (event) => event.preventDefault())
  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault()
  })
  canvas.addEventListener('lostpointercapture', () => {
    if (!pan.active) return
    pan.end()
    refreshCursor(pointerX, pointerY)
  })

  canvas.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.size >= 2) {
        beginPinch(event)
        event.preventDefault()
        return
      }
    }
    if (event.button === 0 && spaceDown) {
      beginPan(event)
      return
    }
    if (event.button === 2) {
      if (player.placingType() !== null || player.raisingCity()) {
        player.cancelPlace()
        view.showPlacement(null)
      } else {
        player.select(null)
        hideBox()
      }
      refreshCursor(event.clientX, event.clientY)
      event.preventDefault()
      return
    }
    if (event.button === 0 && (player.placingType() !== null || player.raisingCity())) {
      canvas.setPointerCapture(event.pointerId)
      return
    }
    if (event.button === 0) {
      selectArmed = true
      boxSelecting = false
      originX = event.clientX
      originY = event.clientY
      canvas.setPointerCapture(event.pointerId)
      return
    }
    if (event.button === 1) {
      beginPan(event)
    }
  })

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' && touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pinch) {
        stepPinch()
        event.preventDefault()
        return
      }
    }
    view.setZoomCursor(event.clientX, event.clientY)
    pointerX = event.clientX
    pointerY = event.clientY
    if (pan.active && !pan.track(event.buttons)) refreshCursor(event.clientX, event.clientY)
    if ((player.placingType() !== null || player.raisingCity()) && !pan.active) showGhost(event.clientX, event.clientY)
    if (pan.active) {
      view.panByPixels(lastX, lastY, event.clientX, event.clientY)
      lastX = event.clientX
      lastY = event.clientY
      canvas.style.cursor = 'grabbing'
      view.setHovered([])
      return
    }
    if (selectArmed) {
      const dx = event.clientX - originX
      const dy = event.clientY - originY
      if (!boxSelecting && dx * dx + dy * dy >= DRAG_SELECT_PX * DRAG_SELECT_PX) {
        boxSelecting = true
        view.setBoxPreview(true)
      }
      if (boxSelecting) {
        placeMarquee(marquee, originX, originY, event.clientX, event.clientY)
        view.setHovered(boxIds(event.clientX, event.clientY))
        canvas.style.cursor = 'default'
        return
      }
    }
    const hovered = view.pickUnit(event.clientX, event.clientY)
    view.setHovered(hovered === null ? [] : [hovered])
    refreshCursor(event.clientX, event.clientY)
  })

  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'touch') {
      endTouch(event.pointerId)
      if (swallowTouch) {
        hideBox()
        pan.end()
        if (touches.size === 0) swallowTouch = false
        refreshCursor(event.clientX, event.clientY)
        return
      }
    }
    if (pan.active) {
      pan.end()
      refreshCursor(event.clientX, event.clientY)
      return
    }
    if (event.button !== 0) return
    if (player.placingType() !== null || player.raisingCity()) {
      commitPlace(event.clientX, event.clientY)
      refreshCursor(event.clientX, event.clientY)
      return
    }
    if (boxSelecting) {
      if (event.shiftKey) player.addIds(boxIds(event.clientX, event.clientY))
      else player.selectIds(boxIds(event.clientX, event.clientY))
      lastPick = null
      hideBox()
      view.setHovered([])
      refreshCursor(event.clientX, event.clientY)
      return
    }
    if (!selectArmed) return
    selectArmed = false
    const unitId = view.pickUnit(event.clientX, event.clientY)
    const picked = unitId === null ? undefined : replica.unit(unitId)
    if (picked && repeatsPick(picked, event)) {
      selectKind(picked.typeId, event.shiftKey)
      lastPick = null
      refreshCursor(event.clientX, event.clientY)
      return
    }
    let tile = view.pickTile(event.clientX, event.clientY)
    const plot = view.pickCityBuilding(event.clientX, event.clientY)
    if ((event.ctrlKey || event.metaKey) && player.commanding() && plot) tile = plot
    const hallTile = plot ?? tile
    applyClick(tile, picked, replica, player, view, event, hallTile ? replica.ownedHall(hallTile) : null)
    lastPick = picked && picked.ownerId === replica.playerId
      ? { typeId: picked.typeId, at: event.timeStamp, x: event.clientX, y: event.clientY }
      : null
    refreshCursor(event.clientX, event.clientY)
  })

  canvas.addEventListener('pointercancel', (event) => {
    endTouch(event.pointerId)
    if (touches.size === 0) swallowTouch = false
    pinch = null
    pan.end()
    hideBox()
    view.setHovered([])
  })

  canvas.addEventListener('pointerleave', () => {
    if (!pan.active && !selectArmed) view.setHovered([])
  })

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      view.zoomAt(wheelPixels(event), event.clientX, event.clientY)
    },
    { passive: false },
  )

  const syncRanges = (event: KeyboardEvent) => {
    const ctrl = event.key === 'Control' && event.type === 'keyup' ? false : event.ctrlKey
    const meta = event.key === 'Meta' && event.type === 'keyup' ? false : event.metaKey
    groundAttack = ctrl || meta
    view.setShowRanges(groundAttack)
    refreshCursor(pointerX, pointerY)
  }

  window.addEventListener('keydown', (event) => {
    syncRanges(event)
    if (!typing(event) && event.key.toLowerCase() === 'z' && !event.repeat) {
      event.preventDefault()
      view.pingMoves(player.orderReturn())
    }
    if (event.code !== 'Space') return
    if (document.body.classList.contains('lobby')) return
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    if (target instanceof HTMLElement && target.isContentEditable) return
    event.preventDefault()
    if (spaceDown) return
    spaceDown = true
    hideBox()
    view.setHovered([])
    refreshCursor(pointerX, pointerY)
  })

  window.addEventListener('keyup', (event) => {
    syncRanges(event)
    if (event.code !== 'Space') return
    spaceDown = false
    pan.end()
    refreshCursor(pointerX, pointerY)
  })

  window.addEventListener('blur', () => {
    pan.end()
    spaceDown = false
    groundAttack = false
    view.setShowRanges(false)
    hideBox()
    view.setHovered([])
    keys.release()
  })
}

export function orderAt(
  tile: TileCoord,
  replica: Replica,
  player: Commander,
  view: GameView,
  mods: ClickMods,
) {
  if (player.placingType() !== null || player.raisingCity()) {
    player.cancelPlace()
    view.showPlacement(null)
    return
  }
  const standing = replica.occupant(tile)
  const target = standing && (standing.ownerId !== replica.playerId || replica.homePad(standing, player.selected()))
  applyClick(tile, target ? standing : undefined, replica, player, view, mods, replica.ownedHall(tile))
}

function placeAt(tile: TileCoord, replica: Replica, player: Commander, view: GameView) {
  if (player.raisingCity()) {
    player.setAim(tile)
    if (!replica.canRaise(tile)) return
    player.placeCity(tile)
    view.showPlacement(null)
    return
  }
  const typeId = player.placingType()
  const world = replica.world
  if (typeId === null || !world) return
  const terrainAt = (x: number, y: number) => world.terrain[y * world.width + x] as Terrain
  const span = spanOf(UNIT_TYPES[typeId])
  const domain = typeId === UnitTypeId.Shipyard ? MoveDomain.Water : MoveDomain.Ground
  if (!canPlaceFootprint(tile, span.x, world.width, world.height, terrainAt, replica.units, span.y, domain)) return
  if (!replica.nearCity(tile, span.x, span.y)) return
  player.placeBuilding(tile)
  view.showPlacement(null)
}

function applyClick(
  tile: TileCoord | null,
  picked: UnitSnapshot | undefined,
  replica: Replica,
  player: Commander,
  view: GameView,
  mods: ClickMods,
  hall: number | null = null,
) {
  const standing = picked ?? (tile ? replica.occupant(tile) : undefined)
  const force = (mods.ctrlKey || mods.metaKey) && player.commanding()
  const ownUnit = picked !== undefined && picked.ownerId === replica.playerId
  const ownStanding = standing !== undefined && standing.ownerId === replica.playerId
  if (ownUnit && mods.shiftKey) {
    player.toggle(picked.id)
  } else if (force && ownStanding && standing) {
    player.orderAttack(standing.id)
    view.ping(standing.x, standing.z, true)
  } else if (force && tile) {
    player.orderAttackGround(tile)
    view.ping(tile.x + 0.5, tile.y + 0.5, true)
  } else if (standing && standing.ownerId !== replica.playerId && player.commanding()) {
    player.orderAttack(standing.id)
    view.ping(standing.x, standing.z, true)
  } else if (picked && picked.ownerId === replica.playerId && replica.homePad(picked, player.selected())) {
    const pad = { x: picked.tileX, y: picked.tileY }
    view.pingMoves(player.orderMove(pad))
  } else if (picked && picked.ownerId === replica.playerId) {
    player.select(picked.id)
  } else if (hall !== null) {
    player.selectCity(hall)
  } else if (tile && player.factorySelected() && replica.isOpen(tile, [])) {
    player.setRally(tile)
    view.ping(tile.x + 0.5, tile.y + 0.5, false)
  } else if (tile && player.commanding() && replica.canCommand(tile, player.selected())) {
    view.pingMoves(player.orderMove(tile))
  }
}

function placeMarquee(marquee: HTMLElement, x0: number, y0: number, x1: number, y1: number) {
  marquee.style.display = 'block'
  marquee.style.left = `${Math.min(x0, x1)}px`
  marquee.style.top = `${Math.min(y0, y1)}px`
  marquee.style.width = `${Math.abs(x1 - x0)}px`
  marquee.style.height = `${Math.abs(y1 - y0)}px`
}

function wheelPixels(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 40
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * 800
  return event.deltaY
}
