import { populationOf, type CityLayout } from '../shared/cities.ts'
import { baysFree } from '../shared/flight.ts'
import type { CityState, TrainJob, UnitSnapshot } from '../shared/protocol.ts'
import { AIRPORT, ARTILLERY, CRUISER, FACTORY, GUNSHIP, HEAVY_TANK, HELIPAD, JET, MED_TANK, SCOUT, SHIPYARD, TURRET, UNIT_TYPES, UnitTypeId, yardOf, type UnitType } from '../shared/unit-types.ts'

export const enum PingState {
  None = 0,
  Good = 1,
  Slow = 2,
  Bad = 3,
}

export const enum Trend {
  Steady = 0,
  Up = 1,
  Down = 2,
}

export const enum TileKind {
  Structure = 0,
  City = 1,
  Train = 2,
}

export const enum BuildTab {
  Base = 0,
  Land = 1,
  Air = 2,
  Sea = 3,
}

export const enum TileBlock {
  NeedsFactory = 0,
  NeedsPopulation = 1,
  SelectFactory = 2,
  SelectAirport = 3,
  SelectHelipad = 4,
  SelectShipyard = 5,
  NotFinished = 6,
  ApronFull = 7,
}

export const enum HealthBand {
  Healthy = 0,
  Damaged = 1,
  Critical = 2,
}

export type HudInput = {
  playerId: number | null
  units: readonly UnitSnapshot[]
  queue: readonly TrainJob[]
  cities: readonly (CityState | null)[]
  layouts: readonly (CityLayout | null)[]
  selected: readonly number[]
  group: number | null
  yard: UnitSnapshot | null
  placing: UnitTypeId | null
  raising: boolean
  hall: number | null
  quote: number | null
  rtt: number | null
  spectating: boolean
}

export type Ping = { state: PingState.None } | { state: PingState.Good | PingState.Slow | PingState.Bad; ms: number }

/** A train tile's yard is the id of the selected yard when that yard trains its type. */
type TileHead =
  | { kind: TileKind.City }
  | { kind: TileKind.Structure; type: UnitTypeId }
  | { kind: TileKind.Train; type: UnitTypeId; yard: number | null }

type TileState = {
  tab: BuildTab
  slot: number
  cost: string
  count: number
  progress: number
  block: TileBlock | null
  armed: boolean
  badge: boolean
}

export type HudTile = TileHead & TileState

export type QueueChip = { kind: TileKind.Structure | TileKind.Train; type: UnitTypeId; count: number; progress: number }

export type Selection = { ids: readonly number[]; hall: number | null }

export type SelectedRow = { type: UnitTypeId; count: number; health: number; band: HealthBand; progress: number | null }

export type HudModel = {
  army: number
  population: number
  cities: number
  over: boolean
  ping: Ping
  tiles: HudTile[]
  tab: BuildTab | null
  queue: QueueChip[]
  selection: Selection
  rows: SelectedRow[]
  group: number | null
  hall: { focus: number; label: string } | null
}

type Tally = Map<UnitTypeId, { count: number; progress: number }>

const STRUCTURES = [FACTORY, TURRET, AIRPORT, HELIPAD, SHIPYARD]
const TRAINABLE = [SCOUT, MED_TANK, HEAVY_TANK, ARTILLERY, JET, GUNSHIP, CRUISER]
const NEEDS_FACTORY = new Set<UnitTypeId>([UnitTypeId.Airport, UnitTypeId.Helipad, UnitTypeId.Shipyard])
const FOCUS_LABEL = ['Money ×4', 'Money ×2', 'Balanced', 'Growth ×2', 'Growth ×4']
const IDLE = { count: 0, progress: 0 }
const COUNT_SECONDS = 0.15
const TREND_GAP = 30
const SLOW_PING_MS = 150
const BAD_PING_MS = 300
const HEALTHY = 0.5
const DAMAGED = 0.25

