// Drives the procedural audio package from what this client can see.
import {
  audio,
  CHANNELS,
  createEngine,
  type EngineVoice,
  music,
  type MoodName,
  play,
  setListener,
  setZoom,
  space,
  speak,
  UNIT_AUDIO,
  useVoiceClips,
} from '../../packages/audio/src/index.ts'
import type { CityState, ShotEvent, ShotHit, UnitSnapshot } from '../shared/protocol.ts'
import { scarStrength, Terrain } from '../shared/tiles.ts'
import { UNIT_TYPES, WeaponKind, yardOf, type UnitTypeId } from '../shared/unit-types.ts'

const voiceClips = import.meta.glob('../../assets/voices/*/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
})
useVoiceClips(voiceClips)

const IDLE_SECONDS = 1.4
const ATTACK_MS = 6_000
const KILL_WINDOW_MS = 6_000
const HAPPY_MS = 8_000
const ARMY_WINDOW_MS = 10_000
const DOWN_MS = 20_000
const FEW_KILLS = 2
const BUILD_GAP_MS = 260

type UnitSound = {
  engine?: string
  weapon?: string
  death: string
  incoming?: string
  slew?: string
}

const BY_TYPE: UnitSound[] = [
  UNIT_AUDIO.scout,
  UNIT_AUDIO.medTank,
  UNIT_AUDIO.heavyTank,
  UNIT_AUDIO.artillery,
  UNIT_AUDIO.factory,
  UNIT_AUDIO.turret,
  UNIT_AUDIO.jet,
  UNIT_AUDIO.gunship,
  UNIT_AUDIO.cruiser,
  UNIT_AUDIO.airport,
  UNIT_AUDIO.helipad,
  UNIT_AUDIO.shipyard,
]

type Known = {
  health: number
  progress: number
  yaw: number
  slew: number
  x: number
  z: number
}

export type SoundFrame = {
  units: readonly UnitSnapshot[]
  shots: readonly ShotEvent[]
  hits: readonly ShotHit[]
  cities: readonly (CityState | null)[]
  credits: number
  playerId: number | null
  terrain: readonly number[] | null
  width: number
  selected: readonly number[]
  ear: { x: number; z: number; yaw: number; zoom: number; span: number }
  dt: number
}

class GameSound {
  private mode: 'silent' | 'lobby' | 'match' = 'silent'
  private muted = false
  private booted = false
  private watched: number | null = null
  private credits = 0
  private selection = ''
  private owners: number[] = []
  private ruins: number[] = []
  private readonly known = new Map<number, Known>()
  private readonly engines = new Map<number, EngineVoice>()
  private readonly idle = new Map<number, number>()
  private readonly buildAt = new Map<number, number>()
  private readonly said = new Map<string, number>()
  private readonly killAt: number[] = []
  private readonly lossAt: number[] = []
  private readonly armyAt: { t: number; n: number }[] = []
  private attackedUntil = 0
  private happyUntil = 0
  private depressedUntil = 0
  private mood: MoodName | null = null

  lobby() {
    this.mode = 'lobby'
    music.setContext('lobby')
    if (!this.muted) this.ensure()
  }

  match() {
    const enter = this.mode !== 'match'
    this.mode = 'match'
    if (enter) {
      music.setContext('battle')
      this.applyMood('inquisitive')
    }
    if (!this.muted) this.ensure()
  }

  silent() {
    this.mode = 'silent'
    music.stop()
  }

  setMuted(muted: boolean) {
    this.muted = muted
    for (const channel of CHANNELS) music.setMute(channel, muted)
    if (!muted && this.mode !== 'silent') this.ensure()
  }

  resume() {
    audio()
    if (this.muted || this.mode === 'silent' || music.playing) return
    music.start()
  }

  reset() {
    for (const voice of this.engines.values()) voice.stop()
    this.engines.clear()
    this.idle.clear()
    this.known.clear()
    this.buildAt.clear()
    this.owners = []
    this.ruins = []
    this.selection = ''
    this.booted = false
    this.watched = null
    this.clearFight()
  }

  click() {
    this.tap('ui.click', 40)
  }

  move() {
    play('ui.move')
    this.line('yes-sir', 1200)
  }

  attack() {
    play('ui.attack')
    this.line('affirmative', 1200)
  }

  invalid() {
    this.tap('ui.invalid', 280)
  }

  unable() {
    this.invalid()
    this.line('unable-to-deploy', 1200)
  }

  refused(broke: boolean) {
    this.invalid()
    this.line(broke ? 'not-enough-credits' : 'not-enough-population', 1200)
  }

  tree(x: number, z: number) {
    play('death.tree', { x, y: z })
  }

