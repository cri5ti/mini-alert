import { createHash, type Hash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { constants, createDeflateRaw } from 'node:zlib'
import { AiPlayer } from '../ai/player.ts'
import { Commander } from '../client/commander.ts'
import { Replica } from '../client/replica.ts'
import { ServerHost, type RemotePlay } from '../server/host.ts'
import { seatIsland, spreadTowns } from '../server/island-match.ts'
import { generateIsland } from '../server/mapgen/generate.ts'
import type { Game } from '../server/game.ts'
import type { Player } from '../server/player.ts'
import { decodeClientMessage, decodeServerFrame, encodeClientMessage, encodeServerFrame } from '../shared/codec.ts'
import { SIM_STEP, SNAPSHOT_GAP } from '../shared/motion.ts'
import { canPlaceCityBuilding, cityCenter, type CityLayout } from '../shared/cities.ts'
import { playerColor } from '../shared/players.ts'
import {
  ClientMessageKind,
  ServerEventKind,
  type ClientMessage,
  type ClientPort,
  type MapPoint,
  type ServerFrame,
} from '../shared/protocol.ts'
import type { TileCoord } from '../shared/tiles.ts'
import { UNIT_TYPES, UnitTypeId } from '../shared/unit-types.ts'

export const enum Scenario {
  Idle = 0,
  Battle = 1,
  Assault = 2,
  Economy = 3,
  Cities = 4,
  Churn = 5,
}

export const enum Link {
  Lan = 0,
  Wan = 1,
  Bad = 2,
  Spike = 3,
}

export const SCENARIO_NAMES = ['idle', 'battle', 'assault', 'economy', 'cities', 'churn'] as const
export const LINK_NAMES = ['lan', 'wan', 'bad', 'spike'] as const
export const SIZES = [128, 256] as const

type Profile = { base: number; jitter: number; loss: number; stall: number }

/** One-way delay in ms: `base` plus up to `jitter`; a lost packet holds the stream back by `stall`. */
const PROFILES: readonly Profile[] = [
  { base: 2, jitter: 0, loss: 0, stall: 0 },
  { base: 45, jitter: 40, loss: 0, stall: 0 },
  { base: 80, jitter: 80, loss: 0.02, stall: 250 },
  { base: 30, jitter: 15, loss: 0.01, stall: 400 },
]

const RENDER_HZ = 60
const PING_MS = 2000
const WARMUP_MS = 2000
const MEASURE_MS = 60_000
const CITIES_MEASURE_MS = 30_000
const ORDER_AT_MS = 1000
const ASSAULT_EVERY_MS = 4000
const TRAIN_CHECK_MS = 1000
const TRAIN_QUEUE = 4
const VISIBLE_JUMP = 0.1
const HISTORY_TICKS = 300
const DEFLATE_TAIL = 4
const SPECTATORS = 2
const BATTLE_ARMY = 60
const ASSAULT_ARMY = 30
const IDLE_ARMY = 20
const CITIES_ARMY = 6
const ECONOMY_CITIES = 3
const CHURN_ARMY = 12
const CHURN_TYPES = [UnitTypeId.MedTank, UnitTypeId.MedTank, UnitTypeId.MedTank, UnitTypeId.Scout]
const CHURN_EVERY_MS = 1000
const CHURN_CREDITS = 1_000_000
const CHURN_PLACE_TRIES = 4
const VIEW_EVERY_MS = 10_000
const MIXED = [UnitTypeId.MedTank, UnitTypeId.Scout, UnitTypeId.Artillery]

const EVENT_NAMES: Record<number, string> = {
  [ServerEventKind.Welcome]: 'welcome',
  [ServerEventKind.Snapshot]: 'snapshot',
  [ServerEventKind.UnitMotion]: 'motion',
  [ServerEventKind.UnitHealth]: 'health',
  [ServerEventKind.UnitProgress]: 'progress',
  [ServerEventKind.UnitHidden]: 'hidden',
  [ServerEventKind.ShotSpawn]: 'shot',
  [ServerEventKind.ShotHit]: 'hit',
  [ServerEventKind.MapPatch]: 'map',
  [ServerEventKind.CityUpdate]: 'city',
  [ServerEventKind.Credits]: 'credits',
  [ServerEventKind.Training]: 'training',
  [ServerEventKind.Rally]: 'rally',
  [ServerEventKind.Yields]: 'yields',
}

export type CaseSpec = {
  scenario: Scenario
  size: number
  link: Link
  seed: number
  /** Measured seconds after the warm-up; the scenario's own length when absent. */
  seconds?: number
}

export type Spread = { p50: number; p95: number; p99: number; max: number }

export type ClientRow = {
  playerId: number
  rawBytesPerSec: number
  deflatedBytesPerSec: number
  framesPerSec: number
  eventsPerSec: Record<string, number>
  correctionsPerSec: number
  visibleCorrectionsPerSec: number
  resyncRequests: number
  snapshotsAfterJoin: number
  droppedFrames: number
  echoMs: Spread | null
  ownError: Spread | null
  enemyError: Spread | null
  lagTicks: number | null
  ticksPerSec: number | null
}

/** Changes the churn scenario drives, counted over the whole run. */
export type Triggers = {
  ownerFlips: number
  ruinsAdded: number
  placeCity: number
  placeBuilding: number
  structuresCompleted: number
  structuresDestroyed: number
  cityTilesExplored: number
  viewSwitches: number
}

export type ServerRow = { hostMs: number; gameMs: number; aiMs: number; networkMs: number; worstMs: number }

export type Row = {
  scenario: string
  size: number
  net: string
  seed: number
  seconds: number
  ticks: number
  clients: ClientRow[]
  /** Real-clock ms per server tick; the only figures that vary between runs of one case. */
  server: ServerRow
  triggers: Triggers | null
  hash: string
  /** Every unit's id, pose and health after each server tick. */
  gameHash: string
  commandHash: string
  commands: Command[]
}

/** A command the host hands to the Game from a remote client or an AI seat; `lag` is what a move order passes to `Game.orderMove`. */
export type Command = { tag: number; tick: number; message: ClientMessage; lag?: number }

type Pose = { x: number; z: number }

/** A TCP-ordered one-way stream: nothing arrives before what was sent ahead of it. */
class Pipe {
  private readonly queue: { at: number; bytes: Uint8Array }[] = []
  private last = 0

  constructor(
    private readonly profile: Profile,
    private readonly random: () => number,
  ) {}

  send(now: number, bytes: Uint8Array) {
    let at = now + Math.round(this.profile.base + this.profile.jitter * this.random())
    if (this.random() < this.profile.loss) at += this.profile.stall
    this.last = Math.max(this.last, at)
    this.queue.push({ at: this.last, bytes })
  }

  deliver(now: number, receive: (bytes: Uint8Array) => void) {
    while (this.queue.length > 0 && this.queue[0].at <= now) receive(this.queue.shift()!.bytes)
  }
}

class Samples {
  private values = new Float64Array(1024)
  length = 0

  push(value: number) {
    if (this.length === this.values.length) {
      const grown = new Float64Array(this.values.length * 2)
      grown.set(this.values)
      this.values = grown
    }
    this.values[this.length++] = value
  }

  spread(): Spread | null {
    if (this.length === 0) return null
    const sorted = this.values.slice(0, this.length).sort()
    const at = (q: number) => round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)])
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted[sorted.length - 1]) }
  }
}

