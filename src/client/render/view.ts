import { BoxGeometry, Color, DoubleSide, Group, InstancedMesh, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, RingGeometry } from 'three'
import type { CityState, MapPoint, ShotEvent, ShotHit, UnitSnapshot, WorldSnapshot } from '../../shared/protocol.ts'
import { citySightOrigin, type CityLayout } from '../../shared/cities.ts'
import { collectFriends, type CitySight, type SightSource } from '../../shared/vision.ts'
import { UNIT_TYPES, buildStage, spanOf, Locomotion, type WeaponKind } from '../../shared/unit-types.ts'
import type { ExpectedSite } from '../replica.ts'
import type { TileCoord } from '../../shared/tiles.ts'
import { Fog } from './fog.ts'
import { CityLayer } from './cities.ts'
import { Minimap, type MinimapCommand } from './minimap.ts'
import { createRadarWatch, radarContact, type ContactKind } from './radar.ts'
import { PropField } from './props.ts'
import { Stage, cameraYaw } from './stage.ts'
import { Particles } from './particles.ts'
import { ShotLayer } from './shots.ts'
import { TILE_TOP } from './terrain.ts'
import { buildSurface } from './island.ts'
import { ScarLayer } from './scars.ts'
import { createUnitMesh, releaseMesh, scorchUnit, syncUnitMesh, unitSpan } from './units/vehicle.ts'

const WRECK_HOLD = 4
const WRECK_SINK = 1.6
const BAR_ZOOM = 0.5
const SURFACE_SECONDS = 0.5

type Wreck = {
  group: Group
  age: number
  baseY: number
  drop: number
}

export class GameView {
  private readonly stage: Stage
  private readonly units = new Map<number, Group>()
  private readonly selectionRings: Mesh[] = []
  private readonly hoverRings: Mesh[] = []
  private readonly rangeRings: Mesh[] = []
  private readonly sightRings: Mesh[] = []
  private readonly rangeMark: Mesh
  private readonly sightMark: Mesh
  private showRanges = false
  private hoveredIds: number[] = []
  private boxPreview = false
  private minimap: Minimap | null = null
  private cities: CityLayer | null = null
  private props: PropField | null = null
  private readonly livingUnits: UnitSnapshot[] = []
  private readonly aliveIds = new Set<number>()
  private readonly livingById = new Map<number, UnitSnapshot>()
  private readonly shownSelection: UnitSnapshot[] = []
  private readonly selectedIds = new Set<number>()
  private readonly hoveredUnits: UnitSnapshot[] = []
  private readonly friendBuffer: SightSource[] = []
  private readonly citySights: CitySight[] = []
  private fog: Fog | null = null
  private surface: Group | null = null
  private propsEpoch = -1
  private builtTerrain = -1
  private syncedCities = -1
  private sinceSurface = 0
  private readonly placement: Mesh[] = []
  private readonly expectedSites: Mesh[] = []
  private readonly shots: ShotLayer
  private readonly particles: Particles
  private readonly scars = new ScarLayer()
  private readonly wrecks: Wreck[] = []
  private readonly pings: { mesh: Mesh; age: number }[] = []
  private readonly radar = createRadarWatch()
  private alert: ((kind: ContactKind) => void) | null = null
  private readonly rallyMark: Group
  private readonly hallRing: Mesh
  private shotDt = 0
  private pendingCleared: readonly TileCoord[] = []

