import { CITY_CATALOG, type CityLayout } from '../shared/cities.ts'
import { MapSize, type Faction } from '../shared/lobby.ts'
import { playerColor } from '../shared/players.ts'
import type { CityState, TrainJob, UnitSnapshot, WorldSnapshot } from '../shared/protocol.ts'
import { TRACE_LABEL, TraceSlot } from '../shared/trace.ts'
import { UNIT_TYPES, UnitTypeId } from '../shared/unit-types.ts'
import { Trend, type HudInput } from './hud-model.ts'
import type { CreditReadout } from './hud-ui.ts'
import { islandTerrain } from './lobby-fixtures.ts'
import type { TracePaint } from './trace-pie.ts'

export type HudFixture = {
  input: HudInput
  credits: CreditReadout
  factions: Faction[]
}

const ME = 1
const BO = 2
const CY = 3
const COTTAGE = CITY_CATALOG.findIndex((entry) => entry.density === 1)
const NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eve', 'Finn', 'Gus', 'Hal']
const FACTORY_ID = 1
const AIRPORT_ID = 3

function unit(id: number, typeId: UnitTypeId, x: number, y: number, fields: Partial<UnitSnapshot> = {}): UnitSnapshot {
  const ownerId = fields.ownerId ?? ME
  return {
    id,
    typeId,
    ownerId,
    color: playerColor(ownerId),
    x: x + 0.5,
    z: y + 0.5,
    facing: 0,
    turretYaw: 0,
    speed: 0,
    health: UNIT_TYPES[typeId].maxHealth,
    tileX: x,
    tileY: y,
    path: [],
    goal: null,
    attackId: null,
    attackPoint: null,
    progress: 1,
    ...fields,
  }
}

function job(typeId: UnitTypeId, yardId: number, progress = 0): TrainJob {
  return { typeId, yardId, progress }
}

type Town = { state: CityState; layout: CityLayout }

function town(ownerId: number, population: number, focus = 0): Town {
  const buildings = Array.from({ length: population }, (_, x) => ({ x, y: 0, model: COTTAGE, yaw: 0, keep: false }))
  return {
    state: { ownerId, color: playerColor(ownerId), progress: 1, challengerId: 0, challengerColor: 0, grown: 0, focus, ruins: [], sites: [] },
    layout: { x: 0, y: 0, span: population, seed: 0, tiles: [], buildings, streets: [] },
  }
}

function factions(count: number): Faction[] {
  return NAMES.slice(0, count).map((name, index) => ({
    playerId: index + 1,
    name,
    color: playerColor(index + 1),
    ai: index === 2,
    defeated: index === 3,
  }))
}

function input(units: UnitSnapshot[], towns: Town[], fields: Partial<HudInput> = {}): HudInput {
  return {
    playerId: ME,
    units,
    queue: [],
    cities: towns.map((entry) => entry.state),
    layouts: towns.map((entry) => entry.layout),
    selected: [],
    group: null,
    yard: null,
    placing: null,
    raising: false,
    hall: null,
    quote: null,
    rtt: 48,
    spectating: false,
    ...fields,
  }
}

function supply(entries: readonly { typeId: UnitTypeId }[]): number {
  return entries.reduce((sum, entry) => sum + UNIT_TYPES[entry.typeId].supply, 0)
}

function baseUnits(): UnitSnapshot[] {
  return [
    unit(FACTORY_ID, UnitTypeId.Factory, 36, 38),
    unit(2, UnitTypeId.Turret, 41, 36),
    unit(AIRPORT_ID, UnitTypeId.Airport, 31, 43),
    unit(4, UnitTypeId.MedTank, 42, 42),
    unit(5, UnitTypeId.MedTank, 43, 43),
    unit(6, UnitTypeId.Scout, 46, 45),
    unit(20, UnitTypeId.MedTank, 88, 38, { ownerId: BO }),
    unit(21, UnitTypeId.HeavyTank, 90, 41, { ownerId: BO }),
    unit(22, UnitTypeId.Scout, 41, 86, { ownerId: CY }),
  ]
}

function baseTowns(focus = 0): Town[] {
  return [town(ME, 24, focus), town(ME, 18), town(BO, 20)]
}

export function baseHud(): HudFixture {
  return { input: input(baseUnits(), baseTowns()), credits: { shown: 12_450, trend: Trend.Steady }, factions: factions(4) }
}

export function armedHud(): HudFixture {
  return { ...baseHud(), input: input(baseUnits(), baseTowns(), { placing: UnitTypeId.Turret }) }
}

export function factoryHud(): HudFixture {
  const units = baseUnits()
  const queue = [
    job(UnitTypeId.MedTank, FACTORY_ID, 0.4),
    job(UnitTypeId.MedTank, FACTORY_ID),
    job(UnitTypeId.Scout, FACTORY_ID),
    job(UnitTypeId.Jet, AIRPORT_ID, 0.6),
  ]
  return { ...baseHud(), input: input(units, baseTowns(), { queue, selected: [FACTORY_ID], yard: units[0] }) }
}