type Remote = {
  tag: number
  player: Player
  enemyTown: TileCoord
  replica: Replica
  commander: Commander
  play: RemotePlay
  down: Pipe
  up: Pipe
  seq: number
  sentAt: Map<number, number>
  frames: { bytes: Uint8Array; measured: boolean }[]
  rawBytes: number
  deflatedBytes: number
  framesSent: number
  events: Map<number, number>
  corrections: number
  visibleCorrections: number
  resyncRequests: number
  snapshots: number
  dropped: number
  /** Seeded offset in ms of this client's render clock against the server's ticks. */
  phase: number
  renders: number
  renderedAt: number
  pingAt: number
  actAt: number
  echo: Samples
  own: Samples
  enemy: Samples
  lag: number
  lagSamples: number
  firstTick: number | null
  acts: number
  placeTries: number
  strikeTarget: number | null
}

type Tally = { host: number; game: number; ai: number; worst: number; ticks: number; tee: number }

export async function runCase(spec: CaseSpec): Promise<Row> {
  const realRandom = Math.random
  const realNow = performance.now
  const clock = { now: 0 }
  Math.random = mulberry32(spec.seed)
  performance.now = () => clock.now
  let run: Run
  try {
    run = simulate(spec, clock, realNow.bind(performance))
  } finally {
    Math.random = realRandom
    performance.now = realNow
  }
  await deflateAll(run.remotes)
  return run.row()
}

type Run = { remotes: Remote[]; row(): Row }

