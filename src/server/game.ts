import { BUILDING_HP, BUILDING_RADIUS, buildingCost, canPlaceCityBuilding, captureDuration, captureFade, CITY_GROW_SECONDS, clampCityFocus, DENSITY_MIN, cityCenter, cityContains, cityHolds, citySightOrigin, eachBuildingTile, footprintNearCity, growCity, growthFactor, insertBuilding, layoutCities, lostStreets, modelAtRank, moneyFactor, populationOf, settledCity, SIEGE_RANGE, STREET_HP, StreetKind, type CityLayout } from '../shared/cities.ts'
import type { CitySite, CityState, MapPoint, ShotEvent, ShotHit, TrainJob, UnitSnapshot } from '../shared/protocol.ts'
import type { CitySight } from '../shared/vision.ts'
import { SCAR_CHANCE, SCAR_FADE, SCAR_MAX, Terrain, scarGain, scarStrength, scarTerrain, tileCenter, type TileCoord } from '../shared/tiles.ts'
import { bayFacing, bayTile, baysFree, Flight, openBay } from '../shared/flight.ts'
import { domainOf, MoveDomain, spanOf, UNIT_TYPES, UnitTypeId, yardOf } from '../shared/unit-types.ts'
import { atRest, SIM_STEP } from '../shared/motion.ts'
import { planMoves } from '../shared/route.ts'
import { PathFinder } from './path/pathfinder.ts'
import { instantBuilds } from './instant.ts'
import { __TRACE__, traceBegin, traceEnd } from './trace.ts'
import { TraceSlot } from '../shared/trace.ts'
import { CREDIT_PER_POPULATION, INCOME_SECONDS, Player, creditCap } from './player.ts'
import { createUnit } from './units/create.ts'
import { Unit } from './units/unit.ts'
import { applyImpacts, engage, type Blast, type Impact } from './sim/combat.ts'
import { World } from './world.ts'
import { Quad } from '../shared/quad.ts'

export type Scenery = {
  coast: MapPoint[]
  holes: MapPoint[][]
  roads: MapPoint[][]
  towns: MapPoint[]
  seed: number
}

/** Settled layouts by city, valid while the city keeps its layout object and its ruin count; ruins only grow. */
const settledCities = new WeakMap<object, { layout: CityLayout; ruins: number; settled: CityLayout }>()

const EMPTY_SCENERY: Scenery = { coast: [], holes: [], roads: [], towns: [], seed: 0 }

type CityRuntime = {
  layout: CityLayout
  ownerId: number
  progress: number
  challengerId: number
  grown: number
  /** -2..2. Negative leans toward money, positive toward growth. */
  focus: number
  growCredit: number
  ruins: TileCoord[]
  sites: CitySite[]
  integrity: Map<string, number>
}
const SPAWN_STEPS: TileCoord[] = [
  { x: 0, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 1, y: -1 },
  { x: 0, y: 2 },
  { x: 0, y: -2 },
  { x: 2, y: 0 },
]

const SPAWN_REACH = 8
const FACTORY_BUILD_BONUS = 0.25

function spawnSteps(): TileCoord[] {
  const steps = [...SPAWN_STEPS]
  const seen = new Set(steps.map((step) => `${step.x},${step.y}`))
  for (let radius = 0; radius <= SPAWN_REACH; radius++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue
        const key = `${x},${y}`
        if (seen.has(key)) continue
        seen.add(key)
        steps.push({ x, y })
      }
    }
  }
  return steps
}

export class Game {
  readonly world: World
  readonly pathfinder: PathFinder
  readonly units: Unit[] = []
  private readonly captureSeek = new Quad()
  private readonly captureHits: number[] = []
  private readonly players = new Map<number, Player>()
  private nextUnitId = 1
  private nextPlayerId = 1
  private readonly spawnAnchors = new Map<number, TileCoord>()
  private impacts: Impact[] = []
  private time = 0
  private deaths: Unit[] = []
  private readonly jobs = new Map<number, number[]>()
  private readonly training = new Map<number, TrainJob[]>()
  private readonly rallies = new Map<number, TileCoord>()
  scenery: Scenery = EMPTY_SCENERY
  private readonly cities: CityRuntime[] = []
  private incomeClock = 0
  private yields: MapPoint[] = []
  private landed: ShotHit[] = []
  private growthTerrain: number[] | null = null
  private readonly fallen: TileCoord[] = []
  private readonly scars: TileCoord[] = []
  /** Tile index to the time its scar next loses a strength. */
  private scarUntil = new Map<number, number>()

  constructor(world: World) {
    this.world = world
    this.pathfinder = new PathFinder(world)
  }

  static fromState(fields: Record<string, unknown>): Game {
    const world = fields.world
    if (!(world instanceof World)) throw new Error('saved game has no world')
    const game = new Game(world)
    game.install(fields)
    return game
  }