  constructor(canvas: HTMLCanvasElement, mapWidth: number, mapHeight: number) {
    this.stage = new Stage(canvas, mapWidth, mapHeight)
    this.shots = new ShotLayer(this.stage.scene, (dirX, dirZ) => this.stage.pixelsPerUnit(dirX, dirZ))
    this.particles = new Particles(this.stage.scene)
    this.stage.scene.add(this.scars.root)
    this.rangeMark = new Mesh(
      new RingGeometry(0.86, 1, 72),
      new MeshBasicMaterial({
        color: 0xd64545,
        transparent: true,
        opacity: 0.8,
        side: DoubleSide,
        depthWrite: false,
      }),
    )
    this.rangeMark.rotation.x = -Math.PI / 2
    this.rangeMark.visible = false
    this.sightMark = new Mesh(
      new RingGeometry(0.94, 1, 72),
      new MeshBasicMaterial({
        color: 0xf6f1dc,
        transparent: true,
        opacity: 0.35,
        side: DoubleSide,
        depthWrite: false,
      }),
    )
    this.sightMark.rotation.x = -Math.PI / 2
    this.sightMark.visible = false
    this.rallyMark = rallyFlag()
    this.stage.scene.add(this.rallyMark)
    this.hallRing = new Mesh(
      new RingGeometry(1.28, 1.48, 40),
      new MeshBasicMaterial({ color: 0xf0d060, transparent: true, opacity: 0.55, depthWrite: false, side: DoubleSide }),
    )
    this.hallRing.rotation.x = -Math.PI / 2
    this.hallRing.visible = false
    this.stage.scene.add(this.hallRing)
  }

  showHall(at: { x: number; z: number } | null) {
    this.hallRing.visible = at !== null
    if (!at) return
    this.hallRing.position.set(at.x, TILE_TOP + 0.08, at.z)
  }

  mountTerrain(world: WorldSnapshot, revision: number, knownTiles: number) {
    const root = document.querySelector<HTMLElement>('#minimap')
    const map = document.querySelector<HTMLCanvasElement>('#minimap-map')
    const marks = document.querySelector<HTMLCanvasElement>('#minimap-marks')
    this.fog = new Fog(this.stage.scene, world.width, world.height)
    this.fog.seed(world.known)
    const sea = new Mesh(
      new PlaneGeometry(world.width, world.height),
      new MeshStandardMaterial({ color: new Color(0x7fcee8), roughness: 0.4, metalness: 0 }),
    )
    sea.rotation.x = -Math.PI / 2
    sea.position.set(world.width / 2, 0, world.height / 2)
    this.stage.scene.add(sea)
    this.presentSurface(world)
    this.scars.sync(world)
    this.builtTerrain = revision
    if (root && map && marks) {
      this.minimap = new Minimap(root, map, marks, world, (x, z) => this.focus(x, z))
    }
    this.cities = new CityLayer()
    void this.cities.load().then(() => this.stage.scene.add(this.cities!.root))
    this.noteProps(world, knownTiles)
  }

  /** Rebuilds the island at most every SURFACE_SECONDS; the fog hides tiles revealed in between. */
  syncTerrain(world: WorldSnapshot, revision: number, knownTiles: number) {
    if (revision === this.builtTerrain || this.sinceSurface < SURFACE_SECONDS) return
    this.builtTerrain = revision
    this.sinceSurface = 0
    this.presentSurface(world)
    this.scars.sync(world)
    this.minimap?.retile(world)
    this.noteProps(world, knownTiles)
    this.props?.hideStale(world)
  }

  syncCities(layouts: readonly (CityLayout | null)[], revision: number) {
    if (revision === this.syncedCities) return
    this.syncedCities = revision
    this.minimap?.setLayouts(layouts)
  }

  private presentSurface(world: WorldSnapshot) {
    if (this.surface) {
      this.stage.scene.remove(this.surface)
      disposeGroup(this.surface)
    }
    this.surface = buildSurface(world)
    this.stage.scene.add(this.surface)
  }

  private noteProps(world: WorldSnapshot, knownTiles: number) {
    const epoch = knownTiles
    if (epoch === this.propsEpoch) return
    this.propsEpoch = epoch
    const field = this.props ?? new PropField()
    this.props = field
    void field.sync(world).then(() => {
      if (this.propsEpoch !== epoch || this.props !== field) return
      if (!field.root.parent) this.stage.scene.add(field.root)
      this.clearGround(this.pendingCleared, false)
    })
  }

  private ownedCitySights(playerId: number, states: readonly (CityState | null)[], layouts: readonly (CityLayout | null)[]) {
    const sights = this.citySights
    let count = 0
    for (let index = 0; index < layouts.length; index++) {
      const state = states[index]
      const layout = layouts[index]
      if (!state || !layout || state.ownerId !== playerId) continue
      const sight = sights[count] ?? (sights[count] = { ownerId: playerId, x: 0, z: 0 })
      const origin = citySightOrigin(layout)
      sight.ownerId = playerId
      sight.x = origin.x
      sight.z = origin.z
      count += 1
    }
    sights.length = count
    return sights
  }

