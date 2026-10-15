import { createLocalLink } from '../shared/local-link.ts'
import { KEEPALIVE_TICKS, MOTION_HEARTBEAT, SNAPSHOT_COOLDOWN, wrapAngle } from '../shared/motion.ts'
import {
  ClientMessageKind,
  ServerEventKind,
  type CityRecord,
  type CityState,
  type ClientMessage,
  type ClientPort,
  type MapData,
  type MapPoint,
  type ServerEvent,
  type ServerFrame,
  type ShotEvent,
  type TrainJob,
  type ShotHit,
  type UnitSnapshot,
} from '../shared/protocol.ts'
import { CITY_SIGHT, type CityLayout } from '../shared/cities.ts'
import { type TileCoord } from '../shared/tiles.ts'
import { spanOf, UNIT_TYPES, WeaponKind } from '../shared/unit-types.ts'
import { EXPLORE_MARGIN, type CitySight, type SightSource } from '../shared/vision.ts'
import type { AiPlayer } from '../ai/player.ts'
import { Replica } from '../client/replica.ts'
import type { Game } from './game.ts'
import type { Player } from './player.ts'
import { __TRACE__, traceBegin, traceEnd } from './trace.ts'
import { TraceSlot } from '../shared/trace.ts'

const PROGRESS_STEPS = 40
const LEDGER_TICKS = 6
const SNAPSHOT_COOLDOWN_MS = 1000
const DRIFT_TILES = 0.25
const DRIFT_TURN = 0.35
const DRIFT_ALTITUDE = 0.25
const BACKSTOP_TICKS = 300
const CATCH_UP_TICKS = 15
const MARGIN_OFFSETS = discOffsets(EXPLORE_MARGIN)
const NO_UNITS: ReadonlySet<number> = new Set()

type LayoutClip = { source: CityLayout; layout: CityLayout; shape: string }

type StateClip = { source: string; state: CityState; core: string; progress: number }

type VisibleCity = { index: number; layout: LayoutClip; state: StateClip }

type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

/** What an owner's cities and structures light: `discs` holds x, z, sight per source and `rects` tileX, tileY, spanX, spanY per structure. */
type StaticLayer = { discs: number[]; rects: number[]; lit: Uint8Array }

/** A mobile unit's sight disc and footprint; `pass` is the last parking pass that saw the unit. */
type Pose = { x: number; z: number; sight: number; tileX: number; tileY: number; spanX: number; spanY: number; parked: boolean; pass: number }

/**
 * What an owner's parked mobile units light, shared by every session of that owner: `lit` counts the parked discs
 * and footprints over each tile. A unit parks only at a pose every session scanned on the tick before, so its tiles'
 * margins are explored and reveal skips it until it leaves that pose.
 */
type Parking = { owner: number; poses: Map<number, Pose>; lit: Uint16Array; pass: number }

/** A change that may wait for the next frame going out anyway, or for the ledger cadence. */
type Deferred = { event: ServerEvent; commit(): void }

type Session = {
  playerId: number
  playing: boolean
  /** Remote players get a command's result at once instead of on the next tick. */
  echo: boolean
  ack: number
  /** What a remote player's client holds apart from its own order guesses: fed every frame sent and stepped like the client, so units are corrected when they drift from it or are ordered. */
  shadow: Replica | null
  send(message: ServerFrame): void
}

type Memory = {
  owner: number
  explored: Uint8Array
  /** Holds `sight` for tiles in view this tick and `sight - 1` for tiles in view last tick. */
  visible: Uint32Array
  sight: number
  /** The static layer `visible` was last stamped against; its tiles count as in view whether or not `visible` holds them. */
  layer: StaticLayer | null
  parking: Parking
  felledSeen: number
  scarredSeen: number
  /** Tiles explored or changed since the last map patch went out. */
  unsentTiles: Set<number>
  seen: Set<number>
  route: Map<number, number>
  motionTick: Map<number, number>
  health: Map<number, number>
  progress: Map<number, number>
  rounds: Map<number, number>
  cityCore: Map<number, string>
  cityProgress: Map<number, number>
  cityShape: Map<number, string>
  /** Cities clipped to `explored`; an entry is dropped when the session explores a tile inside that city's bounds. */
  layoutClips: Map<number, LayoutClip>
  stateClips: Map<number, StateClip>
  credits: number | null
  trainingKinds: string | null
  training: string | null
  rally: string | null
  lastSnapshotTick: number
  lastSnapshotAt: number
  lastSentTick: number
  ledgerTick: number
  ackSent: number
}

export type RemotePlay = {
  readonly playing: boolean
  retire(): void
  command(message: ClientMessage, seq: number, tick: number): void
  setView(playerId: number): void
  sync(): void
  close(): void
}

export class ServerHost {
  tickNo = 0
  private readonly sessions: Session[] = []
  private readonly memory = new Map<Session, Memory>()
  private ais: AiPlayer[]
  private stopped = false
  /** Game reads every session shares, computed on first use; `drop` clears them whenever the game may have changed. */
  private routes: Map<number, number> | null = null
  private sights: CitySight[] | null = null
  private states: CityState[] | null = null
  private layouts: CityLayout[] | null = null
  private stateKeys: string[] | null = null
  private cityBounds: Bounds[] | null = null
  private layers = new Map<number, StaticLayer>()
  private checkedLayers: Map<number, StaticLayer> | null = null
  /** Tiles each owner has explored. A closed session keeps this so the next sync can send it. */
  private exploredMaps = new Map<number, Uint8Array>()
  private parkings = new Map<number, Parking>()
  private checkedParkings: Set<Parking> | null = null

