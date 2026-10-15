import type { ClientPort } from '../shared/protocol.ts'
import { ClientMessageKind } from '../shared/protocol.ts'
import type { TileCoord } from '../shared/tiles.ts'
import { Locomotion, UNIT_TYPES, UnitTypeId, yardOf } from '../shared/unit-types.ts'
import type { UnitSnapshot } from '../shared/protocol.ts'
import type { Replica } from './replica.ts'

const GROUP_SLOTS = 10
const YARDS = new Set<UnitTypeId>([UnitTypeId.Factory, UnitTypeId.Airport, UnitTypeId.Helipad, UnitTypeId.Shipyard])

export class Commander {
  private selectedIds: number[] = []
  private groups: number[][] = emptyGroups()
  private placing: UnitTypeId | null = null
  private raising = false
  private aim: TileCoord | null = null
  private hall: number | null = null
  private spectating = false
  private readonly replica: Replica
  private readonly port: ClientPort

  constructor(replica: Replica, port: ClientPort) {
    this.replica = replica
    this.port = port
  }

  reset() {
    this.selectedIds = []
    this.groups = emptyGroups()
    this.cancelPlace()
    this.hall = null
  }

  setSpectating(on: boolean) {
    this.spectating = on
    if (!on) return
    this.selectedIds = []
    this.placing = null
    this.raising = false
    this.aim = null
    this.hall = null
  }

  select(id: number | null) {
    this.hall = null
    if (this.spectating) {
      this.selectedIds = []
      return
    }
    if (id === null) {
      this.selectedIds = []
      return
    }
    const unit = this.replica.unit(id)
    if (!unit || unit.ownerId !== this.replica.playerId) return
    if (UNIT_TYPES[unit.typeId].topSpeed <= 0 && !YARDS.has(unit.typeId)) return
    this.selectedIds = [id]
  }

  selectIds(ids: readonly number[]) {
    this.hall = null
    const own: number[] = []
    for (const id of ids) {
      const unit = this.replica.unit(id)
      if (!unit || unit.ownerId !== this.replica.playerId || UNIT_TYPES[unit.typeId].topSpeed <= 0 || own.includes(id)) continue
      own.push(id)
    }
    this.selectedIds = own
  }

  addIds(ids: readonly number[]) {
    this.selectIds([...this.selectedIds, ...ids])
  }

  toggle(id: number) {
    if (this.selectedIds.includes(id)) this.selectIds(this.selectedIds.filter((other) => other !== id))
    else this.addIds([id])
  }

  assignGroup(slot: number) {
    if (this.spectating) return
    const ids = this.selected()
      .filter((unit) => UNIT_TYPES[unit.typeId].topSpeed > 0)
      .map((unit) => unit.id)
    this.groups = this.groups.map((group) => group.filter((id) => !ids.includes(id)))
    this.groups[slot] = ids
  }

  recallGroup(slot: number, add: boolean): UnitSnapshot[] {
    const units = this.members(slot)
    this.groups[slot] = units.map((unit) => unit.id)
    if (units.length === 0) return units
    if (add) this.addIds(this.groups[slot])
    else this.selectIds(this.groups[slot])
    return units
  }

  groupOf(): number | null {
    const live = new Set(this.selected().filter((unit) => unit.health > 0).map((unit) => unit.id))
    if (live.size === 0) return null
    for (let slot = 0; slot < GROUP_SLOTS; slot++) {
      if (this.groups[slot].length < live.size) continue
      const members = this.members(slot)
      if (members.length === live.size && members.every((unit) => live.has(unit.id))) return slot
    }
    return null
  }

  private members(slot: number): UnitSnapshot[] {
    const units: UnitSnapshot[] = []
    for (const id of this.groups[slot]) {
      const unit = this.replica.unit(id)
      if (unit && unit.ownerId === this.replica.playerId && unit.health > 0) units.push(unit)
    }
    return units
  }

  selectCity(index: number | null) {
    if (this.spectating) return
    if (index === null) {
      this.hall = null
      return
    }
    const state = this.replica.cities[index]
    if (!state || state.ownerId !== this.replica.playerId) return
    this.selectedIds = []
    this.placing = null
    this.raising = false
    this.hall = index
  }

  selectedCity(): number | null {
    if (this.hall === null) return null
    const state = this.replica.cities[this.hall]
    if (!state || state.ownerId !== this.replica.playerId) {
      this.hall = null
      return null
    }
    return this.hall
  }

  setCityFocus(focus: number) {
    const index = this.selectedCity()
    if (index === null || this.spectating) return
    const step = Math.max(-2, Math.min(2, Math.round(focus)))
    this.replica.setCityFocus(index, step)
    this.port.send({ kind: ClientMessageKind.SetCityFocus, index, focus: step })
  }

  commanding(): boolean {
    return this.selected().some((unit) => UNIT_TYPES[unit.typeId].topSpeed > 0)
  }

  productionYard(): UnitSnapshot | null {
    const units = this.selected()
    if (units.length !== 1) return null
    const unit = units[0]
    if (unit.health <= 0 || !YARDS.has(unit.typeId)) return null
    return unit
  }