  focus(x: number, z: number) {
    this.stage.focus(x, z)
  }

  resize() {
    this.stage.resize()
  }

  forgetVision(known?: Uint8Array) {
    this.fog?.reset()
    if (known) this.fog?.seed(known)
  }

  setMinimapCommand(command: MinimapCommand) {
    this.minimap?.setCommand(command)
  }

  setMinimapHover(hover: (tile: TileCoord | null) => void) {
    this.minimap?.setHover(hover)
  }

  setAlert(alert: (kind: ContactKind) => void) {
    this.alert = alert
  }

  dispose() {
    this.minimap?.dispose()
    this.stage.dispose()
  }

  setPanAxis(x: number, z: number) {
    this.stage.setPanAxis(x, z)
  }

  setEdgePan(x: number, z: number) {
    this.stage.setEdgePan(x, z)
  }

  nudgeYaw(direction: number) {
    this.stage.nudgeYaw(direction)
  }

  update(dt: number) {
    this.shotDt = dt
    this.sinceSurface += dt
    this.stage.update(dt)
  }

  panByPixels(fromX: number, fromY: number, toX: number, toY: number) {
    this.stage.panByPixels(fromX, fromY, toX, toY)
  }

  setZoomCursor(clientX: number, clientY: number) {
    this.stage.setZoomCursor(clientX, clientY)
  }

  zoomAt(deltaY: number, clientX: number, clientY: number) {
    this.stage.zoomAt(deltaY, clientX, clientY)
  }

  setHovered(ids: readonly number[]) {
    this.hoveredIds = [...ids]
  }

  setBoxPreview(active: boolean) {
    this.boxPreview = active
  }

  setShowRanges(on: boolean) {
    this.showRanges = on
  }

  showExpectedSites(sites: readonly ExpectedSite[]) {
    while (this.expectedSites.length < sites.length) {
      const mesh = new Mesh(
        new PlaneGeometry(1, 1),
        new MeshBasicMaterial({ color: 0xf6f1dc, transparent: true, opacity: 0.4, depthWrite: false }),
      )
      mesh.rotation.x = -Math.PI / 2
      mesh.renderOrder = 4
      this.stage.scene.add(mesh)
      this.expectedSites.push(mesh)
    }
    for (let i = 0; i < this.expectedSites.length; i++) {
      const mesh = this.expectedSites[i]
      const site = sites[i]
      mesh.visible = site !== undefined
      if (!site) continue
      const span = site.typeId === null ? { x: 1, y: 1 } : spanOf(UNIT_TYPES[site.typeId])
      mesh.scale.set(span.x - 0.08, span.y - 0.08, 1)
      mesh.position.set(site.tile.x + span.x / 2, TILE_TOP + 0.09, site.tile.y + span.y / 2)
    }
  }

