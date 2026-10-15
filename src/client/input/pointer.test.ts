// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { UnitSnapshot } from '../../shared/protocol.ts'
import { UnitTypeId } from '../../shared/unit-types.ts'
import type { Commander } from '../commander.ts'
import type { GameView } from '../render/view.ts'
import type { Replica } from '../replica.ts'
import { bindInput } from './pointer.ts'

function stub<T extends object>(fields: Partial<T>): T {
  return new Proxy(fields, { get: (target, key) => (key in target ? target[key as keyof T] : () => undefined) }) as T
}

describe('bindInput', () => {
  it('selects every unit of the double-clicked kind inside the canvas', () => {
    const tank = { id: 7, typeId: UnitTypeId.MedTank, ownerId: 1 } as UnitSnapshot
    const canvas = document.createElement('canvas')
    canvas.setPointerCapture = () => {}
    canvas.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 44, width: 980, height: 676 })
    document.body.append(canvas)
    const unitsInRect = vi.fn<GameView['unitsInRect']>(() => [tank.id])
    const view = stub<GameView>({ unitsInRect, pickUnit: () => tank.id, pickTile: () => null, pickCityBuilding: () => null })
    const replica = stub<Replica>({ playerId: 1, units: [tank], unit: () => tank, ownedHall: () => null })
    const player = stub<Commander>({ placingType: () => null, raisingCity: () => false, commanding: () => false })
    bindInput(canvas, replica, player, view)
    for (let click = 0; click < 2; click++) {
      canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 300, clientY: 300 }))
      canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 300, clientY: 300 }))
    }
    expect(unitsInRect.mock.calls).toEqual([[0, 44, 980, 720, [tank], 1]])
  })
})