  outcome(won: boolean) {
    if (!won && this.mode === 'match') music.setContext('defeat')
    this.line(won ? 'victory' : 'defeat', 60_000)
  }

  sync(frame: SoundFrame) {
    setListener(frame.ear.x, frame.ear.z, space.listenerHeight, frame.ear.yaw)
    setZoom(frame.ear.zoom)
    if (this.watched !== frame.playerId) {
      this.watched = frame.playerId
      this.known.clear()
      this.booted = false
      this.owners = []
      this.ruins = []
      this.selection = ''
      this.clearFight()
    }
    const byId = new Map<number, UnitSnapshot>()
    for (const unit of frame.units) byId.set(unit.id, unit)
    if (this.booted) {
      this.fire(frame, byId)
      this.impacts(frame)
      this.units(frame, byId)
      this.cities(frame)
      this.money(frame.credits)
      this.pick(frame.selected)
      this.conduct(frame)
    }
    this.remember(frame)
    this.drive(frame, byId)
    this.booted = true
  }

  private clearFight() {
    this.killAt.length = 0
    this.lossAt.length = 0
    this.armyAt.length = 0
    this.attackedUntil = 0
    this.happyUntil = 0
    this.depressedUntil = 0
    this.mood = null
  }

  private conduct(frame: SoundFrame) {
    if (this.mode !== 'match' || music.context === 'defeat') return
    const now = performance.now()
    const playerId = frame.playerId
    let army = 0
    for (const unit of frame.units) {
      const prior = this.known.get(unit.id)
      const fighter = fighting(unit.typeId)
      if (fighter && unit.ownerId === playerId && unit.health > 0 && unit.progress >= 1) army += 1
      if (!prior || prior.health <= 0 || unit.health > 0) continue
      if (unit.ownerId === playerId) {
        this.attackedUntil = now + ATTACK_MS
        if (fighter) this.lossAt.push(now)
      } else if (fighter) this.killAt.push(now)
      continue
    }
    for (const unit of frame.units) {
      const prior = this.known.get(unit.id)
      if (!prior || unit.ownerId !== playerId || unit.health <= 0 || prior.health <= unit.health) continue
      this.attackedUntil = now + ATTACK_MS
    }
    const recent = (times: number[], window: number) => {
      let count = 0
      for (let i = times.length - 1; i >= 0; i--) {
        if (now - times[i] > window) break
        count += 1
      }
      return count
    }
    while (this.killAt.length > 0 && now - this.killAt[0] > ARMY_WINDOW_MS) this.killAt.shift()
    while (this.lossAt.length > 0 && now - this.lossAt[0] > ARMY_WINDOW_MS) this.lossAt.shift()
    const last = this.armyAt[this.armyAt.length - 1]
    if (!last || now - last.t >= 500) this.armyAt.push({ t: now, n: army })
    const cut = now - ARMY_WINDOW_MS
    while (this.armyAt.length > 1 && this.armyAt[1].t <= cut) this.armyAt.shift()
    const then = this.armyAt[0]
    const losses = recent(this.lossAt, ARMY_WINDOW_MS)
    const kills = recent(this.killAt, ARMY_WINDOW_MS)
    if (then && then.t <= cut && then.n >= 2 && army <= then.n * 0.25 && losses > kills && now >= this.depressedUntil) {
      this.depressedUntil = now + DOWN_MS
    }
    if (recent(this.killAt, KILL_WINDOW_MS) >= FEW_KILLS) this.happyUntil = now + HAPPY_MS
    const mood: MoodName = now < this.depressedUntil ? 'defeated'
      : now < this.happyUntil ? 'exciting'
      : now < this.attackedUntil ? 'anxious'
      : 'inquisitive'
    this.applyMood(mood)
  }

  private applyMood(mood: MoodName) {
    if (this.mood === mood) return
    this.mood = mood
    const names = ['calm', 'inquisitive', 'exciting', 'anxious', 'defeated'] as const
    for (const name of names) music.setMood(name, name === mood ? 1 : 0)
  }

  private ensure() {
    if (!music.playing) music.start()
  }

  private tap(id: string, gap: number) {
    const now = performance.now()
    if (now - (this.said.get(id) ?? 0) < gap) return
    this.said.set(id, now)
    play(id)
  }

  private line(id: string, gap: number) {
    const now = performance.now()
    if (now - (this.said.get(`v:${id}`) ?? 0) < gap) return
    this.said.set(`v:${id}`, now)
    void speak(id)
  }

