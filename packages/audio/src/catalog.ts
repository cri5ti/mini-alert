// One-shot catalog and the map from a unit to the sounds the game should play.
import oneshotFile from '../presets/oneshots.json'
import { playRecipe, type SoundPreset } from './recipe.ts'
import { playAt } from './spatial.ts'

export const oneshots = oneshotFile as SoundPreset[]

export const UNIT_AUDIO = {
  scout: { engine: 'engine.scout', weapon: 'weapon.mg', death: 'death.scout' },
  medTank: { engine: 'engine.med-tank', weapon: 'weapon.shell-med', death: 'death.med-tank' },
  heavyTank: { engine: 'engine.heavy-tank', weapon: 'weapon.shell-heavy', death: 'death.heavy-tank' },
  artillery: { engine: 'engine.artillery', weapon: 'weapon.howitzer', death: 'death.artillery', incoming: 'weapon.incoming' },
  turret: { weapon: 'weapon.turret', slew: 'weapon.turret-slew', death: 'death.turret' },
  jet: { engine: 'engine.jet', weapon: 'weapon.rocket', death: 'death.jet' },
  gunship: { engine: 'engine.gunship', weapon: 'weapon.gunship', death: 'death.gunship' },
  cruiser: { engine: 'engine.cruiser', weapon: 'weapon.naval', death: 'death.cruiser' },
  factory: { death: 'death.structure' },
  airport: { death: 'death.structure' },
  helipad: { death: 'death.structure' },
  shipyard: { death: 'death.structure' },
} as const

export function preset(id: string) {
  return oneshots.find((s) => s.id === id)
}

export function play(id: string, at?: { x: number; y: number; alt?: number }) {
  const sound = preset(id)
  if (!sound) throw new Error(`unknown sound ${id}`)
  if (at && sound.spatial) {
    playAt(at.x, at.y, (t) => playRecipe(sound.steps, t), { alt: at.alt ?? 0, life: 16 })
    return
  }
  playRecipe(sound.steps)
}
