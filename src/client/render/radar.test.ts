import { describe, expect, it } from 'vitest'
import { UnitTypeId } from '../../shared/unit-types.ts'
import { ContactKind, RADAR_QUIET_MS, createRadarWatch, radarContact } from './radar.ts'

function unit(health: number, progress = 1, typeId = UnitTypeId.MedTank) {
  return { id: 1, typeId, ownerId: 1, health, x: 3, z: 4, progress }
}

describe('radar contact', () => {
  it('marks the first hit on an owned unit and then stays quiet', () => {
    const watch = createRadarWatch()
    const owned = unit(100)
    expect(radarContact(watch, 0, 1, [owned], [])).toBeNull()
    owned.health = 80
    expect(radarContact(watch, 1_000, 1, [owned], [])).toEqual({ x: 3, z: 4, kind: ContactKind.Unit })
    owned.health = 60
    expect(radarContact(watch, 5_000, 1, [owned], [])).toBeNull()
    expect(radarContact(watch, 1_000 + RADAR_QUIET_MS, 1, [owned], [])).toBeNull()
    owned.health = 40
    expect(radarContact(watch, 1_000 + RADAR_QUIET_MS, 1, [owned], [])).toEqual({ x: 3, z: 4, kind: ContactKind.Unit })
  })

  it('marks a finished unit that disappears and ignores a cancelled build', () => {
    const watch = createRadarWatch()
    const finished = unit(100)
    expect(radarContact(watch, 0, 1, [finished], [])).toBeNull()
    expect(radarContact(watch, 1_000, 1, [], [])).toEqual({ x: 3, z: 4, kind: ContactKind.Unit })

    const site = createRadarWatch()
    const building = unit(100, 0.4)
    expect(radarContact(site, 0, 1, [building], [])).toBeNull()
    expect(radarContact(site, 1_000, 1, [], [])).toBeNull()
  })

  it('calls a hit or destroyed building a base contact', () => {
    const watch = createRadarWatch()
    const factory = unit(100, 1, UnitTypeId.Factory)
    expect(radarContact(watch, 0, 1, [factory], [])).toBeNull()
    factory.health = 80
    expect(radarContact(watch, 1_000, 1, [factory], [])).toEqual({ x: 3, z: 4, kind: ContactKind.Base })
    expect(radarContact(watch, 1_000 + RADAR_QUIET_MS, 1, [], [])).toEqual({ x: 3, z: 4, kind: ContactKind.Base })
  })

  it('ignores enemy losses and marks a new ruin in an owned city', () => {
    const watch = createRadarWatch()
    const foe = { ...unit(100), ownerId: 2 }
    expect(radarContact(watch, 0, 1, [foe], [])).toBeNull()
    foe.health = 10
    const city = { ownerId: 1, ruins: [] as { x: number; y: number }[] }
    expect(radarContact(watch, 1_000, 1, [foe], [city])).toBeNull()
    city.ruins.push({ x: 8, y: 9 })
    expect(radarContact(watch, 1_000, 1, [foe], [city])).toEqual({ x: 8.5, z: 9.5, kind: ContactKind.Base })
  })

  it('learns a seat from scratch when the commander changes', () => {
    const watch = createRadarWatch()
    const owned = unit(40)
    expect(radarContact(watch, 0, 1, [owned], [])).toBeNull()
    expect(radarContact(watch, 1_000, 2, [{ ...owned, ownerId: 2, health: 10 }], [])).toBeNull()
  })
})