  showPlacement(cells: readonly { x: number; y: number; open: boolean }[] | null) {
    const list = cells ?? []
    while (this.placement.length < list.length) {
      const mesh = new Mesh(
        new PlaneGeometry(0.92, 0.92),
        new MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }),
      )
      mesh.rotation.x = -Math.PI / 2
      mesh.renderOrder = 4
      this.stage.scene.add(mesh)
      this.placement.push(mesh)
    }
    for (let i = 0; i < this.placement.length; i++) {
      const mesh = this.placement[i]
      const cell = list[i]
      mesh.visible = cell !== undefined
      if (!cell) continue
      mesh.position.set(cell.x + 0.5, TILE_TOP + 0.09, cell.y + 0.5)
      const material = mesh.material
      if (material instanceof MeshBasicMaterial) material.color.set(cell.open ? 0x3cde73 : 0xd64545)
    }
  }

  unitsInRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    units: readonly UnitSnapshot[],
    ownerId: number | null,
  ): number[] {
    const left = Math.min(x0, x1)
    const right = Math.max(x0, x1)
    const top = Math.min(y0, y1)
    const bottom = Math.max(y0, y1)
    const hits: number[] = []
    for (const unit of units) {
      if (unit.ownerId !== ownerId || UNIT_TYPES[unit.typeId].topSpeed <= 0) continue
      const y = selectHeight(unit)
      const center = this.stage.project(unit.x, unit.z, y)
      const mesh = this.units.get(unit.id)
      const span = mesh ? unitSpan(mesh) : 0.7
      const edge = this.stage.project(unit.x + span / 2, unit.z, y)
      const radius = Math.max(6, Math.hypot(edge.x - center.x, edge.y - center.y))
      if (circleHitsRect(center.x, center.y, radius, left, top, right, bottom)) hits.push(unit.id)
    }
    return hits
  }

  pickUnit(clientX: number, clientY: number): number | null {
    return this.stage.pickUnit([...this.units.values()], clientX, clientY)
  }

  pickTile(clientX: number, clientY: number): TileCoord | null {
    return this.stage.pickTile(clientX, clientY)
  }

  pickCityBuilding(clientX: number, clientY: number): TileCoord | null {
    const root = this.cities?.root
    if (!root) return null
    return this.stage.pickPlot(root, clientX, clientY)
  }

  /** One fading ring per path end. The same tile is marked once when a group shares it. */
  pingMoves(goals: readonly TileCoord[]) {
    const seen = new Set<string>()
    for (const goal of goals) {
      const key = `${goal.x},${goal.y}`
      if (seen.has(key)) continue
      seen.add(key)
      this.ping(goal.x + 0.5, goal.y + 0.5, false)
    }
  }

  ping(x: number, z: number, attack: boolean) {
    const mesh = new Mesh(
      new RingGeometry(0.34, 0.5, 28),
      new MeshBasicMaterial({
        color: attack ? 0xd64545 : 0x3cde73,
        transparent: true,
        opacity: 1,
        side: DoubleSide,
        depthWrite: false,
      }),
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(x, TILE_TOP + 0.07, z)
    this.stage.scene.add(mesh)
    this.pings.push({ mesh, age: 0 })
  }

  render(
    units: readonly UnitSnapshot[],
    selected: readonly UnitSnapshot[],
    shots: readonly ShotEvent[] = [],
    hits: readonly ShotHit[] = [],
    playerId: number | null = null,
    cities: readonly (CityState | null)[] = [],
    layouts: readonly (CityLayout | null)[] = [],
    rally: TileCoord | null = null,
    cleared: readonly TileCoord[] = [],
    yields: readonly MapPoint[] = [],
  ) {
    const living = this.livingUnits
    living.length = 0
    for (const unit of units) {
      if (unit.health > 0) {
        living.push(unit)
        continue
      }
      const group = this.units.get(unit.id)
      if (!group) continue
      this.wreck(group)
      this.units.delete(unit.id)
    }
    const alive = this.aliveIds
    alive.clear()
    this.livingById.clear()
    for (const unit of living) {
      alive.add(unit.id)
      this.livingById.set(unit.id, unit)
    }
    const shownSelection = this.shownSelection
    shownSelection.length = 0
    for (const unit of selected) shownSelection.push(this.livingById.get(unit.id) ?? unit)
    selected = shownSelection
    for (const [id, group] of this.units) {
      if (alive.has(id)) continue
      releaseMesh(group)
      this.units.delete(id)
    }
    this.advanceWrecks(this.shotDt)
    this.advancePings(this.shotDt)
    const selectedIds = this.selectedIds
    selectedIds.clear()
    for (const unit of selected) selectedIds.add(unit.id)
    const showBars = this.stage.zoom >= BAR_ZOOM
    for (const unit of living) {
      let group = this.units.get(unit.id)
      const stage = buildStage(unit.progress)
      const built = UNIT_TYPES[unit.typeId].topSpeed <= 0
      if (group && built && group.userData.stage !== stage) {
        releaseMesh(group)
        this.units.delete(unit.id)
        group = undefined
      }
      if (!group) {
        group = createUnitMesh(unit)
        this.units.set(unit.id, group)
        this.stage.scene.add(group)
      }
      syncUnitMesh(group, unit, selectedIds.has(unit.id), showBars)
    }

    const showSelection = !this.boxPreview
    this.placeRings(this.selectionRings, this.stage.selection, showSelection ? selected : [])
    const showRanges = showSelection && this.showRanges && selected.length === 1
    this.placeRanges(showRanges ? selected : [])
    this.placeRally(rally)

    const hovered = this.hoveredUnits
    hovered.length = 0
    for (const id of this.hoveredIds) {
      if (!this.boxPreview && selectedIds.has(id)) continue
      const unit = living.find((candidate) => candidate.id === id)
      if (unit) hovered.push(unit)
    }
    this.placeRings(this.hoverRings, this.stage.hover, hovered)

    for (const drop of yields) this.particles.collect(drop.x, drop.y)
    const impact = (x: number, z: number, kind: WeaponKind) => this.particles.hit(x, z, kind)
    this.shots.spawn(shots)
    this.shots.strike(hits, impact)
    this.shots.advance(this.shotDt, impact)
    this.particles.advance(this.shotDt)
    this.scars.advance(this.shotDt)
    if (playerId === null) this.friendBuffer.length = 0
    else collectFriends(living, playerId, this.ownedCitySights(playerId, cities, layouts), this.friendBuffer)
    this.fog?.update(this.shotDt, this.friendBuffer)
    this.fog?.setView(cameraYaw)
    this.cities?.present(layouts, cities)
    this.clearGround(cleared)
    const contact = radarContact(this.radar, performance.now(), playerId, units, cities)
    if (contact) {
      this.minimap?.blip(contact.x, contact.z, contact.kind)
      this.alert?.(contact.kind)
    }
    this.minimap?.draw(living, selectedIds, playerId, this.stage.groundViewport(), this.fog?.mask, cities, rally)
    this.stage.draw()
  }

  private clearGround(tiles: readonly TileCoord[], burst = true) {
    this.pendingCleared = tiles
    const props = this.props
    if (!props || tiles.length === 0) return
    const fell = props.hideTrees(tiles)
    if (!burst) return
    for (const spot of fell) this.particles.fell(spot.x, spot.z)
  }

  private wreck(group: Group) {
    const bodyHeight = group.userData.bodyHeight
    const height = typeof bodyHeight === 'number' ? bodyHeight : 0.5
    scorchUnit(group)
    this.particles.explosion(group.position.x, group.position.y, group.position.z)
    this.wrecks.push({
      group,
      age: 0,
      baseY: group.position.y,
      drop: height + 0.28,
    })
  }

  private advanceWrecks(dt: number) {
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const wreck = this.wrecks[i]
      wreck.age += dt
      if (wreck.age <= WRECK_HOLD) continue
      const t = Math.min(1, (wreck.age - WRECK_HOLD) / WRECK_SINK)
      wreck.group.position.y = wreck.baseY - wreck.drop * t * t
      if (t < 1) continue
      releaseMesh(wreck.group)
      this.wrecks.splice(i, 1)
    }
  }

  private advancePings(dt: number) {
    const life = 0.42
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const ping = this.pings[i]
      ping.age += dt
      const t = ping.age / life
      if (t >= 1) {
        ping.mesh.removeFromParent()
        ping.mesh.geometry.dispose()
        const material = ping.mesh.material
        if (material instanceof MeshBasicMaterial) material.dispose()
        this.pings.splice(i, 1)
        continue
      }
      const bounce = Math.sin(Math.min(t * 1.15, 1) * Math.PI)
      ping.mesh.scale.setScalar(0.25 + bounce * 1.25)
      const material = ping.mesh.material
      if (material instanceof MeshBasicMaterial) material.opacity = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6
    }
  }

  private placeRings(pool: Mesh[], source: Mesh, units: readonly UnitSnapshot[]) {
    source.visible = false
    const rings = growRings(pool, source, units.length, this.stage.scene)
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i]
      const unit = units[i]
      if (!unit) {
        ring.visible = false
        continue
      }
      ring.visible = true
      placeRing(ring, unit, this.units.get(unit.id))
    }
  }

  private placeRanges(units: readonly UnitSnapshot[]) {
    const ready = units.filter((unit) => unit.progress >= 1)
    this.placeDistance(
      this.sightRings,
      this.sightMark,
      ready.flatMap((unit) => {
        const sight = UNIT_TYPES[unit.typeId].weapon.sight
        return sight > 0 ? [{ unit, radius: sight }] : []
      }),
      0.06,
      TILE_TOP + 0.065,
    )
    this.placeDistance(
      this.rangeRings,
      this.rangeMark,
      ready.flatMap((unit) => {
        const weapon = UNIT_TYPES[unit.typeId].weapon
        return weapon.damage > 0 && weapon.range > 0 ? [{ unit, radius: weapon.range }] : []
      }),
      0.14,
      TILE_TOP + 0.07,
    )
  }

  private placeDistance(
    pool: Mesh[],
    source: Mesh,
    marks: readonly { unit: UnitSnapshot; radius: number }[],
    band: number,
    y: number,
  ) {
    const rings = growRings(pool, source, marks.length, this.stage.scene)
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i]
      const mark = marks[i]
      if (!mark) {
        ring.visible = false
        continue
      }
      if (ring.userData.range !== mark.radius) {
        const next = new RingGeometry(Math.max(0.05, mark.radius - band), mark.radius, 80)
        if (ring.geometry !== source.geometry) ring.geometry.dispose()
        ring.geometry = next
        ring.userData.range = mark.radius
      }
      ring.visible = true
      ring.scale.set(1, 1, 1)
      ring.position.set(mark.unit.x, y, mark.unit.z)
    }
  }

  private placeRally(rally: TileCoord | null) {
    this.rallyMark.visible = rally !== null
    if (!rally) return
    this.rallyMark.position.set(rally.x + 0.5, TILE_TOP, rally.y + 0.5)
  }
}