  private fire(frame: SoundFrame, byId: ReadonlyMap<number, UnitSnapshot>) {
    for (const shot of frame.shots) {
      const shooter = byId.get(shot.shooterId)
      const prior = this.known.get(shot.shooterId)
      const typeId = shooter?.typeId
      const spec = typeId === undefined ? undefined : BY_TYPE[typeId]
      const kind = shot.kind
      const weapon = spec?.weapon ?? (kind === WeaponKind.Bullet ? 'weapon.mg' : kind === WeaponKind.Rocket ? 'weapon.rocket' : 'weapon.shell-med')
      const x = shooter?.x ?? prior?.x ?? shot.x
      const z = shooter?.z ?? prior?.z ?? shot.z
      play(weapon, { x, y: z, alt: shooter?.altitude ?? 0 })
      if (spec?.incoming) play(spec.incoming, { x: shot.aimX, y: shot.aimZ })
    }
  }

  private impacts(frame: SoundFrame) {
    const deaths: { x: number; z: number }[] = []
    for (const unit of frame.units) {
      const prior = this.known.get(unit.id)
      if (!prior || prior.health <= 0 || unit.health > 0) continue
      deaths.push({ x: unit.x, z: unit.z })
      play(BY_TYPE[unit.typeId]?.death ?? 'death.structure', { x: unit.x, y: unit.z, alt: unit.altitude ?? 0 })
      if (unit.ownerId === frame.playerId) this.alarm()
    }
    for (const hit of frame.hits) {
      let killed = false
      for (const spot of deaths) {
        if (Math.hypot(spot.x - hit.aimX, spot.z - hit.aimZ) < 1.5) killed = true
      }
      if (killed) continue
      const wet = wetAt(frame.terrain, frame.width, hit.aimX, hit.aimZ)
      const id = wet ? 'impact.splash' : hit.kind === WeaponKind.Rocket ? 'impact.rocket' : hit.kind === WeaponKind.Bullet ? 'impact.bullet' : 'impact.shell'
      play(id, { x: hit.aimX, y: hit.aimZ })
    }
  }

  private units(frame: SoundFrame, byId: ReadonlyMap<number, UnitSnapshot>) {
    const now = performance.now()
    const playerId = frame.playerId
    for (const unit of frame.units) {
      if (unit.health <= 0) continue
      const prior = this.known.get(unit.id)
      const type = UNIT_TYPES[unit.typeId]
      const built = type.topSpeed <= 0
      if (!prior && built && unit.progress < 1) play('ui.place', { x: unit.x, y: unit.z })
      if (prior && prior.health > unit.health && unit.ownerId === playerId) this.alarm()
      if (prior && built && prior.progress < 1 && unit.progress >= 1) {
        play('ui.complete', { x: unit.x, y: unit.z })
        if (unit.ownerId === playerId) this.line('construction-complete', 400)
      }
      if (!prior && !built && unit.ownerId === playerId && unit.progress >= 1 && besideYard(unit, byId, playerId)) {
        play('ui.ready', { x: unit.x, y: unit.z })
        this.line('unit-ready', 400)
      }
      if (built && unit.progress < 1 && unit.ownerId === playerId && now >= (this.buildAt.get(unit.id) ?? 0)) {
        play('ui.construct', { x: unit.x, y: unit.z })
        this.buildAt.set(unit.id, now + BUILD_GAP_MS)
      }
      const spec = BY_TYPE[unit.typeId]
      if (prior && spec?.slew && Math.abs(wrap(unit.turretYaw - prior.yaw)) > 0.4 && now - prior.slew > 900) {
        play(spec.slew, { x: unit.x, y: unit.z })
        prior.slew = now
      }
    }
  }

  private cities(frame: SoundFrame) {
    const playerId = frame.playerId
    let ruinsPlayed = 0
    for (let i = 0; i < frame.cities.length; i++) {
      const city = frame.cities[i]
      if (!city) continue
      const owner = this.owners[i]
      if (owner !== undefined && owner !== city.ownerId && city.ownerId === playerId) {
        const site = city.sites[0]
        if (site) play('ui.capture', { x: site.x, y: site.y })
        this.line('city-conquered', 1500)
      }
      const fallen = city.ruins.length - (this.ruins[i] ?? city.ruins.length)
      for (let n = 0; n < fallen && ruinsPlayed < 3; n++) {
        const tile = city.ruins[city.ruins.length - 1 - n]
        if (!tile) continue
        play('death.structure', { x: tile.x + 0.5, y: tile.y + 0.5 })
        ruinsPlayed += 1
      }
    }
  }

  private money(credits: number) {
    if (credits > this.credits) play('ui.credits-in')
    else if (credits < this.credits) play('ui.credits-out')
    this.credits = credits
  }

  private pick(selected: readonly number[]) {
    const key = [...selected].sort((a, b) => a - b).join(',')
    if (key !== this.selection && key.length > 0) play('ui.select')
    this.selection = key
  }