  constructor(
    readonly game: Game,
    ai: AiPlayer | readonly AiPlayer[] = [],
  ) {
    this.ais = Array.isArray(ai) ? ai : [ai]
  }

  join(player: Player): ClientPort {
    const link = createLocalLink(player.id)
    const session: Session = {
      playerId: player.id,
      playing: true,
      echo: false,
      ack: 0,
      shadow: null,
      send: (message) => link.server.send(message),
    }
    link.server.onClient((message) => this.onCommand(session, message))
    this.sessions.push(session)
    return link.client
  }

  attach(playerId: number, playing: boolean, send: (message: ServerFrame) => void): RemotePlay {
    const session: Session = { playerId, playing, echo: true, ack: 0, shadow: null, send }
    this.sessions.push(session)
    return {
      get playing() {
        return session.playing
      },
      retire() {
        session.playing = false
      },
      command: (message, seq, tick) => {
        session.ack = seq
        this.onCommand(session, message, tick)
      },
      setView: (next) => {
        if (session.playing) return
        session.playerId = next
        this.memory.delete(session)
        this.pushSync(session)
      },
      sync: () => this.pushSync(session),
      close: () => {
        const index = this.sessions.indexOf(session)
        if (index >= 0) this.sessions.splice(index, 1)
        this.memory.delete(session)
      },
    }
  }

  addAi(ai: AiPlayer) {
    this.ais.push(ai)
  }

  setAiPace(pace: number) {
    for (const ai of this.ais) ai.setPace(pace)
  }

  dispose() {
    this.stopped = true
    this.ais = []
    this.sessions.length = 0
    this.memory.clear()
    this.exploredMaps.clear()
  }

  silence(playerId: number) {
    this.ais = this.ais.filter((ai) => ai.playerId !== playerId)
  }

  sync(playerId: number) {
    const session = this.sessions.find((port) => port.playerId === playerId)
    if (session) this.pushSync(session)
  }

  tick(dt: number) {
    if (this.stopped) return
    __TRACE__ && traceBegin(TraceSlot.Ai)
    for (const ai of this.ais) ai.update(dt)
    __TRACE__ && traceEnd()
    const shots = this.game.tick(dt)
    const hits = this.game.takeHits()
    const yields = this.game.takeYields()
    this.game.takeDeaths()
    this.tickNo += 1
    __TRACE__ && traceBegin(TraceSlot.Net)
    this.drop()
    const living = this.game.unitSnapshots()
    this.park(living)
    for (const session of this.sessions) {
      if (!this.memory.has(session)) {
        this.pushSync(session)
        continue
      }
      this.pushTick(session, living, shots, hits, yields)
    }
    __TRACE__ && traceEnd()
  }

  private onCommand(session: Session, message: ClientMessage, tick?: number) {
    this.apply(session, message, tick === undefined ? 0 : Math.max(0, Math.min(CATCH_UP_TICKS, this.tickNo - tick)))
    this.drop()
    if (!session.echo) return
    this.pushTick(session, this.game.unitSnapshots(), [], [], [], session.playing ? orderedUnits(message) : NO_UNITS)
  }

  /** `lag` is how many ticks the sender's own simulation ran past the moment it issued the command. */
  private apply(session: Session, message: ClientMessage, lag: number) {
    if (message.kind === ClientMessageKind.RequestSnapshot) {
      const memory = this.memory.get(session)
      const recent = memory && this.tickNo - memory.lastSnapshotTick < SNAPSHOT_COOLDOWN && performance.now() - memory.lastSnapshotAt < SNAPSHOT_COOLDOWN_MS
      if (recent) return
      this.pushSync(session)
      return
    }
    if (!session.playing) return
    const playerId = session.playerId
    if (message.kind === ClientMessageKind.OrderMove) {
      this.game.orderMove(playerId, message.unitIds, message.tile, lag)
    } else if (message.kind === ClientMessageKind.OrderAttack) {
      this.game.orderAttack(playerId, message.unitIds, message.targetId)
    } else if (message.kind === ClientMessageKind.OrderAttackGround) {
      this.game.orderAttackGround(playerId, message.unitIds, message.tile)
    } else if (message.kind === ClientMessageKind.Spawn) {
      this.game.trySpawn(playerId, message.typeId, message.yardId)
    } else if (message.kind === ClientMessageKind.CancelSpawn) {
      this.game.cancelTraining(playerId, message.typeId, message.yardId)
    } else if (message.kind === ClientMessageKind.PlaceBuilding) {
      this.game.placeBuilding(playerId, message.typeId, message.tile)
    } else if (message.kind === ClientMessageKind.PlaceCity) {
      this.game.placeCityBuilding(playerId, message.tile)
    } else if (message.kind === ClientMessageKind.CancelBuilding) {
      this.game.cancelBuild(playerId, message.typeId)
    } else if (message.kind === ClientMessageKind.SetRally) {
      this.game.setRally(playerId, message.tile)
    } else if (message.kind === ClientMessageKind.SetCityFocus) {
      this.game.setCityFocus(playerId, message.index, message.focus)
    }
  }

