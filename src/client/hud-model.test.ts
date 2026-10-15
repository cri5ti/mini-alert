import { describe, expect, it } from 'vitest'
import { CITY_CATALOG, type CityLayout } from '../shared/cities.ts'
import type { CityState, TrainJob, UnitSnapshot } from '../shared/protocol.ts'
import type { TileCoord } from '../shared/tiles.ts'
import { UNIT_TYPES, UnitTypeId } from '../shared/unit-types.ts'
import { BuildTab, CreditCounter, focusLabel, functionSlot, HealthBand, hudModel, PingState, TileBlock, TileKind, Trend, type HudInput, type HudModel, type HudTile } from './hud-model.ts'

const ME = 1
const RIVAL = 2
const COTTAGE = CITY_CATALOG.findIndex((entry) => entry.density === 1)

function unit(id: number, typeId: UnitTypeId, fields: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    id,
    typeId,
    ownerId: ME,
    color: 0,
    x: id + 0.5,
    z: 0.5,
    facing: 0,
    turretYaw: 0,
    speed: 0,
    health: 100,
    tileX: id,
    tileY: 0,
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

type Town = { state: CityState; layout: CityLayout | null }

function town(ownerId: number, population: number, ruins: TileCoord[] = []): Town {
  const buildings = Array.from({ length: population }, (_, x) => ({ x, y: 0, model: COTTAGE, yaw: 0, keep: false }))
  return {
    state: { ownerId, color: 0, progress: 1, challengerId: 0, challengerColor: 0, grown: 0, focus: 0, ruins, sites: [] },
    layout: { x: 0, y: 0, span: population, seed: 0, tiles: [], buildings, streets: [] },
  }
}

function input(fields: Partial<HudInput> & { towns?: Town[] } = {}): HudInput {
  const { towns = [town(ME, 40)], ...rest } = fields
  return {
    playerId: ME,
    units: [],
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
    rtt: null,
    spectating: false,
    ...rest,
  }
}

function name(tile: HudTile): string {
  return tile.kind === TileKind.City ? 'Building' : UNIT_TYPES[tile.type].label
}

function shown(model: HudModel): string[] {
  return model.tiles.filter((tile) => tile.tab === model.tab).map(name)
}

function find(model: HudModel, label: string): HudTile {
  const found = model.tiles.find((tile) => name(tile) === label)
  if (!found) throw new Error(`no ${label}`)
  return found
}

function ready(model: HudModel): string[] {
  return model.tiles.filter((tile) => tile.tab === model.tab && tile.block === null).map(name)
}

describe('hud readouts', () => {
  it('sums the supply of the live units the player owns into the army', () => {
    const model = hudModel(input({
      units: [
        unit(1, UnitTypeId.MedTank),
        unit(2, UnitTypeId.Factory),
        unit(3, UnitTypeId.Scout, { health: 0 }),
        unit(4, UnitTypeId.HeavyTank, { ownerId: RIVAL }),
      ],
    }))
    expect(model.army).toBe(UNIT_TYPES[UnitTypeId.MedTank].supply + UNIT_TYPES[UnitTypeId.Factory].supply)
  })

  it('is over only when the army exceeds the population', () => {
    const tanks = [unit(1, UnitTypeId.MedTank), unit(2, UnitTypeId.MedTank)]
    expect(hudModel(input({ towns: [town(ME, 4)], units: tanks })).over).toBe(false)
    expect(hudModel(input({ towns: [town(ME, 3)], units: tanks })).over).toBe(true)
  })

  it('counts the population and cities of the settled cities the player holds, less ruins', () => {
    const model = hudModel(input({
      towns: [
        town(ME, 5, [{ x: 0, y: 0 }]),
        town(RIVAL, 9),
        { ...town(ME, 7), layout: null },
        town(ME, 3),
      ],
    }))
    expect(model.population).toBe(4 + 3)
    expect(model.cities).toBe(2)
  })

  it('rates the ping as none without a sample, slow above 150 ms and bad above 300 ms', () => {
    expect(hudModel(input({ rtt: null })).ping).toEqual({ state: PingState.None })
    expect(hudModel(input({ rtt: 150 })).ping).toEqual({ state: PingState.Good, ms: 150 })
    expect(hudModel(input({ rtt: 150.4 })).ping).toEqual({ state: PingState.Slow, ms: 150 })
    expect(hudModel(input({ rtt: 300 })).ping).toEqual({ state: PingState.Slow, ms: 300 })
    expect(hudModel(input({ rtt: 300.4 })).ping).toEqual({ state: PingState.Bad, ms: 300 })
  })
})

describe('credit counter', () => {
  it('eases toward the target with a 0.15 s time constant', () => {
    const counter = new CreditCounter()
    counter.ease(1000, 0.15)
    expect(counter.shown).toBeCloseTo(1000 * (1 - Math.exp(-1)), 6)
  })

  it('snaps to the target within 0.5', () => {
    const counter = new CreditCounter()
    counter.snap(999.4)
    counter.ease(1000, 0.001)
    expect(counter.shown).toBeLessThan(999.5)
    counter.snap(999.6)
    counter.ease(1000, 0.001)
    expect(counter.shown).toBe(1000)
  })

  it('trends up or down while the target is more than 30 away', () => {
    const counter = new CreditCounter()
    counter.ease(31, 1e-20)
    expect(counter.trend).toBe(Trend.Up)
    counter.ease(30, 1e-20)
    expect(counter.trend).toBe(Trend.Steady)
    counter.ease(-31, 1e-20)
    expect(counter.trend).toBe(Trend.Down)
    counter.ease(-30, 1e-20)
    expect(counter.trend).toBe(Trend.Steady)
  })
})

describe('hud tiles without a yard', () => {
  it('shows every Base tile, marking Airport, Helipad and Shipyard Needs a factory until a factory is finished', () => {
    const blocks = (units: UnitSnapshot[]) => {
      const model = hudModel(input({ units }))
      return model.tiles.filter((tile) => tile.tab === model.tab).map((tile) => [name(tile), tile.block])
    }
    expect(blocks([unit(1, UnitTypeId.Factory, { progress: 0.5 })])).toEqual([
      ['Factory', null],
      ['Turret', null],
      ['Airport', TileBlock.NeedsFactory],
      ['Helipad', TileBlock.NeedsFactory],
      ['Shipyard', TileBlock.NeedsFactory],
      ['Building', null],
    ])
    expect(blocks([unit(1, UnitTypeId.Factory)]).every(([, block]) => block === null)).toBe(true)
  })

  it('counts a placed yard site without a finished factory', () => {
    const model = hudModel(input({ units: [unit(1, UnitTypeId.Helipad, { progress: 0 })] }))
    expect(find(model, 'Helipad')).toMatchObject({ count: 1, progress: 0, block: TileBlock.NeedsFactory })
  })

  it('readies a structure only with population room for its supply, plus a finished factory where it needs one', () => {
    const units = [unit(1, UnitTypeId.Factory), unit(2, UnitTypeId.MedTank)]
    const queue = [job(UnitTypeId.Scout, 1)]
    const used = UNIT_TYPES[UnitTypeId.Factory].supply + UNIT_TYPES[UnitTypeId.MedTank].supply + UNIT_TYPES[UnitTypeId.Scout].supply
    const roomy = hudModel(input({ towns: [town(ME, used + UNIT_TYPES[UnitTypeId.Helipad].supply)], units, queue }))
    expect(ready(roomy)).toEqual(['Factory', 'Turret', 'Helipad', 'Building'])
    const tight = hudModel(input({ towns: [town(ME, used + UNIT_TYPES[UnitTypeId.Turret].supply)], units, queue }))
    expect(ready(tight)).toEqual(['Turret', 'Building'])
  })

  it('prices the city house with the quote and arms it while raising', () => {
    const idle = find(hudModel(input()), 'Building')
    expect(idle).toMatchObject({ cost: '1', block: null, armed: false })
    const raising = find(hudModel(input({ raising: true, quote: 1200 })), 'Building')
    expect(raising).toMatchObject({ cost: '1,200 · 1', block: null, armed: true })
  })

  it('arms the structure tile of the placing type', () => {
    const model = hudModel(input({ placing: UnitTypeId.Turret }))
    expect(model.tiles.filter((tile) => tile.armed).map(name)).toEqual(['Turret'])
  })
})

describe('hud tiles with a yard selected', () => {
  const factory = unit(1, UnitTypeId.Factory)
  const queue = [
    job(UnitTypeId.MedTank, 1, 0.4),
    job(UnitTypeId.MedTank, 1),
    job(UnitTypeId.Scout, 1, 0.3),
    job(UnitTypeId.HeavyTank, 7, 0.9),
    job(UnitTypeId.Scout, 7),
  ]

  it('opens the tab of its train tiles, counted from its own jobs', () => {
    const model = hudModel(input({ units: [factory], yard: factory, queue }))
    expect(shown(model)).toEqual(['Scout', 'Med Tank', 'Heavy Tank', 'Artillery'])
    expect(find(model, 'Med Tank')).toMatchObject({ count: 2, progress: 0.4 })
    expect(find(model, 'Scout')).toMatchObject({ count: 1, progress: 0 })
    expect(find(model, 'Heavy Tank')).toMatchObject({ count: 0, progress: 0 })
  })

  it('readies a train tile only when the yard is finished and army + queued + supply fits the population', () => {
    const jobs = [job(UnitTypeId.Scout, 1)]
    const used = UNIT_TYPES[UnitTypeId.Factory].supply + UNIT_TYPES[UnitTypeId.Scout].supply
    const room = used + UNIT_TYPES[UnitTypeId.Artillery].supply
    const finished = hudModel(input({ towns: [town(ME, room)], units: [factory], yard: factory, queue: jobs }))
    expect(ready(finished)).toEqual(['Scout', 'Med Tank', 'Artillery'])
    const site = unit(1, UnitTypeId.Factory, { progress: 0.5 })
    const building = hudModel(input({ units: [site], yard: site, queue: jobs }))
    expect(ready(building)).toEqual([])
  })

  it('readies a jet only with a free apron bay, less the jets queued at that airport', () => {
    const airport = unit(1, UnitTypeId.Airport)
    const parked = (count: number) =>
      Array.from({ length: count }, (_, bay) => unit(10 + bay, UnitTypeId.Jet, { home: { x: airport.tileX, y: airport.tileY }, bay }))
    const elsewhere = job(UnitTypeId.Jet, 2)
    const jet = (units: UnitSnapshot[], jobs: TrainJob[]) => find(hudModel(input({ units: [airport, ...units], yard: airport, queue: jobs })), 'Jet')
    expect(jet(parked(4), [job(UnitTypeId.Jet, 1), elsewhere]).block).toBeNull()
    expect(jet(parked(5), [job(UnitTypeId.Jet, 1), elsewhere]).block).toBe(TileBlock.ApronFull)
    expect(jet(parked(5), [elsewhere]).block).toBeNull()
  })
})

describe('hud queue chips', () => {
  it('list the structure sites per type, then the jobs per type across every yard, with count and head progress', () => {
    const units = [
      unit(1, UnitTypeId.Factory),
      unit(2, UnitTypeId.Turret, { progress: 0.2 }),
      unit(3, UnitTypeId.Factory, { progress: 0.1 }),
      unit(4, UnitTypeId.Turret, { progress: 0.6 }),
      unit(5, UnitTypeId.MedTank, { progress: 0.5 }),
    ]
    const queue = [
      job(UnitTypeId.MedTank, 1, 0.5),
      job(UnitTypeId.Scout, 1),
      job(UnitTypeId.MedTank, 7, 0.25),
      job(UnitTypeId.MedTank, 7),
      job(UnitTypeId.Jet, 9, 0.1),
    ]
    const chips = hudModel(input({ units, queue })).queue.map((chip) => [chip.kind, UNIT_TYPES[chip.type].label, chip.count, chip.progress])
    expect(chips).toEqual([
      [TileKind.Structure, 'Factory', 1, 0.1],
      [TileKind.Structure, 'Turret', 2, 0.6],
      [TileKind.Train, 'Scout', 1, 0],
      [TileKind.Train, 'Med Tank', 3, 0.5],
      [TileKind.Train, 'Jet', 1, 0.1],
    ])
  })

  it('are empty while nothing is in production', () => {
    expect(hudModel(input({ units: [unit(1, UnitTypeId.Factory)] })).queue).toEqual([])
  })
})

describe('hud tile badge', () => {
  it('shows for more than one, or for one that has not started', () => {
    const factory = unit(1, UnitTypeId.Factory)
    const queue = [job(UnitTypeId.MedTank, 1, 0.4), job(UnitTypeId.Scout, 1), job(UnitTypeId.Artillery, 2, 0.6)]
    const model = hudModel(input({ units: [factory], yard: factory, queue }))
    expect(find(model, 'Scout')).toMatchObject({ count: 1, badge: true })
    expect(find(model, 'Med Tank')).toMatchObject({ count: 1, badge: false })
    const pair = hudModel(input({ units: [factory], yard: factory, queue: [job(UnitTypeId.MedTank, 1, 0.4), job(UnitTypeId.MedTank, 1)] }))
    expect(find(pair, 'Med Tank')).toMatchObject({ count: 2, badge: true })
  })
})

describe('hud build tabs', () => {
  it('put structures and the city house on Base, factory units on Land, Jet and Gunship on Air and Cruiser on Sea, numbering each tab from F1', () => {
    const model = hudModel(input({ units: [unit(1, UnitTypeId.Factory, { progress: 0.5 })] }))
    const slots = model.tiles.map((tile) => [tile.tab, name(tile), tile.slot])
    expect(slots).toEqual([
      [BuildTab.Base, 'Factory', 1],
      [BuildTab.Base, 'Turret', 2],
      [BuildTab.Base, 'Airport', 3],
      [BuildTab.Base, 'Helipad', 4],
      [BuildTab.Base, 'Shipyard', 5],
      [BuildTab.Base, 'Building', 6],
      [BuildTab.Land, 'Scout', 1],
      [BuildTab.Land, 'Med Tank', 2],
      [BuildTab.Land, 'Heavy Tank', 3],
      [BuildTab.Land, 'Artillery', 4],
      [BuildTab.Air, 'Jet', 1],
      [BuildTab.Air, 'Gunship', 2],
      [BuildTab.Sea, 'Cruiser', 1],
    ])
  })

  it('open Land for a selected factory, Air for an airport or helipad, Sea for a shipyard, and Base otherwise', () => {
    const opened = (typeId: UnitTypeId) => {
      const selected = unit(1, typeId, { progress: 0.5 })
      return hudModel(input({ units: [selected], selected: [1], yard: selected })).tab
    }
    const yards = [UnitTypeId.Factory, UnitTypeId.Airport, UnitTypeId.Helipad, UnitTypeId.Shipyard]
    expect(yards.map(opened)).toEqual([BuildTab.Land, BuildTab.Air, BuildTab.Air, BuildTab.Sea])
    expect(hudModel(input({ units: [unit(1, UnitTypeId.MedTank)], selected: [1] })).tab).toBe(BuildTab.Base)
  })
})

describe('hud tile reasons', () => {
  it('mark a structure Needs a factory before Needs population', () => {
    const block = (units: UnitSnapshot[], label: string) => find(hudModel(input({ towns: [], units })), label).block
    expect(block([], 'Airport')).toBe(TileBlock.NeedsFactory)
    expect(block([], 'Turret')).toBe(TileBlock.NeedsPopulation)
    expect(block([unit(1, UnitTypeId.Factory)], 'Airport')).toBe(TileBlock.NeedsPopulation)
  })

  it('mark a train tile Select a factory, an airport, a helipad or a shipyard unless its yard is the selected one', () => {
    const factory = unit(1, UnitTypeId.Factory)
    const trains = (fields: Parameters<typeof input>[0]) => {
      const model = hudModel(input({ units: [factory], ...fields }))
      return ['Scout', 'Jet', 'Gunship', 'Cruiser'].map((label) => {
        const tile = find(model, label)
        return [label, tile.block, tile.kind === TileKind.Train ? tile.yard : null]
      })
    }
    expect(trains({ towns: [] })).toEqual([
      ['Scout', TileBlock.SelectFactory, null],
      ['Jet', TileBlock.SelectAirport, null],
      ['Gunship', TileBlock.SelectHelipad, null],
      ['Cruiser', TileBlock.SelectShipyard, null],
    ])
    expect(trains({ selected: [1], yard: factory }).slice(0, 2)).toEqual([
      ['Scout', null, 1],
      ['Jet', TileBlock.SelectAirport, null],
    ])
  })

  it('then mark it Not finished while its yard is building, Needs population, then Apron full for a jet', () => {
    const jet = (progress: number, towns: Town[]) => {
      const airport = unit(1, UnitTypeId.Airport, { progress })
      const parked = Array.from({ length: 6 }, (_, bay) => unit(10 + bay, UnitTypeId.Jet, { home: { x: airport.tileX, y: airport.tileY }, bay }))
      return find(hudModel(input({ towns, units: [airport, ...parked], selected: [1], yard: airport })), 'Jet').block
    }
    expect(jet(0.5, [])).toBe(TileBlock.NotFinished)
    expect(jet(1, [])).toBe(TileBlock.NeedsPopulation)
    expect(jet(1, [town(ME, 40)])).toBe(TileBlock.ApronFull)
  })
})

describe('hud F-slots', () => {
  it('reads F1 and up from a key code', () => {
    expect(functionSlot('F1')).toBe(1)
    expect(functionSlot('F12')).toBe(12)
    expect(functionSlot('F0')).toBeNull()
    expect(functionSlot('KeyF')).toBeNull()
  })
})

describe('hud selection rows', () => {
  it('count the live selected units per type, most numerous first with ties by type id', () => {
    const units = [
      unit(1, UnitTypeId.Gunship),
      unit(2, UnitTypeId.Scout),
      unit(3, UnitTypeId.MedTank),
      unit(4, UnitTypeId.Scout),
      unit(5, UnitTypeId.Artillery),
      unit(6, UnitTypeId.MedTank, { health: 0 }),
      unit(7, UnitTypeId.MedTank),
    ]
    const rows = hudModel(input({ units, selected: [1, 2, 3, 4, 5, 6] })).rows
    expect(rows.map((row) => [UNIT_TYPES[row.type].label, row.count])).toEqual([
      ['Scout', 2],
      ['Med Tank', 1],
      ['Artillery', 1],
      ['Gunship', 1],
    ])
  })

  it('rate the health of a row as Σhealth / ΣmaxHealth, healthy from 50% and damaged from 25%', () => {
    const max = UNIT_TYPES[UnitTypeId.MedTank].maxHealth
    const rated = (...healths: number[]) => {
      const units = healths.map((health, index) => unit(index + 1, UnitTypeId.MedTank, { health }))
      const [row] = hudModel(input({ units, selected: units.map((entry) => entry.id) })).rows
      return [row.health, row.band]
    }
    expect(rated(max, max * 0.2)).toEqual([0.6, HealthBand.Healthy])
    expect(rated(max * 0.5)).toEqual([0.5, HealthBand.Healthy])
    expect(rated(max * 0.25)).toEqual([0.25, HealthBand.Damaged])
    expect(rated(max * 0.2)).toEqual([0.2, HealthBand.Critical])
  })

  it('carry the progress of a building that is not finished', () => {
    const units = [unit(1, UnitTypeId.Factory, { progress: 0.4 }), unit(2, UnitTypeId.Airport)]
    const progress = (id: number) => hudModel(input({ units, selected: [id] })).rows[0].progress
    expect([progress(1), progress(2)]).toEqual([0.4, null])
  })
})

describe('hud city hall', () => {
  it('opens Base and carries the focus of the hall with its label', () => {
    const hall = town(ME, 6)
    hall.state.focus = -2
    const model = hudModel(input({ towns: [hall], units: [unit(1, UnitTypeId.Factory)], queue: [job(UnitTypeId.Scout, 1)], hall: 0 }))
    expect(model.tab).toBe(BuildTab.Base)
    expect(model.hall).toEqual({ focus: -2, label: 'Money ×4' })
    expect(hudModel(input()).hall).toBeNull()
  })

  it('labels the focus steps from Money ×4 to Growth ×4', () => {
    expect([-2, -1, 0, 1, 2].map(focusLabel)).toEqual(['Money ×4', 'Money ×2', 'Balanced', 'Growth ×2', 'Growth ×4'])
  })
})

describe('hud for spectators', () => {
  it('shows no tile', () => {
    const model = hudModel(input({ spectating: true, units: [unit(1, UnitTypeId.Factory)], queue: [job(UnitTypeId.Scout, 1)] }))
    expect(shown(model)).toEqual([])
  })

  it('shows no selection row', () => {
    expect(hudModel(input({ spectating: true, units: [unit(1, UnitTypeId.MedTank)], selected: [1] })).rows).toEqual([])
  })
})