function growRings(pool: Mesh[], source: Mesh, count: number, scene: { add(mesh: Mesh): void }): Mesh[] {
  while (pool.length < count) {
    const mesh = source.clone()
    mesh.visible = false
    scene.add(mesh)
    pool.push(mesh)
  }
  return pool
}

function disposeGroup(group: Group) {
  const materials = new Set<Material>()
  group.traverse((child) => {
    if (!(child instanceof Mesh)) return
    if (child instanceof InstancedMesh) child.dispose()
    if (!child.geometry.userData.retain) child.geometry.dispose()
    const material = child.material
    if (Array.isArray(material)) for (const item of material) materials.add(item)
    else materials.add(material)
  })
  for (const material of materials) {
    if (!material.userData.retain) material.dispose()
  }
}

function circleHitsRect(
  cx: number,
  cy: number,
  radius: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean {
  const nearestX = Math.min(right, Math.max(left, cx))
  const nearestY = Math.min(bottom, Math.max(top, cy))
  const dx = cx - nearestX
  const dy = cy - nearestY
  return dx * dx + dy * dy <= radius * radius
}

function rallyFlag(): Group {
  const group = new Group()
  const pole = new Mesh(
    new BoxGeometry(0.06, 1.1, 0.06),
    new MeshBasicMaterial({ color: 0xe7efe0 }),
  )
  pole.position.y = 0.55
  const flag = new Mesh(
    new PlaneGeometry(0.62, 0.38),
    new MeshBasicMaterial({ color: 0xf0d060, side: DoubleSide }),
  )
  flag.position.set(0.34, 0.9, 0)
  group.add(pole, flag)
  group.visible = false
  return group
}

function placeRing(ring: Mesh, unit: UnitSnapshot, mesh: Group | undefined) {
  const span = mesh ? unitSpan(mesh) : 0.7
  ring.scale.set(span / 0.72, span / 0.72, 1)
  ring.position.set(unit.x, selectHeight(unit), unit.z)
}

function selectHeight(unit: UnitSnapshot): number {
  const type = UNIT_TYPES[unit.typeId]
  if (type.locomotion !== Locomotion.Plane && type.locomotion !== Locomotion.Rotor) return TILE_TOP + 0.06
  return TILE_TOP + (unit.altitude ?? 0) + type.hull.y * 0.5
}