function simulate(spec: CaseSpec, clock: { now: number }, realNow: () => number): Run {
  const cities = spec.scenario === Scenario.Cities
  const churn = spec.scenario === Scenario.Churn
  const measureMs = spec.seconds !== undefined ? spec.seconds * 1000 : cities ? CITIES_MEASURE_MS : MEASURE_MS
  const endMs = WARMUP_MS + measureMs
  const profile = PROFILES[spec.link]
  const actions = mulberry32(spec.seed ^ 0x5eed)
  const island = generateIsland(spec.seed, spec.size, spec.size)
  const seats = cities || churn ? [false, false, true, true] : [false, false]
  const towns = spreadTowns(island, seats.length)
  const { game, players } = seatIsland(island, seats.map((ai, index) => ({ ai, color: playerColor(index + 1) })), towns)
  const host = new ServerHost(game)
  const tally: Tally = { host: 0, game: 0, ai: 0, worst: 0, ticks: 0, tee: 0 }
  const hash = createHash('sha256')
  const gameHash = createHash('sha256')
  const commands: Command[] = []
  let moveLag: number | undefined
  let measuring = false

  const outposts = stage(spec.scenario, game, players, towns, island.towns)
  const watch = churn ? new Watch(game) : null

  const gameTick = game.tick.bind(game)
  game.tick = (dt) => {
    const started = realNow()
    const shots = gameTick(dt)
    if (measuring) tally.game += realNow() - started
    return shots
  }
  const orderMove = game.orderMove.bind(game)
  game.orderMove = (playerId, unitIds, tile, lag) => {
    moveLag = lag
    return orderMove(playerId, unitIds, tile, lag)
  }

  let session = 0
  const remotes: Remote[] = []
  for (let index = 0; index < seats.length; index++) {
    const player = players[index]
    const tag = session++
    if (seats[index]) {
      const bot = new AiPlayer(teePort(host.join(player), (frame) => tee(tag, frame, null), (message, pass) => relay(tag, message, pass)))
      const update = bot.update.bind(bot)
      bot.update = (dt) => {
        const started = realNow()
        update(dt)
        if (measuring) tally.ai += realNow() - started
      }
      host.addAi(bot)
      host.sync(player.id)
      continue
    }
    const enemy = towns[index === 0 ? 1 : 0]
    remotes.push(attachRemote(tag, player, tileOf(enemy), index))
  }
  host.setAiPace(1)
  const spectators: RemotePlay[] = []
  for (let index = 0; index < (cities ? SPECTATORS : churn ? 1 : 0); index++) {
    const tag = session++
    const view = players[index * 2].id
    spectators.push(host.attach(view, false, (frame) => tee(tag, frame, encodeServerFrame(frame))))
    spectators[index].sync()
  }
  let viewAt = VIEW_EVERY_MS
  let view = 0

  const history = new Map<number, Map<number, Pose>>()
  history.set(host.tickNo, poses(game))
  let tickIndex = 0
  for (let now = 0; now < endMs; now++) {
    clock.now = now
    measuring = now >= WARMUP_MS
    for (const remote of remotes) remote.up.deliver(now, (bytes) => command(remote, bytes))
    if (churn && now >= viewAt) {
      viewAt += VIEW_EVERY_MS
      view = (view + 1) % players.length
      spectators[0].setView(players[view].id)
      watch!.triggers.viewSwitches += 1
    }
    while (tickAt(tickIndex + 1) <= now) {
      tickIndex += 1
      tally.tee = 0
      const started = realNow()
      host.tick(SIM_STEP)
      const spent = realNow() - started - tally.tee
      if (measuring) {
        tally.host += spent
        tally.worst = Math.max(tally.worst, spent)
        tally.ticks += 1
      }
      history.set(host.tickNo, poses(game))
      history.delete(host.tickNo - HISTORY_TICKS)
      hashGame(gameHash, host.tickNo, game)
      watch?.observe()
    }
    for (const remote of remotes) remote.down.deliver(now, (bytes) => receive(remote, bytes, now))
    for (const remote of remotes) {
      if (remote.phase + Math.floor((remote.renders * 1000) / RENDER_HZ) > now) continue
      remote.renders += 1
      render(remote, (now - remote.renderedAt) / 1000, now)
      remote.renderedAt = now
    }
  }

  const seconds = measureMs / 1000
  const gameMs = tally.game / tally.ticks
  const aiMs = tally.ai / tally.ticks
  const hostMs = tally.host / tally.ticks
  return {
    remotes,
    row: () => ({
      scenario: SCENARIO_NAMES[spec.scenario],
      size: spec.size,
      net: LINK_NAMES[spec.link],
      seed: spec.seed,
      seconds,
      ticks: tally.ticks,
      clients: remotes.map((remote) => clientRow(remote, seconds)),
      server: {
        hostMs: round(hostMs),
        gameMs: round(gameMs),
        aiMs: round(aiMs),
        networkMs: round(hostMs - gameMs - aiMs),
        worstMs: round(tally.worst),
      },
      triggers: watch ? { ...watch.triggers } : null,
      hash: hash.digest('hex'),
      gameHash: gameHash.digest('hex'),
      commandHash: createHash('sha256').update(JSON.stringify(commands)).digest('hex'),
      commands,
    }),
  }

  function attachRemote(tag: number, player: Player, enemyTown: TileCoord, index: number): Remote {
    const replica = new Replica({ rollback: true })
    const port: ClientPort = {
      send: (message) => send(remote, message),
      onServer() {},
    }
    const remote: Remote = {
      tag,
      player,
      enemyTown,
      replica,
      commander: new Commander(replica, port),
      down: new Pipe(profile, mulberry32(spec.seed * 31 + index * 2 + 1)),
      up: new Pipe(profile, mulberry32(spec.seed * 31 + index * 2 + 2)),
      seq: 0,
      sentAt: new Map(),
      frames: [],
      rawBytes: 0,
      deflatedBytes: 0,
      framesSent: 0,
      events: new Map(),
      corrections: 0,
      visibleCorrections: 0,
      resyncRequests: 0,
      snapshots: 0,
      dropped: 0,
      phase: Math.floor(mulberry32(spec.seed * 31 + index * 2 + 3)() * (1000 / RENDER_HZ)),
      renders: 0,
      renderedAt: 0,
      pingAt: PING_MS,
      actAt: ORDER_AT_MS,
      echo: new Samples(),
      own: new Samples(),
      enemy: new Samples(),
      lag: 0,
      lagSamples: 0,
      firstTick: null,
      acts: 0,
      placeTries: 0,
      strikeTarget: null,
      play: host.attach(player.id, true, (frame) => {
        const bytes = encodeServerFrame(frame)
        tee(tag, frame, bytes)
        remote.down.send(clock.now, bytes)
        remote.frames.push({ bytes, measured: measuring })
        if (!measuring) return
        remote.rawBytes += bytes.length
        remote.framesSent += 1
        for (const event of frame.events) remote.events.set(event.kind, (remote.events.get(event.kind) ?? 0) + 1)
      }),
    }
    replica.onCorrection = (jump) => {
      if (!measuring) return
      remote.corrections += 1
      if (jump > VISIBLE_JUMP) remote.visibleCorrections += 1
    }
    remote.play.sync()
    return remote
  }

  /** Hashes a frame sent to session `tag`; the time it takes is kept off the server's tally. */
  function tee(tag: number, frame: ServerFrame, sent: Uint8Array | null) {
    const started = realNow()
    hashFrame(hash, tag, frame, sent)
    watch?.explored(frame)
    tally.tee += realNow() - started
  }

  /** Passes a client's message to the host and records it when the host hands it to the Game. */
  function relay<T>(tag: number, message: ClientMessage, pass: () => T): T {
    moveLag = undefined
    const result = pass()
    if (message.kind !== ClientMessageKind.Ping && message.kind !== ClientMessageKind.RequestSnapshot) {
      commands.push(moveLag === undefined ? { tag, tick: host.tickNo, message } : { tag, tick: host.tickNo, message, lag: moveLag })
    }
    return result
  }

  function send(remote: Remote, message: ClientMessage): number {
    remote.seq += 1
    remote.up.send(clock.now, encodeClientMessage(message, remote.seq, remote.replica.localTick))
    remote.sentAt.set(remote.seq, clock.now)
    return remote.seq
  }

  function command(remote: Remote, bytes: Uint8Array) {
    const decoded = decodeClientMessage(bytes)
    if (!decoded) return
    const kind = decoded.message.kind
    const placing = kind === ClientMessageKind.PlaceCity || kind === ClientMessageKind.PlaceBuilding
    if (placing) remote.player.credits = Math.max(remote.player.credits, CHURN_CREDITS)
    const layouts = watch && placing ? game.cityLayouts() : null
    const units = game.units.length
    relay(remote.tag, decoded.message, () => remote.play.command(decoded.message, decoded.seq, decoded.tick))
    if (!watch || !layouts) return
    if (kind === ClientMessageKind.PlaceCity && game.cityLayouts().some((layout, index) => layout !== layouts[index])) {
      watch.triggers.placeCity += 1
    }
    if (kind === ClientMessageKind.PlaceBuilding && game.units.length > units) watch.triggers.placeBuilding += 1
    watch.observe()
  }

  function receive(remote: Remote, bytes: Uint8Array, now: number) {
    const frame = decodeServerFrame(bytes)
    if (!frame) throw new Error('undecodable frame')
    const replica = remote.replica
    const snapshot = frame.events.some((event) => event.kind === ServerEventKind.Snapshot)
    if (snapshot && replica.world) remote.snapshots += 1
    const joined = replica.world !== null
    replica.apply(frame, now)
    if (!snapshot && joined && Math.abs(frame.tick - replica.localTick) > SNAPSHOT_GAP) remote.dropped += 1
    for (const [seq, at] of remote.sentAt) {
      if (seq > frame.ack) continue
      if (measuring) remote.echo.push(now - at)
      remote.sentAt.delete(seq)
    }
  }

  function render(remote: Remote, dt: number, now: number) {
    const replica = remote.replica
    if (replica.advance(dt)) {
      remote.resyncRequests += 1
      send(remote, { kind: ClientMessageKind.RequestSnapshot })
    }
    const drawn = replica.drawn()
    if (now >= remote.pingAt) {
      send(remote, { kind: ClientMessageKind.Ping })
      remote.pingAt += PING_MS
    }
    if (replica.world && now >= remote.actAt) act(remote)
    if (!measuring || !replica.world) return
    remote.lag += host.tickNo - replica.localTick
    remote.lagSamples += 1
    remote.firstTick ??= replica.localTick
    const at = replica.localTick - 1 + replica.drawPhase()
    const floor = Math.floor(at)
    const from = history.get(floor)
    const to = history.get(floor + 1)
    if (!from || !to) return
    const weight = at - floor
    for (const unit of drawn) {
      if (UNIT_TYPES[unit.typeId].topSpeed <= 0) continue
      const a = from.get(unit.id)
      const b = to.get(unit.id)
      if (!a || !b) continue
      const error = Math.hypot(unit.x - (a.x + (b.x - a.x) * weight), unit.z - (a.z + (b.z - a.z) * weight))
      if (unit.ownerId === replica.playerId) remote.own.push(error)
      else remote.enemy.push(error)
    }
  }

  function act(remote: Remote) {
    const replica = remote.replica
    const commander = remote.commander
    if (spec.scenario === Scenario.Battle) {
      remote.actAt = Infinity
      commander.selectIds(replica.units.map((unit) => unit.id))
      commander.orderMove(midpoint(towns[0], towns[1]))
    } else if (spec.scenario === Scenario.Assault) {
      remote.actAt += ASSAULT_EVERY_MS
      commander.selectIds(replica.units.map((unit) => unit.id))
      const enemies = replica.units.filter((unit) => unit.ownerId !== replica.playerId && unit.health > 0).sort(byId)
      if (enemies.length > 0) commander.orderAttack(enemies[Math.floor(actions() * enemies.length)].id)
      else commander.orderMove(remote.enemyTown)
    } else if (spec.scenario === Scenario.Economy) {
      remote.actAt += TRAIN_CHECK_MS
      const factory = replica.units.find(
        (unit) => unit.ownerId === replica.playerId && unit.typeId === UnitTypeId.Factory && unit.health > 0 && unit.progress >= 1,
      )
      if (factory && replica.queue().length < TRAIN_QUEUE) {
        commander.select(factory.id)
        commander.spawn(UnitTypeId.Scout)
      }
    } else if (churn) {
      remote.actAt += CHURN_EVERY_MS
      churnAct(remote)
    } else remote.actAt = Infinity
  }

  /**
   * Splits the remote player's tanks into a capture, a siege and a strike group and sends its scouts to the
   * farthest cities, then keeps placing a factory and city buildings and attack-ordering a visible enemy structure.
   */
  function churnAct(remote: Remote) {
    const replica = remote.replica
    const commander = remote.commander
    const index = players.indexOf(remote.player)
    const own = replica.units.filter((unit) => unit.ownerId === replica.playerId && unit.health > 0).sort(byId)
    const tanks = own.filter((unit) => unit.typeId === UnitTypeId.MedTank)
    const third = Math.ceil(tanks.length / 3)
    const states = game.cityStates()
    const centers = game.cityLayouts().map((layout) => cityCenter(layout))
    const home = tileOf(towns[index])
    const order = (units: readonly { id: number }[], tile: TileCoord) => {
      if (units.length === 0) return
      commander.selectIds(units.map((unit) => unit.id))
      commander.orderMove(tile)
    }
    if (remote.acts % 10 === 0) {
      const neutral = centers.filter((_, city) => states[city].ownerId === 0)
      neutral.sort((a, b) => distance(a, home) - distance(b, home))
      if (neutral.length > 0) order(tanks.slice(0, third), neutral[0])
    }
    if (remote.acts === 0) {
      const outpost = outposts[index] ?? remote.enemyTown
      order(tanks.slice(third, third * 2), outpost)
      order(tanks.slice(third * 2), outpost)
      const far = [...centers].sort((a, b) => distance(b, home) - distance(a, home))
      own.filter((unit) => unit.typeId === UnitTypeId.Scout).forEach((scout, at) => order([scout], far[at % far.length]))
    }
    remote.acts += 1
    const structure = replica.units
      .filter((unit) => unit.ownerId !== replica.playerId && unit.health > 0 && UNIT_TYPES[unit.typeId].topSpeed <= 0)
      .sort(byId)[0]
    const strike = tanks.slice(third * 2)
    if (structure && remote.strikeTarget !== structure.id && strike.length > 0) {
      remote.strikeTarget = structure.id
      commander.selectIds(strike.map((unit) => unit.id))
      commander.orderAttack(structure.id)
    }
    if (!own.some((unit) => unit.typeId === UnitTypeId.Factory)) {
      for (let i = 0; i < CHURN_PLACE_TRIES; i++) {
        const step = PLACE_STEPS[remote.placeTries++ % PLACE_STEPS.length]
        commander.armBuilding(UnitTypeId.Factory)
        commander.placeBuilding({ x: home.x + step.x, y: home.y + step.y })
      }
    }
    const terrain = terrainOf(game)
    const { width, height } = game.world
    const layouts = game.cityLayouts()
    for (let city = 0; city < layouts.length; city++) {
      if (states[city].ownerId !== replica.playerId) continue
      const site = citySite(layouts[city], terrain, width, height)
      if (!site) continue
      commander.armCity()
      commander.placeCity(site)
      break
    }
  }
}