export function airportHud(): HudFixture {
  const units = baseUnits()
  const airport = units[2]
  for (let bay = 0; bay < 4; bay++) {
    units.push(unit(10 + bay, UnitTypeId.Jet, 31 + bay, 44, { home: { x: airport.tileX, y: airport.tileY }, bay }))
  }
  const queue = [job(UnitTypeId.Jet, AIRPORT_ID, 0.25)]
  return { ...baseHud(), input: input(units, baseTowns(), { queue, selected: [AIRPORT_ID], yard: airport }) }
}

export function hallHud(): HudFixture {
  return { ...baseHud(), input: input(baseUnits(), baseTowns(1), { hall: 0 }) }
}

function armyUnits(): UnitSnapshot[] {
  const health = (typeId: UnitTypeId, share: number) => ({ health: UNIT_TYPES[typeId].maxHealth * share })
  return [
    ...baseUnits(),
    unit(7, UnitTypeId.MedTank, 44, 41, health(UnitTypeId.MedTank, 0.4)),
    unit(8, UnitTypeId.MedTank, 45, 42, health(UnitTypeId.MedTank, 0.2)),
    unit(9, UnitTypeId.HeavyTank, 46, 40, health(UnitTypeId.HeavyTank, 0.4)),
    unit(10, UnitTypeId.HeavyTank, 47, 41, health(UnitTypeId.HeavyTank, 0.2)),
    unit(11, UnitTypeId.Artillery, 44, 44, health(UnitTypeId.Artillery, 0.15)),
    unit(12, UnitTypeId.Scout, 47, 46),
    unit(13, UnitTypeId.Scout, 48, 45),
    unit(14, UnitTypeId.Gunship, 49, 43),
    unit(15, UnitTypeId.Jet, 50, 41),
  ]
}

const ARMY_SELECTION = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

export function armyHud(): HudFixture {
  return {
    input: input(armyUnits(), baseTowns(), { rtt: 210, selected: ARMY_SELECTION, group: 1 }),
    credits: { shown: 4_870, trend: Trend.Up },
    factions: factions(4),
  }
}

export function spectateHud(): HudFixture {
  const units = [
    ...baseUnits(),
    unit(30, UnitTypeId.Factory, 40, 88, { ownerId: CY }),
    unit(31, UnitTypeId.MedTank, 44, 84, { ownerId: CY }),
    unit(32, UnitTypeId.Cruiser, 20, 90, { ownerId: CY }),
  ]
  return {
    input: input(units, [...baseTowns(), town(CY, 30)], { playerId: CY, spectating: true }),
    credits: { shown: 9_300, trend: Trend.Steady },
    factions: factions(8),
  }
}

export function strainedHud(): HudFixture {
  const yards = [
    unit(FACTORY_ID, UnitTypeId.Factory, 36, 38),
    unit(AIRPORT_ID, UnitTypeId.Airport, 31, 43),
    unit(16, UnitTypeId.Helipad, 39, 33),
    unit(17, UnitTypeId.Shipyard, 26, 38),
  ]
  const sites = [
    unit(40, UnitTypeId.Factory, 44, 34, { progress: 0.3 }),
    unit(41, UnitTypeId.Turret, 46, 37, { progress: 0.6 }),
    unit(42, UnitTypeId.Airport, 48, 30, { progress: 0.1 }),
    unit(43, UnitTypeId.Helipad, 36, 30, { progress: 0.8 }),
    unit(44, UnitTypeId.Shipyard, 25, 44, { progress: 0.45 }),
  ]
  const units = [...yards, ...sites, unit(4, UnitTypeId.MedTank, 42, 42), unit(6, UnitTypeId.Scout, 46, 45)]
  const queue = [
    job(UnitTypeId.Scout, FACTORY_ID, 0.5),
    job(UnitTypeId.MedTank, FACTORY_ID),
    job(UnitTypeId.HeavyTank, FACTORY_ID),
    job(UnitTypeId.Artillery, FACTORY_ID),
    job(UnitTypeId.Jet, AIRPORT_ID, 0.2),
    job(UnitTypeId.Gunship, 16, 0.7),
    job(UnitTypeId.Cruiser, 17, 0.1),
  ]
  return {
    input: input(units, [town(ME, supply(units) + supply(queue))], { queue, rtt: 420 }),
    credits: { shown: 85, trend: Trend.Down },
    factions: factions(4),
  }
}

export function traceHud(): HudFixture {
  return { ...armyHud(), factions: factions(8) }
}

export function traceFrame(): TracePaint {
  const samples = TRACE_LABEL.map((_, slot) => ({ slot, ms: slot === TraceSlot.Idle ? 15.8 : 0.1 + slot * 0.05 }))
  return { samples, budget: 33.333 }
}

export function radarWorld(): WorldSnapshot {
  const size = MapSize.Small
  const terrain = Array.from({ length: size * size }, (_, index) => islandTerrain(index % size, Math.floor(index / size), size))
  return {
    width: size,
    height: size,
    terrain,
    known: new Uint8Array(size * size).fill(1),
    shifts: new Uint8Array(size * size),
    coast: [],
    holes: [],
    roads: [],
    towns: [],
    seed: 0,
  }
}

export const RADAR_VIEW: readonly { x: number; z: number }[] = [
  { x: 28, z: 32 },
  { x: 58, z: 32 },
  { x: 64, z: 56 },
  { x: 22, z: 56 },
]