export function hudModel(input: HudInput): HudModel {
  const { yard, hall } = input
  const own = input.units.filter((unit) => unit.ownerId === input.playerId && unit.health > 0)
  let army = 0
  for (const unit of own) army += UNIT_TYPES[unit.typeId].supply
  let training = 0
  for (const job of input.queue) training += UNIT_TYPES[job.typeId].supply
  const held = heldCities(input)
  const room = (supply: number) => army + training + supply <= held.population
  const factory = own.some((unit) => unit.typeId === UnitTypeId.Factory && unit.progress >= 1)
  const tiles: HudTile[] = []
  const taken: number[] = []
  const add = (head: TileHead, tab: BuildTab, state: Omit<TileState, 'tab' | 'slot' | 'badge'>) => {
    taken[tab] = (taken[tab] ?? 0) + 1
    tiles.push({ ...head, ...state, tab, slot: taken[tab], badge: state.count > 1 || (state.count === 1 && state.progress <= 0) })
  }

  const sites = structureSites(own)
  for (const type of STRUCTURES) {
    const { count, progress } = sites.get(type.id) ?? IDLE
    add({ kind: TileKind.Structure, type: type.id }, BuildTab.Base, {
      cost: costLine(type.cost, type.supply),
      count,
      progress,
      block: NEEDS_FACTORY.has(type.id) && !factory ? TileBlock.NeedsFactory : room(type.supply) ? null : TileBlock.NeedsPopulation,
      armed: input.placing === type.id,
    })
  }
  add({ kind: TileKind.City }, BuildTab.Base, {
    cost: costLine(input.quote, 1),
    count: 0,
    progress: 0,
    block: null,
    armed: input.raising,
  })

  const yardJobs = tallyJobs(yard === null ? [] : input.queue.filter((job) => job.yardId === yard.id))
  const trainBlock = (type: UnitType, at: UnitSnapshot | null): TileBlock | null => {
    if (at === null) return selectYard(yardOf(type.id))
    if (at.progress < 1) return TileBlock.NotFinished
    if (!room(type.supply)) return TileBlock.NeedsPopulation
    if (type.id === UnitTypeId.Jet && jetApron(own, input.queue, at) <= 0) return TileBlock.ApronFull
    return null
  }
  for (const type of TRAINABLE) {
    const { count, progress } = yardJobs.get(type.id) ?? IDLE
    const at = yard !== null && yard.typeId === yardOf(type.id) ? yard : null
    add({ kind: TileKind.Train, type: type.id, yard: at === null ? null : at.id }, tabOf(yardOf(type.id)), {
      cost: costLine(type.cost, type.supply),
      count,
      progress,
      block: trainBlock(type, at),
      armed: false,
    })
  }

  const queue: QueueChip[] = []
  for (const type of STRUCTURES) {
    const site = sites.get(type.id)
    if (site) queue.push({ kind: TileKind.Structure, type: type.id, ...site })
  }
  const jobs = tallyJobs(input.queue)
  for (const type of TRAINABLE) {
    const tally = jobs.get(type.id)
    if (tally) queue.push({ kind: TileKind.Train, type: type.id, ...tally })
  }

  const focus = hall === null ? null : (input.cities[hall]?.focus ?? 0)
  return {
    army,
    population: held.population,
    cities: held.cities,
    over: army > held.population,
    ping: pingOf(input.rtt),
    tiles,
    tab: input.spectating ? null : tabOf(yard === null ? null : yard.typeId),
    queue,
    selection: { ids: input.selected, hall },
    rows: input.spectating ? [] : selectedRows(own, input.selected),
    group: input.group,
    hall: focus === null ? null : { focus, label: focusLabel(focus) },
  }
}

export function focusLabel(step: number): string {
  return FOCUS_LABEL[step + 2] ?? 'Balanced'
}

export function functionSlot(code: string): number | null {
  const match = /^F(\d+)$/.exec(code)
  if (!match) return null
  const slot = Number(match[1])
  return slot >= 1 ? slot : null
}

export class CreditCounter {
  shown = 0
  trend = Trend.Steady

  snap(credits: number) {
    this.shown = credits
    this.trend = Trend.Steady
  }

  ease(target: number, dt: number) {
    const blend = dt <= 0 ? 1 : 1 - Math.exp(-dt / COUNT_SECONDS)
    this.shown += (target - this.shown) * blend
    if (Math.abs(target - this.shown) < 0.5) this.shown = target
    const gap = target - this.shown
    this.trend = gap > TREND_GAP ? Trend.Up : gap < -TREND_GAP ? Trend.Down : Trend.Steady
  }
}

