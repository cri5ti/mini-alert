import { describe, expect, it, vi } from 'vitest'
import { Flight } from '../shared/flight.ts'
import { SIM_STEP } from '../shared/motion.ts'
import { ServerEventKind, type MapCell, type ServerFrame, type UnitSnapshot } from '../shared/protocol.ts'
import { planMoves } from '../shared/route.ts'
import { Terrain } from '../shared/tiles.ts'
import { UnitTypeId } from '../shared/unit-types.ts'
import { Replica } from './replica.ts'

vi.mock('../shared/route.ts', { spy: true })

function scout(x: number, path: { x: number; y: number }[]): UnitSnapshot {
  return {
    id: 1,
    typeId: UnitTypeId.Scout,
    ownerId: 1,
    color: 0,
    x,
    z: 4.5,
    facing: Math.PI / 2,
    turretYaw: Math.PI / 2,
    speed: path.length > 0 ? 3 : 0,
    health: 100,
    tileX: Math.floor(x),
    tileY: 4,
    path,
    goal: path.at(-1) ?? null,
    attackId: null,
    attackPoint: null,
    progress: 1,
  }
}

function joined(...units: UnitSnapshot[]): Replica {
  return welcomed(new Replica(), units)
}

function rolling(...units: UnitSnapshot[]): Replica {
  return welcomed(new Replica({ rollback: true }), units)
}

function welcomed(replica: Replica, units: UnitSnapshot[]): Replica {
  const cells: MapCell[] = []
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) cells.push({ x, y, terrain: Terrain.Land, shift: 0 })
  replica.apply({
    tick: 10,
    ack: 0,
    events: [
      { kind: ServerEventKind.Welcome, playerId: 1 },
      {
        kind: ServerEventKind.Snapshot,
        map: { width: 16, height: 16, cells, coast: [], holes: [], roads: [], towns: [], cleared: [] },
        units,
        cities: [],
        credits: 0,
        training: [],
        rally: null,
      },
    ],
  })
  return replica
}

const road = [{ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 }, { x: 7, y: 4 }, { x: 8, y: 4 }, { x: 9, y: 4 }]

function onRow(unit: UnitSnapshot, id: number, row: number): UnitSnapshot {
  return { ...unit, id, z: row + 0.5, tileY: row, path: unit.path.map((tile) => ({ x: tile.x, y: row })), goal: unit.goal && { x: unit.goal.x, y: row } }
}

function motion(unit: UnitSnapshot): ServerFrame['events'][number] {
  return { kind: ServerEventKind.UnitMotion, unit }
}

function convoy(): UnitSnapshot[] {
  return [3, 4, 5].map((row, index) => {
    const path = Array.from({ length: 12 }, (_, step) => ({ x: 2 + step, y: row }))
    return { ...scout(1.5, path), id: index + 1, z: row + 0.5, tileY: row }
  })
}

/** The convoy's UnitMotion every `every` ticks up to `last`, with routes the clients cannot predict switched at ticks 120 and 150. */
function convoyFrames(every: number, last: number): ServerFrame[] {
  const server = joined(...convoy())
  const frames: ServerFrame[] = []
  for (let tick = 10 + every; tick <= last; tick += every) {
    server.simulateTo(tick)
    if (tick === 120) server.predictMove([1], { x: 14, y: 1 })
    if (tick === 150) server.predictMove([2, 3], { x: 3, y: 12 })
    frames.push({ tick, ack: 0, events: server.units.map((unit) => ({ kind: ServerEventKind.UnitMotion, unit: structuredClone(unit) })) })
  }
  return frames
}

type Watch = { arrive?: (replica: Replica, frame: ServerFrame) => void; render?: (replica: Replica, time: number) => void }

/** Feeds `frames` in order, each `delay` ticks late, rendering every half tick; `now` maps tick time to arrival time. */
function fedLate(
  frames: ServerFrame[],
  delay: (tick: number, index: number) => number,
  now: (time: number, index: number) => number,
  watch: Watch = {},
): Replica {
  const replica = joined(...convoy())
  let at = 0
  const queue = frames.map((frame, index) => ({ frame, at: (at = Math.max(at, frame.tick + delay(frame.tick, index))) }))
  let index = 0
  for (let half = 21; half < 2 * (at + 30); half++) {
    while (queue.length > 0 && queue[0].at <= half / 2) {
      const frame = queue.shift()?.frame as ServerFrame
      watch.arrive?.(replica, frame)
      replica.apply(frame, now(half / 2, index++))
    }
    replica.advance(SIM_STEP / 2)
    watch.render?.(replica, half / 2)
  }
  return replica
}