  private install(fields: Record<string, unknown>) {
    const target = this as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'world' || key === 'pathfinder' || key === 'captureSeek' || key === 'captureHits') continue
      target[key] = value
    }
    this.reseat()
  }

  private reseat() {
    for (const unit of this.units) {
      if (unit.health <= 0) continue
      this.fillFootprint(unit)
    }
    this.syncBlocks()
    this.armScars()
  }

  addPlayer(color?: number): Player {
    const player = new Player(this.nextPlayerId++, color)
    this.players.set(player.id, player)
    return player
  }

  player(id: number): Player | undefined {
    return this.players.get(id)
  }

  setSpawnAnchor(playerId: number, tile: TileCoord) {
    this.spawnAnchors.set(playerId, tile)
  }

  bindCities() {
    const terrain = this.terrainTable()
    this.cities.length = 0
    for (const layout of layoutCities(this.scenery.towns, this.scenery.seed, terrain, this.world.width, this.world.height)) {
      this.cities.push({ layout, ownerId: 0, progress: 0, challengerId: 0, grown: 0, focus: 0, growCredit: 0, ruins: [], sites: [], integrity: new Map() })
      this.clearCityTrees(layout)
    }
    this.syncBlocks()
  }

  setCityFocus(playerId: number, index: number, focus: number): boolean {
    const city = this.cities[index]
    if (!city || city.ownerId !== playerId) return false
    city.focus = clampCityFocus(focus)
    return true
  }

  claimCity(town: MapPoint, playerId: number) {
    const x = Math.floor(town.x)
    const y = Math.floor(town.y)
    const city = this.cities.find((candidate) => cityContains(candidate.layout, x, y))
    if (!city || city.ownerId === playerId) return
    const previous = city.ownerId
    city.ownerId = playerId
    const loser = this.players.get(previous)
    if (loser) this.capCredits(loser)
  }

  cityLayouts(): CityLayout[] {
    return this.cities.map((city) => city.layout)
  }

  cityStates(): CityState[] {
    return this.cities.map((city) => ({
      ownerId: city.ownerId,
      color: city.ownerId > 0 ? (this.player(city.ownerId)?.color ?? 0) : 0,
      progress: city.progress,
      challengerId: city.challengerId,
      challengerColor: city.challengerId > 0 ? (this.player(city.challengerId)?.color ?? 0) : 0,
      grown: city.grown,
      focus: city.focus,
      ruins: city.ruins.map((tile) => ({ x: tile.x, y: tile.y })),
      sites: city.sites.map((site) => ({
        x: site.x,
        y: site.y,
        model: site.model,
        yaw: site.yaw,
        at: site.at,
      })),
    }))
  }

  felled(): readonly TileCoord[] {
    return this.fallen
  }

  scarred(): readonly TileCoord[] {
    return this.scars
  }

  clearedTiles(): TileCoord[] {
    return this.fallen.map((tile) => ({ x: tile.x, y: tile.y }))
  }

  citySights(): CitySight[] {
    return this.cities.map((city) => ({ ownerId: city.ownerId, ...citySightOrigin(this.live(city)) }))
  }

  nearestUnownedCityTile(playerId: number, from: TileCoord): TileCoord | null {
    let best: TileCoord | null = null
    let bestDist = Infinity
    for (const city of this.cities) {
      if (city.ownerId === playerId) continue
      const layout = this.live(city)
      if (layout.tiles.length === 0) continue
      const center = cityCenter(layout)
      const dist = (center.x - from.x) ** 2 + (center.y - from.y) ** 2
      if (dist >= bestDist) continue
      bestDist = dist
      best = center
    }
    return best
  }

  creditIncome(playerId: number): number {
    let population = 0
    for (const city of this.cities) {
      if (city.ownerId !== playerId || this.besieged(city)) continue
      population += this.peopleOf(city) * moneyFactor(city.focus)
    }
    return CREDIT_PER_POPULATION * population
  }

  takeYields(): MapPoint[] {
    const yields = this.yields
    this.yields = []
    return yields
  }

  takeHits(): ShotHit[] {
    const hits = this.landed
    this.landed = []
    return hits
  }

  hasFinishedFactory(playerId: number): boolean {
    return this.units.some(
      (unit) =>
        unit.ownerId === playerId &&
        unit.typeId === UnitTypeId.Factory &&
        unit.health > 0 &&
        unit.progress >= 1,
    )
  }

  placeBuilding(playerId: number, typeId: UnitTypeId, tile: TileCoord): boolean {
    const owner = this.players.get(playerId)
    const type = UNIT_TYPES[typeId]
    if (!owner || type.topSpeed > 0) return false
    if (type.supply > 0 && this.supplyUsed(playerId) + type.supply > this.population(playerId)) return false
    const span = spanOf(type)
    const domain = typeId === UnitTypeId.Shipyard ? MoveDomain.Water : MoveDomain.Ground
    if (!this.footprintFree(tile, span.x, domain, span.y)) return false
    const owned = this.cities.filter((city) => city.ownerId === playerId).map((city) => this.live(city))
    if (!footprintNearCity(owned, tile, span.x, span.y)) return false
    const unit = this.spawn(owner, typeId, tile, 0)
    unit.bill = type.cost
    unit.progress = 0
    const queue = this.jobs.get(playerId) ?? []
    queue.push(unit.id)
    this.jobs.set(playerId, queue)
    return true
  }

  placeCityBuilding(playerId: number, tile: TileCoord): boolean {
    const owner = this.players.get(playerId)
    if (!owner || !this.pathfinder.isWalkable(tile.x, tile.y, -1)) return false
    const terrain = this.terrainTable()
    let cityIndex = -1
    for (let i = 0; i < this.cities.length; i++) {
      const city = this.cities[i]
      if (city.ownerId !== playerId) continue
      if (!canPlaceCityBuilding(city.layout, tile.x, tile.y, terrain, this.world.width, this.world.height)) continue
      cityIndex = i
      break
    }
    if (cityIndex < 0) return false
    const city = this.cities[cityIndex]
    const quote = buildingCost(populationOf(this.live(city), city.ruins))
    if (owner.credits < quote) return false
    const next = insertBuilding(
      city.layout,
      { x: tile.x, y: tile.y, model: modelAtRank(DENSITY_MIN, Math.floor(Math.random() * 0x7fffffff)), yaw: Math.floor(Math.random() * 4) },
      terrain,
      this.world.width,
      this.world.height,
    )
    if (!next) return false
    const placed = next.buildings.find((building) => building.x === tile.x && building.y === tile.y)
    if (!placed) return false
    owner.credits -= quote
    city.layout = next
    this.clearCityTrees(next)
    city.sites.push({
      x: placed.x,
      y: placed.y,
      model: placed.model,
      yaw: placed.yaw,
      at: city.grown,
    })
    this.syncBlocks()
    return true
  }

  placeNearAnchor(playerId: number, typeId: UnitTypeId): boolean {
    const anchor = this.spawnAnchors.get(playerId)
    if (!anchor) return false
    for (const step of spawnSteps()) {
      const tile = { x: anchor.x + step.x, y: anchor.y + step.y }
      if (this.placeBuilding(playerId, typeId, tile)) return true
    }
    return false
  }

  finishBuild(playerId: number) {
    const queue = this.jobs.get(playerId)
    const id = queue?.[0]
    if (id === undefined) return
    const unit = this.units.find((candidate) => candidate.id === id)
    const owner = this.players.get(playerId)
    if (unit && owner && unit.progress < 1) {
      owner.credits = Math.max(0, owner.credits - unit.bill * (1 - unit.progress))
    }
    if (unit) {
      unit.progress = 1
      if (unit.typeId === UnitTypeId.Airport) this.adoptOrphanJets(unit)
    }
    queue?.shift()
    if (queue && queue.length === 0) this.jobs.delete(playerId)
  }

  cancelBuild(playerId: number, typeId: UnitTypeId): boolean {
    const queue = this.jobs.get(playerId)
    if (!queue) return false
    for (let i = queue.length - 1; i >= 0; i--) {
      const unit = this.units.find((candidate) => candidate.id === queue[i])
      if (!unit || unit.typeId !== typeId || unit.progress >= 1) continue
      queue.splice(i, 1)
      unit.health = 0
      if (queue.length === 0) this.jobs.delete(playerId)
      return true
    }
    return false
  }

  trainingFor(playerId: number): TrainJob[] {
    return (this.training.get(playerId) ?? []).map((job) => ({ typeId: job.typeId, progress: job.progress, yardId: job.yardId }))
  }

  trainingCount(playerId: number): number {
    return this.training.get(playerId)?.length ?? 0
  }

  setRally(playerId: number, tile: TileCoord): boolean {
    if (!this.ownsFactory(playerId)) return false
    if (!this.pathfinder.isWalkable(tile.x, tile.y, -1)) return false
    this.rallies.set(playerId, { x: tile.x, y: tile.y })
    return true
  }

  rally(playerId: number): TileCoord | null {
    const tile = this.rallies.get(playerId)
    return tile ? { x: tile.x, y: tile.y } : null
  }

  trySpawn(playerId: number, typeId: UnitTypeId, yardId: number): boolean {
    const owner = this.players.get(playerId)
    const type = UNIT_TYPES[typeId]
    const yard = this.owned(playerId, yardId)
    if (!owner || !yard || type.topSpeed <= 0 || yard.health <= 0 || yard.progress < 1) return false
    if (yard.typeId !== yardOf(typeId)) return false
    if (this.supplyUsed(playerId) + type.supply > this.population(playerId)) return false
    if (typeId === UnitTypeId.Jet && this.queuedJets(playerId, yard.id) >= this.baysAt(yard)) return false
    const queue = this.training.get(playerId) ?? []
    queue.push({ typeId, progress: 0, yardId: yard.id })
    this.training.set(playerId, queue)
    return true
  }

  cancelTraining(playerId: number, typeId: UnitTypeId, yardId = 0): boolean {
    const queue = this.training.get(playerId)
    if (!queue) return false
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].typeId !== typeId) continue
      if (yardId !== 0 && queue[i].yardId !== yardId) continue
      queue.splice(i, 1)
      if (queue.length === 0) this.training.delete(playerId)
      return true
    }
    return false
  }

  spawn(owner: Player, typeId: UnitTypeId, tile: TileCoord, facing = 0): Unit {
    const type = UNIT_TYPES[typeId]
    const domain = typeId === UnitTypeId.Shipyard ? MoveDomain.Water : domainOf(type)
    const pad = domain === MoveDomain.Water ? MoveDomain.Water : MoveDomain.Ground
    const span = spanOf(type)
    const spot = type.topSpeed > 0 ? this.openSpawn(tile, span.x, pad, span.y) : tile
    if (!spot || !this.footprintFree(spot, span.x, pad, span.y)) {
      throw new Error(`cannot spawn on ${tile.x},${tile.y}`)
    }
    const unit = createUnit(this.nextUnitId++, owner.id, type, spot, facing)
    unit.pos = { x: spot.x + span.x / 2, z: spot.y + span.y / 2 }
    this.units.push(unit)
    owner.addUnit(unit.id)
    if (domain !== MoveDomain.Air) this.fillFootprint(unit)
    return unit
  }

  /** Moves the units toward the tile; ground and sea units at rest then advance `lag` steps, as the ordering client already shows them. */
  orderMove(playerId: number, unitIds: readonly number[], tile: TileCoord, lag = 0): boolean {
    let moved = false
    const surface: Unit[] = []
    for (const unit of this.ownedAll(playerId, unitIds)) {
      if (unit.type.topSpeed <= 0) continue
      unit.attackId = null
      unit.attackPoint = null
      if (domainOf(unit.type) === MoveDomain.Air) {
        if (unit.orderMove(tile, this.pathfinder, this.units)) moved = true
      } else surface.push(unit)
    }
    const resting = new Set(surface.filter(atRest))
    const movers = surface.map((unit) => ({ id: unit.id, tile: unit.tile, domain: domainOf(unit.type) }))
    const routes = planMoves(this.pathfinder, movers, tile)
    for (const unit of surface) {
      const path = routes.get(unit.id)
      if (!path || !unit.travel(path)) continue
      moved = true
      if (!resting.has(unit)) continue
      for (let i = 0; i < lag; i++) unit.step(SIM_STEP, this.pathfinder, this.units)
    }
    return moved
  }

  orderAttack(playerId: number, unitIds: readonly number[], targetId: number): boolean {
    const target = this.units.find((candidate) => candidate.id === targetId)
    if (!target || target.health <= 0) return false
    let ordered = false
    for (const unit of this.ownedAll(playerId, unitIds)) {
      if (target.id === unit.id) continue
      unit.attackPoint = null
      unit.attackId = target.id
      unit.step(0, this.pathfinder, this.units)
      ordered = true
    }
    return ordered
  }

  orderAttackGround(playerId: number, unitIds: readonly number[], tile: TileCoord): boolean {
    if (!this.world.inBounds(tile.x, tile.y)) return false
    const point = { x: tile.x + 0.5, z: tile.y + 0.5 }
    let ordered = false
    for (const unit of this.ownedAll(playerId, unitIds)) {
      if (unit.health <= 0 || unit.progress < 1 || unit.type.weapon.damage <= 0) continue
      if (unit.type.topSpeed <= 0 && Math.hypot(point.x - unit.pos.x, point.z - unit.pos.z) > unit.type.weapon.range) continue
      unit.attackId = null
      unit.attackPoint = point
      unit.step(0, this.pathfinder, this.units)
      ordered = true
    }
    return ordered
  }

  tick(dt: number): ShotEvent[] {
    this.advanceIncome(dt)
    __TRACE__ && traceBegin(TraceSlot.Build)
    this.advanceBuilds(dt)
    __TRACE__ && traceEnd()
    __TRACE__ && traceBegin(TraceSlot.Units)
    for (const unit of this.units) {
      if (unit.health <= 0) continue
      unit.step(dt, this.pathfinder, this.units)
    }
    __TRACE__ && traceEnd()
    this.time += dt
    const blasts: Blast[] = []
    __TRACE__ && traceBegin(TraceSlot.CombatSights)
    const sights = this.citySights()
    __TRACE__ && traceEnd()
    __TRACE__ && traceBegin(TraceSlot.CombatBuildings)
    const structures = this.buildingTargets()
    __TRACE__ && traceEnd()
    const shots = engage(this.units, dt, this.time, this.impacts, sights, blasts, structures, this.world.width, this.world.height)
    __TRACE__ && traceBegin(TraceSlot.CombatImpacts)
    const hits = applyImpacts(this.units, this.impacts, this.time, blasts)
    for (const shot of shots) {
      if (shot.flight === 0) hits.push({ kind: shot.kind, aimX: shot.aimX, aimZ: shot.aimZ })
    }
    this.landed = hits
    __TRACE__ && traceEnd()
    __TRACE__ && traceBegin(TraceSlot.Map)
    this.blast(blasts)
    __TRACE__ && traceEnd()
    this.removeDead()
    this.fadeScars()
    __TRACE__ && traceBegin(TraceSlot.CityCapture)
    this.advanceCaptures(dt)
    __TRACE__ && traceEnd()
    __TRACE__ && traceBegin(TraceSlot.CityGrowth)
    this.advanceGrowth(dt)
    __TRACE__ && traceEnd()
    __TRACE__ && traceBegin(TraceSlot.Build)
    this.advanceTraining(dt)
    __TRACE__ && traceEnd()
    this.capAllCredits()
    return shots
  }

  unitSnapshots(): UnitSnapshot[] {
    return this.units.map((unit) => this.snapshot(unit))
  }

  takeDeaths(): UnitSnapshot[] {
    const snapshots = this.deaths.map((unit) => this.snapshot(unit))
    this.deaths = []
    return snapshots
  }

  private ownedAll(playerId: number, unitIds: readonly number[]): Unit[] {
    const units: Unit[] = []
    for (const id of new Set(unitIds)) {
      const unit = this.owned(playerId, id)
      if (unit) units.push(unit)
    }
    return units
  }

  private owned(playerId: number, unitId: number): Unit | undefined {
    const player = this.players.get(playerId)
    if (!player?.owns(unitId)) return undefined
    return this.units.find((candidate) => candidate.id === unitId)
  }

  private removeDead() {
    this.deaths = []
    for (const unit of this.units) {
      if (unit.health > 0) continue
      if (unit.type.topSpeed <= 0) this.scarFootprint(unit)
      this.pathfinder.release(unit)
      this.clearJob(unit.id)
      this.clearTraining(unit.id)
      this.deaths.push(unit)
    }
    this.units.splice(0, this.units.length, ...this.units.filter((unit) => unit.health > 0))
  }

  /** Floats are float32, as the wire carries them, so the host's shadows and AI seats hold what clients decode. */
  private snapshot(unit: Unit): UnitSnapshot {
    return {
      id: unit.id,
      typeId: unit.typeId,
      ownerId: unit.ownerId,
      color: this.player(unit.ownerId)?.color ?? 0xffffff,
      x: Math.fround(unit.pos.x),
      z: Math.fround(unit.pos.z),
      facing: Math.fround(unit.facing),
      turretYaw: Math.fround(unit.type.weapon.turretRate > 0 ? unit.turretYaw : unit.facing),
      speed: Math.fround(unit.speed),
      health: Math.fround(unit.health),
      tileX: unit.tile.x,
      tileY: unit.tile.y,
      path: unit.path.map((tile) => ({ x: tile.x, y: tile.y })),
      goal: unit.path.length > 0 ? { ...unit.path[unit.path.length - 1] } : null,
      attackId: unit.attackId,
      attackPoint: unit.attackPoint ? { x: Math.fround(unit.attackPoint.x), z: Math.fround(unit.attackPoint.z) } : null,
      progress: Math.fround(unit.progress),
      home: unit.home ? { x: unit.home.x, y: unit.home.y } : null,
      returning: unit.returning,
      flight: unit.flight,
      altitude: Math.fround(unit.altitude),
      orbit: unit.orbit ? { x: unit.orbit.x, y: unit.orbit.y } : null,
      bay: unit.bay,
      rounds: unit.rounds,
    }
  }

  private terrainTable(): number[] {
    if (this.growthTerrain && this.growthTerrain.length === this.world.width * this.world.height) return this.growthTerrain
    const terrain: number[] = []
    for (let y = 0; y < this.world.height; y++) {
      for (let x = 0; x < this.world.width; x++) terrain.push(this.world.terrainAt(x, y))
    }
    this.growthTerrain = terrain
    return terrain
  }

  private supplyUsed(playerId: number): number {
    let used = 0
    for (const unit of this.units) {
      if (unit.ownerId !== playerId || unit.health <= 0) continue
      used += unit.type.supply
    }
    for (const job of this.training.get(playerId) ?? []) used += UNIT_TYPES[job.typeId].supply
    return used
  }

  private population(playerId: number): number {
    let people = 0
    for (const city of this.cities) {
      if (city.ownerId !== playerId) continue
      people += this.peopleOf(city)
    }
    return people
  }

  private peopleOf(city: CityRuntime): number {
    return populationOf(this.live(city), city.ruins)
  }

  private besieged(city: CityRuntime): boolean {
    const layout = this.live(city)
    const reach = SIEGE_RANGE * SIEGE_RANGE
    for (const unit of this.units) {
      if (unit.health <= 0 || unit.ownerId === 0 || unit.ownerId === city.ownerId) continue
      for (const tile of layout.tiles) {
        const dx = unit.pos.x - (tile.x + 0.5)
        const dz = unit.pos.z - (tile.y + 0.5)
        if (dx * dx + dz * dz <= reach) return true
      }
    }
    return false
  }

  private advanceIncome(dt: number) {
    this.incomeClock += dt
    while (this.incomeClock >= INCOME_SECONDS) {
      this.incomeClock -= INCOME_SECONDS
      for (const player of this.players.values()) {
        for (const city of this.cities) {
          if (city.ownerId !== player.id || this.besieged(city)) continue
          const people = this.peopleOf(city)
          if (people <= 0) continue
          player.credits += CREDIT_PER_POPULATION * people * moneyFactor(city.focus)
          const origin = citySightOrigin(this.live(city))
          this.yields.push({ x: origin.x, y: origin.z })
        }
        this.capCredits(player)
      }
    }
  }

  private capCredits(player: Player) {
    const cap = creditCap(this.population(player.id))
    if (player.credits > cap) player.credits = cap
  }

  private capAllCredits() {
    for (const player of this.players.values()) this.capCredits(player)
  }

  private advanceGrowth(dt: number) {
    const step = instantBuilds() ? dt * 10 : dt
    const terrain = this.terrainTable()
    let changed = false
    for (const city of this.cities) {
      if (city.ownerId === 0) continue
      city.growCredit += step * growthFactor(city.focus)
      while (city.growCredit >= CITY_GROW_SECONDS) {
        city.growCredit -= CITY_GROW_SECONDS
        const next = growCity(city.layout, terrain, this.world.width, this.world.height)
        if (!next) {
          city.growCredit = 0
          break
        }
        const added = next.buildings.find(
          (building) => !city.layout.buildings.some((current) => current.x === building.x && current.y === building.y),
        )
        if (added && this.pathfinder.occupant(added.x, added.y) !== null) continue
        city.layout = next
        city.grown += 1
        this.clearCityTrees(next)
        changed = true
      }
    }
    if (changed) this.syncBlocks()
  }

  private blast(blasts: readonly Blast[]) {
    if (blasts.length === 0) return
    let blocks = false
    for (const blast of blasts) {
      if (blast.air) continue
      if (this.damageBuildings(blast)) blocks = true
      this.damageStreets(blast)
      this.fellTrees(blast)
      this.scarGround(blast)
    }
    if (blocks) this.syncBlocks()
  }

  private damageBuildings(blast: Blast): boolean {
    let fell = false
    for (const city of this.cities) {
      if (city.ownerId === 0) continue
      for (const building of city.layout.buildings) {
        if (building.keep || this.isRuin(city, building.x, building.y)) continue
        const dist = Math.hypot(building.x + 0.5 - blast.x, building.y + 0.5 - blast.z)
        const gap = Math.max(0, dist - BUILDING_RADIUS)
        const dealt = blast.splash > 0 ? blast.damage * Math.max(0, 1 - gap / blast.splash) : 0
        if (dealt <= 0) continue
        const id = `${building.x},${building.y}`
        const hp = (city.integrity.get(id) ?? BUILDING_HP) - dealt
        if (hp > 0) {
          city.integrity.set(id, hp)
          continue
        }
        city.integrity.delete(id)
        city.ruins.push({ x: building.x, y: building.y })
        this.stampScar(building.x, building.y)
        for (const street of lostStreets(city.layout, city.ruins)) city.ruins.push(street)
        if (!this.hasDistrict(city)) {
          city.ownerId = 0
          city.progress = 0
          city.challengerId = 0
        }
        fell = true
      }
    }
    return fell
  }

  private damageStreets(blast: Blast) {
    for (const city of this.cities) {
      if (city.ownerId === 0) continue
      const seen = new Set<string>()
      for (const street of city.layout.streets) {
        if (street.kind >= StreetKind.Lamp) continue
        const id = `${street.x},${street.y}`
        if (seen.has(id) || this.isRuin(city, street.x, street.y)) continue
        seen.add(id)
        const dist = Math.hypot(street.x + 0.5 - blast.x, street.y + 0.5 - blast.z)
        const dealt = blast.splash > 0 ? blast.damage * Math.max(0, 1 - dist / blast.splash) : 0
        if (dealt <= 0) continue
        const hp = (city.integrity.get(id) ?? STREET_HP) - dealt
        if (hp > 0) {
          city.integrity.set(id, hp)
          continue
        }
        city.integrity.delete(id)
        city.ruins.push({ x: street.x, y: street.y })
        for (const extra of lostStreets(city.layout, city.ruins)) city.ruins.push(extra)
      }
    }
  }

  private fellTrees(blast: Blast) {
    if (blast.splash <= 0) return
    const reach = Math.ceil(blast.splash)
    const cx = Math.floor(blast.x)
    const cy = Math.floor(blast.z)
    for (let y = cy - reach; y <= cy + reach; y++) {
      for (let x = cx - reach; x <= cx + reach; x++) {
        if (!this.world.inBounds(x, y) || this.world.terrainAt(x, y) !== Terrain.Tree) continue
        if (Math.hypot(x + 0.5 - blast.x, y + 0.5 - blast.z) > blast.splash) continue
        this.world.setTerrain(x, y, Terrain.Land)
        this.fallen.push({ x, y })
      }
    }
  }

  private scarFootprint(unit: Unit) {
    const span = spanOf(unit.type)
    for (let dy = 0; dy < span.y; dy++) {
      for (let dx = 0; dx < span.x; dx++) this.stampScar(unit.tile.x + dx, unit.tile.y + dy)
    }
  }

  private stampScar(x: number, y: number) {
    if (!this.world.inBounds(x, y) || !openGround(this.world.terrainAt(x, y))) return
    this.markScar(x, y, SCAR_MAX)
  }

  private markScar(x: number, y: number, strength: number) {
    const tile = scarTerrain(strength)
    const index = y * this.world.width + x
    this.scarUntil.set(index, this.time + SCAR_FADE)
    if (tile === this.world.terrainAt(x, y)) return
    this.world.setTerrain(x, y, tile)
    this.scars.push({ x, y })
    if (this.growthTerrain) this.growthTerrain[index] = tile
  }

  private fadeScars() {
    if (this.scarUntil.size === 0) return
    const due: number[] = []
    for (const [index, at] of this.scarUntil) if (at <= this.time) due.push(index)
    const width = this.world.width
    for (const index of due) {
      const x = index % width
      const y = (index - x) / width
      const strength = scarStrength(this.world.terrainAt(x, y))
      if (strength <= 1) {
        this.world.setTerrain(x, y, Terrain.Land)
        this.scarUntil.delete(index)
        if (this.growthTerrain) this.growthTerrain[index] = Terrain.Land
      } else {
        const tile = scarTerrain(strength - 1)
        this.world.setTerrain(x, y, tile)
        this.scarUntil.set(index, this.time + SCAR_FADE)
        if (this.growthTerrain) this.growthTerrain[index] = tile
      }
      this.scars.push({ x, y })
    }
  }

  private armScars() {
    if (!(this.scarUntil instanceof Map)) this.scarUntil = new Map()
    const { width, height } = this.world
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (scarStrength(this.world.terrainAt(x, y)) === 0) continue
        const index = y * width + x
        if (!this.scarUntil.has(index)) this.scarUntil.set(index, this.time + SCAR_FADE)
      }
    }
  }

  private scarGround(blast: Blast) {
    if (blast.splash <= 0) return
    const reach = Math.ceil(blast.splash)
    const cx = Math.floor(blast.x)
    const cy = Math.floor(blast.z)
    for (let y = cy - reach; y <= cy + reach; y++) {
      for (let x = cx - reach; x <= cx + reach; x++) {
        if (!this.world.inBounds(x, y)) continue
        const dist = Math.hypot(x + 0.5 - blast.x, y + 0.5 - blast.z)
        if (dist > blast.splash) continue
        const dealt = blast.damage * Math.max(0, 1 - dist / blast.splash)
        const gain = scarGain(dealt)
        if (gain <= 0 || Math.random() >= SCAR_CHANCE) continue
        const terrain = this.world.terrainAt(x, y)
        if (!openGround(terrain)) continue
        const next = Math.min(SCAR_MAX, scarStrength(terrain) + gain)
        this.markScar(x, y, next)
      }
    }
  }

  private live(city: CityRuntime): CityLayout {
    const cached = settledCities.get(city)
    if (cached && cached.layout === city.layout && cached.ruins === city.ruins.length) return cached.settled
    const settled = settledCity(city.layout, city.ruins)
    settledCities.set(city, { layout: city.layout, ruins: city.ruins.length, settled })
    return settled
  }

  private buildingTargets() {
    const targets: { x: number; z: number; ownerId: number }[] = []
    for (const city of this.cities) {
      for (const building of city.layout.buildings) {
        if (city.ownerId === 0 || building.keep || this.isRuin(city, building.x, building.y)) continue
        targets.push({ x: building.x + 0.5, z: building.y + 0.5, ownerId: city.ownerId })
      }
    }
    return targets
  }

  private hasDistrict(city: CityRuntime): boolean {
    for (const building of city.layout.buildings) {
      if (building.keep || this.isRuin(city, building.x, building.y)) continue
      return true
    }
    return false
  }

  private isRuin(city: CityRuntime, x: number, y: number): boolean {
    for (const ruin of city.ruins) if (ruin.x === x && ruin.y === y) return true
    return false
  }

  private clearCityTrees(layout: CityLayout) {
    const table = this.growthTerrain
    for (const tile of layout.tiles) {
      if (!this.world.inBounds(tile.x, tile.y) || this.world.terrainAt(tile.x, tile.y) !== Terrain.Tree) continue
      this.world.setTerrain(tile.x, tile.y, Terrain.Land)
      this.fallen.push({ x: tile.x, y: tile.y })
      if (table) table[tile.y * this.world.width + tile.x] = Terrain.Land
    }
  }

  private syncBlocks() {
    this.pathfinder.clearBlocked()
    for (const city of this.cities) {
      for (const building of this.live(city).buildings) {
        eachBuildingTile(building, (x, y) => this.pathfinder.setBlocked(x, y, true))
      }
    }
  }

  private advanceCaptures(dt: number) {
    const units = this.units
    this.captureSeek.clear(this.world.width, this.world.height)
    for (let i = 0; i < units.length; i++) {
      const unit = units[i]
      if (unit.health <= 0 || unit.progress < 1 || unit.type.supply <= 0) continue
      this.captureSeek.insert(i, unit.pos.x, unit.pos.z)
    }
    const found = this.captureHits
    for (const city of this.cities) {
      const layout = this.live(city)
      const weight = new Map<number, number>()
      const span = citySpan(layout)
      if (span) {
        found.length = 0
        this.captureSeek.seek(span.minX, span.minZ, span.maxX, span.maxZ, found)
        for (let n = 0; n < found.length; n++) {
          const unit = units[found[n]]
          if (!cityHolds(layout, unit.pos.x, unit.pos.z)) continue
          weight.set(unit.ownerId, (weight.get(unit.ownerId) ?? 0) + unit.type.supply)
        }
      }
      const people = populationOf(layout, city.ruins)
      const challengerPresent = city.challengerId > 0 && (weight.get(city.challengerId) ?? 0) > 0
      if (challengerPresent) {
        if (weight.size > 1) continue
        this.pressCapture(city, city.challengerId, weight.get(city.challengerId) ?? 1, people, dt)
        continue
      }
      if (city.progress > 0) {
        let pressure = 0
        for (const supply of weight.values()) pressure += supply
        city.progress = Math.max(0, city.progress - dt / captureFade(pressure, people))
        if (city.progress > 0) continue
        city.challengerId = 0
      }
      if (weight.size !== 1) continue
      const holder = weight.keys().next().value
      if (holder === undefined || holder === city.ownerId) continue
      this.pressCapture(city, holder, weight.get(holder) ?? 1, people, dt)
    }
  }

  private pressCapture(city: CityRuntime, holder: number, supply: number, population: number, dt: number) {
    if (city.challengerId !== holder) {
      city.challengerId = holder
      city.progress = 0
    }
    const duration = captureDuration(population)
    city.progress += (dt * supply) / duration
    if (city.progress < 1) return
    city.ownerId = holder
    city.progress = 0
    city.challengerId = 0
  }

  private advanceBuilds(dt: number) {
    for (const [playerId, queue] of this.jobs) {
      const owner = this.players.get(playerId)
      if (!owner) continue
      let left = dt
      while (queue.length > 0 && left > 0) {
        const unit = this.units.find((candidate) => candidate.id === queue[0])
        if (!unit || unit.health <= 0) {
          queue.shift()
          continue
        }
        const before = unit.progress
        const duration = instantBuilds() ? 0 : unit.type.buildTime
        unit.progress = this.fund(owner, unit.bill, before, duration, left)
        const gained = unit.progress - before
        if (gained <= 0) break
        left -= gained * duration
        if (unit.progress < 1) break
        queue.shift()
        if (unit.typeId === UnitTypeId.Airport) this.adoptOrphanJets(unit)
      }
      if (queue.length === 0) this.jobs.delete(playerId)
    }
  }

  private advanceTraining(dt: number) {
    for (const [playerId, queue] of this.training) {
      const owner = this.players.get(playerId)
      if (!owner) continue
      const leftFor = new Map<number, number>()
      for (const job of queue) if (!leftFor.has(job.yardId)) leftFor.set(job.yardId, dt)
      const drop = new Set<number>()
      for (let i = 0; i < queue.length; i++) {
        const job = queue[i]
        let left = leftFor.get(job.yardId) ?? 0
        if (left <= 0 && job.progress < 1) continue
        const yard = this.units.find(
          (unit) => unit.id === job.yardId && unit.ownerId === playerId && unit.health > 0 && unit.progress >= 1,
        )
        if (!yard) {
          drop.add(i)
          continue
        }
        if (job.progress < 1) {
          const type = UNIT_TYPES[job.typeId]
          const duration = instantBuilds() ? 0 : type.buildTime / (1 + FACTORY_BUILD_BONUS)
          const before = job.progress
          job.progress = this.fund(owner, type.cost, before, duration, left)
          const gained = job.progress - before
          if (gained <= 0) {
            leftFor.set(job.yardId, 0)
            continue
          }
          left -= gained * duration
          leftFor.set(job.yardId, left)
          if (job.progress < 1) continue
        }
        if (!this.releaseTrainee(playerId, job, yard)) {
          leftFor.set(job.yardId, 0)
          continue
        }
        drop.add(i)
      }
      if (drop.size === 0) continue
      const next = queue.filter((_, index) => !drop.has(index))
      if (next.length === 0) this.training.delete(playerId)
      else this.training.set(playerId, next)
    }
  }

  private fund(owner: Player, cost: number, progress: number, duration: number, dt: number): number {
    if (progress >= 1 || cost <= 0 || dt <= 0) return progress >= 1 ? 1 : progress
    const unpaid = cost * (1 - progress)
    const slice = Math.min(owner.credits, unpaid, duration <= 0 ? unpaid : (cost * dt) / duration)
    if (slice <= 0) return progress
    owner.credits -= slice
    if (unpaid - slice <= 1e-4) return 1
    return progress + slice / cost
  }

  private releaseTrainee(playerId: number, job: TrainJob, yard: Unit): boolean {
    const owner = this.players.get(playerId)
    if (!owner) return false
    const typeId = job.typeId
    const type = UNIT_TYPES[typeId]
    const domain = domainOf(type)
    if (domain === MoveDomain.Air) {
      if (typeId === UnitTypeId.Jet) return this.releaseJet(owner, yard)
      const unit = this.placeMobile(owner, typeId, yard.tile, 0)
      unit.home = { x: yard.tile.x, y: yard.tile.y }
      unit.flight = Flight.Ground
      unit.altitude = 0
      return true
    }
    const exit = this.exitTile(yard, domain === MoveDomain.Water ? MoveDomain.Water : MoveDomain.Ground)
    if (!exit) return false
    const unit = this.spawn(owner, typeId, exit.tile, exit.facing)
    if (domain === MoveDomain.Ground) {
      const rally = this.rallies.get(playerId) ?? exit.rally
      const goal = this.openNear(rally)
      if (goal && (goal.x !== unit.tile.x || goal.y !== unit.tile.y)) unit.orderMove(goal, this.pathfinder)
    }
    return true
  }

  private openNear(target: TileCoord): TileCoord | null {
    let best: TileCoord | null = null
    let bestScore = Infinity
    for (let dy = -SPAWN_REACH; dy <= SPAWN_REACH; dy++) {
      for (let dx = -SPAWN_REACH; dx <= SPAWN_REACH; dx++) {
        const tile = { x: target.x + dx, y: target.y + dy }
        if (!this.pathfinder.isWalkable(tile.x, tile.y, -1)) continue
        const score = dx * dx + dy * dy
        if (score >= bestScore) continue
        best = tile
        bestScore = score
      }
    }
    return best
  }

  private releaseJet(owner: Player, airport: Unit): boolean {
    const bay = openBay(this.takenBays(airport))
    if (bay < 0) return false
    const tile = bayTile(airport.tile, bay)
    const unit = this.placeMobile(owner, UnitTypeId.Jet, tile, bayFacing(bay))
    unit.home = { x: airport.tile.x, y: airport.tile.y }
    unit.bay = bay
    unit.flight = Flight.Ground
    unit.altitude = 0
    return true
  }

  private adoptOrphanJets(airport: Unit) {
    for (const unit of this.units) {
      if (unit.ownerId !== airport.ownerId || unit.typeId !== UnitTypeId.Jet || unit.health <= 0) continue
      if (this.jetHasAirport(unit)) continue
      const bay = openBay(this.takenBays(airport))
      if (bay < 0) return
      unit.home = { x: airport.tile.x, y: airport.tile.y }
      unit.bay = bay
      const grounded =
        unit.flight === Flight.Ground ||
        unit.flight === Flight.Taxi ||
        unit.flight === Flight.Landing ||
        unit.altitude < 0.25
      if (grounded || unit.returning) unit.orderMove(airport.tile, this.pathfinder, this.units)
    }
  }

  private jetHasAirport(jet: Unit): boolean {
    if (!jet.home || jet.bay < 0) return false
    for (const unit of this.units) {
      if (!this.finishedAirport(unit, jet.ownerId)) continue
      if (unit.tile.x === jet.home.x && unit.tile.y === jet.home.y) return true
    }
    return false
  }

  private baysAt(airport: Unit): number {
    const parked: { x: number; y: number; bay: number }[] = []
    for (const unit of this.units) {
      if (unit.typeId !== UnitTypeId.Jet || unit.health <= 0 || unit.bay < 0 || !unit.home) continue
      if (unit.home.x !== airport.tile.x || unit.home.y !== airport.tile.y) continue
      parked.push({ x: unit.home.x, y: unit.home.y, bay: unit.bay })
    }
    return baysFree([{ x: airport.tile.x, y: airport.tile.y }], parked)
  }

  private queuedJets(playerId: number, yardId: number): number {
    let count = 0
    for (const job of this.training.get(playerId) ?? []) if (job.yardId === yardId && job.typeId === UnitTypeId.Jet) count += 1
    return count
  }

  private finishedAirport(unit: Unit, playerId: number): boolean {
    return unit.ownerId === playerId && unit.typeId === UnitTypeId.Airport && unit.health > 0 && unit.progress >= 1
  }

  private takenBays(airport: Unit): Set<number> {
    const taken = new Set<number>()
    for (const unit of this.units) {
      if (unit.typeId !== UnitTypeId.Jet || unit.health <= 0 || unit.bay < 0) continue
      if (unit.home?.x !== airport.tile.x || unit.home?.y !== airport.tile.y) continue
      taken.add(unit.bay)
    }
    return taken
  }

  private ownsFactory(playerId: number): boolean {
    return this.units.some((unit) => unit.ownerId === playerId && unit.typeId === UnitTypeId.Factory && unit.health > 0)
  }

  private placeMobile(owner: Player, typeId: UnitTypeId, tile: TileCoord, facing: number): Unit {
    const unit = createUnit(this.nextUnitId++, owner.id, UNIT_TYPES[typeId], tile, facing)
    unit.pos = tileCenter(tile)
    this.units.push(unit)
    owner.addUnit(unit.id)
    return unit
  }

  private openSpawn(target: TileCoord, spanX: number, domain = MoveDomain.Ground, spanY = spanX): TileCoord | null {
    for (const step of spawnSteps()) {
      const tile = { x: target.x + step.x, y: target.y + step.y }
      if (this.footprintFree(tile, spanX, domain, spanY)) return tile
    }
    return null
  }

  private footprintFree(origin: TileCoord, spanX: number, domain = MoveDomain.Ground, spanY = spanX): boolean {
    for (let dy = 0; dy < spanY; dy++) {
      for (let dx = 0; dx < spanX; dx++) {
        if (!this.pathfinder.isWalkable(origin.x + dx, origin.y + dy, -1, domain)) return false
      }
    }
    return spanX > 0 && spanY > 0
  }

  private fillFootprint(unit: Unit) {
    const span = spanOf(unit.type)
    for (let dy = 0; dy < span.y; dy++) {
      for (let dx = 0; dx < span.x; dx++) {
        this.pathfinder.setOccupant(unit.tile.x + dx, unit.tile.y + dy, unit.id, unit.type.topSpeed > 0)
      }
    }
  }

  private exitTile(factory: Unit, domain = MoveDomain.Ground): { tile: TileCoord; facing: number; rally: TileCoord } | null {
    const span = spanOf(factory.type)
    const origin = factory.tile
    for (let ring = 1; ring <= SPAWN_REACH; ring++) {
      const y0 = origin.y - ring
      const y1 = origin.y + span.y - 1 + ring
      const x0 = origin.x - ring
      const x1 = origin.x + span.x - 1 + ring
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const onRing = x === x0 || x === x1 || y === y0 || y === y1
          if (!onRing || !this.pathfinder.isWalkable(x, y, -1, domain)) continue
          const dx = Math.sign(x + 0.5 - factory.pos.x)
          const dy = Math.sign(y + 0.5 - factory.pos.z)
          const rally = {
            x: Math.min(this.world.width - 1, Math.max(0, x + dx * 3)),
            y: Math.min(this.world.height - 1, Math.max(0, y + dy * 3)),
          }
          return { tile: { x, y }, facing: Math.atan2(dx, dy), rally }
        }
      }
    }
    return null
  }

  private clearTraining(yardId: number) {
    for (const [playerId, queue] of this.training) {
      const next = queue.filter((job) => job.yardId !== yardId)
      if (next.length === queue.length) continue
      if (next.length === 0) this.training.delete(playerId)
      else this.training.set(playerId, next)
    }
  }

  private clearJob(unitId: number) {
    for (const [playerId, queue] of this.jobs) {
      const next = queue.filter((id) => id !== unitId)
      if (next.length === queue.length) continue
      if (next.length === 0) this.jobs.delete(playerId)
      else this.jobs.set(playerId, next)
    }
  }
}

function openGround(terrain: Terrain): boolean {
  return terrain === Terrain.Land || terrain === Terrain.Flowers || terrain === Terrain.Forest || scarStrength(terrain) > 0
}

function citySpan(city: CityLayout): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const tile of city.tiles) {
    if (tile.x < minX) minX = tile.x
    if (tile.y < minZ) minZ = tile.y
    if (tile.x + 1 > maxX) maxX = tile.x + 1
    if (tile.y + 1 > maxZ) maxZ = tile.y + 1
  }
  if (minX === Infinity) return null
  return { minX, minZ, maxX, maxZ }
}
