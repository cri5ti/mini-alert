import { flightTime } from '../../shared/ballistics.ts'
import { CITY_SIGHT } from '../../shared/cities.ts'
import { airborne, planeInFlight } from '../../shared/flight.ts'
import { turnToward } from '../../shared/motion.ts'
import { hostile } from '../../shared/players.ts'
import type { ShotEvent, ShotHit } from '../../shared/protocol.ts'
import { Locomotion, WeaponKind } from '../../shared/unit-types.ts'
import { seesPoint, type CitySight, type SightSource } from '../../shared/vision.ts'
import { wrapAngle } from '../sim/drive.ts'
import type { Unit } from '../units/unit.ts'
import { __TRACE__, traceBegin, traceEnd } from '../trace.ts'
import { TraceSlot } from '../../shared/trace.ts'
import { Quad } from '../../shared/quad.ts'

export type Impact = {
  time: number
  x: number
  z: number
  ownerId: number
  damage: number
  splash: number
  kind: WeaponKind
  /** The shot was aimed at an aircraft, so its splash stays in the air. */
  air: boolean
  /** Aimed at a unit of the shooter, so the blast can hurt that team. */
  allies: boolean
}

export type Blast = {
  x: number
  z: number
  damage: number
  splash: number
  air: boolean
}

export type StructureTarget = {
  x: number
  z: number
  ownerId: number
}

export function engage(
  units: readonly Unit[],
  dt: number,
  time: number,
  impacts: Impact[],
  cities: readonly CitySight[] = [],
  blasts: Blast[] = [],
  structures: readonly StructureTarget[] = [],
  width = 0,
  height = 0,
): ShotEvent[] {
  __TRACE__ && traceBegin(TraceSlot.CombatTeam)
  const vision = teamVision(units, cities)
  __TRACE__ && traceEnd()
  __TRACE__ && traceBegin(TraceSlot.CombatTargets)
  const byId = new Map<number, Unit>()
  unitQuad.clear(width, height)
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]
    byId.set(unit.id, unit)
    if (unit.health <= 0) continue
    unitQuad.insert(i, unit.pos.x, unit.pos.z)
  }
  __TRACE__ && traceEnd()
  __TRACE__ && traceBegin(TraceSlot.CombatStructures)
  structureQuad.clear(width, height)
  for (let i = 0; i < structures.length; i++) {
    const building = structures[i]
    structureQuad.insert(i, building.x, building.z)
  }
  __TRACE__ && traceEnd()
  const shots: ShotEvent[] = []
  __TRACE__ && traceBegin(TraceSlot.CombatFire)
  for (const unit of units) {
    if (unit.health <= 0 || unit.progress < 1 || unit.type.weapon.damage <= 0) continue
    const weapon = unit.type.weapon
    unit.sinceShot += dt
    unit.cooldown = Math.max(0, unit.cooldown - dt)
    if (weapon.kind !== WeaponKind.Rocket && unit.sinceShot >= weapon.reload && unit.rounds < weapon.magazine) {
      unit.rounds = weapon.magazine
    }

    const ordered = unit.attackPoint
    const friends = vision.get(unit.ownerId) ?? []
    __TRACE__ && traceBegin(TraceSlot.CombatTargets)
    const target = ordered ? null : pickTarget(unit, units, friends, byId)
    __TRACE__ && traceEnd()
    __TRACE__ && traceBegin(TraceSlot.CombatStructures)
    const structure = ordered || target ? null : pickStructure(unit, structures, friends)
    __TRACE__ && traceEnd()
    const aim = weapon.turretRate > 0 ? unit.turretYaw : unit.facing
    if (!ordered && !target && !structure) continue
    const predicted = target && explosive(weapon.kind) ? lead(unit, target) : null
    const aimX = ordered?.x ?? predicted?.x ?? target?.pos.x ?? structure?.x ?? unit.pos.x
    const aimZ = ordered?.z ?? predicted?.z ?? target?.pos.z ?? structure?.z ?? unit.pos.z
    const desired = Math.atan2(aimX - unit.pos.x, aimZ - unit.pos.z)
    if (weapon.turretRate > 0) unit.turretYaw = turnToward(unit.turretYaw, desired, weapon.turretRate, dt)
    const gun = weapon.turretRate > 0 ? unit.turretYaw : aim
    const dist = target ? distance(unit, target) : Math.hypot(aimX - unit.pos.x, aimZ - unit.pos.z)
    const aligned = Math.abs(wrapAngle(desired - gun)) <= weapon.aimTolerance
    if (unit.type.locomotion === Locomotion.Plane && !planeInFlight(unit.flight, unit.altitude)) continue
    if (dist > weapon.range || !aligned || unit.rounds <= 0 || unit.cooldown > 0) continue

    unit.rounds -= 1
    unit.cooldown = weapon.fireInterval
    unit.sinceShot = 0
    const landed = scatterPoint(aimX, aimZ, shotScatter(dist, unit.speed, unit.type.topSpeed))
    const accel = weapon.accel ?? 0
    const flight = predicted?.flight ?? (explosive(weapon.kind) && weapon.shellSpeed > 0 ? flightTime(dist, weapon.shellSpeed, accel) : 0)
    const air = target !== null && flying(target)
    const allies = target !== null && target.ownerId === unit.ownerId
    if (flight === 0) {
      strike(units, landed.x, landed.z, unit.ownerId, weapon.damage, weapon.splash, air, allies)
      if (explosive(weapon.kind)) blasts.push({ x: landed.x, z: landed.z, damage: weapon.damage, splash: weapon.splash, air })
    } else {
      impacts.push({
        time: time + flight,
        x: landed.x,
        z: landed.z,
        ownerId: unit.ownerId,
        damage: weapon.damage,
        splash: weapon.splash,
        kind: weapon.kind,
        air,
        allies,
      })
    }
    shots.push({
      kind: weapon.kind,
      shooterId: unit.id,
      x: unit.pos.x,
      z: unit.pos.z,
      aimX: landed.x,
      aimZ: landed.z,
      flight,
    })
  }
  __TRACE__ && traceEnd()
  return shots
}