  private drop() {
    this.routes = null
    this.sights = null
    this.states = null
    this.layouts = null
    this.stateKeys = null
    this.cityBounds = null
    this.checkedLayers = null
    this.checkedParkings = null
  }

  private pushSync(session: Session) {
    this.drop()
    const memory = this.blank(session.playerId)
    this.memory.set(session, memory)
    const { width } = this.game.world
    const living = this.game.unitSnapshots()
    this.reveal(memory, living)
    const units = living.filter((unit) => this.knows(memory, unit, width))
    const visible = this.visibleCities(memory)
    const cities: CityRecord[] = visible.map((city) => ({ index: city.index, state: city.state.state, layout: city.layout.layout }))
    __TRACE__ && traceBegin(TraceSlot.Map)
    const map = this.mapOf(memory)
    __TRACE__ && traceEnd()
    const training = this.game.trainingFor(session.playerId)
    const rally = this.game.rally(session.playerId)
    const credits = this.game.player(session.playerId)?.credits ?? 0
    this.remember(memory, units, visible, credits, training, rally)
    memory.lastSnapshotTick = this.tickNo
    memory.lastSnapshotAt = performance.now()
    memory.ackSent = session.ack
    const frame: ServerFrame = {
      tick: this.tickNo,
      ack: session.ack,
      events: [
        { kind: ServerEventKind.Welcome, playerId: session.playerId },
        {
          kind: ServerEventKind.Snapshot,
          map,
          units,
          cities,
          credits,
          training,
          rally,
        },
      ],
    }
    session.send(frame)
    if (!session.echo) return
    session.shadow = new Replica()
    session.shadow.apply(frame)
  }

  private pushTick(
    session: Session,
    living: readonly UnitSnapshot[],
    shots: readonly ShotEvent[],
    hits: readonly ShotHit[],
    yields: readonly MapPoint[],
    ordered = NO_UNITS,
  ) {
    const memory = this.memory.get(session)
    if (!memory) return
    const { width, height } = this.game.world
    const fresh = this.reveal(memory, living)
    this.unclip(memory, fresh)
    const shadow = session.shadow
    shadow?.simulateTo(this.tickNo)
    const held = shadow ? new Map(shadow.units.map((unit) => [unit.id, unit])) : null
    const events: ServerEvent[] = []
    const ledger: Deferred[] = []
    __TRACE__ && traceBegin(TraceSlot.Map)
    const patch = this.changedMap(memory, fresh)
    __TRACE__ && traceEnd()
    if (patch) ledger.push({ event: { kind: ServerEventKind.MapPatch, map: patch }, commit: () => memory.unsentTiles.clear() })
    this.changedCities(memory, events, ledger)

    const known = new Set<number>()
    for (const unit of living) {
      if (!this.knows(memory, unit, width)) continue
      known.add(unit.id)
      const mobile = unit.path.length > 0 || unit.speed !== 0 || this.routeOf(unit) !== 0
      const freshUnit = !memory.seen.has(unit.id)
      const routeChanged = memory.route.get(unit.id) !== this.routeOf(unit)
      const beat = held ? BACKSTOP_TICKS : MOTION_HEARTBEAT
      const due = this.tickNo - (memory.motionTick.get(unit.id) ?? -beat) >= beat
      const commitMotion = () => {
        memory.seen.add(unit.id)
        memory.route.set(unit.id, this.routeOf(unit))
        memory.motionTick.set(unit.id, this.tickNo)
        memory.rounds.set(unit.id, unit.rounds ?? 0)
      }
      const answered = ordered.has(unit.id) && unit.ownerId === session.playerId
      const newRounds = roundsNews(unit, memory.rounds.get(unit.id), unit.ownerId === session.playerId)
      if (freshUnit || answered || (mobile && routeChanged) || newRounds || (held && drifted(held.get(unit.id), unit))) {
        events.push({ kind: ServerEventKind.UnitMotion, unit })
        commitMotion()
      } else if (due && (held ? unit.path.length > 0 || unit.speed !== 0 : mobile)) {
        ledger.push({ event: { kind: ServerEventKind.UnitMotion, unit }, commit: commitMotion })
      }
      if (memory.health.get(unit.id) !== unit.health) {
        if (!freshUnit) events.push({ kind: ServerEventKind.UnitHealth, id: unit.id, health: unit.health })
        memory.health.set(unit.id, unit.health)
      }
      if (memory.progress.get(unit.id) !== unit.progress) {
        const commit = () => memory.progress.set(unit.id, unit.progress)
        const event: ServerEvent = { kind: ServerEventKind.UnitProgress, id: unit.id, progress: unit.progress }
        if (freshUnit) commit()
        else if (unit.progress >= 1) {
          events.push(event)
          commit()
        } else ledger.push({ event, commit })
      }
    }
    for (const id of [...memory.seen]) {
      if (known.has(id)) continue
      events.push({ kind: ServerEventKind.UnitHidden, id })
      memory.seen.delete(id)
      memory.route.delete(id)
      memory.motionTick.delete(id)
      memory.health.delete(id)
      memory.progress.delete(id)
      memory.rounds.delete(id)
    }
    for (const shot of shots) {
      if (!this.shotVisible(memory, shot, living, session.playerId, width, height)) continue
      events.push({ kind: ServerEventKind.ShotSpawn, shot })
    }
    for (const hit of hits) {
      if (!this.lit(memory, hit.aimX, hit.aimZ, width, height)) continue
      events.push({ kind: ServerEventKind.ShotHit, hit })
    }
    const seenYields = yields.filter((point) => this.lit(memory, point.x, point.y, width, height))
    if (seenYields.length > 0) events.push({ kind: ServerEventKind.Yields, yields: seenYields })
    this.economy(session, memory, events, ledger)
    const acked = memory.ackSent !== session.ack
    if (ledger.length > 0 && (events.length > 0 || acked || this.tickNo - memory.ledgerTick >= LEDGER_TICKS)) {
      for (const entry of ledger) {
        events.push(entry.event)
        entry.commit()
      }
      memory.ledgerTick = this.tickNo
    }
    if (events.length === 0 && !acked && this.tickNo - memory.lastSentTick < KEEPALIVE_TICKS) return
    memory.lastSentTick = this.tickNo
    memory.ackSent = session.ack
    const frame: ServerFrame = { tick: this.tickNo, events, ack: session.ack }
    session.send(frame)
    shadow?.apply(frame)
  }