  private alarm() {
    this.tap('ui.radar', 12_000)
    this.line('under-attack', 12_000)
  }

  private remember(frame: SoundFrame) {
    const seen = new Set<number>()
    const now = performance.now()
    for (const unit of frame.units) {
      seen.add(unit.id)
      const prior = this.known.get(unit.id)
      this.known.set(unit.id, {
        health: unit.health,
        progress: unit.progress,
        yaw: unit.turretYaw,
        slew: prior?.slew ?? now,
        x: unit.x,
        z: unit.z,
      })
    }
    for (const id of this.known.keys()) if (!seen.has(id)) this.known.delete(id)
    this.owners = frame.cities.map((city) => city?.ownerId ?? -1)
    this.ruins = frame.cities.map((city) => city?.ruins.length ?? 0)
    this.credits = frame.credits
    this.selection = [...frame.selected].sort((a, b) => a - b).join(',')
  }

  private drive(frame: SoundFrame, byId: ReadonlyMap<number, UnitSnapshot>) {
    const live = new Set<number>()
    const ear = frame.ear
    const hear = Math.max(28, ear.span * 1.5)
    for (const unit of frame.units) {
      const spec = BY_TYPE[unit.typeId]
      if (!spec?.engine || unit.health <= 0) continue
      const dist = Math.hypot(unit.x - ear.x, unit.z - ear.z)
      const held = this.engines.has(unit.id)
      if (dist > (held ? hear * 1.35 : hear)) continue
      const type = UNIT_TYPES[unit.typeId]
      const airborne = (unit.altitude ?? 0) > 0.3
      const moving = unit.speed > 0.05 || airborne || unit.path.length > 0
      let voice = this.engines.get(unit.id)
      if (!voice) {
        if (!moving) continue
        voice = createEngine(spec.engine)
        voice.ignite(unit.speed > type.topSpeed * 0.2)
        this.engines.set(unit.id, voice)
      }
      live.add(unit.id)
      let pace = type.topSpeed > 0 ? unit.speed / type.topSpeed : 0
      if (airborne) pace = Math.max(pace, 0.35)
      voice.setSpeed(Math.min(1, pace), true)
      voice.setTerrain(surface(frame.terrain, frame.width, unit.tileX, unit.tileY))
      voice.setPosition(unit.x, unit.z, unit.altitude ?? 0)
      if (moving) this.idle.set(unit.id, 0)
      else this.idle.set(unit.id, (this.idle.get(unit.id) ?? 0) + frame.dt)
    }
    for (const [id, voice] of this.engines) {
      if (!byId.has(id) || (byId.get(id)?.health ?? 0) <= 0) {
        voice.stop()
        this.engines.delete(id)
        this.idle.delete(id)
        continue
      }
      if (live.has(id)) {
        const idle = this.idle.get(id) ?? 0
        if (idle <= IDLE_SECONDS) continue
      }
      voice.shutdown()
      this.engines.delete(id)
      this.idle.delete(id)
    }
  }
}

function fighting(typeId: UnitTypeId): boolean {
  const type = UNIT_TYPES[typeId]
  return type.topSpeed > 0 || type.weapon.damage > 0
}

function besideYard(unit: UnitSnapshot, byId: ReadonlyMap<number, UnitSnapshot>, playerId: number | null): boolean {
  const yard = yardOf(unit.typeId)
  for (const other of byId.values()) {
    if (other.ownerId !== playerId || other.typeId !== yard || other.progress < 1) continue
    if (Math.hypot(unit.x - other.x, unit.z - other.z) < 4) return true
  }
  return false
}

function surface(terrain: readonly number[] | null, width: number, x: number, y: number): string {
  if (!terrain || width <= 0) return 'grass'
  return ground(terrain[y * width + x])
}

function wetAt(terrain: readonly number[] | null, width: number, x: number, z: number): boolean {
  if (!terrain || width <= 0) return false
  const cell = terrain[Math.floor(z) * width + Math.floor(x)]
  return cell === Terrain.Water || cell === Terrain.Lake
}

function ground(cell: number | undefined): string {
  if (cell === Terrain.Road) return 'road'
  if (cell === Terrain.Forest || cell === Terrain.Tree) return 'forest'
  if (cell === Terrain.Town) return 'town'
  if (cell === Terrain.Water || cell === Terrain.Lake) return 'water'
  if (scarStrength(cell ?? 0) > 0) return 'scar'
  return 'grass'
}

function wrap(delta: number): number {
  let angle = delta
  while (angle > Math.PI) angle -= Math.PI * 2
  while (angle < -Math.PI) angle += Math.PI * 2
  return angle
}

export const sound = new GameSound()