/** Scenario units and cities, placed before any session joins; churn returns each remote player's nearby AI town. */
function stage(scenario: Scenario, game: Game, players: readonly Player[], towns: readonly MapPoint[], all: readonly MapPoint[]): TileCoord[] {
  const outposts: TileCoord[] = []
  if (scenario === Scenario.Idle) deploy(game, players, towns, IDLE_ARMY, [UnitTypeId.MedTank])
  else if (scenario === Scenario.Battle) deploy(game, players, towns, BATTLE_ARMY, MIXED)
  else if (scenario === Scenario.Assault) deploy(game, players, towns, ASSAULT_ARMY, MIXED)
  else if (scenario === Scenario.Economy) {
    const claimed = new Set(towns)
    for (let index = 0; index < players.length; index++) {
      const home = towns[index]
      const id = players[index].id
      const near = all.filter((town) => !claimed.has(town))
      near.sort((a, b) => Math.hypot(a.x - home.x, a.y - home.y) - Math.hypot(b.x - home.x, b.y - home.y))
      for (const town of near.slice(0, ECONOMY_CITIES)) {
        game.claimCity(town, id)
        claimed.add(town)
      }
      game.placeNearAnchor(id, UnitTypeId.Factory)
      game.finishBuild(id)
      const anchor = tileOf(home)
      for (let reach = 3; reach < 12; reach++) if (game.setRally(id, { x: anchor.x + reach, y: anchor.y })) break
    }
  } else if (scenario === Scenario.Cities) {
    const free = all.filter((town) => !towns.includes(town))
    free.forEach((town, index) => game.claimCity(town, players[index % players.length].id))
    deploy(game, players, towns, CITIES_ARMY, [UnitTypeId.MedTank])
  } else {
    const claimed = new Set(towns)
    const claim = (from: MapPoint, playerId: number): MapPoint | null => {
      const near = all.filter((town) => !claimed.has(town))
      near.sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))
      if (near.length === 0) return null
      game.claimCity(near[0], playerId)
      claimed.add(near[0])
      return near[0]
    }
    for (let index = 0; index < 2; index++) {
      const ai = players[index + 2].id
      const town = claim(towns[index], ai)
      if (!town) continue
      outposts[index] = tileOf(town)
      for (const step of PLACE_STEPS) if (game.placeBuilding(ai, UnitTypeId.Factory, { x: outposts[index].x + step.x, y: outposts[index].y + step.y })) break
      game.finishBuild(ai)
    }
    players.forEach((player, index) => claim(towns[index], player.id))
    deploy(game, players, towns, CHURN_ARMY, CHURN_TYPES)
  }
  return outposts
}