function fedOnTime(frames: ServerFrame[], tick: number): Replica {
  const replica = joined(...convoy())
  for (const frame of frames) {
    replica.simulateTo(frame.tick)
    replica.apply(frame)
  }
  replica.simulateTo(tick)
  return replica
}

describe('replica drawing', () => {
  it('poses a moving unit between its last two sim steps', () => {
    const replica = joined(scout(2.5, road))
    replica.drawn()
    replica.advance(SIM_STEP)
    const stepped = replica.units[0].x
    replica.drawn()
    replica.advance(SIM_STEP * 1.5)
    const after = replica.units[0].x
    const drawn = replica.drawn()[0].x
    expect(drawn).toBeGreaterThan(stepped)
    expect(drawn).toBeLessThan(after)
  })

  it('blends a server correction in instead of jumping', () => {
    const replica = joined(scout(2.5, []))
    const before = replica.drawn()[0].x
    const moved: ServerFrame = { tick: 10, ack: 0, events: [{ kind: ServerEventKind.UnitMotion, unit: scout(3.5, []) }] }
    replica.apply(moved)
    expect(replica.units[0].x).toBe(3.5)
    expect(replica.drawn()[0].x).toBeCloseTo(before)
    for (let i = 0; i < 30; i++) replica.advance(SIM_STEP)
    expect(replica.drawn()[0].x).toBeCloseTo(3.5, 2)
  })

  it('draws a moving unit corrected with its own state as an uncorrected copy draws it', () => {
    const corrected = joined(scout(2.5, road))
    const uncorrected = joined(scout(2.5, road))
    const pose = (replica: Replica) => {
      const { x, z, facing, turretYaw, altitude } = replica.drawn()[0]
      return [x, z, facing, turretYaw, altitude ?? 0]
    }
    for (const replica of [corrected, uncorrected]) {
      replica.drawn()
      replica.advance(SIM_STEP * 1.5)
      replica.drawn()
    }
    const now = performance.now()
    const tick = corrected.localTick
    corrected.apply({ tick, ack: 0, events: [{ kind: ServerEventKind.UnitMotion, unit: structuredClone(corrected.units[0]) }] }, now)
    uncorrected.apply({ tick, ack: 0, events: [] }, now)
    for (let frame = 0; frame < 12; frame++) {
      expect(pose(corrected)).toEqual(pose(uncorrected).map((value) => expect.closeTo(value, 9)))
      corrected.advance(SIM_STEP / 3)
      uncorrected.advance(SIM_STEP / 3)
    }
  })

  it('steps forward to a frame far ahead instead of asking for a snapshot', () => {
    const replica = joined(scout(2.5, road))
    replica.apply({ tick: 160, ack: 0, events: [] })
    expect(replica.wantsSnapshot).toBe(false)
    expect(replica.localTick).toBe(160)
    expect(replica.units[0].x).toBeGreaterThan(5)
  })

  it('starts an ordered unit toward its target before the server answers', () => {
    const replica = joined(scout(2.5, []))
    replica.predictMove([1], { x: 12, y: 4 })
    expect(replica.units[0].path).toEqual(Array.from({ length: 10 }, (_, i) => ({ x: 3 + i, y: 4 })))
    for (let i = 0; i < 15; i++) replica.advance(SIM_STEP)
    expect(replica.units[0].x).toBeGreaterThan(2.6)
  })

  it('returns the end of the route a move order plans for each unit, keeping units on the move on course', () => {
    const replica = joined(scout(2.5, road), onRow(scout(2.5, road), 2, 6), onRow(scout(2.5, []), 3, 8))
    const goals = replica.predictMove([1, 2, 3], { x: 12, y: 10 })
    const courses = replica.units.map((unit) => structuredClone(unit.path))
    expect(courses[0]).toEqual(road)
    expect(goals).toHaveLength(3)
    expect(goals).toContainEqual(courses[2].at(-1))
    expect(replica.predictMove([1, 2, 3], { x: 4, y: 12 })).toHaveLength(3)
    expect(replica.units.map((unit) => unit.path)).toEqual(courses)
  })

  it('keeps a steady pace when frames arrive with uneven delays', () => {
    const replica = joined(scout(1.5, []))
    const delays = [0, 12, 3, 15, 0, 9]
    const frames: { tick: number; at: number }[] = []
    for (let tick = 12, at = 0; tick < 140; tick += 3) {
      at = Math.max(at, tick + 2 + delays[frames.length % delays.length])
      frames.push({ tick, at })
    }
    const paces: number[] = []
    const start = performance.now()
    for (let half = 22; half < 260; half++) {
      const now = half / 2
      while (frames.length > 0 && frames[0].at <= now) replica.apply({ tick: frames.shift()?.tick ?? 0, ack: 0, events: [] }, start + (now - 11) * SIM_STEP * 1000)
      const before = replica.localTick
      replica.advance(SIM_STEP / 2)
      paces.push(replica.localTick - before)
    }
    const settled = paces.slice(40)
    let worst = 0
    for (let i = 0; i + 12 <= settled.length; i++) {
      const steps = settled.slice(i, i + 12).reduce((sum, pace) => sum + pace, 0)
      worst = Math.max(worst, Math.abs(steps - 6))
    }
    expect(worst).toBeLessThanOrEqual(1)
  })

  it('keeps a steady pace when sparse frames arrive with uneven delays', () => {
    const replica = joined(scout(1.5, []))
    const delays = [0, 15, 0, 3, 15, 0]
    const frames: { tick: number; at: number }[] = []
    for (let tick = 40, at = 0; tick < 1500; tick += 60) {
      at = Math.max(at, tick + 2 + delays[frames.length % delays.length])
      frames.push({ tick, at })
    }
    const start = performance.now()
    const paces: number[] = []
    let second = replica.localTick
    for (let half = 22; half < 3000; half++) {
      const now = half / 2
      while (frames.length > 0 && frames[0].at <= now) replica.apply({ tick: frames.shift()?.tick ?? 0, ack: 0, events: [] }, start + (now - 11) * SIM_STEP * 1000)
      replica.advance(SIM_STEP / 2)
      if (half % 60 === 0) {
        paces.push(replica.localTick - second)
        second = replica.localTick
      }
    }
    expect(Math.max(...paces.slice(3).map((pace) => Math.abs(pace - 30)))).toBeLessThanOrEqual(2)
  })

  it('replays a correction from an older tick up to the local tick', () => {
    const replica = joined(scout(2.5, road))
    while (replica.localTick < 20) replica.advance(SIM_STEP)
    replica.apply({ tick: 15, ack: 0, events: [{ kind: ServerEventKind.UnitMotion, unit: scout(3.5, road.slice(1)) }] })
    expect(replica.units[0].x).toBeGreaterThan(3.5 + 4 * SIM_STEP * 3 * 0.9)
  })

  it('holds a frame stamped ahead of the local tick until the clock reaches that tick', () => {
    const replica = joined(scout(2.5, road))
    replica.apply({ tick: 12, ack: 0, events: [{ kind: ServerEventKind.UnitMotion, unit: scout(4.5, road.slice(2)) }] })
    expect(replica.units[0].x).toBe(2.5)
    while (replica.localTick < 12) replica.advance(SIM_STEP)
    expect(replica.localTick).toBe(12)
    expect(replica.units[0].x).toBe(4.5)
  })

  it('ends a convoy fed frames up to four ticks late where frames fed on time leave it', () => {
    const frames = convoyFrames(3, 240)
    const start = performance.now()
    const late = fedLate(frames, (_, index) => [0, 4, 1, 3, 2, 4, 0][index % 7], (time) => start + (time - 10) * SIM_STEP * 1000)
    expect(late.localTick).toBeGreaterThan(240)
    expect(late.units).toEqual(fedOnTime(frames, late.localTick).units)
  })

  it('holds frames as late as they recently arrived and eases back by local ticks, whatever the arrival clock reads', () => {
    const frames = convoyFrames(1, 700)
    const start = performance.now()
    const delay = (tick: number, index: number) => (tick <= 200 ? [0, 4, 1, 3][index % 4] : 0)
    let behind = 0
    const lag = new Map<number, number>()
    const seen: { tick: number; units: UnitSnapshot[] }[] = []
    const first = fedLate(frames, delay, (time) => start + (time - 10) * SIM_STEP * 1000, {
      arrive: (replica, frame) => {
        if (frame.tick > 100 && frame.tick < replica.localTick) behind += 1
      },
      render: (replica, time) => {
        lag.set(time, time - replica.localTick)
        seen.push({ tick: replica.localTick, units: structuredClone(replica.units) })
      },
    })
    expect(behind).toBe(0)
    expect(lag.get(320)).toBeGreaterThanOrEqual(3)
    expect(lag.get(600)).toBeLessThanOrEqual(1)
    let render = 0
    const second = fedLate(frames, delay, (time, index) => start + (time - 10) * SIM_STEP * 1050 + (index % 3) * 9, {
      render: (replica) => expect({ tick: replica.localTick, units: replica.units }).toEqual(seen[render++]),
    })
    expect(second.units).toEqual(first.units)
  })

  it('leaves a leader stopped by a frame three ticks late, and its follower, where the frame on time leaves them', () => {
    const units = () => [scout(4.5, road.slice(2)), { ...scout(3.5, road.slice(1)), id: 2 }]
    const server = joined(...units())
    server.simulateTo(18)
    server.units[0].path = []
    const stop: ServerFrame = { tick: 18, ack: 0, events: [motion(structuredClone(server.units[0]))] }
    const onTime = rolling(...units())
    onTime.simulateTo(18)
    onTime.apply(stop)
    onTime.simulateTo(60)
    const late = rolling(...units())
    late.simulateTo(21)
    late.apply(stop)
    late.simulateTo(60)
    expect(late.units).toEqual(onTime.units)
  })

  it('leaves units where on-time frames leave them when an echo of a tick already applied arrives two ticks late', () => {
    const units = () => [scout(2.5, []), onRow(scout(2.5, []), 2, 8)]
    const tick: ServerFrame = { tick: 13, ack: 0, events: [motion(scout(2.5, road))] }
    const echo: ServerFrame = { tick: 13, ack: 1, events: [motion(onRow(scout(2.5, road), 2, 8))] }
    const onTime = rolling(...units())
    onTime.simulateTo(13)
    onTime.apply(tick)
    onTime.apply(echo)
    onTime.simulateTo(40)
    const late = rolling(...units())
    late.simulateTo(13)
    late.apply(tick)
    late.simulateTo(15)
    late.apply(echo)
    late.simulateTo(40)
    expect(late.units).toEqual(onTime.units)
  })

  it("keeps a guess made after its tick's frames on top of late frames stamped that tick", () => {
    const tank = (id: number, x: number, row: number) => onRow({ ...scout(x, []), typeId: UnitTypeId.MedTank }, id, row)
    const units = () => [tank(1, 2.5, 4), tank(2, 2.5, 8)]
    const first: ServerFrame = { tick: 13, ack: 0, events: [] }
    const late: ServerFrame[] = [
      { tick: 13, ack: 0, events: [motion(tank(1, 2.6, 4))] },
      { tick: 13, ack: 1, events: [motion(tank(2, 3.5, 8))] },
    ]
    const onTime = rolling(...units())
    onTime.simulateTo(13)
    for (const frame of [first, ...late]) onTime.apply(frame)
    onTime.predictMove([1], { x: 12, y: 4 })
    onTime.simulateTo(15)
    onTime.predictMove([2], { x: 12, y: 8 })
    onTime.simulateTo(30)
    const replica = rolling(...units())
    replica.simulateTo(13)
    replica.apply(first)
    replica.predictMove([1], { x: 12, y: 4 })
    replica.simulateTo(15)
    replica.predictMove([2], { x: 12, y: 8 })
    replica.simulateTo(16)
    for (const frame of late) replica.apply(frame)
    replica.simulateTo(30)
    expect(onTime.units[0].x).toBeGreaterThan(2.6)
    expect(replica.units).toEqual(onTime.units)
  })

  it('re-applies a move guess without planning it again when late frames ahead of it leave the map as it was', () => {
    const land: ServerFrame['events'][number] = {
      kind: ServerEventKind.MapPatch,
      map: { width: 16, height: 16, cells: [{ x: 15, y: 15, terrain: Terrain.Land, shift: 0 }], coast: [], holes: [], roads: [], towns: [], cleared: [] },
    }
    const frames: ServerFrame[] = [10, 11].map((tick) => ({ tick, ack: 0, events: [land] }))
    // Off its tile's centre line, the unit's course depends on the route's first tile.
    const unit = () => ({ ...scout(2.5, []), z: 4.2 })
    const onTime = rolling(unit())
    onTime.apply(frames[0])
    onTime.simulateTo(11)
    onTime.apply(frames[1])
    onTime.predictMove([1], { x: 12, y: 4 })
    onTime.simulateTo(30)
    const late = rolling(unit())
    late.simulateTo(11)
    late.predictMove([1], { x: 12, y: 4 })
    late.simulateTo(24)
    vi.mocked(planMoves).mockClear()
    for (const frame of frames) late.apply(frame)
    expect(planMoves).not.toHaveBeenCalled()
    late.simulateTo(30)
    expect(late.units).toEqual(onTime.units)
  })

  it('re-plans a move guess when a late frame ahead of it moves a unit onto its goal', () => {
    const units = () => [scout(2.5, []), onRow(scout(2.5, []), 2, 8)]
    const moved: ServerFrame = { tick: 13, ack: 0, events: [motion(onRow(scout(12.5, []), 2, 4))] }
    const onTime = rolling(...units())
    onTime.simulateTo(13)
    onTime.apply(moved)
    onTime.predictMove([1], { x: 12, y: 4 })
    onTime.simulateTo(30)
    const late = rolling(...units())
    late.simulateTo(13)
    late.predictMove([1], { x: 12, y: 4 })
    late.simulateTo(16)
    late.apply(moved)
    late.simulateTo(30)
    expect(onTime.units[0].goal).not.toEqual({ x: 12, y: 4 })
    expect(late.units).toEqual(onTime.units)
  })

  it('counts a city update apart from terrain changes', () => {
    const replica = joined(scout(2.5, []))
    const terrain = replica.terrainRevision
    const cities = replica.cityRevision
    const layout = { x: 2, y: 2, span: 2, seed: 1, tiles: [{ x: 2, y: 2 }], buildings: [], streets: [] }
    const state = { ownerId: 1, color: 0, progress: 0.5, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] }
    replica.apply({ tick: 10, ack: 0, events: [{ kind: ServerEventKind.CityUpdate, city: { index: 0, state, layout } }] })
    expect(replica.terrainRevision).toBe(terrain)
    expect(replica.cityRevision).toBe(cities + 1)
    expect(replica.knownTiles).toBe(256)
  })

  it('keeps a unit steered onto a city building out of the building tile, as the server does', () => {
    const replica = joined(scout(2.5, road))
    const layout = { x: 6, y: 4, span: 1, seed: 1, tiles: [{ x: 6, y: 4 }], buildings: [{ x: 6, y: 4, model: 0, yaw: 0, keep: false }], streets: [] }
    const state = { ownerId: 0, color: 0, progress: 0, challengerId: 0, challengerColor: 0, grown: 0, ruins: [], sites: [] }
    replica.apply({ tick: 10, ack: 0, events: [{ kind: ServerEventKind.CityUpdate, city: { index: 0, state, layout } }] })
    replica.simulateTo(100)
    expect(replica.units[0].tileX).toBe(5)
  })

  it('lets the lower id take a tile two units enter in one tick, though it came into view after the higher id, as the server does', () => {
    const left = { ...scout(5.5, [{ x: 6, y: 4 }]), id: 2, ownerId: 2 }
    const below = { ...scout(6.5, [{ x: 6, y: 4 }]), id: 5, ownerId: 2, z: 5.5, tileY: 5, facing: Math.PI }
    const replica = joined(below)
    replica.apply({ tick: 10, ack: 0, events: [motion(left)] })
    replica.simulateTo(20)
    expect(replica.unit(2)).toMatchObject({ tileX: 6, tileY: 4 })
    expect(replica.unit(5)).toMatchObject({ tileX: 6, tileY: 5 })
  })

  it('turns a turret toward its attack target between server updates', () => {
    const tank = { ...scout(4.5, []), id: 2, typeId: UnitTypeId.MedTank, facing: 0, turretYaw: 0 }
    const foe = { ...scout(8.5, []), id: 3, ownerId: 2 }
    const replica = joined(tank, foe)
    replica.predictAttack([2], foe, 3)
    for (let i = 0; i < 15; i++) replica.advance(SIM_STEP)
    expect(replica.unit(2)?.turretYaw).toBeGreaterThan(1)
  })

  it('keeps a flying jet on course without its target on an attack order in range until the server answers', () => {
    const jet = { ...scout(4.5, road.slice(2)), typeId: UnitTypeId.Jet, speed: 8, home: { x: 0, y: 12 }, flight: Flight.Cruise, altitude: 2.6 }
    const foe = { ...scout(8.5, []), id: 3, ownerId: 2, z: 8.5, tileY: 8 }
    const ordered = joined(jet, foe)
    const unordered = joined(jet, foe)
    ordered.predictAttack([1], foe, 3)
    ordered.simulateTo(20)
    unordered.simulateTo(20)
    expect(ordered.unit(1)).toEqual(unordered.unit(1))
  })

  it('leads a unit out of range toward its attack target', () => {
    const tank = { ...scout(1.5, []), id: 2, typeId: UnitTypeId.MedTank }
    const replica = joined(tank, { ...scout(14.5, []), id: 3, ownerId: 2 })
    replica.predictAttack([2], { x: 14.5, z: 4.5 }, 3)
    expect(replica.unit(2)?.attackId).toBe(3)
    expect(replica.unit(2)?.path).toEqual([{ x: 2, y: 4 }, { x: 3, y: 4 }, { x: 4, y: 4 }])
  })

  it('keeps units on the move on course on an attack order out of range, turning only turrets to the target', () => {
    const tank = { ...scout(1.5, road), id: 2, typeId: UnitTypeId.MedTank }
    const runner = onRow(scout(1.5, road), 4, 6)
    const replica = joined(tank, runner, { ...scout(14.5, []), id: 3, ownerId: 2 })
    replica.predictAttack([2, 4], { x: 14.5, z: 4.5 }, 3)
    expect(replica.unit(2)).toMatchObject({ x: 1.5, z: 4.5, facing: Math.PI / 2, path: road, attackId: 3 })
    expect(replica.unit(4)).toMatchObject({ path: runner.path, attackId: null })
  })

  it('shows an expected unit in the queue until its command is acknowledged', () => {
    const replica = joined(scout(2.5, []))
    replica.expectTraining(5, UnitTypeId.MedTank, 2)
    replica.apply({ tick: 10, ack: 4, events: [] })
    expect(replica.queue()).toEqual([{ typeId: UnitTypeId.MedTank, yardId: 2, progress: 0 }])
    replica.apply({ tick: 10, ack: 5, events: [] })
    expect(replica.queue()).toEqual([])
  })

  it('advances the head of the training queue between updates', () => {
    const replica = joined(scout(2.5, []))
    const update = (tick: number, progress: number) => ({
      tick,
      ack: 0,
      events: [{ kind: ServerEventKind.Training as const, training: [{ typeId: UnitTypeId.Scout, progress, yardId: 4 }] }],
    })
    replica.apply(update(10, 0.1))
    replica.apply(update(16, 0.2))
    for (let i = 0; i < 9; i++) replica.advance(SIM_STEP)
    expect(replica.queue()[0].progress).toBeCloseTo(0.2 + (0.1 / 6) * (replica.localTick - 16), 5)
    expect(replica.queue()[0].progress).toBeGreaterThan(0.2)
  })

  it('keeps pace with a server running at a tenth of real time', () => {
    const replica = joined(scout(2.5, []))
    let now = performance.now()
    let tick = 10
    for (let frame = 0; frame < 60; frame++) {
      for (let i = 0; i < 60; i++) {
        replica.advance(1 / 60)
        now += 1000 / 60
      }
      tick += 3
      replica.apply({ tick, ack: 0, events: [] }, now)
    }
    expect(replica.wantsSnapshot).toBe(false)
    expect(Math.abs(replica.localTick - tick)).toBeLessThanOrEqual(8)
  })
})
