import { BAY_COUNT, Flight, joinPaths, onBay, onRunway, openBay, rollout, runwayEnd, runwayStart } from '../../shared/flight.ts'
import { footprintCovers } from '../../shared/footprint.ts'
import { driveMotion, flightLine, holdInRange, MotionResult, stepMotion, type MotionState } from '../../shared/motion.ts'
import { tileCenter, type TileCoord } from '../../shared/tiles.ts'
import { domainOf, Locomotion, MoveDomain, spanOf, UnitTypeId, WeaponKind, type UnitType } from '../../shared/unit-types.ts'
import type { PathFinder } from '../path/pathfinder.ts'
import { redirect } from '../sim/steering.ts'

export abstract class Unit {
  id: number
  ownerId: number
  typeId: UnitType['id']
  readonly type: UnitType
  pos: { x: number; z: number }
  tile: TileCoord
  facing: number
  turretYaw: number
  speed = 0
  health: number
  rounds: number
  cooldown = 0
  sinceShot = 0
  attackId: number | null = null
  attackPoint: { x: number; z: number } | null = null
  path: TileCoord[] = []
  route = 0
  home: TileCoord | null = null
  bay = -1
  returning = false
  flight = Flight.Ground
  altitude = 0
  orbit: TileCoord | null = null
  progress = 1
  bill: number

  constructor(id: number, ownerId: number, type: UnitType, tile: TileCoord, facing: number) {
    this.id = id
    this.ownerId = ownerId
    this.type = type
    this.typeId = type.id
    this.pos = tileCenter(tile)
    this.tile = { x: tile.x, y: tile.y }
    this.facing = facing
    this.turretYaw = facing
    this.health = type.maxHealth
    this.rounds = type.weapon.magazine
    this.bill = type.cost
  }

  drive(dt: number): void {
    const state = motionOf(this)
    driveMotion(state, this.type, dt)
    this.facing = state.facing
    this.speed = state.speed
  }

  commitPath(path: readonly TileCoord[]): void {
    if (samePath(this.path, path)) return
    this.path = path.map((tile) => ({ x: tile.x, y: tile.y }))
    this.route++
  }

  orderMove(tile: TileCoord, paths: PathFinder, units: readonly Unit[] = []): boolean {
    if (this.type.topSpeed <= 0) return false
    if (domainOf(this.type) === MoveDomain.Air) return this.orderAir(tile, paths, units)
    return this.travel(paths.findPath(this.tile, tile, this.id, domainOf(this.type)))
  }

  travel(path: readonly TileCoord[] | null): boolean {
    this.returning = false
    this.orbit = null
    if (path === null || path.length === 0) return false
    this.commitPath(path)
    return true
  }

  private orderAir(tile: TileCoord, paths: PathFinder, units: readonly Unit[]): boolean {
    if (!paths.inBounds(tile.x, tile.y)) return false
    const pad = padAt(this, tile, units)
    if (pad && this.type.locomotion === Locomotion.Plane && !this.keepBay(pad, units)) return false
    const grounded = this.flight === Flight.Ground || this.flight === Flight.Taxi || this.flight === Flight.Landing || this.altitude < 0.25
    if (pad && this.parkedAt(pad)) {
      this.returning = false
      this.flight = Flight.Ground
      this.commitPath([])
      return true
    }
    const path = pad ? this.landPath(pad.tile) : this.departPath(tile, grounded)
    if (path.length === 0) return false
    this.returning = pad !== null
    this.orbit = pad === null && this.type.locomotion === Locomotion.Plane ? { x: tile.x, y: tile.y } : null
    if (pad) this.home = { x: pad.tile.x, y: pad.tile.y }
    const onStrip = this.home !== null && onRunway(this.tile.x, this.tile.y, this.home.x, this.home.y)
    const slot = this.type.locomotion === Locomotion.Plane && this.bay >= 0 && !onStrip
    this.flight = grounded && slot ? Flight.Taxi : grounded ? Flight.Takeoff : Flight.Cruise
    this.commitPath(path)
    return true
  }

  private keepBay(pad: Unit, units: readonly Unit[]): boolean {
    const origin = pad.tile
    const stays = this.home?.x === origin.x && this.home?.y === origin.y && this.bay >= 0 && this.bay < BAY_COUNT
    if (stays) return true
    const bay = openBay(takenBays(origin, units, this.id))
    if (bay < 0) return false
    this.home = { x: origin.x, y: origin.y }
    this.bay = bay
    return true
  }