function tabOf(yard: UnitTypeId | null): BuildTab {
  if (yard === UnitTypeId.Factory) return BuildTab.Land
  if (yard === UnitTypeId.Airport || yard === UnitTypeId.Helipad) return BuildTab.Air
  if (yard === UnitTypeId.Shipyard) return BuildTab.Sea
  return BuildTab.Base
}

function selectYard(yard: UnitTypeId): TileBlock {
  if (yard === UnitTypeId.Airport) return TileBlock.SelectAirport
  if (yard === UnitTypeId.Helipad) return TileBlock.SelectHelipad
  if (yard === UnitTypeId.Shipyard) return TileBlock.SelectShipyard
  return TileBlock.SelectFactory
}

function pingOf(rtt: number | null): Ping {
  if (rtt === null) return { state: PingState.None }
  const ms = Math.round(rtt)
  if (rtt > BAD_PING_MS) return { state: PingState.Bad, ms }
  if (rtt > SLOW_PING_MS) return { state: PingState.Slow, ms }
  return { state: PingState.Good, ms }
}

function heldCities(input: HudInput): { cities: number; population: number } {
  let cities = 0
  let population = 0
  for (let i = 0; i < input.layouts.length; i++) {
    const state = input.cities[i]
    const layout = input.layouts[i]
    if (!state || !layout || state.ownerId !== input.playerId) continue
    cities += 1
    population += populationOf(layout, state.ruins)
  }
  return { cities, population }
}

function selectedRows(own: readonly UnitSnapshot[], selected: readonly number[]): SelectedRow[] {
  const ids = new Set(selected)
  const rows = new Map<UnitTypeId, { count: number; health: number; max: number; progress: number | null }>()
  for (const unit of own) {
    if (!ids.has(unit.id)) continue
    const row = rows.get(unit.typeId) ?? { count: 0, health: 0, max: 0, progress: null }
    row.count += 1
    row.health += unit.health
    row.max += UNIT_TYPES[unit.typeId].maxHealth
    if (unit.progress < 1) row.progress = Math.min(row.progress ?? 1, unit.progress)
    rows.set(unit.typeId, row)
  }
  return [...rows]
    .map(([type, row]) => {
      const health = row.health / row.max
      const band = health >= HEALTHY ? HealthBand.Healthy : health >= DAMAGED ? HealthBand.Damaged : HealthBand.Critical
      return { type, count: row.count, health, band, progress: row.progress }
    })
    .sort((a, b) => b.count - a.count || a.type - b.type)
}

function structureSites(own: readonly UnitSnapshot[]): Tally {
  const sites: Tally = new Map()
  for (const unit of own) {
    if (unit.progress >= 1 || UNIT_TYPES[unit.typeId].topSpeed > 0) continue
    const site = sites.get(unit.typeId) ?? { count: 0, progress: 0 }
    site.count += 1
    if (unit.progress > site.progress) site.progress = unit.progress
    sites.set(unit.typeId, site)
  }
  return sites
}

function tallyJobs(jobs: readonly TrainJob[]): Tally {
  const tally: Tally = new Map()
  const heads = new Set<number>()
  for (const job of jobs) {
    const entry = tally.get(job.typeId) ?? { count: 0, progress: 0 }
    entry.count += 1
    tally.set(job.typeId, entry)
    if (heads.has(job.yardId)) continue
    heads.add(job.yardId)
    if (job.progress > entry.progress) entry.progress = job.progress
  }
  return tally
}

function jetApron(own: readonly UnitSnapshot[], queue: readonly TrainJob[], airport: UnitSnapshot): number {
  const parked: { x: number; y: number; bay: number }[] = []
  for (const unit of own) {
    if (unit.typeId !== UnitTypeId.Jet || !unit.home || unit.bay === undefined || unit.bay < 0) continue
    if (unit.home.x !== airport.tileX || unit.home.y !== airport.tileY) continue
    parked.push({ x: unit.home.x, y: unit.home.y, bay: unit.bay })
  }
  let queued = 0
  for (const job of queue) if (job.typeId === UnitTypeId.Jet && job.yardId === airport.id) queued += 1
  return baysFree([{ x: airport.tileX, y: airport.tileY }], parked) - queued
}

function costLine(credits: number | null, supply: number): string {
  const price = credits === null ? '' : credits.toLocaleString('en-US')
  if (supply <= 0) return price
  return price ? `${price} · ${supply}` : String(supply)
}
