import { describe, expect, it } from 'vitest'
import { Game } from '../server/game.ts'
import { World } from '../server/world.ts'
import { decodeClientMessage, decodeServerFrame, encodeClientMessage, encodeServerFrame } from './codec.ts'
import { SIM_STEP } from './motion.ts'
import { ClientMessageKind, ServerEventKind, type ServerFrame } from './protocol.ts'
import { Terrain } from './tiles.ts'
import { UnitTypeId, WeaponKind } from './unit-types.ts'

describe('protobuf frames', () => {
  it('round-trips a server frame and a client command', () => {
    const frame: ServerFrame = {
      tick: 12,
      ack: 41,
      events: [
        { kind: ServerEventKind.Welcome, playerId: 3 },
        {
          kind: ServerEventKind.UnitMotion,
          unit: {
            id: 4,
            typeId: UnitTypeId.Scout,
            ownerId: 3,
            color: 0x336699,
            x: 1.25,
            z: 2.5,
            facing: 0.2,
            turretYaw: 0.2,
            speed: 1.5,
            health: 40,
            tileX: 1,
            tileY: 2,
            path: [{ x: 3, y: 2 }],
            goal: { x: 3, y: 2 },
            attackId: null,
            attackPoint: null,
            progress: 1,
          },
        },
        {
          kind: ServerEventKind.MapPatch,
          map: {
            width: 8,
            height: 8,
            cells: [{ x: 1, y: 2, terrain: Terrain.Land, shift: 0x88 }],
            coast: [],
            holes: [],
            roads: [],
            towns: [],
            cleared: [],
          },
        },
        { kind: ServerEventKind.ShotSpawn, shot: { kind: WeaponKind.Shell, shooterId: 4, x: 1, z: 2, aimX: 3, aimZ: 4, flight: 0.4 } },
        { kind: ServerEventKind.ShotHit, hit: { kind: WeaponKind.Shell, aimX: 3, aimZ: 4 } },
        { kind: ServerEventKind.Credits, credits: 9989.583333333334 },
        { kind: ServerEventKind.Trace, budget: 33.333, samples: [{ slot: 1, ms: 4.5 }, { slot: 10, ms: 20 }] },
      ],
    }
    const back = decodeServerFrame(encodeServerFrame(frame))
    expect(back?.tick).toBe(12)
    expect(back?.ack).toBe(41)
    expect(back?.events[0]).toMatchObject({ kind: ServerEventKind.Welcome, playerId: 3 })
    expect(back?.events[1]).toMatchObject({ kind: ServerEventKind.UnitMotion, unit: { id: 4, x: expect.closeTo(1.25), path: [{ x: 3, y: 2 }] } })
    expect(back?.events[2]).toMatchObject({ kind: ServerEventKind.MapPatch, map: { cells: [{ x: 1, y: 2, terrain: Terrain.Land, shift: 0x88 }] } })
    expect(back?.events[5]).toMatchObject({ kind: ServerEventKind.Credits, credits: expect.closeTo(9989.583333333334) })
    expect(back?.events[6]).toMatchObject({
      kind: ServerEventKind.Trace,
      budget: expect.closeTo(33.333),
      samples: [{ slot: 1, ms: expect.closeTo(4.5) }, { slot: 10, ms: expect.closeTo(20) }],
    })

    const order = decodeClientMessage(encodeClientMessage({ kind: ClientMessageKind.OrderMove, unitIds: [4], tile: { x: 6, y: 1 } }, 42, 900))
    expect(order).toEqual({ seq: 42, tick: 900, message: { kind: ClientMessageKind.OrderMove, unitIds: [4], tile: { x: 6, y: 1 } } })
    expect(decodeClientMessage(encodeClientMessage({ kind: ClientMessageKind.Ping }, 43, 901))).toEqual({
      seq: 43,
      tick: 901,
      message: { kind: ClientMessageKind.Ping },
    })
  })

  it('packs map cells, paths and city layouts as steps', () => {
    const layout = { x: 2, y: 2, span: 4, seed: 7, tiles: [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 3 }], buildings: [], streets: [] }
    const state = { ownerId: 1, color: 0, progress: 0.5, challengerId: 0, challengerColor: 0, grown: 0, ruins: [{ x: 3, y: 2 }], sites: [] }
    const frame: ServerFrame = {
      tick: 1,
      ack: 0,
      events: [
        {
          kind: ServerEventKind.MapPatch,
          map: {
            width: 8,
            height: 8,
            cells: [
              { x: 7, y: 0, terrain: Terrain.Water, shift: 1 },
              { x: 0, y: 1, terrain: Terrain.Tree, shift: 2 },
              { x: 3, y: 0, terrain: Terrain.Land, shift: 3 },
            ],
            coast: [],
            holes: [],
            roads: [],
            towns: [],
            cleared: [{ x: 5, y: 6 }, { x: 4, y: 7 }],
          },
        },
        {
          kind: ServerEventKind.UnitMotion,
          unit: {
            id: 4,
            typeId: UnitTypeId.Scout,
            ownerId: 3,
            color: 0,
            x: 1.5,
            z: 1.5,
            facing: 0,
            turretYaw: 0,
            speed: 0,
            health: 40,
            tileX: 1,
            tileY: 1,
            path: [{ x: 2, y: 2 }, { x: 3, y: 3 }, { x: 3, y: 4 }],
            goal: { x: 3, y: 4 },
            attackId: null,
            attackPoint: null,
            progress: 1,
          },
        },
        { kind: ServerEventKind.CityUpdate, city: { index: 2, state, layout } },
        { kind: ServerEventKind.CityUpdate, city: { index: 2, state, layout: null } },
      ],
    }
    const back = decodeServerFrame(encodeServerFrame(frame))
    expect(back?.events[0]).toMatchObject({
      map: {
        cells: [
          { x: 3, y: 0, terrain: Terrain.Land, shift: 3 },
          { x: 7, y: 0, terrain: Terrain.Water, shift: 1 },
          { x: 0, y: 1, terrain: Terrain.Tree, shift: 2 },
        ],
        cleared: [{ x: 5, y: 6 }, { x: 4, y: 7 }],
      },
    })
    expect(back?.events[1]).toMatchObject({ unit: { path: [{ x: 2, y: 2 }, { x: 3, y: 3 }, { x: 3, y: 4 }], goal: { x: 3, y: 4 } } })
    expect(back?.events[2]).toMatchObject({ city: { layout: { tiles: layout.tiles }, state: { ruins: state.ruins } } })
    expect(back?.events[3]).toMatchObject({ city: { layout: null } })
  })

  it("carries a moving unit's snapshot through a frame unchanged at every tick", () => {
    const game = new Game(new World(24, 12))
    const player = game.addPlayer()
    const tank = game.spawn(player, UnitTypeId.MedTank, { x: 1, y: 2 }, Math.PI / 2)
    expect(game.orderMove(player.id, [tank.id], { x: 19, y: 9 })).toBe(true)
    for (let tick = 1; tick <= 240; tick++) {
      game.tick(SIM_STEP)
      const [unit] = game.unitSnapshots()
      const back = decodeServerFrame(encodeServerFrame({ tick, ack: 0, events: [{ kind: ServerEventKind.UnitMotion, unit }] }))
      expect(back?.events).toEqual([{ kind: ServerEventKind.UnitMotion, unit }])
    }
    expect(tank.tile).toEqual({ x: 19, y: 9 })
  })
})