  private parkedAt(pad: Unit): boolean {
    if (this.type.locomotion !== Locomotion.Plane || this.flight !== Flight.Ground || this.bay < 0) return false
    if (this.home?.x !== pad.tile.x || this.home?.y !== pad.tile.y) return false
    return onBay(this.tile.x, this.tile.y, pad.tile.x, pad.tile.y, this.bay)
  }

  private departPath(tile: TileCoord, grounded: boolean): TileCoord[] {
    if (this.type.locomotion === Locomotion.Plane && this.home && grounded && this.bay >= 0) {
      return joinPaths(rollout(this.tile, this.home), flightLine(runwayEnd(this.home), tile))
    }
    if (this.type.locomotion === Locomotion.Plane && this.home && grounded) {
      return joinPaths(flightLine(this.tile, runwayEnd(this.home)), flightLine(runwayEnd(this.home), tile))
    }
    return flightLine(this.tile, tile)
  }

  private landPath(pad: TileCoord): TileCoord[] {
    if (this.type.locomotion !== Locomotion.Plane) return flightLine(this.tile, pad)
    const start = runwayStart(pad)
    const approach = { x: start.x, y: Math.max(0, pad.y - 6) }
    return joinPaths(flightLine(this.tile, approach), flightLine(approach, runwayEnd(pad)))
  }

  step(dt: number, paths: PathFinder, units: readonly Unit[]) {
    if (this.type.topSpeed <= 0) return
    const rearming = this.recallForRockets(paths, units)
    const engaging = rearming ? false : this.pursue(dt, paths, units)
    const domain = domainOf(this.type)
    const air = domain === MoveDomain.Air
    if (!air && this.path.length > 0) {
      const next = this.path[0]
      if (!paths.isWalkable(next.x, next.y, this.id, domain)) redirect(this, paths, units)
    }

    const state = motionOf(this, !engaging)
    const stalled = this.speed === 0
    const occupied = air ? undefined : (x: number, y: number) => !paths.isWalkable(x, y, this.id, domain)
    const result = stepMotion(state, this.type, dt, occupied)
    if (result === MotionResult.Denied) {
      this.speed = 0
      this.facing = state.facing
      if (!stalled) this.route++
      redirect(this, paths, units)
      return
    }
    const entered = { x: state.tileX, y: state.tileY }
    const changing = entered.x !== this.tile.x || entered.y !== this.tile.y
    if (air) {
      this.tile = entered
    } else if (changing && !paths.claim(this, entered, this.type.footprint, domain)) {
      this.speed = 0
      this.facing = state.facing
      if (!stalled) this.route++
      redirect(this, paths, units)
      return
    }
    this.pos.x = state.x
    this.pos.z = state.z
    this.facing = state.facing
    this.speed = state.speed
    this.returning = state.returning ?? false
    this.flight = state.flight ?? Flight.Ground
    this.altitude = state.altitude ?? 0
    this.orbit = state.orbitX !== undefined && state.orbitY !== undefined ? { x: state.orbitX, y: state.orbitY } : null
    this.path = state.path
    this.rearmRockets()
  }

  private recallForRockets(paths: PathFinder, units: readonly Unit[]): boolean {
    const weapon = this.type.weapon
    if (weapon.kind !== WeaponKind.Rocket || this.rounds > 0) return false
    if (this.flight === Flight.Ground && this.onHomePad()) return true
    if (!this.home || this.returning || this.flight === Flight.Landing || this.flight === Flight.Taxi) return true
    const end = runwayEnd(this.home)
    const goal = this.path[this.path.length - 1]
    if (!goal || goal.x !== end.x || goal.y !== end.y) {
      this.attackId = null
      this.attackPoint = null
      this.orderMove(this.home, paths, units)
    }
    return true
  }

  private rearmRockets(): void {
    const weapon = this.type.weapon
    if (weapon.kind !== WeaponKind.Rocket || this.rounds >= weapon.magazine) return
    if (this.flight !== Flight.Ground || !this.onHomePad()) return
    this.rounds = weapon.magazine
  }

  private onHomePad(): boolean {
    if (!this.home || this.bay < 0) return false
    return onBay(this.tile.x, this.tile.y, this.home.x, this.home.y, this.bay)
  }

  private pursue(dt: number, paths: PathFinder, units: readonly Unit[]): boolean {
    if (this.attackPoint) return this.pursuePoint(dt, paths)
    if (this.attackId === null) return false
    const target = units.find((unit) => unit.id === this.attackId)
    if (!target || target.health <= 0) {
      this.attackId = null
      return false
    }
    if (this.holds(target.pos, dt)) return true
    const range = this.type.weapon.range
    const goal = this.path[this.path.length - 1]
    const goalCenter = goal ? tileCenter(goal) : null
    const goalHolds =
      goalCenter !== null && Math.hypot(goalCenter.x - target.pos.x, goalCenter.z - target.pos.z) <= range
    if (goalHolds) return false
    const tile = approachTile(this, target, paths)
    if (!tile) return false
    if (goal && goal.x === tile.x && goal.y === tile.y) return false
    this.orderMove(tile, paths)
    return false
  }