/** Counts the churn scenario's triggers from the Game between ticks and from the frames sent. */
class Watch {
  readonly triggers: Triggers = {
    ownerFlips: 0,
    ruinsAdded: 0,
    placeCity: 0,
    placeBuilding: 0,
    structuresCompleted: 0,
    structuresDestroyed: 0,
    cityTilesExplored: 0,
    viewSwitches: 0,
  }
  private owners: number[]
  private ruins: number
  private readonly building = new Set<number>()
  private readonly standing = new Set<number>()
  private readonly bounds: Uint8Array

  constructor(private readonly game: Game) {
    const states = game.cityStates()
    this.owners = states.map((state) => state.ownerId)
    this.ruins = states.reduce((sum, state) => sum + state.ruins.length, 0)
    const { width, height } = game.world
    this.bounds = new Uint8Array(width * height)
    for (const layout of game.cityLayouts()) {
      if (layout.tiles.length === 0) continue
      const xs = layout.tiles.map((tile) => tile.x)
      const ys = layout.tiles.map((tile) => tile.y)
      for (let y = Math.max(0, Math.min(...ys)); y <= Math.min(height - 1, Math.max(...ys)); y++) {
        for (let x = Math.max(0, Math.min(...xs)); x <= Math.min(width - 1, Math.max(...xs)); x++) this.bounds[y * width + x] = 1
      }
    }
    this.structures()
  }

