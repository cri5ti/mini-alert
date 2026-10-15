import { describe, expect, it } from 'vitest'
import { AiPlayer } from './player.ts'
import { consider, Scenario } from './scenarios.ts'
import { Game } from '../server/game.ts'
import { ServerHost } from '../server/host.ts'
import { ClientMessageKind } from '../shared/protocol.ts'
import { FACTORY, SCOUT, UnitTypeId } from '../shared/unit-types.ts'
import { CREDIT_PER_POPULATION } from '../server/player.ts'
import type { TileCoord } from '../shared/tiles.ts'
import { World } from '../server/world.ts'

function tank(
  id: number,
  tileX: number,
  tileY: number,
  typeId = UnitTypeId.MedTank,
  ownerId = 1,
  goal: TileCoord | null = null,
) {
  return {
    id,
    typeId,
    ownerId,
    color: ownerId,
    x: tileX + 0.5,
    z: tileY + 0.5,
    facing: 0,
    turretYaw: 0,
    speed: 0,
    health: 999,
    tileX,
    tileY,
    path: [] as TileCoord[],
    goal,
    attackId: null,
    attackPoint: null,
    progress: 1,
  }
}

function structure(id: number, typeId: UnitTypeId, tileX: number, tileY: number) {
  return tank(id, tileX, tileY, typeId)
}

function openBrain(units: ReturnType<typeof tank>[], owned = false) {
  const layout = {
    x: 4,
    y: 4,
    span: 2,
    seed: 1,
    tiles: [{ x: 4, y: 4 }],
    buildings: [{ x: 5, y: 5, model: 0, yaw: 0, keep: true }],
    streets: [{ x: 4, y: 4, kind: 0, yaw: 0, ox: 0, oz: 0 }],
  }
  return {
    playerId: 1,
    width: 48,
    height: 48,
    seed: 1,
    credits: 0,
    towns: [],
    training: [],
    cities: owned ? [{ ownerId: 1, color: 1, progress: 0, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] }] : [],
    terrain: new Array(48 * 48).fill(0),
    known: new Array(48 * 48).fill(1),
    layouts: owned ? [layout] : [],
    units,
  }
}

function stockedBrain(units: ReturnType<typeof tank>[]) {
  const buildings = Array.from({ length: 48 }, (_, index) => ({
    x: 10 + (index % 6),
    y: 10 + Math.floor(index / 6),
    model: 0,
    yaw: 0,
    keep: true,
  }))
  return {
    playerId: 1,
    width: 64,
    height: 64,
    seed: 1,
    credits: 20000,
    towns: [],
    training: [],
    cities: [{ ownerId: 1, color: 1, progress: 0, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] }],
    terrain: new Array(64 * 64).fill(0),
    known: new Array(64 * 64).fill(1),
    layouts: [{
      x: 8,
      y: 8,
      span: 4,
      seed: 3,
      tiles: [{ x: 8, y: 8 }],
      buildings,
      streets: [{ x: 8, y: 8, kind: 0, yaw: 0, ox: 0, oz: 0 }],
    }],
    units,
  }
}