export function applyImpacts(units: readonly Unit[], impacts: Impact[], time: number, blasts: Blast[] = []): ShotHit[] {
  const hits: ShotHit[] = []
  for (let i = impacts.length - 1; i >= 0; i--) {
    const impact = impacts[i]
    if (impact.time > time) continue
    impacts.splice(i, 1)
    strike(units, impact.x, impact.z, impact.ownerId, impact.damage, impact.splash, impact.air, impact.allies)
    if (explosive(impact.kind)) blasts.push({ x: impact.x, z: impact.z, damage: impact.damage, splash: impact.splash, air: impact.air })
    hits.push({ kind: impact.kind, aimX: impact.x, aimZ: impact.z })
  }
  return hits
}

const RANGE_SCATTER = 0.035
const MOVE_SCATTER = 0.14

export function shotScatter(distance: number, speed: number, topSpeed: number): number {
  if (distance <= 0) return 0
  const moving = topSpeed > 0 ? Math.min(1, Math.abs(speed) / topSpeed) : 0
  return distance * (RANGE_SCATTER + MOVE_SCATTER * moving)
}

function scatterPoint(x: number, z: number, radius: number): { x: number; z: number } {
  if (radius <= 0) return { x, z }
  const angle = Math.random() * Math.PI * 2
  const reach = Math.sqrt(Math.random()) * radius
  return { x: x + Math.sin(angle) * reach, z: z + Math.cos(angle) * reach }
}

function lead(shooter: Unit, target: Unit): { x: number; z: number; flight: number } {
  const vx = Math.sin(target.facing) * target.speed
  const vz = Math.cos(target.facing) * target.speed
  const rx = target.pos.x - shooter.pos.x
  const rz = target.pos.z - shooter.pos.z
  const speed = shooter.type.weapon.shellSpeed
  const accel = shooter.type.weapon.accel ?? 0
  if (accel <= 0) {
    const flight = interceptTime(rx, rz, vx, vz, speed)
    return { x: target.pos.x + vx * flight, z: target.pos.z + vz * flight, flight }
  }
  let flight = flightTime(Math.hypot(rx, rz), speed, accel)
  for (let i = 0; i < 3; i++) {
    const aimX = target.pos.x + vx * flight
    const aimZ = target.pos.z + vz * flight
    flight = flightTime(Math.hypot(aimX - shooter.pos.x, aimZ - shooter.pos.z), speed, accel)
  }
  return { x: target.pos.x + vx * flight, z: target.pos.z + vz * flight, flight }
}

function explosive(kind: WeaponKind): boolean {
  return kind === WeaponKind.Shell || kind === WeaponKind.Rocket
}

function interceptTime(rx: number, rz: number, vx: number, vz: number, speed: number): number {
  const fallback = Math.hypot(rx, rz) / speed
  const a = vx * vx + vz * vz - speed * speed
  const b = 2 * (rx * vx + rz * vz)
  const c = rx * rx + rz * rz
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-6) return fallback
    const linear = -c / b
    return linear > 0 ? linear : fallback
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return fallback
  const root = Math.sqrt(disc)
  const first = (-b - root) / (2 * a)
  const second = (-b + root) / (2 * a)
  const soonest = [first, second].filter((time) => time > 0).sort((left, right) => left - right)[0]
  return soonest ?? fallback
}

function strike(units: readonly Unit[], x: number, z: number, ownerId: number, damage: number, splash: number, air: boolean, allies: boolean) {
  for (const unit of units) {
    if (unit.health <= 0 || (!allies && unit.ownerId === ownerId)) continue
    if (air && !flying(unit)) continue
    const dist = Math.hypot(unit.pos.x - x, unit.pos.z - z)
    const dealt = splash > 0 ? damage * Math.max(0, 1 - dist / splash) : dist <= bodyReach(unit) ? damage : 0
    if (dealt <= 0) continue
    unit.health = Math.max(0, unit.health - dealt)
  }
}

function flying(unit: Unit): boolean {
  return airborne(unit.type.locomotion, unit.flight, unit.altitude)
}

