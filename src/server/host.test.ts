import { describe, expect, it } from 'vitest'
import { Replica } from '../client/replica.ts'
import { canPlaceCityBuilding } from '../shared/cities.ts'
import { Flight } from '../shared/flight.ts'
import { KEEPALIVE_TICKS, SIM_STEP, stepMotion, wrapAngle, type MotionState } from '../shared/motion.ts'
import { ClientMessageKind, ServerEventKind, type ServerFrame, type UnitSnapshot } from '../shared/protocol.ts'
import { Terrain, scarStrength } from '../shared/tiles.ts'
import { JET, SCOUT, UnitTypeId } from '../shared/unit-types.ts'
import { Game } from './game.ts'
import { ServerHost } from './host.ts'
import { World } from './world.ts'

function events(frames: readonly ServerFrame[]) {
  return frames.flatMap((frame) => frame.events)
}

function explored(frames: readonly ServerFrame[]): Set<string> {
  const cells = new Set<string>()
  for (const event of events(frames)) {
    if (event.kind !== ServerEventKind.Snapshot && event.kind !== ServerEventKind.MapPatch) continue
    for (const cell of event.map.cells) cells.add(`${cell.x},${cell.y}`)
  }
  return cells
}

describe('host snapshots', () => {
  it('sends a capture in progress as city state without the layout', () => {
    const tiles = new Uint8Array(20 * 20).fill(Terrain.Land)
    const game = new Game(World.fromTiles(20, 20, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 8, y: 8 }], seed: 7 }
    game.bindCities()
    const player = game.addPlayer()
    game.spawn(player, UnitTypeId.Scout, { x: 8, y: 8 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    host.attach(player.id, true, (message) => frames.push(message)).sync()
    frames.length = 0
    for (let i = 0; i < 90; i++) host.tick(SIM_STEP)
    const updates = events(frames).filter((event) => event.kind === ServerEventKind.CityUpdate)
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.length).toBeLessThan(90)
    for (const update of updates) expect(update.city.layout).toBeNull()
  })

  it("answers a city building with that city's new layout in the command's echo", () => {
    const tiles = new Uint8Array(20 * 20).fill(Terrain.Land)
    const game = new Game(World.fromTiles(20, 20, tiles))
    game.scenery = { coast: [], holes: [], roads: [], towns: [{ x: 8, y: 8 }], seed: 7 }
    game.bindCities()
    const player = game.addPlayer()
    game.claimCity({ x: 8, y: 8 }, player.id)
    game.spawn(player, UnitTypeId.Scout, { x: 2, y: 2 })
    player.credits = 10_000
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    host.tick(SIM_STEP)
    const layout = game.cityLayouts()[0]
    const terrain = Array.from({ length: 20 * 20 }, () => Terrain.Land)
    const plots = Array.from({ length: 20 * 20 }, (_, index) => ({ x: index % 20, y: Math.floor(index / 20) }))
    const site = plots.find((tile) => canPlaceCityBuilding(layout, tile.x, tile.y, terrain, 20, 20))
    if (!site) throw new Error('no building plot')
    frames.length = 0
    play.command({ kind: ClientMessageKind.PlaceCity, tile: site }, 1, host.tickNo)
    const update = frames[0].events.find((event) => event.kind === ServerEventKind.CityUpdate)
    expect(update?.city.layout?.buildings).toContainEqual(expect.objectContaining({ x: site.x, y: site.y }))
  })

  it('sends motion on an order and stays quiet when the path does not change', () => {
    const game = new Game(new World(32, 32))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 4, y: 4 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    frames.length = 0
    host.tick(SIM_STEP)
    expect(events(frames).some((event) => event.kind === ServerEventKind.UnitMotion)).toBe(false)

    frames.length = 0
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: [scout.id], tile: { x: 12, y: 4 } }, 1, host.tickNo)
    host.tick(SIM_STEP)
    expect(events(frames).some((event) => event.kind === ServerEventKind.UnitMotion)).toBe(true)
  })

  it('sends no motion for a scout turning a corner, which its client turns alike', () => {
    const wall = []
    for (let y = 5; y < 14; y++) for (let x = 2; x < 12; x++) wall.push({ x, y })
    const game = new Game(new World(32, 32, wall))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 4, y: 4 }, Math.PI / 2)
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: [scout.id], tile: { x: 12, y: 12 } }, 1, host.tickNo)
    frames.length = 0
    for (let i = 0; i < 200; i++) host.tick(SIM_STEP)
    expect(scout.tile).toEqual({ x: 12, y: 12 })
    expect(events(frames).filter((event) => event.kind === ServerEventKind.UnitMotion)).toEqual([])
  })

  it('stops a scout in range of its attack target and turns its hull toward it at 2.5 rad/s on its client, tick for tick as the server does', () => {
    const game = new Game(new World(16, 16))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 4, y: 4 }, Math.PI / 2)
    const foe = game.spawn(game.addPlayer(), UnitTypeId.Scout, { x: 4, y: 10 })
    game.orderMove(player.id, [scout.id], { x: 9, y: 4 })
    for (let i = 0; i < 10; i++) game.tick(SIM_STEP)
    scout.attackId = foe.id
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    host.attach(player.id, true, (frame) => frames.push(frame)).sync()
    const client = new Replica()
    client.apply(frames[0])
    const before = scout.facing
    host.tick(SIM_STEP)
    expect(wrapAngle(before - scout.facing)).toBeCloseTo(2.5 * SIM_STEP, 9)
    for (let i = 0; i < 30; i++) {
      client.simulateTo(host.tickNo)
      const { x, z } = scout.pos
      expect(client.unit(scout.id)).toMatchObject({ x: expect.closeTo(x, 5), z: expect.closeTo(z, 5), facing: expect.closeTo(scout.facing, 5), speed: expect.closeTo(scout.speed, 5), path: [] })
      host.tick(SIM_STEP)
    }
    expect(scout.speed).toBe(0)
    expect(scout.facing).toBeCloseTo(Math.atan2(foe.pos.x - scout.pos.x, foe.pos.z - scout.pos.z), 9)
  })

  it('sends no motion for a jet flying home to rearm past an enemy it is ordered to attack', () => {
    const game = new Game(new World(32, 20))
    const player = game.addPlayer()
    const enemy = game.addPlayer()
    const airport = game.spawn(player, UnitTypeId.Airport, { x: 4, y: 6 })
    const jet = game.spawn(player, UnitTypeId.Jet, { x: 24, y: 4 }, -Math.PI / 2)
    const foe = game.spawn(enemy, UnitTypeId.Scout, { x: 14, y: 8 })
    jet.home = { ...airport.tile }
    jet.flight = Flight.Cruise
    jet.altitude = 2.6
    jet.speed = 8
    jet.rounds = 0
    game.tick(SIM_STEP)
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    play.command({ kind: ClientMessageKind.OrderAttack, unitIds: [jet.id], targetId: foe.id }, 1, host.tickNo)
    frames.length = 0
    for (let i = 0; i < 60; i++) host.tick(SIM_STEP)
    expect(jet).toMatchObject({ returning: true, attackId: foe.id })
    expect(Math.hypot(foe.pos.x - jet.pos.x, foe.pos.z - jet.pos.z)).toBeLessThan(JET.weapon.range)
    expect(events(frames).filter((event) => event.kind === ServerEventKind.UnitMotion)).toEqual([])
  })

  it('turns a scout toward its own unit it is ordered to attack on its client, tick for tick as the server does', () => {
    const game = new Game(new World(16, 16))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 4, y: 4 }, Math.PI / 2)
    const tank = game.spawn(player, UnitTypeId.MedTank, { x: 4, y: 9 })
    scout.attackId = tank.id
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    host.attach(player.id, true, (frame) => frames.push(frame)).sync()
    const client = new Replica()
    client.apply(frames[0])
    for (let i = 0; i < 30; i++) {
      host.tick(SIM_STEP)
      client.simulateTo(host.tickNo)
      expect(client.unit(scout.id)).toMatchObject({ x: scout.pos.x, z: scout.pos.z, facing: expect.closeTo(scout.facing, 5) })
    }
    expect(scout.attackId).toBe(tank.id)
    expect(scout.facing).toBeCloseTo(Math.atan2(tank.pos.x - scout.pos.x, tank.pos.z - scout.pos.z), 9)
  })

  it('holds a jet with rockets left and no airport in range of its attack target on its client, tick for tick as the server does', () => {
    const game = new Game(new World(32, 20))
    const player = game.addPlayer()
    const jet = game.spawn(player, UnitTypeId.Jet, { x: 20, y: 10 }, Math.PI / 2)
    const foe = game.spawn(game.addPlayer(), UnitTypeId.Factory, { x: 12, y: 4 })
    jet.flight = Flight.Cruise
    jet.altitude = 2.6
    jet.speed = JET.topSpeed
    jet.attackId = foe.id
    game.tick(SIM_STEP)
    expect(jet.home).toBeNull()
    expect(jet.rounds).toBeGreaterThan(0)
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    host.attach(player.id, true, (frame) => frames.push(frame)).sync()
    const client = new Replica()
    client.apply(frames[0])
    for (let i = 0; i < 30; i++) {
      host.tick(SIM_STEP)
      client.simulateTo(host.tickNo)
      const { x, z } = jet.pos
      expect(client.unit(jet.id)).toMatchObject({ x: expect.closeTo(x, 5), z: expect.closeTo(z, 5), facing: expect.closeTo(jet.facing, 5), path: [] })
    }
  })

  it("sends each change of a unit's rounds to its owner, and to other players only a rocket unit running empty", () => {
    const game = new Game(new World(24, 16))
    const owner = game.addPlayer()
    const rival = game.addPlayer()
    const scout = game.spawn(owner, UnitTypeId.Scout, { x: 4, y: 8 })
    const jet = game.spawn(owner, UnitTypeId.Jet, { x: 5, y: 10 })
    game.spawn(rival, UnitTypeId.Scout, { x: 15, y: 8 })
    const host = new ServerHost(game)
    const frames = new Map<number, ServerFrame[]>()
    for (const player of [owner, rival]) {
      const sent: ServerFrame[] = []
      frames.set(player.id, sent)
      host.attach(player.id, true, (frame) => sent.push(frame)).sync()
    }
    const told = () =>
      [...frames.values()].map((sent) =>
        events(sent.splice(0)).flatMap((event) => (event.kind === ServerEventKind.UnitMotion ? [[event.unit.id, event.unit.rounds]] : [])),
      )
    told()
    scout.rounds -= 1
    jet.rounds -= 1
    host.tick(SIM_STEP)
    expect(told()).toEqual([[[scout.id, SCOUT.weapon.magazine - 1], [jet.id, JET.weapon.magazine - 1]], []])
    jet.rounds = 0
    host.tick(SIM_STEP)
    expect(told()).toEqual([[[jet.id, 0]], [[jet.id, 0]]])
  })

  it('keeps a jittery client within half a tile of a server unit it cannot predict', () => {
    const game = new Game(new World(32, 20))
    const player = game.addPlayer()
    const tanks = [4, 6, 8, 10, 12, 14].map((y) => game.spawn(player, UnitTypeId.MedTank, { x: 3, y }, Math.PI / 2))
    const host = new ServerHost(game)
    const inbox: { frame: ServerFrame; due: number }[] = []
    const delays = [0, 3, 1, 4, 0, 2]
    let sent = 0
    const play = host.attach(player.id, true, (frame) => inbox.push({ frame, due: host.tickNo + delays[sent++ % delays.length] }))
    play.sync()
    const client = new Replica()
    client.apply(inbox.shift()?.frame as ServerFrame)
    const server = new Map<number, Map<number, { x: number; z: number }>>()
    const ids = tanks.map((tank) => tank.id)
    let seq = 0
    let worst = 0
    for (let tick = 0; tick < 30 * 14; tick++) {
      if (tick === 10 || tick === 200) {
        const target = tick === 10 ? { x: 26, y: 9 } : { x: 8, y: 16 }
        client.predictMove(ids, target)
        play.command({ kind: ClientMessageKind.OrderMove, unitIds: ids, tile: target }, ++seq, client.localTick)
      }
      if (tick >= 60 && tick < 90) tanks[0].speed = 0
      host.tick(SIM_STEP)
      server.set(host.tickNo, new Map(game.units.map((unit) => [unit.id, { x: unit.pos.x, z: unit.pos.z }])))
      while (inbox.length > 0 && inbox[0].due <= host.tickNo) client.apply(inbox.shift()?.frame as ServerFrame)
      client.advance(SIM_STEP)
      const truth = server.get(client.localTick)
      if (!truth) continue
      for (const unit of client.units) {
        const real = truth.get(unit.id)
        if (real) worst = Math.max(worst, Math.hypot(real.x - unit.x, real.z - unit.z))
      }
    }
    expect(worst).toBeLessThan(0.5)
  })

  it('predicts on the client the routes the server plans for the units a move order finds at rest', () => {
    const wall = []
    for (let y = 2; y < 12; y++) wall.push({ x: 12, y })
    const game = new Game(new World(24, 16, wall))
    const player = game.addPlayer()
    const enemy = game.addPlayer()
    const tanks = [3, 5, 7, 9].map((y) => game.spawn(player, UnitTypeId.MedTank, { x: 4, y }, Math.PI / 2))
    game.spawn(enemy, UnitTypeId.MedTank, { x: 14, y: 8 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    host.attach(player.id, true, (message) => frames.push(message)).sync()
    const replica = new Replica()
    replica.apply(frames[0])
    const [runner, ...resting] = tanks
    replica.predictMove([runner.id], { x: 20, y: 3 })
    game.orderMove(player.id, [runner.id], { x: 20, y: 3 })
    const course = structuredClone(runner.path)
    expect(replica.unit(runner.id)?.path).toEqual(course)

    replica.predictMove(tanks.map((tank) => tank.id), { x: 14, y: 8 })
    game.orderMove(player.id, tanks.map((tank) => tank.id), { x: 14, y: 8 })
    expect(runner.path).not.toEqual(course)
    expect(replica.unit(runner.id)?.path).toEqual(course)
    for (const tank of resting) expect(replica.unit(tank.id)?.path).toEqual(tank.path)
  })

  it('answers a late move order where it finds a unit on the move, as its client kept it, and catches up a unit at rest', () => {
    const game = new Game(new World(48, 16))
    const player = game.addPlayer()
    const runner = game.spawn(player, UnitTypeId.MedTank, { x: 4, y: 3 }, Math.PI / 2)
    const standing = game.spawn(player, UnitTypeId.MedTank, { x: 20, y: 12 }, Math.PI / 2)
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    const client = new Replica()
    const deliver = () => {
      for (const frame of frames.splice(0)) client.apply(frame)
    }
    const tick = () => {
      host.tick(SIM_STEP)
      client.simulateTo(host.tickNo)
      deliver()
    }
    deliver()
    client.predictMove([runner.id], { x: 40, y: 3 })
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: [runner.id], tile: { x: 40, y: 3 } }, 1, client.localTick)
    deliver()
    for (let i = 0; i < 20; i++) tick()

    const ids = [runner.id, standing.id]
    const goal = { x: 24, y: 12 }
    const sent = client.localTick
    const rest = standing.pos.x
    client.predictMove(ids, goal)
    for (let i = 0; i < 12; i++) tick()
    const arrived = { x: Math.fround(runner.pos.x), z: Math.fround(runner.pos.z) }
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: ids, tile: goal }, 2, sent)
    const echo = new Map<number, UnitSnapshot>()
    for (const event of events(frames)) if (event.kind === ServerEventKind.UnitMotion) echo.set(event.unit.id, event.unit)
    expect(echo.get(runner.id)).toMatchObject(arrived)
    for (const id of ids) {
      const shown = client.unit(id) as UnitSnapshot
      const answer = echo.get(id) as UnitSnapshot
      expect(Math.hypot(shown.x - answer.x, shown.z - answer.z)).toBeLessThan(0.01)
    }
    expect((echo.get(standing.id) as UnitSnapshot).x - rest).toBeGreaterThan(0.3)
  })

  it('sends tiles explored before a reload in the next sync', () => {
    const game = new Game(new World(64, 64))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 8, y: 8 })
    const host = new ServerHost(game)
    const first: ServerFrame[] = []
    const play = host.attach(player.id, true, (frame) => first.push(frame))
    play.sync()
    const started = explored(first)
    game.orderMove(player.id, [scout.id], { x: 48, y: 48 })
    for (let i = 0; i < 900 && Math.hypot(scout.pos.x - 8.5, scout.pos.z - 8.5) < SCOUT.weapon.sight + 6; i++) {
      host.tick(SIM_STEP)
    }
    const seen = explored(first)
    expect(seen.size).toBeGreaterThan(started.size)
    expect(Math.hypot(scout.pos.x - 8.5, scout.pos.z - 8.5)).toBeGreaterThan(SCOUT.weapon.sight + 4)
    play.close()
    const reloaded: ServerFrame[] = []
    host.attach(player.id, true, (frame) => reloaded.push(frame)).sync()
    const snapshot = events(reloaded).find((event) => event.kind === ServerEventKind.Snapshot)
    const again = new Set(snapshot?.map.cells.map((cell) => `${cell.x},${cell.y}`))
    expect([...seen].filter((tile) => !again.has(tile))).toEqual([])
  })

  it('explores terrain two tiles past sight without revealing units there', () => {
    const game = new Game(new World(64, 64))
    const player = game.addPlayer()
    const enemy = game.addPlayer()
    game.spawn(player, UnitTypeId.Scout, { x: 20, y: 20 })
    const sight = SCOUT.weapon.sight
    const hidden = game.spawn(enemy, UnitTypeId.Scout, { x: 20, y: 20 + sight + 1 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    host.attach(player.id, true, (message) => frames.push(message)).sync()
    const snapshot = events(frames).find((event) => event.kind === ServerEventKind.Snapshot)
    const explored = new Set(snapshot?.map.cells.map((cell) => `${cell.x},${cell.y}`))
    expect(explored.has(`${20 + sight + 2},20`)).toBe(true)
    expect(explored.has(`${20 + sight + 3},20`)).toBe(false)
    expect(snapshot?.units.some((unit) => unit.id === hidden.id)).toBe(false)
  })

  it("explores for a spectator what its player explores where a move order's catch-up brings a unit to rest", () => {
    const game = new Game(new World(64, 32))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 10, y: 10 }, Math.PI / 2)
    // Stopped short of the next tile, close enough for the catch-up to end at rest there.
    scout.pos = { x: 10.8, z: 10.5 }
    const host = new ServerHost(game)
    const own: ServerFrame[] = []
    const watched: ServerFrame[] = []
    const play = host.attach(player.id, true, (frame) => own.push(frame))
    play.sync()
    host.attach(player.id, false, (frame) => watched.push(frame)).sync()
    for (let i = 0; i < 3; i++) host.tick(SIM_STEP)
    const before = explored(own).size
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: [scout.id], tile: { x: 11, y: 10 } }, 1, host.tickNo - 15)
    expect(scout.pos.x).toBeGreaterThan(11)
    expect(scout.speed).toBe(0)
    expect(scout.path).toEqual([])
    for (let i = 0; i < 10; i++) host.tick(SIM_STEP)
    expect(explored(own).size).toBeGreaterThan(before)
    expect(explored(watched)).toEqual(explored(own))
  })

  it("lights where a move order's catch-up takes a unit at rest, in the order's echo", () => {
    const game = new Game(new World(48, 32))
    const player = game.addPlayer()
    const enemy = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 10, y: 10 })
    const tank = game.spawn(enemy, UnitTypeId.MedTank, { x: 22, y: 14 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (frame) => frames.push(frame))
    play.sync()
    const snapshot = events(frames).find((event) => event.kind === ServerEventKind.Snapshot)
    expect(snapshot?.units.some((unit) => unit.id === tank.id)).toBe(false)
    for (let i = 0; i < 3; i++) host.tick(SIM_STEP)
    frames.length = 0
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: [scout.id], tile: { x: 20, y: 10 } }, 1, host.tickNo - 15)
    expect(frames).toHaveLength(1)
    expect(frames[0].events.some((event) => event.kind === ServerEventKind.UnitMotion && event.unit.id === tank.id)).toBe(true)
  })

  it('delivers every explored tile although patches wait for the ledger', () => {
    const game = new Game(new World(64, 64))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 4, y: 4 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    host.attach(player.id, true, (message) => frames.push(message)).sync()
    game.orderMove(player.id, [scout.id], { x: 40, y: 30 })
    const seen = new Set<string>()
    const sight = SCOUT.weapon.sight
    for (let i = 0; i < 30 * 30; i++) {
      host.tick(SIM_STEP)
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          if (Math.hypot(x + 0.5 - scout.pos.x, y + 0.5 - scout.pos.z) <= sight - 0.5) seen.add(`${x},${y}`)
        }
      }
    }
    const received = new Set<string>()
    for (const event of events(frames)) {
      if (event.kind === ServerEventKind.Snapshot || event.kind === ServerEventKind.MapPatch) {
        for (const cell of event.map.cells) received.add(`${cell.x},${cell.y}`)
      }
    }
    expect(seen.size).toBeGreaterThan(1000)
    expect([...seen].filter((tile) => !received.has(tile))).toEqual([])
  })

  it('acknowledges a spectator ping at once', () => {
    const game = new Game(new World(16, 16))
    const player = game.addPlayer()
    game.spawn(player, UnitTypeId.Scout, { x: 4, y: 4 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const watch = host.attach(player.id, false, (message) => frames.push(message))
    watch.sync()
    frames.length = 0
    watch.command({ kind: ClientMessageKind.Ping }, 7, host.tickNo)
    expect(frames.map((frame) => frame.ack)).toEqual([7])
  })

  it('answers an order before the next tick', () => {
    const game = new Game(new World(32, 32))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 4, y: 4 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    frames.length = 0
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: [scout.id], tile: { x: 12, y: 4 } }, 2, host.tickNo)
    expect(events(frames).some((event) => event.kind === ServerEventKind.UnitMotion && event.unit.id === scout.id)).toBe(true)
  })

  it('answers an attack order with the server state of a unit its client kept on course', () => {
    const game = new Game(new World(32, 16))
    const player = game.addPlayer()
    const enemy = game.addPlayer()
    const tank = game.spawn(player, UnitTypeId.MedTank, { x: 6, y: 8 }, Math.PI / 2)
    const target = game.spawn(enemy, UnitTypeId.MedTank, { x: 17, y: 8 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    const client = new Replica()
    const deliver = () => {
      for (const frame of frames.splice(0)) client.apply(frame)
    }
    deliver()
    const goal = { x: 11, y: 8 }
    client.predictMove([tank.id], goal)
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: [tank.id], tile: goal }, 1, client.localTick)
    deliver()
    for (let i = 0; i < 5; i++) {
      host.tick(SIM_STEP)
      client.simulateTo(host.tickNo)
      deliver()
    }

    client.predictAttack([tank.id], { x: target.pos.x, z: target.pos.z }, target.id)
    play.command({ kind: ClientMessageKind.OrderAttack, unitIds: [tank.id], targetId: target.id }, 2, client.localTick)
    deliver()
    const held = client.unit(tank.id)
    expect(held?.path).toEqual(tank.path)
    expect(held?.x).toBeCloseTo(tank.pos.x)
    expect(held?.z).toBeCloseTo(tank.pos.z)
    expect(held?.attackId).toBe(target.id)
  })

  it('sends nothing while idle and a tick keepalive after five seconds', () => {
    const game = new Game(new World(32, 32))
    const player = game.addPlayer()
    game.spawn(player, UnitTypeId.Scout, { x: 4, y: 4 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    host.attach(player.id, true, (message) => frames.push(message)).sync()
    frames.length = 0
    for (let i = 0; i < KEEPALIVE_TICKS - 1; i++) host.tick(SIM_STEP)
    expect(frames).toHaveLength(0)
    host.tick(SIM_STEP)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.events).toEqual([])
    expect(frames[0]?.tick).toBe(host.tickNo)
  })

  it('omits an enemy outside sight', () => {
    const game = new Game(new World(48, 16))
    const player = game.addPlayer()
    const other = game.addPlayer()
    game.spawn(player, UnitTypeId.Scout, { x: 2, y: 8 })
    const hidden = game.spawn(other, UnitTypeId.Scout, { x: 40, y: 8 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    host.attach(player.id, true, (message) => frames.push(message)).sync()
    const snapshot = events(frames).find((event) => event.kind === ServerEventKind.Snapshot)
    expect(snapshot?.kind === ServerEventKind.Snapshot && snapshot.units.some((unit) => unit.id === hidden.id)).toBe(false)
  })

  it('patches newly seen tiles instead of the whole map', () => {
    const game = new Game(new World(40, 16))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 2, y: 8 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: [scout.id], tile: { x: 30, y: 8 } }, 3, host.tickNo)
    for (let i = 0; i < 90; i++) host.tick(SIM_STEP)
    const patches = events(frames).filter((event) => event.kind === ServerEventKind.MapPatch)
    expect(patches.length).toBeGreaterThan(0)
    const cells = patches.reduce((sum, event) => sum + (event.kind === ServerEventKind.MapPatch ? event.map.cells.length : 0), 0)
    expect(cells).toBeGreaterThan(0)
    expect(cells).toBeLessThan(40 * 16)
    const patch = patches.find((event) => event.kind === ServerEventKind.MapPatch)
    if (patch?.kind === ServerEventKind.MapPatch) {
      expect(patch.map.cells.every((cell) => cell.shift === 0x88)).toBe(true)
      expect(patch.map.coast).toEqual([])
      expect(patch.map.roads).toEqual([])
    }
  })

  it('patches a scarred tile', () => {
    const tiles = new Uint8Array(24 * 24).fill(Terrain.Land)
    const game = new Game(World.fromTiles(24, 24, tiles))
    const player = game.addPlayer()
    const tank = game.spawn(player, UnitTypeId.MedTank, { x: 10, y: 8 }, 0)
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    frames.length = 0
    play.command({ kind: ClientMessageKind.OrderAttackGround, unitIds: [tank.id], tile: { x: 10, y: 10 } }, 1, host.tickNo)
    let marked = false
    for (let i = 0; i < 1500 && !marked; i++) {
      host.tick(SIM_STEP)
      const cells = events(frames).flatMap((event) => (event.kind === ServerEventKind.MapPatch ? event.map.cells : []))
      marked = cells.some((cell) => cell.x === 10 && cell.y === 10 && scarStrength(cell.terrain) > 0)
    }
    expect(marked).toBe(true)
  })

  it('answers a snapshot request at the server tick and the client keeps that path', () => {
    const game = new Game(new World(24, 12))
    const player = game.addPlayer()
    const scout = game.spawn(player, UnitTypeId.Scout, { x: 2, y: 4 })
    const host = new ServerHost(game)
    const frames: ServerFrame[] = []
    const play = host.attach(player.id, true, (message) => frames.push(message))
    play.sync()
    play.command({ kind: ClientMessageKind.OrderMove, unitIds: [scout.id], tile: { x: 16, y: 4 } }, 4, host.tickNo)
    for (let i = 0; i < 31; i++) host.tick(SIM_STEP)
    frames.length = 0
    play.command({ kind: ClientMessageKind.RequestSnapshot }, 5, host.tickNo)
    const frame = frames.at(-1)
    expect(frame?.tick).toBe(host.tickNo)
    expect(frame?.events.some((event) => event.kind === ServerEventKind.Snapshot)).toBe(true)

    const replica = new Replica()
    if (frame) replica.apply(frame)
    const unit = replica.unit(scout.id)
    expect(unit).toBeDefined()
    if (!unit) return
    const shadow: MotionState = {
      x: unit.x,
      z: unit.z,
      facing: unit.facing,
      speed: unit.speed,
      tileX: unit.tileX,
      tileY: unit.tileY,
      path: unit.path.map((tile) => ({ x: tile.x, y: tile.y })),
    }
    const joinedAt = replica.localTick
    for (let i = 0; i < 2; i++) stepMotion(shadow, SCOUT, SIM_STEP)
    while (replica.localTick < joinedAt + 2) replica.advance(SIM_STEP)
    expect(shadow.path.length).toBeGreaterThan(0)
    const stepped = replica.unit(scout.id)
    expect(stepped?.x).toBeCloseTo(shadow.x)
    expect(stepped?.z).toBeCloseTo(shadow.z)
    expect(stepped?.path).toEqual(shadow.path)
  })
})
