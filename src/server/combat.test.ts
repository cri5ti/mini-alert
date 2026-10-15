import { describe, expect, it } from 'vitest'
import { captureDuration, cityContains, layoutCities, lostStreets, populationOf, projectCity, settledCity, StreetKind, type CityLayout } from '../shared/cities.ts'
import { Flight } from '../shared/flight.ts'
import { SCAR_FADE, Terrain, scarGain, scarStrength, scarTerrain } from '../shared/tiles.ts'
import { MED_TANK, WeaponKind, UnitTypeId } from '../shared/unit-types.ts'
import { Game } from './game.ts'
import { CREDIT_PER_POPULATION } from './player.ts'
import { World } from './world.ts'

function standOff(layout: CityLayout, target: { x: number; y: number }, width: number): { x: number; y: number } | null {
  for (let dist = 1; dist <= 6; dist++) {
    for (let dy = -dist; dy <= dist; dy++) {
      for (let dx = -dist; dx <= dist; dx++) {
        if (Math.abs(dx) + Math.abs(dy) !== dist) continue
        const x = target.x + dx
        const y = target.y + dy
        if (x < 0 || y < 0 || x >= width || y >= width) continue
        if (!cityContains(layout, x, y)) return { x, y }
      }
    }
  }
  return null
}

function battle() {
  const game = new Game(new World(24, 24))
  const human = game.addPlayer()
  const enemy = game.addPlayer()
  return { game, human, enemy }
}