  private economy(session: Session, memory: Memory, events: ServerEvent[], ledger: Deferred[]) {
    const credits = this.game.player(session.playerId)?.credits ?? 0
    if (memory.credits !== credits) {
      ledger.push({ event: { kind: ServerEventKind.Credits, credits }, commit: () => (memory.credits = credits) })
    }
    const training = this.game.trainingFor(session.playerId)
    const kinds = trainingKinds(training)
    const trainingKey = JSON.stringify(training)
    if (memory.trainingKinds !== kinds) {
      memory.trainingKinds = kinds
      memory.training = trainingKey
      events.push({ kind: ServerEventKind.Training, training })
    } else if (memory.training !== trainingKey) {
      ledger.push({ event: { kind: ServerEventKind.Training, training }, commit: () => (memory.training = trainingKey) })
    }
    const rally = this.game.rally(session.playerId)
    const rallyKey = rally ? `${rally.x},${rally.y}` : ''
    if (memory.rally !== rallyKey) {
      memory.rally = rallyKey
      events.push({ kind: ServerEventKind.Rally, rally })
    }
  }

  private remember(
    memory: Memory,
    units: readonly UnitSnapshot[],
    cities: readonly VisibleCity[],
    credits: number,
    training: ReturnType<Game['trainingFor']>,
    rally: TileCoord | null,
  ) {
    memory.seen.clear()
    for (const unit of units) {
      memory.seen.add(unit.id)
      memory.route.set(unit.id, this.routeOf(unit))
      memory.motionTick.set(unit.id, this.tickNo)
      memory.health.set(unit.id, unit.health)
      memory.progress.set(unit.id, unit.progress)
      memory.rounds.set(unit.id, unit.rounds ?? 0)
    }
    memory.cityCore.clear()
    memory.cityProgress.clear()
    memory.cityShape.clear()
    for (const city of cities) {
      memory.cityCore.set(city.index, city.state.core)
      memory.cityProgress.set(city.index, city.state.progress)
      memory.cityShape.set(city.index, city.layout.shape)
    }
    memory.credits = credits
    memory.trainingKinds = trainingKinds(training)
    memory.training = JSON.stringify(training)
    memory.rally = rally ? `${rally.x},${rally.y}` : ''
  }

  private exploredOf(playerId: number): Uint8Array {
    let map = this.exploredMaps.get(playerId)
    if (map) return map
    map = new Uint8Array(this.game.world.width * this.game.world.height)
    this.exploredMaps.set(playerId, map)
    return map
  }

  private blank(playerId: number): Memory {
    const tiles = this.game.world.width * this.game.world.height
    return {
      owner: playerId,
      explored: new Uint8Array(this.exploredOf(playerId)),
      visible: new Uint32Array(tiles),
      sight: 1,
      layer: null,
      parking: this.parkingOf(playerId),
      felledSeen: 0,
      scarredSeen: 0,
      unsentTiles: new Set(),
      seen: new Set(),
      route: new Map(),
      motionTick: new Map(),
      health: new Map(),
      progress: new Map(),
      rounds: new Map(),
      cityCore: new Map(),
      cityProgress: new Map(),
      cityShape: new Map(),
      layoutClips: new Map(),
      stateClips: new Map(),
      credits: null,
      trainingKinds: null,
      training: null,
      rally: null,
      lastSnapshotTick: -SNAPSHOT_COOLDOWN,
      lastSnapshotAt: -SNAPSHOT_COOLDOWN_MS,
      lastSentTick: this.tickNo,
      ledgerTick: this.tickNo,
      ackSent: 0,
    }
  }