function bodyReach(unit: Unit): number {
  const hull = Math.max(unit.type.hull.x, unit.type.hull.z) / 2
  if (unit.type.footprint <= 1) return hull
  return Math.max(hull, (unit.type.footprint * Math.SQRT2) / 2)
}

const ATTACK_COMMIT = 1.5
const unitQuad = new Quad()
const structureQuad = new Quad()
const quadHits: number[] = []

function teamVision(units: readonly Unit[], cities: readonly CitySight[]): Map<number, SightSource[]> {
  const vision = new Map<number, SightSource[]>()
  for (const unit of units) {
    if (unit.health <= 0 || unit.progress < 1) continue
    const sight = unit.type.weapon.sight
    if (sight <= 0) continue
    const friends = vision.get(unit.ownerId) ?? []
    friends.push({ x: unit.pos.x, z: unit.pos.z, sight })
    vision.set(unit.ownerId, friends)
  }
  for (const city of cities) {
    if (city.ownerId <= 0) continue
    const friends = vision.get(city.ownerId) ?? []
    friends.push({ x: city.x, z: city.z, sight: CITY_SIGHT })
    vision.set(city.ownerId, friends)
  }
  return vision
}

function pickTarget(unit: Unit, units: readonly Unit[], friends: readonly SightSource[], byId: Map<number, Unit>): Unit | null {
  const weapon = unit.type.weapon
  const reach = Math.max(weapon.sight, weapon.range)
  const ordered = orderedTarget(unit, byId)
  const orderedVisible = ordered !== null && seesPoint(friends, ordered.pos.x, ordered.pos.z)
  if (ordered && orderedVisible && distance(unit, ordered) <= weapon.range * ATTACK_COMMIT) return ordered
  const gun = weapon.turretRate > 0 ? unit.turretYaw : unit.facing
  let closest: Unit | null = null
  let closestDist = Infinity
  let closestIndex = -1
  let locked: Unit | null = null
  let lockedDist = Infinity
  let lockedIndex = -1
  quadHits.length = 0
  unitQuad.seek(unit.pos.x - reach, unit.pos.z - reach, unit.pos.x + reach, unit.pos.z + reach, quadHits)
  for (let n = 0; n < quadHits.length; n++) {
    const index = quadHits[n]
    const other = units[index]
    if (other.id === unit.id || !hostile(unit.ownerId, other.ownerId) || other.health <= 0) continue
    const dist = distance(unit, other)
    if (dist > reach || !seesPoint(friends, other.pos.x, other.pos.z)) continue
    if (dist < closestDist || (dist === closestDist && index < closestIndex)) {
      closest = other
      closestDist = dist
      closestIndex = index
    }
    if (weapon.turretRate <= 0) continue
    const err = Math.abs(wrapAngle(bearing(unit, other) - gun))
    if (err <= weapon.lockAngle && (dist < lockedDist || (dist === lockedDist && index < lockedIndex))) {
      locked = other
      lockedDist = dist
      lockedIndex = index
    }
  }
  return locked ?? closest
}

function pickStructure(unit: Unit, structures: readonly StructureTarget[], friends: readonly SightSource[]): StructureTarget | null {
  const weapon = unit.type.weapon
  if (!explosive(weapon.kind) || weapon.splash <= 0) return null
  const reach = Math.max(weapon.sight, weapon.range)
  const gun = weapon.turretRate > 0 ? unit.turretYaw : unit.facing
  let closest: StructureTarget | null = null
  let closestDist = Infinity
  let closestIndex = -1
  let locked: StructureTarget | null = null
  let lockedDist = Infinity
  let lockedIndex = -1
  quadHits.length = 0
  structureQuad.seek(unit.pos.x - reach, unit.pos.z - reach, unit.pos.x + reach, unit.pos.z + reach, quadHits)
  for (let n = 0; n < quadHits.length; n++) {
    const index = quadHits[n]
    const building = structures[index]
    if (!hostile(unit.ownerId, building.ownerId)) continue
    const dist = Math.hypot(building.x - unit.pos.x, building.z - unit.pos.z)
    if (dist > reach || !seesPoint(friends, building.x, building.z)) continue
    if (dist < closestDist || (dist === closestDist && index < closestIndex)) {
      closest = building
      closestDist = dist
      closestIndex = index
    }
    if (weapon.turretRate <= 0) continue
    const err = Math.abs(wrapAngle(Math.atan2(building.x - unit.pos.x, building.z - unit.pos.z) - gun))
    if (err <= weapon.lockAngle && (dist < lockedDist || (dist === lockedDist && index < lockedIndex))) {
      locked = building
      lockedDist = dist
      lockedIndex = index
    }
  }
  return locked ?? closest
}

function orderedTarget(unit: Unit, byId: Map<number, Unit>): Unit | null {
  if (unit.attackId === null) return null
  const target = byId.get(unit.attackId)
  if (!target || target.health <= 0) return null
  return target
}

function bearing(from: Unit, to: Unit): number {
  return Math.atan2(to.pos.x - from.pos.x, to.pos.z - from.pos.z)
}

function distance(from: Unit, to: Unit): number {
  return Math.hypot(to.pos.x - from.pos.x, to.pos.z - from.pos.z)
}
