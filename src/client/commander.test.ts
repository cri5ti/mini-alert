import { describe, expect, it } from 'vitest'
import type { ClientMessage, ClientPort, UnitSnapshot } from '../shared/protocol.ts'
import { UnitTypeId } from '../shared/unit-types.ts'
import { Commander } from './commander.ts'
import { Replica } from './replica.ts'

function unit(id: number, typeId: UnitTypeId, ownerId = 1): UnitSnapshot {
  return {
    id,
    typeId,
    ownerId,
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
  }
}

function setup() {
  const replica = new Replica()
  replica.playerId = 1
  replica.units = [
    unit(1, UnitTypeId.MedTank),
    unit(2, UnitTypeId.MedTank),
    unit(3, UnitTypeId.Scout),
    unit(4, UnitTypeId.Factory),
    unit(5, UnitTypeId.MedTank, 2),
  ]
  const sent: ClientMessage[] = []
  const port: ClientPort = { send: (message) => sent.push(message), onServer() {} }
  return { replica, player: new Commander(replica, port) }
}

const ids = (player: Commander) => player.selected().map((selected) => selected.id)

describe('commander selection', () => {
  it('toggles units in and out and drops a selected structure', () => {
    const { player } = setup()
    player.select(4)
    player.toggle(1)
    player.toggle(2)
    expect(ids(player)).toEqual([1, 2])
    player.toggle(1)
    expect(ids(player)).toEqual([2])
  })

  it('adds a box to the selection without enemies or structures', () => {
    const { player } = setup()
    player.select(1)
    player.addIds([3, 4, 5, 1])
    expect(ids(player)).toEqual([1, 3])
  })

  it('moves a unit to the group it was last assigned to', () => {
    const { player } = setup()
    player.selectIds([1, 2])
    player.assignGroup(1)
    player.selectIds([2, 3])
    player.assignGroup(2)
    player.select(null)
    expect(player.recallGroup(1, false).map((recalled) => recalled.id)).toEqual([1])
    expect(ids(player)).toEqual([1])
    player.recallGroup(2, true)
    expect(ids(player)).toEqual([1, 2, 3])
  })

  it('keeps the selection when a group has no living units', () => {
    const { replica, player } = setup()
    player.selectIds([3])
    player.assignGroup(5)
    player.select(1)
    replica.units = replica.units.filter((other) => other.id !== 3)
    expect(player.recallGroup(5, false)).toEqual([])
    expect(ids(player)).toEqual([1])
  })
})

describe('commander groups', () => {
  it('names the group whose live members are the selection', () => {
    const { replica, player } = setup()
    expect(player.groupOf()).toBeNull()
    player.selectIds([1, 2])
    player.assignGroup(3)
    expect(player.groupOf()).toBe(3)
    player.toggle(3)
    expect(player.groupOf()).toBeNull()
    player.recallGroup(3, false)
    expect(player.groupOf()).toBe(3)
    replica.units = replica.units.map((other) => (other.id === 2 ? { ...other, health: 0 } : other))
    expect(player.groupOf()).toBe(3)
    player.selectIds([1, 3])
    expect(player.groupOf()).toBeNull()
    player.select(1)
    expect(player.groupOf()).toBe(3)
    player.select(null)
    expect(player.groupOf()).toBeNull()
  })
})