describe('combat', () => {
  it('damages a faced enemy on the same tick with a bullet', () => {
    const { game, human, enemy } = battle()
    game.spawn(human, UnitTypeId.Scout, { x: 4, y: 4 }, 0)
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 4, y: 8 }, 0)
    foe.facing = 0
    const before = foe.health
    const shots = game.tick(1 / 30)
    expect(foe.health).toBe(before - 5)
    expect(shots).toEqual([
      expect.objectContaining({
        kind: WeaponKind.Bullet,
        flight: 0,
      }),
    ])
    expect(Math.hypot(shots[0].aimX - foe.pos.x, shots[0].aimZ - foe.pos.z)).toBeLessThanOrEqual(0.14)
  })

  it('does not fire when the hull is aimed away', () => {
    const { game, human, enemy } = battle()
    game.spawn(human, UnitTypeId.Scout, { x: 4, y: 4 }, Math.PI)
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 4, y: 8 }, 0)
    const before = foe.health
    expect(game.tick(1 / 30)).toEqual([])
    expect(foe.health).toBe(before)
  })

  it('holds an empty magazine for five seconds and refills a partial one', () => {
    const { game, human, enemy } = battle()
    const scout = game.spawn(human, UnitTypeId.Scout, { x: 4, y: 4 }, 0)
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 4, y: 8 }, 0)
    foe.health = 1000
    let fired = 0
    for (let i = 0; i < 24; i++) fired += game.tick(0.08).length
    expect(fired).toBe(24)
    expect(scout.rounds).toBe(0)
    const held = foe.health
    expect(game.tick(0.08)).toEqual([])
    expect(foe.health).toBe(held)

    scout.facing = Math.PI
    game.tick(5)
    expect(scout.rounds).toBe(24)

    const partial = game.spawn(human, UnitTypeId.Scout, { x: 8, y: 4 }, 0)
    game.spawn(enemy, UnitTypeId.Scout, { x: 8, y: 8 }, 0)
    game.tick(0.08)
    expect(partial.rounds).toBe(23)
    partial.facing = Math.PI
    game.tick(4.9)
    expect(partial.rounds).toBe(23)
    game.tick(0.2)
    expect(partial.rounds).toBe(24)
  })

  it('keeps the turret on an enemy already inside the lock cone', () => {
    const { game, human, enemy } = battle()
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: 10, y: 10 }, 0)
    game.spawn(enemy, UnitTypeId.Scout, { x: 10, y: 16 }, 0)
    game.spawn(enemy, UnitTypeId.Scout, { x: 13, y: 10 }, 0)
    game.tick(0.05)
    expect(Math.abs(tank.turretYaw)).toBeLessThan(0.05)
  })

  it('holds shell damage until the flight time elapses', () => {
    const { game, human, enemy } = battle()
    game.spawn(human, UnitTypeId.MedTank, { x: 2, y: 2 }, 0)
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 2, y: 7 }, 0)
    const before = foe.health
    const shots = game.tick(1 / 30)
    expect(shots[0]?.flight).toBeGreaterThan(0)
    expect(foe.health).toBe(before)
    const flight = shots[0].flight
    game.tick(flight - 1 / 30 - 0.02)
    expect(foe.health).toBe(before)
    game.tick(0.06)
    expect(foe.health).toBeLessThan(before)
    expect(foe.health).toBeGreaterThanOrEqual(before - 34)
  })

  it('aims a shell ahead of a moving target', () => {
    const { game, human, enemy } = battle()
    game.spawn(human, UnitTypeId.MedTank, { x: 2, y: 2 }, 0)
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 2, y: 7 }, 0)
    foe.speed = foe.type.topSpeed
    expect(game.orderMove(enemy.id, [foe.id], { x: 2, y: 20 })).toBe(true)
    const shots = game.tick(1 / 30)
    expect(shots[0]?.aimZ).toBeGreaterThan(foe.pos.z + 1)
  })

  it('fires two artillery rounds before the reload', () => {
    const { game, human, enemy } = battle()
    const gun = game.spawn(human, UnitTypeId.Artillery, { x: 2, y: 2 }, 0)
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 2, y: 8 }, 0)
    foe.health = 1000
    expect(game.tick(1 / 30)).toHaveLength(1)
    expect(gun.rounds).toBe(1)
    expect(game.tick(0.35)).toEqual([])
    expect(gun.rounds).toBe(1)
    expect(game.tick(0.1)).toHaveLength(1)
    expect(gun.rounds).toBe(0)
    expect(game.tick(0.5)).toEqual([])
    foe.health = 0
    game.tick(6)
    expect(gun.rounds).toBe(2)
  })

  it('damages an owned unit only when ordered to attack it', () => {
    const { game, human } = battle()
    const shooter = game.spawn(human, UnitTypeId.Scout, { x: 4, y: 4 }, 0)
    const friend = game.spawn(human, UnitTypeId.Scout, { x: 4, y: 8 }, 0)
    const before = friend.health
    game.tick(1 / 30)
    expect(friend.health).toBe(before)
    expect(game.orderAttack(human.id, [shooter.id], shooter.id)).toBe(false)
    expect(game.orderAttack(human.id, [shooter.id], friend.id)).toBe(true)
    expect(shooter.attackId).toBe(friend.id)
    game.tick(1 / 30)
    expect(friend.health).toBe(before - 5)
    expect(shooter.attackId).toBe(friend.id)
  })

  it('closes on an attack order and locks the turret inside commit range', () => {
    const { game, human, enemy } = battle()
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: 2, y: 2 }, 0)
    const far = game.spawn(enemy, UnitTypeId.Scout, { x: 2, y: 20 }, 0)
    expect(game.orderAttack(human.id, [tank.id], far.id)).toBe(true)
    expect(tank.attackId).toBe(far.id)
    expect(tank.path.length).toBeGreaterThan(0)
    expect(game.orderAttack(enemy.id, [tank.id], far.id)).toBe(false)

    const close = new Game(new World(24, 24))
    const owner = close.addPlayer()
    const other = close.addPlayer()
    const holder = close.spawn(owner, UnitTypeId.MedTank, { x: 4, y: 4 }, 0)
    const prey = close.spawn(other, UnitTypeId.Scout, { x: 4, y: 9 }, 0)
    expect(close.orderAttack(owner.id, [holder.id], prey.id)).toBe(true)
    expect(holder.path).toEqual([])
    expect(holder.attackId).toBe(prey.id)
    close.orderMove(owner.id, [holder.id], { x: 8, y: 4 })
    expect(holder.attackId).toBeNull()
  })

  it('aims the ordered target inside 1.5 range and ignores it beyond that', () => {
    const near = new Game(new World(24, 24))
    const owner = near.addPlayer()
    const other = near.addPlayer()
    const tank = near.spawn(owner, UnitTypeId.MedTank, { x: 10, y: 10 }, 0)
    near.spawn(other, UnitTypeId.Scout, { x: 10, y: 14 }, 0)
    const ordered = near.spawn(other, UnitTypeId.Scout, { x: 16, y: 10 }, 0)
    expect(near.orderAttack(owner.id, [tank.id], ordered.id)).toBe(true)
    near.tick(0.25)
    expect(tank.turretYaw).toBeGreaterThan(0.4)

    const wide = new Game(new World(40, 16))
    const human = wide.addPlayer()
    const enemy = wide.addPlayer()
    const chaser = wide.spawn(human, UnitTypeId.MedTank, { x: 4, y: 4 }, 0)
    wide.spawn(enemy, UnitTypeId.Scout, { x: 4, y: 8 }, 0)
    const distant = wide.spawn(enemy, UnitTypeId.Scout, { x: 24, y: 4 }, 0)
    expect(wide.orderAttack(human.id, [chaser.id], distant.id)).toBe(true)
    wide.tick(0.25)
    expect(Math.abs(chaser.turretYaw)).toBeLessThan(0.35)
    expect(chaser.path.length).toBeGreaterThan(0)
    distant.health = 0
    wide.tick(1 / 30)
    expect(chaser.attackId).toBeNull()
  })

  it('fires artillery at a distant enemy only while a friendly unit can see them', () => {
    const { game, human, enemy } = battle()
    const gun = game.spawn(human, UnitTypeId.Artillery, { x: 2, y: 2 }, 0)
    game.spawn(enemy, UnitTypeId.Scout, { x: 2, y: 16 }, 0)
    expect(game.tick(1 / 30)).toEqual([])
    expect(gun.rounds).toBe(2)
    game.spawn(human, UnitTypeId.Scout, { x: 2, y: 10 }, 0)
    const shots = game.tick(1 / 30)
    expect(shots.some((shot) => shot.shooterId === gun.id)).toBe(true)
  })

  it('deals less splash damage farther from the impact', () => {
    const { game, human, enemy } = battle()
    game.spawn(human, UnitTypeId.MedTank, { x: 2, y: 2 }, 0)
    const direct = game.spawn(enemy, UnitTypeId.Scout, { x: 2, y: 7 }, 0)
    const nearby = game.spawn(enemy, UnitTypeId.Scout, { x: 3, y: 7 }, 0)
    const before = direct.health
    const shots = game.tick(1 / 30)
    const flight = shots[0].flight
    game.tick(flight - 1 / 30 - 0.02)
    expect(direct.health).toBe(before)
    game.tick(0.06)
    expect(direct.health).toBeLessThan(before)
    expect(direct.health).toBeGreaterThanOrEqual(before - 34)
    expect(nearby.health).toBeLessThan(before)
    expect(nearby.health).toBeGreaterThan(direct.health)
  })

  it('keeps an air shot off the ground under the aircraft', () => {
    const width = 24
    const height = 24
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    tiles[6 * width + 2] = Terrain.Tree
    const game = new Game(World.fromTiles(width, height, tiles))
    const human = game.addPlayer()
    const enemy = game.addPlayer()
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: 2, y: 2 }, 0)
    const jet = game.spawn(enemy, UnitTypeId.Jet, { x: 2, y: 6 }, 0)
    const scout = game.spawn(enemy, UnitTypeId.Scout, { x: 2, y: 6 }, 0)
    jet.flight = Flight.Cruise
    jet.altitude = 2.6
    const jetHealth = jet.health
    const scoutHealth = scout.health
    const shots = game.tick(1 / 30)
    expect(shots.some((shot) => shot.shooterId === tank.id)).toBe(true)
    const flight = shots.find((shot) => shot.shooterId === tank.id)?.flight ?? 0
    game.tick(flight)
    expect(jet.health).toBeLessThan(jetHealth)
    expect(scout.health).toBe(scoutHealth)
    expect(game.world.terrainAt(2, 6)).toBe(Terrain.Tree)
  })

  it('attacks a ground tile and keeps firing there', () => {
    const { game, human } = battle()
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: 2, y: 2 }, 0)
    expect(game.orderAttackGround(human.id, [tank.id], { x: 2, y: 18 })).toBe(true)
    expect(tank.attackPoint).toEqual({ x: 2.5, z: 18.5 })
    expect(tank.path.length).toBeGreaterThan(0)
    const close = game.spawn(human, UnitTypeId.Artillery, { x: 8, y: 8 }, 0)
    expect(game.orderAttackGround(human.id, [close.id], { x: 8, y: 12 })).toBe(true)
    expect(close.path).toEqual([])
    const shots = game.tick(1 / 30)
    expect(shots.some((shot) => shot.shooterId === close.id)).toBe(true)
    expect(close.attackPoint).toEqual({ x: 8.5, z: 12.5 })
    expect(game.orderMove(human.id, [close.id], { x: 9, y: 8 })).toBe(true)
    expect(close.attackPoint).toBeNull()
  })

  it('fells a tree with a shell and leaves it standing under bullets', () => {
    const width = 24
    const height = 24
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    tiles[10 * width + 10] = Terrain.Tree
    const game = new Game(World.fromTiles(width, height, tiles))
    const human = game.addPlayer()
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: 10, y: 8 }, 0)
    expect(game.orderAttackGround(human.id, [tank.id], { x: 10, y: 10 })).toBe(true)
    const shots = game.tick(0.4)
    expect(shots.some((shot) => shot.shooterId === tank.id)).toBe(true)
    const flight = shots.find((shot) => shot.shooterId === tank.id)?.flight ?? 0
    expect(game.world.terrainAt(10, 10)).toBe(Terrain.Tree)
    game.tick(flight)
    const felled = game.world.terrainAt(10, 10)
    expect(felled === Terrain.Land || scarStrength(felled) > 0).toBe(true)
    expect(game.clearedTiles()).toEqual([{ x: 10, y: 10 }])
    expect(game.pathfinder.isWalkable(10, 10, -1)).toBe(true)

    const bullets = new Game(World.fromTiles(width, height, tiles))
    const owner = bullets.addPlayer()
    const scout = bullets.spawn(owner, UnitTypeId.Scout, { x: 10, y: 8 }, 0)
    expect(bullets.orderAttackGround(owner.id, [scout.id], { x: 10, y: 10 })).toBe(true)
    bullets.tick(1)
    expect(bullets.world.terrainAt(10, 10)).toBe(Terrain.Tree)
    expect(bullets.world.terrainAt(10, 9)).toBe(Terrain.Land)
  })

  it('scars open ground and deepens it as more shells land', () => {
    const width = 24
    const height = 24
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    tiles[10 * width + 10] = Terrain.Flowers
    tiles[11 * width + 10] = Terrain.Forest
    tiles[10 * width + 11] = Terrain.Water
    tiles[10 * width + 9] = Terrain.Road
    const game = new Game(World.fromTiles(width, height, tiles))
    const human = game.addPlayer()
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: 10, y: 8 }, 0)
    expect(game.orderAttackGround(human.id, [tank.id], { x: 10, y: 10 })).toBe(true)
    let guard = 0
    while (scarStrength(game.world.terrainAt(10, 10)) < 1 && guard < 40) {
      landShell(game, tank.id)
      guard += 1
    }
    expect(scarStrength(game.world.terrainAt(10, 10))).toBeGreaterThan(0)
    expect(game.world.terrainAt(11, 10)).toBe(Terrain.Water)
    expect(game.world.terrainAt(9, 10)).toBe(Terrain.Road)
    expect(game.world.terrainAt(10, 14)).toBe(Terrain.Land)
    expect(game.pathfinder.isWalkable(10, 10, tank.id)).toBe(true)
    expect(scarGain(7)).toBe(0)
    expect(scarGain(34)).toBe(1)
    expect(scarGain(140)).toBe(2)
    expect(scarStrength(scarTerrain(3))).toBe(3)
    expect(scarStrength(Terrain.Land)).toBe(0)
  })

  it('leaves the strongest scar on a destroyed building', () => {
    const width = 16
    const height = 16
    const game = new Game(World.fromTiles(width, height, new Uint8Array(width * height).fill(Terrain.Land)))
    const human = game.addPlayer()
    const factory = game.spawn(human, UnitTypeId.Factory, { x: 4, y: 4 }, 0)
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: 8, y: 8 }, 0)
    factory.health = 0
    tank.health = 0
    game.tick(0.1)
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) expect(scarStrength(game.world.terrainAt(4 + dx, 4 + dy))).toBe(3)
    }
    expect(game.world.terrainAt(8, 8)).toBe(Terrain.Land)
    game.tick(SCAR_FADE)
    expect(scarStrength(game.world.terrainAt(4, 4))).toBe(2)
    game.tick(SCAR_FADE)
    expect(scarStrength(game.world.terrainAt(4, 4))).toBe(1)
    game.tick(SCAR_FADE)
    expect(game.world.terrainAt(4, 4)).toBe(Terrain.Land)
    expect(scarStrength(game.world.terrainAt(5, 5))).toBe(0)
  })

  it('destroys a city building under shellfire and drops it from the population', () => {
    const width = 20
    const height = 20
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    const game = new Game(World.fromTiles(width, height, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 8, y: 8 }], seed: 11 }
    game.bindCities()
    const human = game.addPlayer()
    game.claimCity({ x: 8, y: 8 }, human.id)
    const layout = layoutCities(game.scenery.towns, game.scenery.seed, tiles, width, height)[0]
    const building = layout.buildings.find((block) => !block.keep)
    expect(building).toBeDefined()
    if (!building) return
    const hall = layout.buildings.find((block) => block.keep)
    const street = layout.streets.find(
      (road) => road.kind < 6 && Math.abs(road.x - building.x) + Math.abs(road.y - building.y) === 1,
    )
    expect(street).toBeDefined()
    if (!street) return
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: street.x, y: street.y }, 0)
    expect(game.orderAttackGround(human.id, [tank.id], { x: building.x, y: building.y })).toBe(true)
    let guard = 0
    while (!game.cityStates()[0].ruins.some((ruin) => ruin.x === building.x && ruin.y === building.y) && guard < 40) {
      game.tick(0.5)
      guard += 1
    }
    const state = game.cityStates()[0]
    expect(state.ruins).toContainEqual({ x: building.x, y: building.y })
    const full = projectCity(layout, state.grown, tiles, width, height)
    const fallen = state.ruins.filter((ruin) => full.buildings.some((block) => block.x === ruin.x && block.y === ruin.y))
    for (const street of lostStreets(full, fallen)) expect(state.ruins).toContainEqual(street)
    expect(game.pathfinder.isWalkable(building.x, building.y, tank.id)).toBe(true)
    expect(scarStrength(game.world.terrainAt(building.x, building.y))).toBe(3)
    const people = populationOf(full, state.ruins)
    expect(people).toBeLessThan(populationOf(full))
    expect(game.creditIncome(human.id)).toBe(CREDIT_PER_POPULATION * people)
    if (hall) expect(state.ruins).not.toContainEqual({ x: hall.x, y: hall.y })
  })

  it('destroys a building when the shell lands on the street beside it', () => {
    const width = 20
    const height = 20
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    const game = new Game(World.fromTiles(width, height, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 8, y: 8 }], seed: 11 }
    game.bindCities()
    const human = game.addPlayer()
    game.claimCity({ x: 8, y: 8 }, human.id)
    const layout = layoutCities(game.scenery.towns, game.scenery.seed, tiles, width, height)[0]
    const building = layout.buildings.find((block) => !block.keep)
    expect(building).toBeDefined()
    if (!building) return
    const street = layout.streets.find(
      (road) => road.kind < 6 && Math.abs(road.x - building.x) + Math.abs(road.y - building.y) === 1,
    )
    expect(street).toBeDefined()
    if (!street) return
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: street.x, y: street.y }, 0)
    expect(game.orderAttackGround(human.id, [tank.id], { x: street.x, y: street.y })).toBe(true)
    let guard = 0
    while (!game.cityStates()[0].ruins.some((ruin) => ruin.x === building.x && ruin.y === building.y) && guard < 24) {
      game.tick(0.5)
      guard += 1
    }
    expect(game.cityStates()[0].ruins).toContainEqual({ x: building.x, y: building.y })
  })

  it('shoots an enemy city on its own and turns the city neutral when only the hall remains', () => {
    const width = 20
    const height = 20
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    const game = new Game(World.fromTiles(width, height, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 8, y: 8 }], seed: 11 }
    game.bindCities()
    const human = game.addPlayer()
    const enemy = game.addPlayer()
    game.claimCity({ x: 8, y: 8 }, enemy.id)
    const layout = layoutCities(game.scenery.towns, game.scenery.seed, tiles, width, height)[0]
    const hall = layout.buildings.find((block) => block.keep)
    const block = layout.buildings.find((building) => !building.keep)
    expect(hall).toBeDefined()
    expect(block).toBeDefined()
    if (!hall || !block) return
    const stand = standOff(layout, block, width)
    expect(stand).not.toBeNull()
    if (!stand) return
    const tank = game.spawn(human, UnitTypeId.MedTank, stand, 0)
    let guard = 0
    while (!game.cityStates()[0].ruins.some((ruin) => ruin.x === block.x && ruin.y === block.y) && guard < 40) {
      game.tick(0.5)
      guard += 1
    }
    expect(game.cityStates()[0].ruins).toContainEqual({ x: block.x, y: block.y })
    expect(game.cityStates()[0].ruins).not.toContainEqual({ x: hall.x, y: hall.y })
    guard = 0
    while (guard < 80) {
      const standing = game.cityLayouts()[0].buildings.find(
        (building) => !building.keep && !game.cityStates()[0].ruins.some((ruin) => ruin.x === building.x && ruin.y === building.y),
      )
      if (!standing) break
      expect(game.orderAttackGround(human.id, [tank.id], { x: standing.x, y: standing.y })).toBe(true)
      let shots = 0
      while (!game.cityStates()[0].ruins.some((ruin) => ruin.x === standing.x && ruin.y === standing.y) && shots < 40) {
        game.tick(0.5)
        shots += 1
      }
      guard += 1
    }
    expect(game.cityStates()[0].ownerId).toBe(0)
    expect(game.orderAttackGround(human.id, [tank.id], { x: hall.x, y: hall.y })).toBe(true)
    for (let i = 0; i < 20; i++) game.tick(0.5)
    expect(game.cityStates()[0].ruins).not.toContainEqual({ x: hall.x, y: hall.y })
    expect(game.pathfinder.isWalkable(hall.x, hall.y, tank.id)).toBe(false)
  })

  it('does not shell a neutral city, even when ordered to', () => {
    const width = 20
    const height = 20
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    const game = new Game(World.fromTiles(width, height, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 8, y: 8 }], seed: 11 }
    game.bindCities()
    const human = game.addPlayer()
    const layout = layoutCities(game.scenery.towns, game.scenery.seed, tiles, width, height)[0]
    const block = layout.buildings.find((building) => !building.keep)
    expect(block).toBeDefined()
    if (!block) return
    const stand = standOff(layout, block, width)
    expect(stand).not.toBeNull()
    if (!stand) return
    const tank = game.spawn(human, UnitTypeId.MedTank, stand, 0)
    for (let i = 0; i < 16; i++) game.tick(0.5)
    expect(game.cityStates()[0].ruins).not.toContainEqual({ x: block.x, y: block.y })
    expect(game.orderAttackGround(human.id, [tank.id], { x: block.x, y: block.y })).toBe(true)
    for (let i = 0; i < 16; i++) game.tick(0.5)
    expect(game.cityStates()[0].ownerId).toBe(0)
    expect(game.cityStates()[0].ruins).not.toContainEqual({ x: block.x, y: block.y })
  })

  it('destroys a shelled street', () => {
    const width = 20
    const height = 20
    const tiles = new Uint8Array(width * height).fill(Terrain.Land)
    const game = new Game(World.fromTiles(width, height, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 8, y: 8 }], seed: 7 }
    game.bindCities()
    const human = game.addPlayer()
    const layout = layoutCities(game.scenery.towns, game.scenery.seed, tiles, width, height)[0]
    const roads = layout.streets.filter((street) => street.kind < StreetKind.Lamp)
    const street = roads[0]
    const stand = roads.find((road) => road.x !== street.x || road.y !== street.y) ?? street
    const tank = game.spawn(human, UnitTypeId.MedTank, { x: stand.x, y: stand.y }, 0)
    expect(game.orderAttackGround(human.id, [tank.id], { x: street.x, y: street.y })).toBe(true)
    const captureTicks = Math.ceil(captureDuration(populationOf(layout)) / MED_TANK.supply / 0.5)
    let guard = 0
    while (!game.cityStates()[0].ruins.some((ruin) => ruin.x === street.x && ruin.y === street.y) && guard < captureTicks + 40) {
      game.tick(0.5)
      guard += 1
    }
    const state = game.cityStates()[0]
    expect(state.ruins).toContainEqual({ x: street.x, y: street.y })
    const full = projectCity(layout, state.grown, tiles, width, height)
    const settled = settledCity(full, state.ruins)
    expect(settled.streets.some((road) => road.kind < StreetKind.Lamp && road.x === street.x && road.y === street.y)).toBe(false)
  })
})

function landShell(game: Game, shooterId: number) {
  const shots = game.tick(2)
  const flight = shots.find((shot) => shot.shooterId === shooterId)?.flight ?? 0
  if (flight > 0) game.tick(flight)
}