  private reveal(memory: Memory, units: readonly UnitSnapshot[]): TileCoord[] {
    const { width, height } = this.game.world
    const fresh: TileCoord[] = []
    const sight = ++memory.sight
    __TRACE__ && traceBegin(TraceSlot.VisionCopy)
    const layer = this.staticLayer(memory.owner, units)
    const parking = memory.parking
    this.unparkMoved(parking, units)
    __TRACE__ && traceEnd()
    // A changed layer rescans every source, so the tiles it newly lights explore their margins in source order.
    const whole = memory.layer !== layer
    memory.layer = layer
    const see = (x: number, y: number) => {
      const index = y * width + x
      const before = memory.visible[index]
      memory.visible[index] = sight
      if (before === sight || before === sight - 1 || (!whole && (layer.lit[index] === 1 || parking.lit[index] > 0))) return
      for (const offset of MARGIN_OFFSETS) {
        const nx = x + offset.x
        const ny = y + offset.y
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const near = ny * width + nx
        if (memory.explored[near] === 1) continue
        memory.explored[near] = 1
        this.exploredOf(memory.owner)[near] = 1
        fresh.push({ x: nx, y: ny })
      }
    }
    __TRACE__ && traceBegin(TraceSlot.VisionFriends)
    const friends: SightSource[] = []
    for (const unit of units) {
      if (unit.ownerId !== memory.owner || unit.health <= 0 || unit.progress < 1) continue
      if (!whole && (isStructure(unit) || parking.poses.get(unit.id)?.parked)) continue
      const sight = UNIT_TYPES[unit.typeId].weapon.sight
      if (sight > 0) friends.push({ x: unit.x, z: unit.z, sight })
    }
    if (whole) {
      for (const city of (this.sights ??= this.game.citySights())) {
        if (city.ownerId === memory.owner) friends.push({ x: city.x, z: city.z, sight: CITY_SIGHT })
      }
    }
    __TRACE__ && traceEnd()
    __TRACE__ && traceBegin(TraceSlot.VisionStamp)
    for (const friend of friends) {
      const reach = Math.ceil(friend.sight)
      const originX = Math.floor(friend.x)
      const originY = Math.floor(friend.z)
      const reachSq = friend.sight * friend.sight
      for (let y = Math.max(0, originY - reach); y <= Math.min(height - 1, originY + reach); y++) {
        for (let x = Math.max(0, originX - reach); x <= Math.min(width - 1, originX + reach); x++) {
          const cx = x + 0.5 - friend.x
          const cz = y + 0.5 - friend.z
          if (cx * cx + cz * cz <= reachSq) see(x, y)
        }
      }
    }
    __TRACE__ && traceEnd()
    __TRACE__ && traceBegin(TraceSlot.VisionFoot)
    for (const unit of units) {
      if (unit.ownerId !== memory.owner || unit.health <= 0) continue
      if (!whole && (isStructure(unit) || parking.poses.get(unit.id)?.parked)) continue
      const span = spanOf(UNIT_TYPES[unit.typeId])
      for (let y = Math.max(0, unit.tileY); y < Math.min(height, unit.tileY + span.y); y++) {
        for (let x = Math.max(0, unit.tileX); x < Math.min(width, unit.tileX + span.x); x++) see(x, y)
      }
    }
    __TRACE__ && traceEnd()
    return fresh
  }

  /** The owner's static layer, rebuilt when its sources differ by value from the ones it was built from. */
  private staticLayer(owner: number, units: readonly UnitSnapshot[]): StaticLayer {
    this.checkedLayers ??= new Map()
    const checked = this.checkedLayers.get(owner)
    if (checked) return checked
    const discs: number[] = []
    const rects: number[] = []
    for (const unit of units) {
      if (unit.ownerId !== owner || unit.health <= 0 || !isStructure(unit)) continue
      const type = UNIT_TYPES[unit.typeId]
      if (unit.progress >= 1 && type.weapon.sight > 0) discs.push(unit.x, unit.z, type.weapon.sight)
      const span = spanOf(type)
      rects.push(unit.tileX, unit.tileY, span.x, span.y)
    }
    for (const city of (this.sights ??= this.game.citySights())) {
      if (city.ownerId === owner) discs.push(city.x, city.z, CITY_SIGHT)
    }
    let layer = this.layers.get(owner)
    if (!layer || !sameValues(layer.discs, discs) || !sameValues(layer.rects, rects)) {
      layer = { discs, rects, lit: this.stampStatic(discs, rects) }
      this.layers.set(owner, layer)
    }
    this.checkedLayers.set(owner, layer)
    return layer
  }

