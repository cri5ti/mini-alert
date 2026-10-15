import { describe, expect, it } from 'vitest'
import { CITY_GROW_SECONDS, CITY_MODELS, buildingCost, canPlaceCityBuilding, layoutCities, populationOf, projectCity } from '../shared/cities.ts'
import { AIRPORT, ARTILLERY, FACTORY, HEAVY_TANK, HELIPAD, MED_TANK, SCOUT, SHIPYARD, TURRET, UnitTypeId, yardOf } from '../shared/unit-types.ts'
import { Game } from './game.ts'
import { CREDIT_PER_POPULATION, INCOME_SECONDS, STARTING_CREDITS, creditCap } from './player.ts'
import { Terrain } from '../shared/tiles.ts'
import { World } from './world.ts'

function seat(game: Game, playerId: number, x: number, y: number) {
  game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: x + 0.5, y: y + 0.5 }], seed: 11 }
  game.bindCities()
  game.claimCity({ x: x + 0.5, y: y + 0.5 }, playerId)
}

describe('buildings', () => {
  it('pauses a structure when credits run out and keeps what was already paid', () => {
    const game = new Game(new World(12, 12))
    const human = game.addPlayer()
    human.credits = 100
    seat(game, human.id, 8, 2)
    expect(game.placeBuilding(human.id, UnitTypeId.Turret, { x: 2, y: 2 })).toBe(true)
    quiet(game, 8, 2)
    expect(human.credits).toBe(100)
    game.tick(TURRET.buildTime)
    expect(game.units[0].progress).toBeCloseTo(100 / TURRET.cost)
    expect(human.credits).toBeCloseTo(0)
    game.tick(TURRET.buildTime)
    expect(game.units[0].progress).toBeCloseTo(100 / TURRET.cost)
    expect(human.credits).toBeCloseTo(0)
  })

  it('places several structures and builds them one at a time', () => {
    const game = new Game(new World(16, 16))
    const human = game.addPlayer()
    seat(game, human.id, 4, 10)
    growPop(game, human.id, TURRET.supply + FACTORY.supply)
    expect(game.placeBuilding(human.id, UnitTypeId.Turret, { x: 2, y: 2 })).toBe(true)
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 6, y: 6 })).toBe(true)
    quiet(game, 4, 10)
    expect(human.credits).toBe(10_000)
    const turret = game.units[0]
    const factory = game.units[1]
    expect(game.pathfinder.occupant(6, 6)).toBe(factory.id)
    expect(game.pathfinder.occupant(7, 7)).toBe(factory.id)
    game.tick(2.5)
    expect(turret.progress).toBeCloseTo(0.5)
    expect(factory.progress).toBe(0)
    expect(human.credits).toBeCloseTo(10_000 - TURRET.cost / 2)
    game.tick(2.5)
    expect(turret.progress).toBe(1)
    expect(factory.progress).toBe(0)
    expect(human.credits).toBeCloseTo(10_000 - TURRET.cost)
    game.tick(4)
    expect(factory.progress).toBeCloseTo(0.5)
    expect(human.credits).toBeCloseTo(10_000 - TURRET.cost - FACTORY.cost / 2)
  })

  it('queues unit production and finishes one at a time', () => {
    const game = new Game(new World(16, 16))
    const human = game.addPlayer()
    seat(game, human.id, 10, 4)
    growPop(game, human.id, FACTORY.supply + SCOUT.supply * 2)
    const beat = game.creditIncome(human.id)
    game.takeYields()
    const paid = () => game.takeYields().length * beat
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 4, y: 4 })).toBe(true)
    game.finishBuild(human.id)
    expect(human.credits).toBe(10_000 - FACTORY.cost)
    expect(train(game, human.id, UnitTypeId.Scout)).toBe(true)
    expect(train(game, human.id, UnitTypeId.Scout)).toBe(true)
    expect(human.credits).toBe(10_000 - FACTORY.cost)
    expect(game.units.filter((unit) => unit.typeId === UnitTypeId.Scout)).toHaveLength(0)
    expect(game.trainingFor(human.id)[0]?.progress).toBe(0)
    const pace = 1.25
    game.tick(SCOUT.buildTime / 2)
    let earned = paid()
    expect(game.trainingFor(human.id)).toHaveLength(2)
    expect(game.trainingFor(human.id)[0]?.progress).toBeCloseTo(0.5 * pace)
    expect(game.trainingFor(human.id)[1]?.progress).toBe(0)
    expect(human.credits).toBeCloseTo(10_000 - FACTORY.cost - SCOUT.cost * 0.5 * pace + earned)
    game.tick(SCOUT.buildTime / 2)
    expect(game.units.filter((unit) => unit.typeId === UnitTypeId.Scout)).toHaveLength(1)
    expect(game.trainingFor(human.id)[0]?.progress).toBeCloseTo(0.25)
    game.tick(SCOUT.buildTime)
    expect(game.units.filter((unit) => unit.typeId === UnitTypeId.Scout)).toHaveLength(2)
    expect(game.trainingFor(human.id)).toHaveLength(0)
    earned += paid()
    const floor = 10_000 - FACTORY.cost - SCOUT.cost * 2 + earned
    expect(human.credits).toBeGreaterThanOrEqual(floor - 0.01)
  })

  it('cancels the latest queued build and leaves credits already spent', () => {
    const game = new Game(new World(16, 16))
    const human = game.addPlayer()
    seat(game, human.id, 4, 10)
    growPop(game, human.id, TURRET.supply + FACTORY.supply)
    expect(game.placeBuilding(human.id, UnitTypeId.Turret, { x: 2, y: 2 })).toBe(true)
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 6, y: 6 })).toBe(true)
    quiet(game, 4, 10)
    expect(game.cancelBuild(human.id, UnitTypeId.Factory)).toBe(true)
    game.tick(0)
    expect(game.units.map((unit) => unit.typeId)).toEqual([UnitTypeId.Turret])
    game.tick(TURRET.buildTime / 2)
    expect(human.credits).toBeCloseTo(10_000 - TURRET.cost / 2)
    expect(game.cancelBuild(human.id, UnitTypeId.Turret)).toBe(true)
    game.tick(0)
    expect(game.units).toHaveLength(0)
    expect(human.credits).toBeCloseTo(10_000 - TURRET.cost / 2)

    game.claimCity({ x: 4.5, y: 10.5 }, human.id)
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 6, y: 6 })).toBe(true)
    game.finishBuild(human.id)
    const layout = layoutCities(game.scenery.towns, game.scenery.seed, terrainOf(game), game.world.width, game.world.height)[0]
    const road = layout.streets.find((street) => street.kind < 6)
    expect(road).toBeDefined()
    if (!road) return
    const holder = game.spawn(human, UnitTypeId.Scout, { x: road.x, y: road.y }, 0)
    let guard = 0
    while (
      game.creditIncome(human.id) / CREDIT_PER_POPULATION <
        FACTORY.supply + SCOUT.supply + MED_TANK.supply + SCOUT.supply &&
      guard < 40
    ) {
      game.tick(CITY_GROW_SECONDS)
      guard += 1
    }
    holder.health = 0
    game.tick(0)
    expect(train(game, human.id, UnitTypeId.Scout)).toBe(true)
    expect(train(game, human.id, UnitTypeId.MedTank)).toBe(true)
    expect(train(game, human.id, UnitTypeId.Scout)).toBe(true)
    expect(game.cancelTraining(human.id, UnitTypeId.Scout)).toBe(true)
    expect(game.trainingFor(human.id).map((job) => job.typeId)).toEqual([UnitTypeId.Scout, UnitTypeId.MedTank])
    game.tick(SCOUT.buildTime / 2)
    const paid = human.credits
    expect(game.cancelTraining(human.id, UnitTypeId.Scout)).toBe(true)
    expect(game.trainingFor(human.id).map((job) => job.typeId)).toEqual([UnitTypeId.MedTank])
    expect(human.credits).toBeCloseTo(paid)
  })

  it('pays credits per population every income beat, unless an enemy is near', () => {
    const width = 16
    const height = 16
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    const game = new Game(World.fromTiles(width, height, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 6, y: 6 }], seed: 11 }
    game.bindCities()
    const human = game.addPlayer()
    game.claimCity({ x: 6, y: 6 }, human.id)
    const population = populationOf(layoutCities(game.scenery.towns, game.scenery.seed, terrainOf(game), width, height)[0])
    expect(population).toBeGreaterThan(0)
    expect(game.creditIncome(human.id)).toBe(CREDIT_PER_POPULATION * population)
    human.credits = 0
    game.tick(INCOME_SECONDS - 1)
    expect(human.credits).toBe(0)
    expect(game.takeYields()).toEqual([])
    const income = game.creditIncome(human.id)
    game.tick(1)
    expect(human.credits).toBe(income)
    expect(game.takeYields()).toHaveLength(1)

    human.credits = 0
    const foe = game.addPlayer()
    const street = layoutCities(game.scenery.towns, game.scenery.seed, terrainOf(game), width, height)[0].streets[0]
    game.spawn(foe, UnitTypeId.Scout, { x: street.x, y: street.y }, 0)
    expect(game.creditIncome(human.id)).toBe(0)
    game.tick(INCOME_SECONDS)
    expect(human.credits).toBe(0)
    expect(game.takeYields()).toEqual([])
  })

  it('caps stored credits by population and drops the surplus when that population falls', () => {
    const game = new Game(new World(16, 16))
    const human = game.addPlayer()
    seat(game, human.id, 8, 2)
    const people = game.creditIncome(human.id) / CREDIT_PER_POPULATION
    expect(people).toBeGreaterThan(0)
    human.credits = creditCap(people) + 800
    game.tick(0)
    expect(human.credits).toBe(creditCap(people))
    game.tick(INCOME_SECONDS)
    expect(human.credits).toBe(creditCap(people))
    const foe = game.addPlayer()
    game.claimCity({ x: 8.5, y: 2.5 }, foe.id)
    expect(human.credits).toBe(STARTING_CREDITS)
    expect(foe.credits).toBe(STARTING_CREDITS)
  })

  it('refuses to train more units than the population', () => {
    const width = 24
    const height = 24
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    const game = new Game(World.fromTiles(width, height, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 6, y: 6 }], seed: 11 }
    game.bindCities()
    const human = game.addPlayer()
    game.claimCity({ x: 6, y: 6 }, human.id)
    growPop(game, human.id, FACTORY.supply + 1)
    const population = game.creditIncome(human.id) / CREDIT_PER_POPULATION
    expect(population).toBeGreaterThan(FACTORY.supply)
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 2, y: 2 })).toBe(true)
    game.finishBuild(human.id)
    const room = population - FACTORY.supply
    expect(room).toBeGreaterThan(0)
    for (let i = 0; i < room; i++) game.spawn(human, UnitTypeId.Scout, { x: 18, y: i }, 0)
    expect(train(game, human.id, UnitTypeId.Scout)).toBe(false)
    const scout = game.units.find((unit) => unit.typeId === UnitTypeId.Scout)
    expect(scout).toBeDefined()
    if (!scout) return
    scout.health = 0
    game.tick(0)
    expect(train(game, human.id, UnitTypeId.Scout)).toBe(true)
    expect(train(game, human.id, UnitTypeId.Scout)).toBe(false)
  })

  it('charges more population for heavier units and turrets', () => {
    const width = 24
    const height = 24
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    const game = new Game(World.fromTiles(width, height, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 6, y: 6 }], seed: 11 }
    game.bindCities()
    const human = game.addPlayer()
    game.claimCity({ x: 6, y: 6 }, human.id)
    growPop(game, human.id, FACTORY.supply + MED_TANK.supply)
    const population = game.creditIncome(human.id) / CREDIT_PER_POPULATION
    const room = population - FACTORY.supply
    expect(room).toBeGreaterThanOrEqual(MED_TANK.supply)
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 2, y: 2 })).toBe(true)
    game.finishBuild(human.id)
    expect(train(game, human.id, UnitTypeId.MedTank)).toBe(true)
    const second = room >= MED_TANK.supply * 2
    expect(train(game, human.id, UnitTypeId.MedTank)).toBe(second)
    let left = room - MED_TANK.supply - (second ? MED_TANK.supply : 0)
    while (left >= TURRET.supply) {
      expect(train(game, human.id, UnitTypeId.Scout)).toBe(true)
      left -= SCOUT.supply
    }
    expect(train(game, human.id, UnitTypeId.Artillery)).toBe(false)
    expect(game.placeBuilding(human.id, UnitTypeId.Turret, { x: 14, y: 14 })).toBe(false)
    expect(SCOUT.supply).toBe(1)
    expect(MED_TANK.supply).toBe(2)
    expect(ARTILLERY.supply).toBe(3)
    expect(HEAVY_TANK.supply).toBe(4)
    expect(TURRET.supply).toBe(2)
    expect(FACTORY.supply).toBe(4)
    expect(HELIPAD.supply).toBe(4)
    expect(SHIPYARD.supply).toBe(8)
    expect(AIRPORT.supply).toBe(12)
  })

  it('rejects a footprint that overlaps an occupied tile', () => {
    const game = new Game(new World(12, 12))
    const human = game.addPlayer()
    seat(game, human.id, 10, 4)
    game.spawn(human, UnitTypeId.Scout, { x: 4, y: 4 })
    const credits = human.credits
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 4, y: 4 })).toBe(false)
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 3, y: 3 })).toBe(false)
    expect(human.credits).toBe(credits)
  })

  it('refuses a building beside a city the player does not own', () => {
    const game = new Game(new World(24, 24))
    const human = game.addPlayer()
    const foe = game.addPlayer()
    game.scenery = {
      coast: [],
      holes: [],
      roads: [],
      towns: [
        { x: 4.5, y: 10.5 },
        { x: 18.5, y: 4.5 },
      ],
      seed: 11,
    }
    game.bindCities()
    game.claimCity({ x: 18.5, y: 4.5 }, foe.id)
    expect(game.placeBuilding(human.id, UnitTypeId.Turret, { x: 2, y: 2 })).toBe(false)
    game.claimCity({ x: 4.5, y: 10.5 }, human.id)
    expect(game.placeBuilding(human.id, UnitTypeId.Turret, { x: 2, y: 2 })).toBe(true)
  })

  it('trains each factory on its own and sends the unit out of that one', () => {
    const game = new Game(new World(28, 28))
    const human = game.addPlayer()
    seat(game, human.id, 10, 8)
    growPop(game, human.id, FACTORY.supply * 2 + SCOUT.supply * 3)
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 4, y: 6 })).toBe(true)
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 13, y: 8 })).toBe(true)
    game.finishBuild(human.id)
    game.finishBuild(human.id)
    const first = game.units[0]
    const second = game.units[1]
    const pace = 1.25
    expect(train(game, human.id, UnitTypeId.Scout, first.id)).toBe(true)
    expect(train(game, human.id, UnitTypeId.Scout, second.id)).toBe(true)
    game.tick(SCOUT.buildTime / 2)
    const jobs = game.trainingFor(human.id)
    expect(jobs.map((job) => job.yardId)).toEqual([first.id, second.id])
    expect(jobs[0]?.progress).toBeCloseTo(0.5 * pace)
    expect(jobs[1]?.progress).toBeCloseTo(0.5 * pace)
    const rally = { x: 24, y: 8 }
    expect(game.setRally(human.id, rally)).toBe(true)
    game.tick(SCOUT.buildTime / 2)
    const scouts = game.units.filter((unit) => unit.typeId === UnitTypeId.Scout)
    expect(scouts).toHaveLength(2)
    const from = (scout: { pos: { x: number; z: number } }, factory: { pos: { x: number; z: number } }) =>
      Math.hypot(scout.pos.x - factory.pos.x, scout.pos.z - factory.pos.z)
    expect(from(scouts[0], first)).toBeLessThan(from(scouts[0], second))
    expect(from(scouts[1], second)).toBeLessThan(from(scouts[1], first))
    expect(scouts[0].path.at(-1)).toEqual(rally)
    expect(scouts[1].path.at(-1)).toEqual(rally)
    expect(train(game, human.id, UnitTypeId.Scout, second.id)).toBe(true)
    second.health = 0
    game.tick(0)
    expect(game.trainingFor(human.id)).toHaveLength(0)
  })

  it('sends the next unit to an open tile beside an occupied waypoint', () => {
    const game = new Game(new World(28, 28))
    const human = game.addPlayer()
    seat(game, human.id, 10, 8)
    growPop(game, human.id, FACTORY.supply + SCOUT.supply * 2)
    expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 4, y: 6 })).toBe(true)
    game.finishBuild(human.id)
    const rally = { x: 20, y: 8 }
    expect(game.setRally(human.id, rally)).toBe(true)
    const parked = game.spawn(human, UnitTypeId.Scout, rally, 0)
    expect(train(game, human.id, UnitTypeId.Scout)).toBe(true)
    game.tick(SCOUT.buildTime)
    const scout = game.units.find((unit) => unit.typeId === UnitTypeId.Scout && unit.id !== parked.id)
    expect(scout).toBeDefined()
    if (!scout) return
    const goal = scout.path.at(-1)
    expect(goal).toBeDefined()
    if (!goal) return
    expect(goal).not.toEqual(rally)
    expect(Math.abs(goal.x - rally.x) + Math.abs(goal.y - rally.y)).toBe(1)
    expect(game.rally(human.id)).toEqual(rally)
  })

  it('prices a city building from that city and uses a grown building', () => {
    expect(buildingCost(1)).toBe(100)
    expect(buildingCost(5)).toBe(100)
    expect(buildingCost(6)).toBe(100)
    expect(buildingCost(7)).toBe(200)
    expect(buildingCost(8)).toBe(300)
    const game = new Game(new World(64, 32))
    const human = game.addPlayer()
    game.scenery = {
      coast: [],
      holes: [],
      roads: [],
      towns: [
        { x: 8.5, y: 8.5 },
        { x: 40.5, y: 8.5 },
      ],
      seed: 11,
    }
    game.bindCities()
    game.claimCity(game.scenery.towns[0], human.id)
    game.claimCity(game.scenery.towns[1], human.id)
    const terrain = terrainOf(game)
    const bases = layoutCities(game.scenery.towns, game.scenery.seed, terrain, game.world.width, game.world.height)
    const openStreet = (index: number) => bases[index].streets.find((road) => road.kind < 6)
    const smallStreet = openStreet(1)
    const largeStreet = openStreet(0)
    expect(smallStreet).toBeDefined()
    expect(largeStreet).toBeDefined()
    if (!smallStreet || !largeStreet) return
    const dweller = game.spawn(human, UnitTypeId.Scout, { x: smallStreet.x, y: smallStreet.y }, 0)
    let guard = 0
    while (legalPlot(game, 1) === null && guard < 20) {
      game.tick(CITY_GROW_SECONDS)
      guard += 1
    }
    dweller.health = 0
    game.tick(0)
    game.spawn(human, UnitTypeId.Scout, { x: largeStreet.x, y: largeStreet.y }, 0)
    while (cityPop(game, 0) <= 6 && guard < 50) {
      game.tick(CITY_GROW_SECONDS)
      guard += 1
    }
    const large = cityPop(game, 0)
    const small = cityPop(game, 1)
    expect(large).toBeGreaterThan(6)
    expect(buildingCost(large)).toBeGreaterThan(buildingCost(small))
    const wide = legalPlot(game, 0)
    const narrow = legalPlot(game, 1)
    expect(wide).not.toBeNull()
    expect(narrow).not.toBeNull()
    if (!wide || !narrow) return
    const income = game.creditIncome(human.id)
    const purse = human.credits
    human.credits = buildingCost(large) - 1
    expect(game.placeCityBuilding(human.id, wide)).toBe(false)
    human.credits = purse
    expect(game.placeCityBuilding(human.id, { x: 63, y: 31 })).toBe(false)
    expect(game.placeCityBuilding(human.id, wide)).toBe(true)
    expect(human.credits).toBeCloseTo(purse - buildingCost(large))
    expect(game.creditIncome(human.id)).toBe(income + CREDIT_PER_POPULATION)
    expect(game.placeCityBuilding(human.id, narrow)).toBe(true)
    expect(human.credits).toBeCloseTo(purse - buildingCost(large) - buildingCost(small))
    expect(game.creditIncome(human.id)).toBe(income + CREDIT_PER_POPULATION * 2)
    expect(game.units.filter((unit) => unit.health > 0)).toHaveLength(1)
    const largeSite = game.cityStates()[0].sites[0]
    expect(largeSite.model).toBeGreaterThanOrEqual(0)
    expect(largeSite.model).toBeLessThan(CITY_MODELS)
    const replay = projectCity(bases[0], game.cityStates()[0].grown, terrain, game.world.width, game.world.height, game.cityStates()[0].sites)
    const built = replay.buildings.find((building) => building.x === wide.x && building.y === wide.y)
    expect(built?.model).toBe(largeSite.model)
    expect(built?.yaw).toBe(largeSite.yaw)
    expect(built?.keep).toBe(false)
    expect(game.pathfinder.isWalkable(wide.x, wide.y, -1)).toBe(false)
  })

  it('holds a finished turret in place while it fires', () => {
    const game = new Game(new World(24, 24))
    const human = game.addPlayer()
    const enemy = game.addPlayer()
    seat(game, human.id, 10, 4)
    expect(game.placeBuilding(human.id, UnitTypeId.Turret, { x: 4, y: 4 })).toBe(true)
    const turret = game.units[0]
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 4, y: 10 })
    const health = foe.health
    game.tick(2)
    expect(foe.health).toBe(health)
    game.finishBuild(human.id)
    game.tick(2)
    game.tick(1)
    expect(turret.tile).toEqual({ x: 4, y: 4 })
    expect(turret.pos).toEqual({ x: 4.5, z: 4.5 })
    expect(foe.health).toBeLessThan(health)
    expect(game.orderMove(human.id, [turret.id], { x: 8, y: 8 })).toBe(false)
    expect(turret.path).toEqual([])
  })

  it('finishes a structure and a queued unit on the next tick when INSTANT=1', () => {
    const previous = process.env.INSTANT
    process.env.INSTANT = '1'
    try {
      const game = new Game(new World(16, 16))
      const human = game.addPlayer()
      seat(game, human.id, 4, 10)
      growPop(game, human.id, FACTORY.supply + SCOUT.supply)
      expect(game.placeBuilding(human.id, UnitTypeId.Factory, { x: 6, y: 6 })).toBe(true)
      quiet(game, 4, 10)
      game.tick(1 / 30)
      const factory = game.units[0]
      expect(factory.progress).toBe(1)
      expect(human.credits).toBeCloseTo(10_000 - FACTORY.cost)
      game.claimCity({ x: 4.5, y: 10.5 }, human.id)
      expect(train(game, human.id, UnitTypeId.Scout)).toBe(true)
      game.tick(1 / 30)
      expect(game.units.some((unit) => unit.typeId === UnitTypeId.Scout)).toBe(true)
      expect(game.trainingFor(human.id)).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env.INSTANT
      else process.env.INSTANT = previous
    }
  })
})