  observe() {
    const states = this.game.cityStates()
    states.forEach((state, index) => {
      if (state.ownerId !== this.owners[index]) this.triggers.ownerFlips += 1
    })
    this.owners = states.map((state) => state.ownerId)
    const ruins = states.reduce((sum, state) => sum + state.ruins.length, 0)
    this.triggers.ruinsAdded += ruins - this.ruins
    this.ruins = ruins
    this.structures()
  }

  explored(frame: ServerFrame) {
    const width = this.game.world.width
    for (const event of frame.events) {
      if (event.kind !== ServerEventKind.MapPatch) continue
      for (const cell of event.map.cells) this.triggers.cityTilesExplored += this.bounds[cell.y * width + cell.x]
    }
  }

  private structures() {
    const alive = new Set<number>()
    for (const unit of this.game.units) {
      if (unit.type.topSpeed > 0 || unit.health <= 0) continue
      alive.add(unit.id)
      if (unit.progress < 1) this.building.add(unit.id)
      else if (this.building.delete(unit.id)) this.triggers.structuresCompleted += 1
    }
    for (const id of this.standing) {
      if (alive.has(id)) continue
      this.triggers.structuresDestroyed += 1
      this.building.delete(id)
    }
    this.standing.clear()
    for (const id of alive) this.standing.add(id)
  }
}

/** The first open building plot of a city, scanning its bounding box row by row. */
function citySite(layout: CityLayout, terrain: ArrayLike<number>, width: number, height: number): TileCoord | null {
  if (layout.tiles.length === 0) return null
  const xs = layout.tiles.map((tile) => tile.x)
  const ys = layout.tiles.map((tile) => tile.y)
  for (let y = Math.min(...ys) - 1; y <= Math.max(...ys) + 1; y++) {
    for (let x = Math.min(...xs) - 1; x <= Math.max(...xs) + 1; x++) {
      if (canPlaceCityBuilding(layout, x, y, terrain, width, height)) return { x, y }
    }
  }
  return null
}