  private stampStatic(discs: readonly number[], rects: readonly number[]): Uint8Array {
    const { width, height } = this.game.world
    const lit = new Uint8Array(width * height)
    const cover = (index: number) => (lit[index] = 1)
    for (let i = 0; i < discs.length; i += 3) coverDisc(discs[i], discs[i + 1], discs[i + 2], width, height, cover)
    for (let i = 0; i < rects.length; i += 4) coverRect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3], width, height, cover)
    return lit
  }

  private parkingOf(owner: number): Parking {
    let parking = this.parkings.get(owner)
    if (!parking) {
      const { width, height } = this.game.world
      parking = { owner, poses: new Map(), lit: new Uint16Array(width * height), pass: 0 }
      this.parkings.set(owner, parking)
    }
    return parking
  }

  /** The per-tick pass: parks every mobile unit whose pose equals the one recorded at the previous tick, unparks the rest and records each pose. */
  private park(units: readonly UnitSnapshot[]) {
    this.checkedParkings = new Set(this.parkings.values())
    for (const parking of this.parkings.values()) {
      const pass = ++parking.pass
      for (const unit of units) {
        if (unit.ownerId !== parking.owner || unit.health <= 0 || isStructure(unit)) continue
        const pose = poseOf(unit, pass)
        const recorded = parking.poses.get(unit.id)
        if (recorded && samePose(recorded, pose)) {
          recorded.pass = pass
          if (!recorded.parked) this.stampPose(parking, recorded, 1)
          continue
        }
        if (recorded?.parked) this.stampPose(parking, recorded, -1)
        parking.poses.set(unit.id, pose)
      }
      for (const [id, recorded] of parking.poses) {
        if (recorded.pass === pass) continue
        if (recorded.parked) this.stampPose(parking, recorded, -1)
        parking.poses.delete(id)
      }
    }
  }

  /** Unparks every parked unit that has left its pose or the game; the recorded poses stay as the per-tick pass left them. */
  private unparkMoved(parking: Parking, units: readonly UnitSnapshot[]) {
    this.checkedParkings ??= new Set()
    if (this.checkedParkings.has(parking)) return
    this.checkedParkings.add(parking)
    const pass = ++parking.pass
    for (const unit of units) {
      if (unit.ownerId !== parking.owner || unit.health <= 0) continue
      const recorded = parking.poses.get(unit.id)
      if (!recorded?.parked) continue
      recorded.pass = pass
      if (!samePose(recorded, poseOf(unit, pass))) this.stampPose(parking, recorded, -1)
    }
    for (const recorded of parking.poses.values()) {
      if (recorded.parked && recorded.pass !== pass) this.stampPose(parking, recorded, -1)
    }
  }

  private stampPose(parking: Parking, pose: Pose, delta: 1 | -1) {
    const { width, height } = this.game.world
    const lit = parking.lit
    const cover = (index: number) => (lit[index] += delta)
    pose.parked = delta === 1
    if (pose.sight > 0) coverDisc(pose.x, pose.z, pose.sight, width, height, cover)
    coverRect(pose.tileX, pose.tileY, pose.spanX, pose.spanY, width, height, cover)
  }

  private knows(memory: Memory, unit: UnitSnapshot, width: number): boolean {
    if (unit.ownerId === memory.owner) return true
    const index = unit.tileY * width + unit.tileX
    return index >= 0 && index < memory.visible.length && this.inView(memory, index)
  }

  private inView(memory: Memory, index: number): boolean {
    return memory.visible[index] === memory.sight || memory.layer?.lit[index] === 1 || memory.parking.lit[index] > 0
  }

  private pointVisible(memory: Memory, x: number, z: number, width: number, height: number): boolean {
    const tx = Math.floor(x)
    const ty = Math.floor(z)
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false
    return memory.explored[ty * width + tx] === 1
  }

  private shotVisible(
    memory: Memory,
    shot: ShotEvent,
    units: readonly UnitSnapshot[],
    playerId: number,
    width: number,
    height: number,
  ): boolean {
    const shooter = units.find((unit) => unit.id === shot.shooterId)
    if (shooter?.ownerId === playerId) return true
    return (
      this.lit(memory, shot.x, shot.z, width, height) ||
      this.lit(memory, shot.aimX, shot.aimZ, width, height)
    )
  }

  private lit(memory: Memory, x: number, z: number, width: number, height: number): boolean {
    const tx = Math.floor(x)
    const ty = Math.floor(z)
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false
    return this.inView(memory, ty * width + tx)
  }

  private visibleCities(memory: Memory): VisibleCity[] {
    const records: VisibleCity[] = []
    const { width } = this.game.world
    __TRACE__ && traceBegin(TraceSlot.CityStates)
    const states = (this.states ??= this.game.cityStates())
    const layouts = (this.layouts ??= this.game.cityLayouts())
    const keys = (this.stateKeys ??= states.map(stateKey))
    __TRACE__ && traceEnd()
    __TRACE__ && traceBegin(TraceSlot.CityClip)
    for (let index = 0; index < states.length; index++) {
      let layout = memory.layoutClips.get(index)
      if (layout?.source !== layouts[index]) {
        const clipped = clipLayout(layouts[index], memory.explored, width)
        layout = { source: layouts[index], layout: clipped, shape: shapeKey(clipped) }
        memory.layoutClips.set(index, layout)
      }
      if (layout.layout.tiles.length === 0) continue
      let state = memory.stateClips.get(index)
      if (state?.source !== keys[index]) {
        const clipped = clipState(states[index], memory.explored, width)
        state = { source: keys[index], state: clipped, core: coreKey(clipped), progress: progressStep(clipped) }
        memory.stateClips.set(index, state)
      }
      records.push({ index, layout, state })
    }
    __TRACE__ && traceEnd()
    return records
  }

  private unclip(memory: Memory, fresh: readonly TileCoord[]) {
    if (fresh.length === 0) return
    const bounds = (this.cityBounds ??= this.citySpans())
    for (let index = 0; index < bounds.length; index++) {
      const box = bounds[index]
      if (!fresh.some((tile) => tile.x >= box.minX && tile.x <= box.maxX && tile.y >= box.minY && tile.y <= box.maxY)) continue
      memory.layoutClips.delete(index)
      memory.stateClips.delete(index)
    }
  }

  private citySpans(): Bounds[] {
    const states = (this.states ??= this.game.cityStates())
    const layouts = (this.layouts ??= this.game.cityLayouts())
    return layouts.map((layout, index) => {
      const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      const state = states[index]
      for (const points of [layout.tiles, layout.buildings, layout.streets, state.ruins, state.sites]) {
        for (const point of points) {
          box.minX = Math.min(box.minX, point.x)
          box.minY = Math.min(box.minY, point.y)
          box.maxX = Math.max(box.maxX, point.x)
          box.maxY = Math.max(box.maxY, point.y)
        }
      }
      return box
    })
  }

  private changedCities(memory: Memory, events: ServerEvent[], ledger: Deferred[]) {
    __TRACE__ && traceBegin(TraceSlot.CityKey)
    const live = new Set<number>()
    for (const city of this.visibleCities(memory)) {
      const { index } = city
      const { shape } = city.layout
      const { core, progress } = city.state
      live.add(index)
      const reshaped = memory.cityShape.get(index) !== shape
      const recast = memory.cityCore.get(index) !== core
      if (!reshaped && !recast && memory.cityProgress.get(index) === progress) continue
      const event: ServerEvent = {
        kind: ServerEventKind.CityUpdate,
        city: { index, state: city.state.state, layout: reshaped ? city.layout.layout : null },
      }
      const commit = () => {
        memory.cityShape.set(index, shape)
        memory.cityCore.set(index, core)
        memory.cityProgress.set(index, progress)
      }
      if (reshaped || recast) {
        events.push(event)
        commit()
      } else ledger.push({ event, commit })
    }
    for (const index of [...memory.cityCore.keys()]) {
      if (live.has(index)) continue
      memory.cityCore.delete(index)
      memory.cityProgress.delete(index)
      memory.cityShape.delete(index)
    }
    __TRACE__ && traceEnd()
  }

  private mapOf(memory: Memory): MapData {
    const { width, height } = this.game.world
    const cells = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (memory.explored[y * width + x] !== 1) continue
        cells.push({ x, y, terrain: this.game.world.terrainAt(x, y), shift: this.game.world.shiftAt(x, y) })
      }
    }
    const felled = this.game.felled()
    memory.felledSeen = felled.length
    memory.scarredSeen = this.game.scarred().length
    return {
      width,
      height,
      cells,
      coast: [],
      holes: [],
      roads: [],
      towns: this.game.scenery.towns.filter((point) => this.pointVisible(memory, point.x, point.y, width, height)),
      cleared: felled.filter((tile) => memory.explored[tile.y * width + tile.x] === 1),
    }
  }

  private changedMap(memory: Memory, fresh: readonly TileCoord[]): MapData | null {
    const { width, height } = this.game.world
    const wanted = memory.unsentTiles
    for (const tile of fresh) wanted.add(tile.y * width + tile.x)
    const felled = this.game.felled()
    for (let i = memory.felledSeen; i < felled.length; i++) {
      const index = felled[i].y * width + felled[i].x
      if (memory.explored[index] === 1) wanted.add(index)
    }
    memory.felledSeen = felled.length
    const scarred = this.game.scarred()
    for (let i = memory.scarredSeen; i < scarred.length; i++) {
      const index = scarred[i].y * width + scarred[i].x
      if (memory.explored[index] === 1) wanted.add(index)
    }
    memory.scarredSeen = scarred.length
    if (wanted.size === 0) return null
    const cells = []
    for (const index of wanted) {
      const x = index % width
      const y = (index - x) / width
      cells.push({ x, y, terrain: this.game.world.terrainAt(x, y), shift: this.game.world.shiftAt(x, y) })
    }
    return {
      width,
      height,
      cells,
      coast: [],
      holes: [],
      roads: [],
      towns: this.game.scenery.towns.filter((point) => wanted.has(Math.floor(point.y) * width + Math.floor(point.x))),
      cleared: felled.filter((tile) => wanted.has(tile.y * width + tile.x)),
    }
  }

  private routeOf(unit: UnitSnapshot): number {
    this.routes ??= new Map(this.game.units.map((live) => [live.id, live.route]))
    return this.routes.get(unit.id) ?? 0
  }
}

