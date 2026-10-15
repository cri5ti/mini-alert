import { describe, expect, it } from 'vitest'
import { bayTile, Flight } from '../shared/flight.ts'
import { AIRPORT, CRUISER, JET, SHIPYARD, UnitTypeId, WeaponKind, yardOf } from '../shared/unit-types.ts'
import { CREDIT_PER_POPULATION } from './player.ts'
import { Terrain } from '../shared/tiles.ts'
import { Game } from './game.ts'
import { World } from './world.ts'

const STEP = 1 / 30

function seat(game: Game, playerId: number, x: number, y: number) {
  game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: x + 0.5, y: y + 0.5 }], seed: 3 }
  game.bindCities()
  game.claimCity({ x: x + 0.5, y: y + 0.5 }, playerId)
}

function padPop(game: Game, playerId: number, people: number) {
  let added = 0
  while (game.creditIncome(playerId) / CREDIT_PER_POPULATION < people && added < 8) {
    added += 1
    game.scenery.towns.push({ x: game.world.width - 1.5, y: 0.5 + (added - 1) * 5 })
    game.bindCities()
    for (const town of game.scenery.towns) game.claimCity(town, playerId)
  }
}

describe('craft', () => {
  it('trains a jet on the strip, circles the order, and can be sent home', () => {
    const game = new Game(new World(28, 16))
    const human = game.addPlayer()
    seat(game, human.id, 10, 8)
    padPop(game, human.id, AIRPORT.supply + JET.supply)
    expect(train(game, human.id, UnitTypeId.Jet)).toBe(false)
    expect(game.placeBuilding(human.id, UnitTypeId.Airport, { x: 4, y: 6 })).toBe(true)
    game.finishBuild(human.id)
    const airport = game.units.find((unit) => unit.typeId === UnitTypeId.Airport)
    expect(airport).toBeDefined()
    expect(train(game, human.id, UnitTypeId.Jet)).toBe(true)
    game.tick(JET.buildTime)
    const jet = game.units.find((unit) => unit.typeId === UnitTypeId.Jet)
    expect(jet).toBeDefined()
    if (!jet || !airport) return
    expect(jet.home).toEqual({ x: airport.tile.x, y: airport.tile.y })
    expect(jet.tile).toEqual(airport.tile)
    expect(jet.flight).toBe(Flight.Ground)
    expect(game.orderMove(human.id, [jet.id], { x: 22, y: 6 })).toBe(true)
    expect(jet.returning).toBe(false)
    expect(jet.flight).toBe(Flight.Taxi)
    expect(jet.bay).toBe(0)
    expect(jet.path.some((tile) => tile.x === airport.tile.x + 1 && tile.y === airport.tile.y + 2)).toBe(true)
    let guard = 0
    while (jet.flight !== Flight.Orbit && guard < 30 * 20) {
      game.tick(STEP)
      guard += 1
    }
    expect(jet.flight).toBe(Flight.Orbit)
    expect(jet.returning).toBe(false)
    expect(game.orderMove(human.id, [jet.id], airport.tile)).toBe(true)
    expect(jet.returning).toBe(true)
  })

  it('launches a cruiser onto water and stops a land order at the shore', () => {
    const width = 24
    const height = 16
    const tiles = new Uint8Array(width * height)
    for (let y = 2; y <= 4; y++) {
      for (let x = 0; x < width; x++) tiles[y * width + x] = Terrain.Water
    }
    const game = new Game(World.fromTiles(width, height, tiles))
    const human = game.addPlayer()
    seat(game, human.id, 12, 10)
    padPop(game, human.id, SHIPYARD.supply + CRUISER.supply)
    expect(game.placeBuilding(human.id, UnitTypeId.Shipyard, { x: 6, y: 6 })).toBe(false)
    expect(game.placeBuilding(human.id, UnitTypeId.Shipyard, { x: 12, y: 3 })).toBe(true)
    game.finishBuild(human.id)
    expect(train(game, human.id, UnitTypeId.Cruiser)).toBe(true)
    game.tick(20)
    const ship = game.units.find((unit) => unit.typeId === UnitTypeId.Cruiser)
    expect(ship).toBeDefined()
    if (!ship) return
    expect(game.world.terrainAt(ship.tile.x, ship.tile.y)).toBe(Terrain.Water)
    expect(game.orderMove(human.id, [ship.id], { x: 18, y: 2 })).toBe(true)
    expect(ship.path.every((tile) => game.world.terrainAt(tile.x, tile.y) === Terrain.Water)).toBe(true)
    expect(game.orderMove(human.id, [ship.id], { x: 18, y: 8 })).toBe(true)
    expect(ship.path.at(-1)).toEqual({ x: 18, y: 4 })
  })

  it('fires five rockets and reloads only after landing at its airport', () => {
    const game = new Game(new World(28, 16))
    const human = game.addPlayer()
    const enemy = game.addPlayer()
    seat(game, human.id, 10, 8)
    padPop(game, human.id, AIRPORT.supply)
    expect(game.placeBuilding(human.id, UnitTypeId.Airport, { x: 4, y: 6 })).toBe(true)
    game.finishBuild(human.id)
    const airport = game.units.find((unit) => unit.typeId === UnitTypeId.Airport)
    const jet = game.spawn(human, UnitTypeId.Jet, { x: 20, y: 4 }, 0)
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 20, y: 14 }, 0)
    if (!airport) return
    foe.health = 5000
    jet.home = { x: airport.tile.x, y: airport.tile.y }
    jet.tile = { x: 20, y: 4 }
    jet.pos = { x: 20.5, z: 4.5 }
    jet.facing = 0
    jet.flight = Flight.Cruise
    jet.altitude = 2.6
    const opening = game.tick(STEP)
    expect(opening[0]?.kind).toBe(WeaponKind.Rocket)
    expect(opening[0]?.flight).toBeGreaterThan(0)
    expect(foe.health).toBe(5000)
    let rockets = opening.length
    for (let i = 0; i < 80 && rockets < 5; i++) {
      rockets += game.tick(0.2).filter((shot) => shot.kind === WeaponKind.Rocket).length
    }
    expect(rockets).toBe(5)
    expect(jet.rounds).toBe(0)
    game.tick(STEP)
    expect(jet.returning).toBe(true)
    const phase = () => jet.flight as Flight
    let guard = 0
    while (phase() !== Flight.Ground && guard < 30 * 40) {
      game.tick(STEP)
      if (phase() !== Flight.Ground) expect(jet.rounds).toBe(0)
      guard += 1
    }
    expect(phase()).toBe(Flight.Ground)
    expect(jet.rounds).toBe(JET.weapon.magazine)
    expect(jet.bay).toBe(0)
    expect(jet.tile).toEqual(bayTile(airport.tile, 0))
  })

  it('parks returning jets on different spots and will not train a seventh', () => {
    const game = new Game(new World(28, 16))
    const human = game.addPlayer()
    seat(game, human.id, 10, 8)
    const layout = game.cityLayouts()[0]
    expect(layout).toBeDefined()
    if (!layout) return
    // Population is standing buildings. These sit off the map so six jets fit under the supply cap.
    while (game.creditIncome(human.id) / CREDIT_PER_POPULATION < AIRPORT.supply + JET.supply * 6) {
      layout.buildings.push({ x: -30 - layout.buildings.length, y: -30, model: 0, yaw: 0, keep: false })
    }
    expect(game.placeBuilding(human.id, UnitTypeId.Airport, { x: 4, y: 6 })).toBe(true)
    game.finishBuild(human.id)
    const airport = game.units.find((unit) => unit.typeId === UnitTypeId.Airport)
    expect(airport).toBeDefined()
    if (!airport) return
    human.credits = JET.cost * 6
    for (let i = 0; i < 6; i++) expect(train(game, human.id, UnitTypeId.Jet)).toBe(true)
    expect(train(game, human.id, UnitTypeId.Jet)).toBe(false)
    game.tick(40)
    const jets = game.units.filter((unit) => unit.typeId === UnitTypeId.Jet)
    expect(jets).toHaveLength(6)
    const tiles = new Set(jets.map((jet) => `${jet.tile.x},${jet.tile.y}`))
    expect(tiles.size).toBe(6)
    for (const jet of jets) expect(jet.tile).toEqual(bayTile(airport.tile, jet.bay))
    const home = { x: airport.tile.x, y: airport.tile.y }
    const [left, right] = jets
    left.tile = { x: 18, y: 4 }
    left.pos = { x: 18.5, z: 4.5 }
    left.flight = Flight.Cruise
    left.altitude = 2.6
    left.facing = Math.PI
    right.tile = { x: 22, y: 10 }
    right.pos = { x: 22.5, z: 10.5 }
    right.flight = Flight.Cruise
    right.altitude = 2.6
    right.facing = Math.PI
    expect(game.orderMove(human.id, [left.id], home)).toBe(true)
    expect(game.orderMove(human.id, [right.id], home)).toBe(true)
    let taxied = false
    let guard = 0
    const phase = (jet: { flight: Flight }) => jet.flight as Flight
    while ((phase(left) !== Flight.Ground || phase(right) !== Flight.Ground) && guard < 30 * 40) {
      game.tick(STEP)
      if (phase(left) === Flight.Taxi || phase(right) === Flight.Taxi) taxied = true
      guard += 1
    }
    expect(taxied).toBe(true)
    expect(left.flight).toBe(Flight.Ground)
    expect(right.flight).toBe(Flight.Ground)
    expect(left.tile).toEqual(bayTile(home, left.bay))
    expect(right.tile).toEqual(bayTile(home, right.bay))
    expect(left.tile).not.toEqual(right.tile)
    expect(Math.hypot(left.pos.x - right.pos.x, left.pos.z - right.pos.z)).toBeGreaterThan(0.8)
    left.health = 0
    game.tick(STEP)
    expect(train(game, human.id, UnitTypeId.Jet)).toBe(true)
  })

  it('holds jet rockets until the plane is in the air', () => {
    const game = new Game(new World(24, 16))
    const human = game.addPlayer()
    const enemy = game.addPlayer()
    const jet = game.spawn(human, UnitTypeId.Jet, { x: 8, y: 4 }, 0)
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 8, y: 8 }, 0)
    foe.health = 500
    jet.tile = { x: 8, y: 4 }
    jet.pos = { x: 8.5, z: 4.5 }
    jet.facing = 0
    jet.flight = Flight.Ground
    jet.altitude = 0
    expect(game.tick(STEP).some((shot) => shot.kind === WeaponKind.Rocket)).toBe(false)
    expect(jet.rounds).toBe(JET.weapon.magazine)
    jet.flight = Flight.Cruise
    jet.altitude = 2.6
    jet.facing = 0
    expect(game.tick(STEP).some((shot) => shot.kind === WeaponKind.Rocket)).toBe(true)
  })

  it('assigns jets with no airport when one finishes', () => {
    const game = new Game(new World(28, 16))
    const human = game.addPlayer()
    seat(game, human.id, 10, 8)
    padPop(game, human.id, AIRPORT.supply)
    const flying = game.spawn(human, UnitTypeId.Jet, { x: 20, y: 4 }, 0)
    flying.flight = Flight.Cruise
    flying.altitude = 2.6
    const parked = game.spawn(human, UnitTypeId.Jet, { x: 18, y: 8 }, 0)
    expect(game.placeBuilding(human.id, UnitTypeId.Airport, { x: 4, y: 6 })).toBe(true)
    game.finishBuild(human.id)
    const airport = game.units.find((unit) => unit.typeId === UnitTypeId.Airport)
    expect(airport).toBeDefined()
    if (!airport) return
    expect(flying.home).toEqual({ x: airport.tile.x, y: airport.tile.y })
    expect(flying.bay).toBeGreaterThanOrEqual(0)
    expect(flying.returning).toBe(false)
    expect(parked.home).toEqual({ x: airport.tile.x, y: airport.tile.y })
    expect(parked.returning).toBe(true)
    expect(parked.bay).not.toBe(flying.bay)
  })
})

function train(game: Game, playerId: number, typeId: UnitTypeId, yardId?: number): boolean {
  const id =
    yardId ??
    game.units.find((unit) => unit.ownerId === playerId && unit.typeId === yardOf(typeId) && unit.health > 0 && unit.progress >= 1)?.id ??
    0
  return game.trySpawn(playerId, typeId, id)
}