function cityPop(game: Game, index: number): number {
  const terrain = terrainOf(game)
  const bases = layoutCities(game.scenery.towns, game.scenery.seed, terrain, game.world.width, game.world.height)
  const state = game.cityStates()[index]
  return populationOf(
    projectCity(bases[index], state.grown, terrain, game.world.width, game.world.height, state.sites),
    state.ruins,
  )
}

function legalPlot(game: Game, index: number): { x: number; y: number } | null {
  const terrain = terrainOf(game)
  const bases = layoutCities(game.scenery.towns, game.scenery.seed, terrain, game.world.width, game.world.height)
  const state = game.cityStates()[index]
  const layout = projectCity(bases[index], state.grown, terrain, game.world.width, game.world.height, state.sites)
  for (let y = 0; y < game.world.height; y++) {
    for (let x = 0; x < game.world.width; x++) {
      if (!canPlaceCityBuilding(layout, x, y, terrain, game.world.width, game.world.height)) continue
      if (!game.pathfinder.isWalkable(x, y, -1)) continue
      return { x, y }
    }
  }
  return null
}

function growPop(game: Game, playerId: number, people: number) {
  const index = game.cityStates().findIndex((state) => state.ownerId === playerId)
  const layout = game.cityLayouts()[index]
  const spot = layout?.streets.find((street) => street.kind < 6) ?? layout?.tiles[0]
  const owner = game.player(playerId)
  if (!spot || !owner) return
  const holder = game.spawn(owner, UnitTypeId.Scout, { x: spot.x, y: spot.y }, 0)
  let guard = 0
  while (game.creditIncome(playerId) / CREDIT_PER_POPULATION < people && guard < 80) {
    game.tick(CITY_GROW_SECONDS)
    guard += 1
  }
  holder.health = 0
  game.tick(0)
  owner.credits = 10_000
}

function quiet(game: Game, x: number, y: number) {
  game.claimCity({ x: x + 0.5, y: y + 0.5 }, 0)
}

function train(game: Game, playerId: number, typeId: UnitTypeId, yardId?: number): boolean {
  const id =
    yardId ??
    game.units.find((unit) => unit.ownerId === playerId && unit.typeId === yardOf(typeId) && unit.health > 0 && unit.progress >= 1)?.id ??
    0
  return game.trySpawn(playerId, typeId, id)
}

function terrainOf(game: Game): number[] {
  const terrain: number[] = []
  for (let y = 0; y < game.world.height; y++) {
    for (let x = 0; x < game.world.width; x++) terrain.push(game.world.terrainAt(x, y))
  }
  return terrain
}