function terrainOf(game: Game): number[] {
  const terrain: number[] = []
  for (let y = 0; y < game.world.height; y++) for (let x = 0; x < game.world.width; x++) terrain.push(game.world.terrainAt(x, y))
  return terrain
}

const PLACE_STEPS = placeSteps()

/** Factory tiles to try around a home town, nearest ring first. */
function placeSteps(): TileCoord[] {
  const steps: TileCoord[] = []
  for (let radius = 3; radius <= 7; radius++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) if (Math.max(Math.abs(x), Math.abs(y)) === radius) steps.push({ x, y })
    }
  }
  return steps
}

function distance(a: TileCoord, b: TileCoord): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function deploy(game: Game, players: readonly Player[], towns: readonly MapPoint[], count: number, types: readonly UnitTypeId[]) {
  for (let index = 0; index < players.length; index++) {
    for (let i = 0; i < count; i++) game.spawn(players[index], types[i % types.length], tileOf(towns[index]))
  }
}

function teePort(
  port: ClientPort,
  seen: (frame: ServerFrame) => void,
  relay: (message: ClientMessage, pass: () => number | null) => number | null,
): ClientPort {
  return {
    send: (message) => relay(message, () => port.send(message)),
    onServer: (handler) =>
      port.onServer((frame) => {
        seen(frame)
        handler(frame)
      }),
  }
}

/** Hashes MapPatch cells in tile order, since clients install them in any order; everything else as sent. */
function hashFrame(hash: Hash, tag: number, frame: ServerFrame, sent: Uint8Array | null) {
  const patched = frame.events.some((event) => event.kind === ServerEventKind.MapPatch)
  const bytes = sent && !patched ? sent : encodeServerFrame(patched ? sortedPatches(frame) : frame)
  const head = new DataView(new ArrayBuffer(8))
  head.setUint32(0, tag)
  head.setUint32(4, bytes.length)
  hash.update(new Uint8Array(head.buffer))
  hash.update(bytes)
}

function sortedPatches(frame: ServerFrame): ServerFrame {
  return {
    ...frame,
    events: frame.events.map((event) =>
      event.kind === ServerEventKind.MapPatch
        ? { ...event, map: { ...event.map, cells: [...event.map.cells].sort((a, b) => a.y - b.y || a.x - b.x) } }
        : event,
    ),
  }
}

function hashGame(hash: Hash, tick: number, game: Game) {
  const view = new DataView(new ArrayBuffer(8 + game.units.length * 40))
  view.setUint32(0, tick)
  view.setUint32(4, game.units.length)
  game.units.forEach((unit, index) => {
    const at = 8 + index * 40
    view.setFloat64(at, unit.id)
    view.setFloat64(at + 8, unit.pos.x)
    view.setFloat64(at + 16, unit.pos.z)
    view.setFloat64(at + 24, unit.facing)
    view.setFloat64(at + 32, unit.health)
  })
  hash.update(new Uint8Array(view.buffer))
}

function byId(a: { id: number }, b: { id: number }): number {
  return a.id - b.id
}

function poses(game: Game): Map<number, Pose> {
  const out = new Map<number, Pose>()
  for (const unit of game.units) {
    if (unit.health > 0 && unit.type.topSpeed > 0) out.set(unit.id, { x: unit.pos.x, z: unit.pos.z })
  }
  return out
}

/** Bytes after a per-client deflate stream flushed once per frame, without the 4-byte tail each flush ends with. */
async function deflateAll(remotes: readonly Remote[]) {
  for (const remote of remotes) {
    const stream = createDeflateRaw()
    let out = 0
    stream.on('data', (chunk: Buffer) => {
      out += chunk.length
    })
    for (const frame of remote.frames) {
      out = 0
      stream.write(frame.bytes)
      await new Promise<void>((resolve) => stream.flush(constants.Z_SYNC_FLUSH, () => resolve()))
      if (frame.measured) remote.deflatedBytes += out - DEFLATE_TAIL
    }
    stream.close()
  }
}

function clientRow(remote: Remote, seconds: number): ClientRow {
  const events: Record<string, number> = {}
  for (const [kind, count] of [...remote.events].sort((a, b) => a[0] - b[0])) events[EVENT_NAMES[kind]] = round(count / seconds)
  return {
    playerId: remote.player.id,
    rawBytesPerSec: round(remote.rawBytes / seconds),
    deflatedBytesPerSec: round(remote.deflatedBytes / seconds),
    framesPerSec: round(remote.framesSent / seconds),
    eventsPerSec: events,
    correctionsPerSec: round(remote.corrections / seconds),
    visibleCorrectionsPerSec: round(remote.visibleCorrections / seconds),
    resyncRequests: remote.resyncRequests,
    snapshotsAfterJoin: remote.snapshots,
    droppedFrames: remote.dropped,
    echoMs: remote.echo.spread(),
    ownError: remote.own.spread(),
    enemyError: remote.enemy.spread(),
    lagTicks: remote.lagSamples === 0 ? null : round(remote.lag / remote.lagSamples),
    ticksPerSec: remote.firstTick === null ? null : round((remote.replica.localTick - remote.firstTick) / seconds),
  }
}

