import { UNIT_TYPES, type UnitTypeId } from '../../shared/unit-types.ts'

/** Quiet time after a radar blip before another one can be raised. */
export const RADAR_QUIET_MS = 10_000

/** What a radar contact found hit: a building or city, or a unit. */
export const enum ContactKind {
  Base,
  Unit,
}

type RadarContact = { x: number; z: number; kind: ContactKind }

type Spot = { x: number; z: number; progress: number; typeId: UnitTypeId }

export type RadarWatch = {
  health: Map<number, number>
  place: Map<number, Spot>
  ruins: number[]
  quietUntil: number
  playerId: number | null
}

type WatchedUnit = {
  id: number
  typeId: UnitTypeId
  ownerId: number
  health: number
  x: number
  z: number
  progress: number
}

type WatchedCity = { ownerId: number; ruins: readonly { x: number; y: number }[] } | null

export function createRadarWatch(): RadarWatch {
  return { health: new Map(), place: new Map(), ruins: [], quietUntil: 0, playerId: null }
}

/** The next place to mark when this commander is hit, or null while the radar is quiet or nothing new landed. */
export function radarContact(
  watch: RadarWatch,
  now: number,
  playerId: number | null,
  units: readonly WatchedUnit[],
  cities: readonly WatchedCity[],
): RadarContact | null {
  if (watch.playerId !== playerId) {
    watch.playerId = playerId
    watch.health.clear()
    watch.place.clear()
    watch.ruins.length = 0
    watch.quietUntil = 0
  }
  const hit = playerId === null ? null : struck(watch, playerId, units, cities)
  remember(watch, playerId, units, cities)
  if (!hit || now < watch.quietUntil) return null
  watch.quietUntil = now + RADAR_QUIET_MS
  return hit
}

function struck(
  watch: RadarWatch,
  playerId: number,
  units: readonly WatchedUnit[],
  cities: readonly WatchedCity[],
): RadarContact | null {
  for (const unit of units) {
    if (unit.ownerId !== playerId || unit.health <= 0) continue
    const prev = watch.health.get(unit.id)
    if (prev !== undefined && unit.health < prev) return { x: unit.x, z: unit.z, kind: kindOf(unit.typeId) }
  }
  const present = new Set<number>()
  for (const unit of units) {
    if (unit.ownerId === playerId && unit.health > 0) present.add(unit.id)
  }
  for (const [id, spot] of watch.place) {
    if (present.has(id) || spot.progress < 1) continue
    return { x: spot.x, z: spot.z, kind: kindOf(spot.typeId) }
  }
  for (let i = 0; i < cities.length; i++) {
    const city = cities[i]
    if (!city || city.ownerId !== playerId) continue
    const prev = watch.ruins[i]
    if (prev === undefined || city.ruins.length <= prev) continue
    const tile = city.ruins[city.ruins.length - 1]
    if (!tile) continue
    return { x: tile.x + 0.5, z: tile.y + 0.5, kind: ContactKind.Base }
  }
  return null
}

function remember(
  watch: RadarWatch,
  playerId: number | null,
  units: readonly WatchedUnit[],
  cities: readonly WatchedCity[],
) {
  const seen = new Set<number>()
  if (playerId !== null) {
    for (const unit of units) {
      if (unit.ownerId !== playerId || unit.health <= 0) continue
      seen.add(unit.id)
      watch.health.set(unit.id, unit.health)
      watch.place.set(unit.id, { x: unit.x, z: unit.z, progress: unit.progress, typeId: unit.typeId })
    }
  }
  for (const id of watch.place.keys()) {
    if (seen.has(id)) continue
    watch.place.delete(id)
    watch.health.delete(id)
  }
  for (let i = 0; i < cities.length; i++) watch.ruins[i] = cities[i]?.ruins.length ?? 0
  watch.ruins.length = cities.length
}

function kindOf(typeId: UnitTypeId): ContactKind {
  return UNIT_TYPES[typeId].topSpeed > 0 ? ContactKind.Unit : ContactKind.Base
}