  factorySelected(): boolean {
    const units = this.selected()
    return units.length === 1 && units[0].typeId === UnitTypeId.Factory
  }

  selected(): UnitSnapshot[] {
    const units: UnitSnapshot[] = []
    for (const id of this.selectedIds) {
      const unit = this.replica.unit(id)
      if (!unit || unit.ownerId !== this.replica.playerId) continue
      units.push(unit)
    }
    return units
  }

  setRally(tile: TileCoord) {
    if (this.spectating || !this.factorySelected()) return
    const seq = this.port.send({ kind: ClientMessageKind.SetRally, tile })
    if (seq !== null) this.replica.expectRally(seq, tile)
  }

  orderMove(tile: TileCoord): TileCoord[] {
    const goals = this.sendMove(this.orderable(), tile)
    return goals.length > 0 ? goals : [tile]
  }

  orderReturn(): TileCoord[] {
    if (this.spectating) return []
    const groups = new Map<string, { tile: TileCoord; ids: number[] }>()
    for (const unit of this.selected()) {
      const type = UNIT_TYPES[unit.typeId]
      if (type.locomotion !== Locomotion.Plane && type.locomotion !== Locomotion.Rotor) continue
      if (!unit.home) continue
      const key = `${unit.home.x},${unit.home.y}`
      const group = groups.get(key) ?? { tile: { x: unit.home.x, y: unit.home.y }, ids: [] }
      group.ids.push(unit.id)
      groups.set(key, group)
    }
    const marks: TileCoord[] = []
    for (const group of groups.values()) {
      const goals = this.sendMove(group.ids, group.tile)
      marks.push(...(goals.length > 0 ? goals : [group.tile]))
    }
    return marks
  }

  private sendMove(unitIds: number[], tile: TileCoord): TileCoord[] {
    if (unitIds.length === 0) return []
    if (this.port.send({ kind: ClientMessageKind.OrderMove, unitIds, tile }) === null) return []
    return this.replica.predictMove(unitIds, tile)
  }

  orderAttack(targetId: number) {
    const unitIds = this.orderable().filter((id) => id !== targetId)
    if (unitIds.length === 0) return
    if (this.port.send({ kind: ClientMessageKind.OrderAttack, unitIds, targetId }) === null) return
    const target = this.replica.unit(targetId)
    if (target) this.replica.predictAttack(unitIds, target, targetId)
  }

  orderAttackGround(tile: TileCoord) {
    const unitIds = this.orderable()
    if (unitIds.length === 0) return
    if (this.port.send({ kind: ClientMessageKind.OrderAttackGround, unitIds, tile }) === null) return
    this.replica.predictAttack(unitIds, { x: tile.x + 0.5, z: tile.y + 0.5 }, null)
  }

  private orderable(): number[] {
    if (this.spectating) return []
    return this.selected().map((unit) => unit.id)
  }

  spawn(typeId: UnitTypeId) {
    if (this.spectating) return
    const yard = this.productionYard()
    if (!yard || yard.progress < 1 || yardOf(typeId) !== yard.typeId) return
    const seq = this.port.send({ kind: ClientMessageKind.Spawn, typeId, yardId: yard.id })
    if (seq !== null) this.replica.expectTraining(seq, typeId, yard.id)
  }

  cancelSpawn(typeId: UnitTypeId, yardId = 0) {
    if (this.spectating) return
    this.port.send({ kind: ClientMessageKind.CancelSpawn, typeId, yardId })
  }

  cancelBuild(typeId: UnitTypeId) {
    if (this.spectating) return
    this.port.send({ kind: ClientMessageKind.CancelBuilding, typeId })
  }

  placingType(): UnitTypeId | null {
    return this.placing
  }

  raisingCity(): boolean {
    return this.raising
  }

  aimedTile(): TileCoord | null {
    return this.aim
  }

  setAim(tile: TileCoord | null) {
    this.aim = tile
  }

  armBuilding(typeId: UnitTypeId) {
    if (this.spectating) return
    this.raising = false
    this.aim = null
    this.placing = this.placing === typeId ? null : typeId
  }

  armCity() {
    if (this.spectating) return
    this.placing = null
    this.raising = !this.raising
    if (!this.raising) this.aim = null
  }

  cancelPlace() {
    this.placing = null
    this.raising = false
    this.aim = null
  }

  placeBuilding(tile: TileCoord) {
    if (this.spectating || this.placing === null) return
    const seq = this.port.send({ kind: ClientMessageKind.PlaceBuilding, typeId: this.placing, tile })
    if (seq !== null) this.replica.expectSite(seq, { typeId: this.placing, tile })
    this.placing = null
  }

  placeCity(tile: TileCoord) {
    if (this.spectating || !this.raising) return
    const seq = this.port.send({ kind: ClientMessageKind.PlaceCity, tile })
    if (seq !== null) this.replica.expectSite(seq, { typeId: null, tile })
    this.raising = false
    this.aim = null
  }
}

function emptyGroups(): number[][] {
  return Array.from({ length: GROUP_SLOTS }, () => [])
}