function tickAt(tick: number): number {
  return Math.round(tick * SIM_STEP * 1000)
}

function tileOf(point: MapPoint): TileCoord {
  return { x: Math.floor(point.x), y: Math.floor(point.y) }
}

function midpoint(a: MapPoint, b: MapPoint): TileCoord {
  return { x: Math.floor((a.x + b.x) / 2), y: Math.floor((a.y + b.y) / 2) }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const USAGE = `Usage: npm run bench -- [options]

Plays a scripted match on a real server with remote clients behind a simulated
network, and reports what each client receives and draws. Time is simulated;
only the server ms/tick columns read the real clock.

Options:
  --scenario <name>  idle, battle, assault, economy, cities, or churn. Default: battle
  --size <n>         128 or 256. Default: 128
  --net <name>       lan, wan, bad, or spike. Default: wan
  --seed <n>         Map, game and network seed. Default: 11
  --all              Every scenario but churn, at every size and network (40 cases)
  --client <n>       Remote client the table shows. Default: 0
  --json             One JSON row per case, with every client, instead of the table
  --help             Show this help
`

const COLUMNS = [
  'case', 'raw B/s', 'deflated B/s', 'frames/s', 'events/s', 'corr/s', 'visible/s', 'resync', 'snap', 'drop',
  'echo ms p50/p95/max', 'own p95/p99/max', 'enemy p95/p99/max', 'lag', 'ticks/s', 'host', 'game', 'ai', 'net', 'worst',
  'frame hash', 'game hash', 'command hash',
]

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const seed = Math.floor(numberArg('--seed', 11))
  const json = process.argv.includes('--json')
  const client = Math.floor(numberArg('--client', 0))
  const specs: CaseSpec[] = []
  if (process.argv.includes('--all')) {
    for (let scenario = Scenario.Idle; scenario <= Scenario.Cities; scenario++) {
      for (const size of SIZES) for (let link = Link.Lan; link <= Link.Spike; link++) specs.push({ scenario, size, link, seed })
    }
  } else {
    specs.push({
      scenario: nameArg('--scenario', SCENARIO_NAMES, Scenario.Battle),
      size: sizeArg(),
      link: nameArg('--net', LINK_NAMES, Link.Wan),
      seed,
    })
  }
  const started = performance.now()
  if (!json) {
    console.log(`| ${COLUMNS.join(' | ')} |`)
    console.log(`|${COLUMNS.map(() => '---').join('|')}|`)
  }
  for (const spec of specs) {
    const row = await runCase(spec)
    console.log(json ? JSON.stringify(row) : tableRow(row, client))
    if (!json && row.triggers) process.stderr.write(`${row.scenario}-${row.size} ${row.net} triggers ${JSON.stringify(row.triggers)}\n`)
  }
  process.stderr.write(`${specs.length} case(s) in ${((performance.now() - started) / 1000).toFixed(1)} s\n`)
}

function tableRow(row: Row, client: number): string {
  const c = row.clients[client]
  if (!c) throw new Error(`no client ${client}; this case has ${row.clients.length}`)
  const events = Object.values(c.eventsPerSec).reduce((sum, rate) => sum + rate, 0)
  const s = row.server
  return `| ${[
    `${row.scenario}-${row.size} ${row.net}`,
    c.rawBytesPerSec.toFixed(0),
    c.deflatedBytesPerSec.toFixed(0),
    c.framesPerSec.toFixed(2),
    events.toFixed(1),
    c.correctionsPerSec.toFixed(2),
    c.visibleCorrectionsPerSec.toFixed(2),
    c.resyncRequests,
    c.snapshotsAfterJoin,
    c.droppedFrames,
    c.echoMs ? `${c.echoMs.p50} / ${c.echoMs.p95} / ${c.echoMs.max}` : '–',
    spread(c.ownError),
    spread(c.enemyError),
    c.lagTicks?.toFixed(2) ?? '–',
    c.ticksPerSec?.toFixed(2) ?? '–',
    s.hostMs.toFixed(2),
    s.gameMs.toFixed(2),
    s.aiMs.toFixed(2),
    s.networkMs.toFixed(2),
    s.worstMs.toFixed(1),
    row.hash.slice(0, 12),
    row.gameHash.slice(0, 12),
    row.commandHash.slice(0, 12),
  ].join(' | ')} |`
}

function spread(value: Spread | null): string {
  return value ? `${value.p95.toFixed(3)} / ${value.p99.toFixed(3)} / ${value.max.toFixed(2)}` : '–'
}

function numberArg(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isFinite(value)) throw new Error(`${flag} needs a number`)
  return value
}

function nameArg<T extends number>(flag: string, names: readonly string[], fallback: T): T {
  const index = process.argv.indexOf(flag)
  if (index < 0) return fallback
  const found = names.indexOf(process.argv[index + 1])
  if (found < 0) throw new Error(`${flag} takes ${names.join(', ')}`)
  return found as T
}

function sizeArg(): number {
  const size = numberArg('--size', 128)
  if (!(SIZES as readonly number[]).includes(size)) throw new Error(`--size takes ${SIZES.join(' or ')}`)
  return size
}