function boot(game: Game, aiId: number) {
  const host = new ServerHost(game)
  const player = game.player(aiId)
  if (!player) throw new Error('missing player')
  const port = host.join(player)
  const bot = new AiPlayer(port)
  host.addAi(bot)
  host.sync(aiId)
  return bot
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

describe('ai', () => {
  it('fights the contact in front of it and leaves the other flank alone', () => {
    const game = new Game(new World(48, 48))
    const human = game.addPlayer()
    const ai = game.addPlayer()
    const foe = game.spawn(human, UnitTypeId.MedTank, { x: 12, y: 4 })
    const near = game.spawn(ai, UnitTypeId.MedTank, { x: 4, y: 4 })
    const far = game.spawn(ai, UnitTypeId.MedTank, { x: 40, y: 40 })
    const bot = boot(game, ai.id)

    bot.update(0.4)
    expect(near.attackId).toBeNull()
    bot.setPace(1)
    bot.update(2)

    expect(near.attackId).toBe(foe.id)
    expect(far.attackId).toBeNull()
    expect(far.path).toEqual([])
  })

  it('places a factory through the build command when it has a city and no workshop', () => {
    const game = new Game(new World(24, 24))
    const ai = game.addPlayer()
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 10.5, y: 8.5 }], seed: 4 }
    game.bindCities()
    game.claimCity({ x: 10.5, y: 8.5 }, ai.id)
    padPop(game, ai.id, FACTORY.supply)
    const bot = boot(game, ai.id)

    bot.update(2)

    const workshop = game.units.find((unit) => unit.ownerId === ai.id && unit.typeId === UnitTypeId.Factory)
    expect(workshop).toBeDefined()
    expect(workshop?.progress).toBe(0)
  })

  it('trains a scout once its factory stands finished', () => {
    const game = new Game(new World(24, 24))
    const ai = game.addPlayer()
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 10.5, y: 8.5 }], seed: 4 }
    game.bindCities()
    game.claimCity({ x: 10.5, y: 8.5 }, ai.id)
    padPop(game, ai.id, FACTORY.supply + SCOUT.supply)
    game.spawn(ai, UnitTypeId.Factory, { x: 2, y: 18 })
    const bot = boot(game, ai.id)

    bot.update(2)

    expect(game.trainingFor(ai.id).map((job) => job.typeId)).toEqual([UnitTypeId.Scout])
  })

  it('garrisons or explores when population blocks the factory', () => {
    const game = new Game(new World(24, 24))
    const ai = game.addPlayer()
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 10.5, y: 8.5 }], seed: 4 }
    game.bindCities()
    game.claimCity({ x: 10.5, y: 8.5 }, ai.id)
    const people = game.creditIncome(ai.id) / CREDIT_PER_POPULATION
    const tiles = openNear(game, { x: 10, y: 8 })
    let spawned = 0
    while ((spawned * SCOUT.supply + FACTORY.supply <= people || spawned === 0) && spawned < tiles.length) {
      game.spawn(ai, UnitTypeId.Scout, tiles[spawned])
      spawned += 1
    }
    expect(spawned * SCOUT.supply + FACTORY.supply).toBeGreaterThan(people)
    const bot = boot(game, ai.id)

    bot.update(2)

    expect(game.units.some((unit) => unit.ownerId === ai.id && unit.typeId === UnitTypeId.Factory)).toBe(false)
    const thought = bot.lastThought
    expect(thought?.candidates.some((candidate) => candidate.scenario === Scenario.Build && candidate.blocked === 'pop')).toBe(true)
    expect(thought?.candidates.some((candidate) => candidate.blocked === '' && candidate.scenario === Scenario.Scout)).toBe(true)
  })

  it('queues a scout from a finished factory', () => {
    const layout = {
      x: 10,
      y: 10,
      span: 3,
      seed: 1,
      tiles: [{ x: 10, y: 10 }],
      buildings: [0, 1, 2, 3, 4, 5].map((index) => ({ x: 11 + index, y: 11, model: 0, yaw: 0, keep: true })),
      streets: [{ x: 10, y: 10, kind: 0, yaw: 0, ox: 0, oz: 0 }],
    }
    const thought = consider(
      {
        playerId: 1,
        width: 32,
        height: 32,
        seed: 1,
        credits: 8000,
        towns: [],
        training: [],
        cities: [{ ownerId: 1, color: 1, progress: 0, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] }],
        terrain: new Array(32 * 32).fill(0),
        layouts: [layout],
        units: [
          { id: 1, typeId: UnitTypeId.Scout, ownerId: 1, color: 1, x: 10.5, z: 10.5, facing: 0, turretYaw: 0, speed: 0, health: 60, tileX: 10, tileY: 10, path: [], goal: null, attackId: null, attackPoint: null, progress: 1 },
          { id: 2, typeId: UnitTypeId.Factory, ownerId: 1, color: 1, x: 14, z: 14, facing: 0, turretYaw: 0, speed: 0, health: 480, tileX: 14, tileY: 14, path: [], goal: null, attackId: null, attackPoint: null, progress: 1 },
        ],
      },
      2,
    )
    expect(thought.orders).toContainEqual({ kind: ClientMessageKind.Spawn, typeId: UnitTypeId.Scout, yardId: 2 })
  })

  it('orders the next idle unit while one is already marching on a city', () => {
    const layout = {
      x: 20,
      y: 20,
      span: 2,
      seed: 1,
      tiles: [{ x: 20, y: 20 }],
      buildings: [],
      streets: [{ x: 20, y: 20, kind: 0, yaw: 0, ox: 0, oz: 0 }],
    }
    const tank = (id: number, tileX: number, goal: TileCoord | null) => ({
      id,
      typeId: UnitTypeId.MedTank,
      ownerId: 1,
      color: 1,
      x: tileX + 0.5,
      z: 4.5,
      facing: 0,
      turretYaw: 0,
      speed: 0,
      health: 100,
      tileX,
      tileY: 4,
      path: [],
      goal,
      attackId: null,
      attackPoint: null,
      progress: 1,
    })
    const thought = consider(
      {
        playerId: 1,
        width: 32,
        height: 32,
        seed: 1,
        credits: 0,
        towns: [],
        training: [],
        cities: [{ ownerId: 2, color: 2, progress: 0, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] }],
        terrain: new Array(32 * 32).fill(0),
        known: new Array(32 * 32).fill(1),
        layouts: [layout],
        units: [tank(1, 4, { x: 20, y: 20 }), tank(2, 5, null), tank(3, 6, null)],
      },
      1,
    )
    expect(thought.orders).toEqual([{ kind: ClientMessageKind.OrderMove, unitIds: [2], tile: { x: 20, y: 20 } }])
  })

  it('keeps a tank on its target and sends the next one', () => {
    const tank = (id: number, tileX: number, attackId: number | null, ownerId = 1) => ({
      id,
      typeId: UnitTypeId.MedTank,
      ownerId,
      color: ownerId,
      x: tileX + 0.5,
      z: ownerId === 1 ? 0.5 : 30.5,
      facing: 0,
      turretYaw: 0,
      speed: 0,
      health: 100,
      tileX,
      tileY: ownerId === 1 ? 0 : 30,
      path: [],
      goal: null,
      attackId,
      attackPoint: null,
      progress: 1,
    })
    const thought = consider(
      {
        playerId: 1,
        width: 32,
        height: 32,
        seed: 1,
        credits: 0,
        towns: [],
        training: [],
        cities: [],
        terrain: new Array(32 * 32).fill(0),
        layouts: [],
        units: [tank(1, 0, 9), tank(2, 1, null), tank(3, 2, null), tank(9, 30, null, 2)],
      },
      1,
    )
    expect(thought.orders).toEqual([{ kind: ClientMessageKind.OrderAttack, unitIds: [2], targetId: 9 }])
  })

  it('steps a scout onto unknown ground', () => {
    const known = new Array(8 * 8).fill(0)
    known[0] = 1
    known[1] = 1
    const thought = consider(
      {
        playerId: 1,
        width: 8,
        height: 8,
        seed: 1,
        credits: 0,
        towns: [],
        training: [],
        cities: [],
        terrain: new Array(8 * 8).fill(0),
        known,
        layouts: [],
        units: [{
          id: 1,
          typeId: UnitTypeId.Scout,
          ownerId: 1,
          color: 1,
          x: 0.5,
          z: 0.5,
          facing: 0,
          turretYaw: 0,
          speed: 0,
          health: 60,
          tileX: 0,
          tileY: 0,
          path: [],
          goal: { x: 1, y: 0 },
          attackId: null,
          attackPoint: null,
          progress: 1,
        }],
      },
      1,
    )
    expect(thought.orders).toEqual([{ kind: ClientMessageKind.OrderMove, unitIds: [1], tile: { x: 1, y: 1 } }])
  })

  it('refuses a fight its group would lose', () => {
    const thought = consider(openBrain([
      tank(1, 4, 4),
      tank(2, 5, 4),
      tank(3, 6, 4),
      tank(10, 30, 4, UnitTypeId.HeavyTank, 2),
      tank(11, 31, 4, UnitTypeId.HeavyTank, 2),
      tank(12, 32, 4, UnitTypeId.HeavyTank, 2),
      tank(13, 33, 4, UnitTypeId.HeavyTank, 2),
    ]), 8)
    expect(thought.orders.some((order) => order.kind === ClientMessageKind.OrderAttack)).toBe(false)
    expect(thought.candidates.some((candidate) => candidate.blocked === 'outmatched')).toBe(true)
  })

  it('groups a scattered army before sending it', () => {
    const thought = consider(openBrain([
      tank(1, 0, 0),
      tank(2, 20, 0),
      tank(3, 0, 20),
      tank(4, 20, 20),
      tank(9, 40, 40, UnitTypeId.Scout, 2),
    ]), 8)
    expect(thought.orders.every((order) => order.kind === ClientMessageKind.OrderMove)).toBe(true)
    expect(thought.orders).toHaveLength(4)
    expect(thought.candidates.some((candidate) => candidate.scenario === Scenario.Muster)).toBe(true)
  })

  it('names a heavy force that is closing on home', () => {
    const thought = consider(openBrain([
      tank(1, 40, 40),
      tank(2, 41, 40),
      tank(3, 42, 40),
      tank(10, 20, 20, UnitTypeId.HeavyTank, 2, { x: 4, y: 4 }),
      tank(11, 21, 20, UnitTypeId.HeavyTank, 2, { x: 4, y: 4 }),
      tank(12, 22, 20, UnitTypeId.HeavyTank, 2, { x: 5, y: 4 }),
      tank(13, 23, 20, UnitTypeId.HeavyTank, 2, { x: 5, y: 4 }),
    ], true), 8)
    expect(thought.candidates.some((candidate) => candidate.blocked.includes('closing') && candidate.blocked.includes('heavy'))).toBe(true)
    expect(thought.orders.some((order) => order.kind === ClientMessageKind.OrderAttack)).toBe(false)
  })

  it('places a turret once a few tanks exist', () => {
    const thought = consider(stockedBrain([
      tank(1, 2, 2),
      tank(2, 3, 2),
      tank(3, 4, 2),
      tank(4, 5, 2),
      structure(20, UnitTypeId.Factory, 16, 16),
    ]), 4)
    expect(thought.orders).toContainEqual(expect.objectContaining({ kind: ClientMessageKind.PlaceBuilding, typeId: UnitTypeId.Turret }))
  })

  it('trains a gunship from a finished helipad after the land core is ready', () => {
    const thought = consider(stockedBrain([
      tank(1, 2, 2, UnitTypeId.Scout),
      tank(2, 3, 2, UnitTypeId.Scout),
      tank(3, 4, 2),
      tank(4, 5, 2),
      tank(5, 6, 2),
      tank(6, 7, 2),
      tank(7, 2, 4, UnitTypeId.HeavyTank),
      tank(8, 3, 4, UnitTypeId.HeavyTank),
      tank(9, 4, 4, UnitTypeId.Artillery),
      structure(20, UnitTypeId.Factory, 16, 16),
      structure(21, UnitTypeId.Turret, 18, 16),
      structure(22, UnitTypeId.Helipad, 14, 16),
    ]), 4)
    expect(thought.orders).toContainEqual({ kind: ClientMessageKind.Spawn, typeId: UnitTypeId.Gunship, yardId: 22 })
  })

  it('does not park a scout in a city so the city will grow', () => {
    const home = {
      x: 4,
      y: 4,
      span: 3,
      seed: 2,
      tiles: [{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 5 }],
      buildings: [] as { x: number; y: number; model: number; yaw: number; keep: boolean }[],
      streets: [
        { x: 4, y: 4, kind: 0, yaw: 0, ox: 0, oz: 0 },
        { x: 5, y: 4, kind: 0, yaw: 0, ox: 0, oz: 0 },
        { x: 4, y: 5, kind: 0, yaw: 0, ox: 0, oz: 0 },
      ],
    }
    const other = {
      x: 20,
      y: 20,
      span: 2,
      seed: 9,
      tiles: [{ x: 20, y: 20 }],
      buildings: [{ x: 21, y: 21, model: 0, yaw: 0, keep: true }],
      streets: [{ x: 20, y: 20, kind: 0, yaw: 0, ox: 0, oz: 0 }],
    }
    const brain = {
      playerId: 1,
      width: 32,
      height: 32,
      seed: 1,
      credits: 0,
      towns: [],
      training: [],
      cities: [
        { ownerId: 1, color: 1, progress: 0, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] },
        { ownerId: 0, color: 0, progress: 0, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] },
      ],
      terrain: new Array(32 * 32).fill(0),
      known: new Array(32 * 32).fill(1),
      layouts: [home, other],
      units: [tank(1, 4, 4, UnitTypeId.Scout)],
    }
    const fresh = consider({ ...brain, mood: { now: 4, pop: 0, popAt: 4, plan: 0, atX: -1, atY: -1, planAt: 4, salt: 1, banX: -1, banY: -1, near: 1e9 } }, 4)
    const stale = consider({ ...brain, mood: { now: 40, pop: 0, popAt: 0, plan: 0, atX: -1, atY: -1, planAt: 0, salt: 1, banX: -1, banY: -1, near: 1e9 } }, 4)
    expect(fresh.candidates.some((candidate) => candidate.scenario === Scenario.Garrison)).toBe(false)
    expect(stale.candidates.some((candidate) => candidate.scenario === Scenario.Garrison)).toBe(false)
  })

  it('keeps exploring with the army until another player is seen', () => {
    const known = new Array(16 * 16).fill(1)
    for (let y = 0; y < 16; y++) known[y * 16 + 15] = 0
    const thought = consider(
      {
        playerId: 1,
        width: 16,
        height: 16,
        seed: 1,
        credits: 0,
        towns: [],
        training: [],
        cities: [],
        terrain: new Array(16 * 16).fill(0),
        known,
        layouts: [],
        units: [tank(1, 2, 2), tank(2, 3, 2), tank(3, 4, 2)],
      },
      8,
    )
    expect(thought.candidates.some((candidate) => candidate.scenario === Scenario.Scout && candidate.blocked === '')).toBe(true)
    expect(thought.orders.some((order) => order.kind === ClientMessageKind.OrderMove)).toBe(true)
  })

  it('explores the fog before marching on a neutral city', () => {
    const known = new Array(16 * 16).fill(0)
    for (let x = 0; x < 16; x++) known[x] = 1
    const thought = consider(
      {
        playerId: 1,
        width: 16,
        height: 16,
        seed: 1,
        credits: 0,
        towns: [],
        training: [],
        cities: [{ ownerId: 0, color: 0, progress: 0, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] }],
        terrain: new Array(16 * 16).fill(0),
        known,
        layouts: [{
          x: 8,
          y: 12,
          span: 1,
          seed: 1,
          tiles: [{ x: 8, y: 12 }],
          buildings: [],
          streets: [{ x: 8, y: 12, kind: 0, yaw: 0, ox: 0, oz: 0 }],
        }],
        units: [tank(1, 2, 0, UnitTypeId.Scout)],
      },
      4,
    )
    expect(thought.candidates.some((candidate) => candidate.scenario === Scenario.Scout && candidate.blocked === '')).toBe(true)
    expect(thought.orders.some((order) => order.kind === ClientMessageKind.OrderMove && order.tile.y === 12)).toBe(false)
  })

  it('steps around unknown water', () => {
    const known = new Array(8 * 8).fill(0)
    known[0] = 1
    known[1] = 1
    const terrain = new Array(8 * 8).fill(0)
    terrain[1 * 8 + 1] = 2
    const thought = consider(
      {
        playerId: 1,
        width: 8,
        height: 8,
        seed: 1,
        credits: 0,
        towns: [],
        training: [],
        cities: [],
        terrain,
        known,
        layouts: [],
        units: [tank(1, 0, 0, UnitTypeId.Scout, 1, { x: 1, y: 0 })],
      },
      1,
    )
    expect(thought.orders).toEqual([{ kind: ClientMessageKind.OrderMove, unitIds: [1], tile: { x: 2, y: 0 } }])
  })

  it('marches on a known enemy city ahead of a closer neutral', () => {
    const city = (x: number, y: number) => ({
      x,
      y,
      span: 1,
      seed: 1,
      tiles: [{ x, y }],
      buildings: [] as { x: number; y: number; model: number; yaw: number; keep: boolean }[],
      streets: [{ x, y, kind: 0, yaw: 0, ox: 0, oz: 0 }],
    })
    const state = (ownerId: number) => ({
      ownerId,
      color: ownerId,
      progress: 0,
      challengerId: 0,
      challengerColor: 0,
      grown: 0,
      ruins: [],
      sites: [],
    })
    const thought = consider(
      {
        playerId: 1,
        width: 48,
        height: 48,
        seed: 1,
        credits: 0,
        towns: [],
        training: [],
        cities: [state(0), state(2)],
        terrain: new Array(48 * 48).fill(0),
        known: new Array(48 * 48).fill(1),
        layouts: [city(8, 4), city(30, 4)],
        units: [tank(1, 4, 4), tank(2, 5, 4), tank(3, 6, 4)],
      },
      8,
    )
    expect(thought.orders.some((order) => order.kind === ClientMessageKind.OrderMove && order.tile.x === 30)).toBe(true)
    expect(thought.orders.some((order) => order.kind === ClientMessageKind.OrderMove && order.tile.x === 8)).toBe(false)
  })

  it('attacks with the gathered tanks while a stray unit is still out', () => {
    const thought = consider(openBrain([
      tank(1, 4, 4),
      tank(2, 5, 4),
      tank(3, 6, 4),
      tank(4, 4, 40),
      tank(9, 30, 4, UnitTypeId.MedTank, 2),
    ]), 8)
    expect(thought.orders.some((order) => order.kind === ClientMessageKind.OrderAttack)).toBe(true)
    expect(thought.candidates.some((candidate) => candidate.scenario === Scenario.Assault && candidate.blocked === '')).toBe(true)
  })

  it('drops a march that is not getting closer even while population changes', () => {
    const thought = consider(
      {
        playerId: 1,
        width: 48,
        height: 48,
        seed: 1,
        credits: 0,
        towns: [],
        training: [],
        cities: [{ ownerId: 2, color: 2, progress: 0, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] }],
        terrain: new Array(48 * 48).fill(0),
        known: new Array(48 * 48).fill(1),
        layouts: [{
          x: 20,
          y: 20,
          span: 1,
          seed: 1,
          tiles: [{ x: 20, y: 20 }],
          buildings: [],
          streets: [{ x: 20, y: 20, kind: 0, yaw: 0, ox: 0, oz: 0 }],
        }],
        units: [tank(1, 4, 4), tank(2, 5, 4), tank(3, 6, 4)],
        mood: {
          now: 40,
          pop: 5,
          popAt: 40,
          plan: Scenario.Capture,
          atX: 20,
          atY: 20,
          planAt: 0,
          salt: 1,
          banX: -1,
          banY: -1,
          near: 22,
        },
      },
      8,
    )
    expect(thought.candidates.some((candidate) => candidate.blocked === 'timeout')).toBe(true)
    expect(thought.orders.some((order) => order.kind === ClientMessageKind.OrderMove)).toBe(false)
    expect(thought.mood.banX).toBe(20)
    expect(thought.mood.banY).toBe(20)
  })

  it('waits longer between actions when the pace is turned down', () => {
    const game = new Game(new World(48, 48))
    const human = game.addPlayer()
    const ai = game.addPlayer()
    const foe = game.spawn(human, UnitTypeId.MedTank, { x: 12, y: 4 })
    const near = game.spawn(ai, UnitTypeId.MedTank, { x: 4, y: 4 })
    const bot = boot(game, ai.id)
    bot.setPace(0.25)

    bot.update(2)
    expect(near.attackId).toBeNull()
    bot.update(5)
    expect(near.attackId).toBe(foe.id)
  })
})

function openNear(game: Game, origin: TileCoord): TileCoord[] {
  const tiles: TileCoord[] = []
  for (let radius = 0; radius <= 8; radius++) {
    for (let y = origin.y - radius; y <= origin.y + radius; y++) {
      for (let x = origin.x - radius; x <= origin.x + radius; x++) {
        if (Math.max(Math.abs(x - origin.x), Math.abs(y - origin.y)) !== radius) continue
        if (!game.world.inBounds(x, y) || !game.pathfinder.isWalkable(x, y, -1)) continue
        tiles.push({ x, y })
      }
    }
  }
  return tiles
}