function clipLayout(layout: CityLayout, explored: Uint8Array, width: number): CityLayout {
  const seen = (x: number, y: number) => {
    const index = y * width + x
    return index >= 0 && index < explored.length && explored[index] === 1
  }
  return {
    x: layout.x,
    y: layout.y,
    span: layout.span,
    seed: layout.seed,
    tiles: layout.tiles.filter((tile) => seen(tile.x, tile.y)),
    buildings: layout.buildings.filter((building) => seen(building.x, building.y)),
    streets: layout.streets.filter((street) => seen(street.x, street.y)),
  }
}

function clipState(state: CityState, explored: Uint8Array, width: number): CityState {
  const seen = (x: number, y: number) => explored[y * width + x] === 1
  return {
    ...state,
    ruins: state.ruins.filter((tile) => seen(tile.x, tile.y)),
    sites: state.sites.filter((site) => seen(site.x, site.y)),
  }
}

function coreKey(state: CityState): string {
  const ruins = state.ruins.map((tile) => `${tile.x},${tile.y}`).join('.')
  const sites = state.sites.map((site) => `${site.at}:${site.x},${site.y},${site.model},${site.yaw}`).join(';')
  return `${state.ownerId}:${state.challengerId}:${state.grown}:${state.focus ?? 0}:${ruins}:${sites}`
}