  private pursuePoint(dt: number, paths: PathFinder): boolean {
    const point = this.attackPoint
    if (!point) return false
    if (this.holds(point, dt)) return true
    const range = this.type.weapon.range
    const goal = this.path[this.path.length - 1]
    const goalCenter = goal ? tileCenter(goal) : null
    const goalHolds = goalCenter !== null && Math.hypot(goalCenter.x - point.x, goalCenter.z - point.z) <= range
    if (goalHolds) return false
    const tile = approachPoint(this, point, paths)
    if (!tile) return false
    if (goal && goal.x === tile.x && goal.y === tile.y) return false
    this.orderMove(tile, paths)
    return false
  }

  private holds(aim: { x: number; z: number }, dt: number): boolean {
    const state = motionOf(this)
    if (!holdInRange(state, this.type, aim, dt)) return false
    this.commitPath(state.path)
    this.facing = state.facing
    return true
  }
}

function motionOf(unit: Unit, loiter = true): MotionState {
  return {
    x: unit.pos.x,
    z: unit.pos.z,
    facing: unit.facing,
    speed: unit.speed,
    tileX: unit.tile.x,
    tileY: unit.tile.y,
    path: unit.path,
    homeX: unit.home?.x,
    homeY: unit.home?.y,
    bay: unit.bay >= 0 ? unit.bay : undefined,
    returning: unit.returning,
    flight: unit.flight,
    altitude: unit.altitude,
    orbitX: unit.orbit?.x,
    orbitY: unit.orbit?.y,
    loiter,
  }
}

function takenBays(origin: TileCoord, units: readonly Unit[], exceptId: number): Set<number> {
  const taken = new Set<number>()
  for (const other of units) {
    if (other.id === exceptId || other.health <= 0 || other.typeId !== UnitTypeId.Jet) continue
    if (other.home?.x !== origin.x || other.home?.y !== origin.y) continue
    if (other.bay >= 0 && other.bay < BAY_COUNT) taken.add(other.bay)
  }
  return taken
}

function padAt(unit: Unit, tile: TileCoord, units: readonly Unit[]): Unit | null {
  const want = unit.type.locomotion === Locomotion.Plane ? UnitTypeId.Airport : UnitTypeId.Helipad
  for (const other of units) {
    if (other.ownerId !== unit.ownerId || other.typeId !== want || other.health <= 0) continue
    const span = spanOf(other.type)
    if (footprintCovers(other.tile.x, other.tile.y, span.x, span.y, tile)) return other
  }
  return null
}

function samePath(left: readonly TileCoord[], right: readonly TileCoord[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i].x !== right[i].x || left[i].y !== right[i].y) return false
  }
  return true
}

function approachPoint(unit: Unit, point: { x: number; z: number }, paths: PathFinder): TileCoord | null {
  const range = unit.type.weapon.range
  const reach = Math.ceil(range) + 1
  const tx = Math.floor(point.x)
  const ty = Math.floor(point.z)
  let best: TileCoord | null = null
  let bestScore = Infinity
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const tile = { x: tx + dx, y: ty + dy }
      if (!paths.isWalkable(tile.x, tile.y, unit.id, domainOf(unit.type))) continue
      const center = tileCenter(tile)
      const toTarget = Math.hypot(center.x - point.x, center.z - point.z)
      if (toTarget > range) continue
      const toSelf = Math.hypot(center.x - unit.pos.x, center.z - unit.pos.z)
      if (toSelf >= bestScore) continue
      best = tile
      bestScore = toSelf
    }
  }
  return best
}

function approachTile(unit: Unit, target: Unit, paths: PathFinder): TileCoord | null {
  const range = unit.type.weapon.range
  const reach = Math.ceil(range) + 1
  let best: TileCoord | null = null
  let bestScore = Infinity
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const tile = { x: target.tile.x + dx, y: target.tile.y + dy }
      if (!paths.isWalkable(tile.x, tile.y, unit.id, domainOf(unit.type))) continue
      const center = tileCenter(tile)
      const toTarget = Math.hypot(center.x - target.pos.x, center.z - target.pos.z)
      const toSelf = Math.hypot(center.x - unit.pos.x, center.z - unit.pos.z)
      const score = toTarget <= range ? toSelf : toSelf + 1000 + toTarget
      if (score >= bestScore) continue
      best = tile
      bestScore = score
    }
  }
  return best
}