function stateKey(state: CityState): string {
  return `${state.color}:${state.challengerColor}:${state.progress}:${coreKey(state)}`
}

function progressStep(state: CityState): number {
  return Math.round(state.progress * PROGRESS_STEPS)
}

function shapeKey(layout: CityLayout): string {
  const buildings = layout.buildings.map((building) => `${building.x},${building.y},${building.model}`).join(';')
  return `${layout.tiles.length}:${layout.streets.length}:${buildings}`
}

function isStructure(unit: UnitSnapshot): boolean {
  return UNIT_TYPES[unit.typeId].topSpeed === 0
}

function poseOf(unit: UnitSnapshot, pass: number): Pose {
  const type = UNIT_TYPES[unit.typeId]
  const span = spanOf(type)
  const sight = unit.progress >= 1 ? type.weapon.sight : 0
  return { x: unit.x, z: unit.z, sight, tileX: unit.tileX, tileY: unit.tileY, spanX: span.x, spanY: span.y, parked: false, pass }
}

function samePose(a: Pose, b: Pose): boolean {
  return a.x === b.x && a.z === b.z && a.sight === b.sight && a.tileX === b.tileX && a.tileY === b.tileY && a.spanX === b.spanX && a.spanY === b.spanY
}

/** Covers every tile whose center lies within `sight` of (x, z), as reveal scans a sight disc. */
function coverDisc(x: number, z: number, sight: number, width: number, height: number, cover: (index: number) => void) {
  const reach = Math.ceil(sight)
  const originX = Math.floor(x)
  const originY = Math.floor(z)
  const reachSq = sight * sight
  for (let ty = Math.max(0, originY - reach); ty <= Math.min(height - 1, originY + reach); ty++) {
    for (let tx = Math.max(0, originX - reach); tx <= Math.min(width - 1, originX + reach); tx++) {
      const cx = tx + 0.5 - x
      const cz = ty + 0.5 - z
      if (cx * cx + cz * cz <= reachSq) cover(ty * width + tx)
    }
  }
}

function coverRect(tileX: number, tileY: number, spanX: number, spanY: number, width: number, height: number, cover: (index: number) => void) {
  for (let y = Math.max(0, tileY); y < Math.min(height, tileY + spanY); y++) {
    for (let x = Math.max(0, tileX); x < Math.min(width, tileX + spanX); x++) cover(y * width + x)
  }
}

function sameValues(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function discOffsets(radius: number): TileCoord[] {
  const offsets: TileCoord[] = []
  const reach = Math.ceil(radius)
  for (let y = -reach; y <= reach; y++) {
    for (let x = -reach; x <= reach; x++) if (x * x + y * y <= radius * radius) offsets.push({ x, y })
  }
  return offsets
}

function orderedUnits(message: ClientMessage): ReadonlySet<number> {
  const order =
    message.kind === ClientMessageKind.OrderMove ||
    message.kind === ClientMessageKind.OrderAttack ||
    message.kind === ClientMessageKind.OrderAttackGround
  return order ? new Set(message.unitIds) : NO_UNITS
}

function trainingKinds(training: readonly TrainJob[]): string {
  return training.map((job) => `${job.yardId}:${job.typeId}`).join(',')
}

/** Whether a session's client needs the unit's new rounds: its owner's ammo bar shows each change, and every client holds a rocket unit in range only while it has rounds. */
function roundsNews(unit: UnitSnapshot, told: number | undefined, owner: boolean): boolean {
  const rounds = unit.rounds ?? 0
  if (told === rounds) return false
  if (owner) return true
  return UNIT_TYPES[unit.typeId].weapon.kind === WeaponKind.Rocket && (told ?? 0) > 0 !== rounds > 0
}

function drifted(held: UnitSnapshot | undefined, unit: UnitSnapshot): boolean {
  if (!held) return true
  if (Math.hypot(held.x - unit.x, held.z - unit.z) > DRIFT_TILES) return true
  if (Math.abs(wrapAngle(held.facing - unit.facing)) > DRIFT_TURN) return true
  if (Math.abs(wrapAngle(held.turretYaw - unit.turretYaw)) > DRIFT_TURN) return true
  if (Math.abs((held.altitude ?? 0) - (unit.altitude ?? 0)) > DRIFT_ALTITUDE) return true
  return held.path.length !== unit.path.length
}
