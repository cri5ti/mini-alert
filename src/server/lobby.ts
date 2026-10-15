import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_LANDFORM,
  DEFAULT_MAP_SIZE,
  LAKE_DEFAULT,
  AI_PACE_DEFAULT,
  clampAiPace,
  clampLakes,
  isLandform,
  isMapSize,
  LobbyClientKind,
  LobbyServerKind,
  Landform,
  MapSize,
  RoomStatus,
  SlotKind,
  slotsForSize,
  type ChatLine,
  type Faction,
  type GameCard,
  type GameLobbyState,
  type LobbyClientMessage,
  type LobbyServerMessage,
  type MapPreview,
  type Person,
  type SlotView,
  type WaitingRoom,
} from '../shared/lobby.ts'
import { PLAYER_COLORS } from '../shared/players.ts'
import { ServerEventKind, type ClientMessage, type MapPoint, type ServerFrame, type TraceSample } from '../shared/protocol.ts'
import { AiPlayer } from '../ai/player.ts'
import type { RemotePlay } from './host.ts'
import { ServerHost } from './host.ts'
import { seatIsland, spreadTowns } from './island-match.ts'
import { generateIsland, type Island } from './mapgen/generate.ts'
import { pack, unpack } from './persist.ts'
import { RequestBoard, type RequestsSave } from './requests.ts'
import './state.ts'
import { Game } from './game.ts'

const CHAT_LIMIT = 40
const NAME_LIMIT = 16
const TEXT_LIMIT = 200
const WAITING_HOLD_SECONDS = 10 * 60

export type LobbySocket = {
  send(message: LobbyServerMessage): void
  sendGame(message: ServerFrame): void
  close(): void
}

/** A connection's handle on its member; it stops acting for the member once that connection closes or a newer one takes the seat. */
export type LobbyMember = {
  readonly id: number
  readonly socket: LobbySocket
}

type Slot = {
  kind: SlotKind
  clientId: number
  name: string
}

type Member = {
  id: number
  token: string
  name: string
  socket: LobbySocket | null
  /** Lobby clock reading when the member went offline; null while connected. */
  leftAt: number | null
  gameId: number | null
  admin: boolean
}

type Match = {
  host: ServerHost
  factions: Faction[]
  seats: Map<number, RemotePlay>
  owners: Map<number, number>
}

type GameRoom = {
  id: number
  hostId: number
  status: RoomStatus
  mapSize: MapSize
  landform: Landform
  lakes: number
  slots: Slot[]
  memberIds: number[]
  chat: ChatLine[]
  island: Island | null
  preview: string
  previewWidth: number
  previewHeight: number
  starts: MapPoint[]
  match: Match | null
  generating: boolean
  token: number
  aiPace: number
}

export type HallSave = {
  nextId: number
  nextGame: number
  hallChat: ChatLine[]
  members: { id: number; token: string; name: string; gameId: number | null; admin: boolean }[]
}

export class Lobby {
  onSave: () => void = () => {}
  private nextId = 1
  private nextGame = 1
  private readonly members = new Map<number, Member>()
  private readonly tokens = new Map<string, number>()
  private readonly games = new Map<number, GameRoom>()
  private readonly hallChat: ChatLine[] = []
  private readonly board = new RequestBoard()
  private clock = 0

  constructor(private readonly random: () => number = Math.random) {}

  gameIds(): number[] {
    return [...this.games.keys()]
  }

  savedHall(): HallSave {
    return {
      nextId: this.nextId,
      nextGame: this.nextGame,
      hallChat: this.hallChat.slice(),
      members: [...this.members.values()].map((member) => ({
        id: member.id,
        token: member.token,
        name: member.name,
        gameId: member.gameId,
        admin: member.admin,
      })),
    }
  }

  savedBoard(): RequestsSave {
    return this.board.saved()
  }

  saveGame(id: number): unknown {
    const room = this.games.get(id)
    if (!room) throw new Error(`missing game ${id}`)
    return this.packRoom(room)
  }

  loadHall(data: unknown) {
    if (!data || typeof data !== 'object') return
    const hall = data as Partial<HallSave>
    if (typeof hall.nextId === 'number') this.nextId = hall.nextId
    if (typeof hall.nextGame === 'number') this.nextGame = hall.nextGame
    if (Array.isArray(hall.hallChat)) this.hallChat.push(...hall.hallChat)
    if (!Array.isArray(hall.members)) return
    for (const member of hall.members) {
      if (!member || typeof member.id !== 'number' || typeof member.token !== 'string') continue
      this.members.set(member.id, {
        id: member.id,
        token: member.token,
        name: typeof member.name === 'string' && member.name ? member.name : `Player ${member.id}`,
        socket: null,
        leftAt: this.clock,
        gameId: typeof member.gameId === 'number' ? member.gameId : null,
        admin: member.admin === true,
      })
      this.tokens.set(member.token, member.id)
      this.nextId = Math.max(this.nextId, member.id + 1)
    }
  }

  loadBoard(data: unknown) {
    this.board.load(data)
  }

  loadGame(data: unknown): boolean {
    const body = unpack(data) as Record<string, unknown>
    const id = body.id
    if (typeof id !== 'number') return false
    const saved = body.match as { factions?: Faction[]; owners?: Map<number, number>; sim?: unknown } | null
    const room = body as unknown as GameRoom
    room.generating = false
    room.match = null
    if (!isLandform(room.landform)) room.landform = DEFAULT_LANDFORM
    room.lakes = clampLakes(room.lakes)
    if (saved) {
      if (!(saved.sim instanceof Game) || !Array.isArray(saved.factions) || !(saved.owners instanceof Map)) return false
      room.match = this.boot(saved.sim, saved.factions, saved.owners, room.aiPace)
    } else if (room.status === RoomStatus.Playing) return false
    this.games.set(id, room)
    this.nextGame = Math.max(this.nextGame, id + 1)
    return true
  }

  loadDone() {
    for (const game of this.games.values()) this.nextGame = Math.max(this.nextGame, game.id + 1)
    for (const member of this.members.values()) {
      this.nextId = Math.max(this.nextId, member.id + 1)
      if (member.gameId !== null && !this.games.has(member.gameId)) member.gameId = null
    }
  }

  private checkpoint() {
    try {
      this.onSave()
    } catch (err) {
      console.error('save failed', err)
    }
  }

  private packRoom(room: GameRoom): unknown {
    const body = pack(room, ['match'])
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('save room')
    const record = body as Record<string, unknown>
    const match = room.match
    record.match = match
      ? { factions: match.factions, owners: pack(match.owners), sim: pack(match.host.game) }
      : null
    return record
  }

  private boot(game: Game, factions: Faction[], owners: Map<number, number>, pace: number): Match {
    const host = new ServerHost(game)
    for (const faction of factions) {
      if (!faction.ai || faction.defeated) continue
      const player = game.player(faction.playerId)
      if (!player) continue
      const port = host.join(player)
      host.addAi(new AiPlayer(port))
      host.sync(player.id)
    }
    if (typeof pace === 'number') host.setAiPace(pace)
    return { host, factions, seats: new Map(), owners }
  }

  connect(socket: LobbySocket, token?: string | null): LobbyMember {
    const clean = cleanToken(token)
    const prior = clean === null ? undefined : this.memberByToken(clean)
    if (prior) {
      if (prior.socket) this.replace(prior, prior.socket)
      prior.socket = socket
      prior.leftAt = null
      this.reenter(prior)
      return { id: prior.id, socket }
    }
    const member: Member = {
      id: this.nextId++,
      token: clean ?? this.mintToken(),
      name: '',
      socket,
      leftAt: null,
      gameId: null,
      admin: false,
    }
    member.name = `Player ${member.id}`
    this.tokens.set(member.token, member.id)
    this.members.set(member.id, member)
    this.refreshWaiting()
    return { id: member.id, socket }
  }

  disconnect(member: LobbyMember) {
    const client = this.live(member)
    if (!client) return
    client.socket = null
    client.leftAt = this.clock
    this.detachSeat(client)
    const game = this.gameOf(client)
    if (game) this.refreshGame(game)
    this.refreshWaiting()
  }

  onLobby(member: LobbyMember, message: LobbyClientMessage) {
    const client = this.live(member)
    if (!client || !message || typeof message.kind !== 'number') return
    if (message.kind === LobbyClientKind.SetName) this.rename(client, message.name)
    else if (message.kind === LobbyClientKind.CreateGame) this.createGame(client)
    else if (message.kind === LobbyClientKind.JoinGame) this.joinGame(client, message.gameId)
    else if (message.kind === LobbyClientKind.LeaveRoom) this.leaveGame(client)
    else if (message.kind === LobbyClientKind.TakeSlot) this.takeSlot(client, message.index)
    else if (message.kind === LobbyClientKind.SetSlotAi) this.fillAi(client, message.index)
    else if (message.kind === LobbyClientKind.ClearSlot) this.clearSlot(client, message.index)
    else if (message.kind === LobbyClientKind.SetMapSize) this.resize(client, message.size)
    else if (message.kind === LobbyClientKind.SetLandform) this.setLandform(client, message.landform)
    else if (message.kind === LobbyClientKind.SetLakes) this.setLakes(client, message.lakes)
    else if (message.kind === LobbyClientKind.StartGame) this.start(client)
    else if (message.kind === LobbyClientKind.Chat) this.say(client, message.text)
    else if (message.kind === LobbyClientKind.ViewAs) this.viewAs(client, message.playerId)
    else if (message.kind === LobbyClientKind.Regenerate) this.regenerate(client)
    else if (message.kind === LobbyClientKind.SetAiPace) this.setAiPace(client, message.pace)
    else if (message.kind === LobbyClientKind.ClaimAdmin) client.admin = true
    else if (message.kind === LobbyClientKind.DestroyGame) this.destroyGame(client, message.gameId)
    else if (message.kind === LobbyClientKind.PostRequest) this.boardChanged(this.board.post(client.id, client.name, message.text))
    else if (message.kind === LobbyClientKind.ToggleVote) this.boardChanged(this.board.toggle(client.id, message.requestId))
    else if (message.kind === LobbyClientKind.MarkRequestDone) this.boardChanged(client.admin && this.board.markDone(message.requestId))
    else if (message.kind === LobbyClientKind.DeleteRequest) this.boardChanged(client.admin && this.board.remove(message.requestId))
  }

  onGame(member: LobbyMember, message: ClientMessage, seq: number, tick: number) {
    const client = this.live(member)
    if (!client?.gameId) return
    this.games.get(client.gameId)?.match?.seats.get(client.id)?.command(message, seq, tick)
  }

  tick(dt: number) {
    this.clock += dt
    this.dropAway()
    for (const game of this.games.values()) {
      if (!game.match) continue
      if (!this.awake(game)) continue
      this.noteDefeats(game)
      if (!this.games.has(game.id) || !game.match) continue
      if (this.liveHumans(game) === 0) continue
      game.match.host.tick(dt)
    }
  }

  pushTrace(samples: TraceSample[], budget: number) {
    const frame: ServerFrame = {
      tick: 0,
      ack: 0,
      events: [{ kind: ServerEventKind.Trace, samples, budget }],
    }
    for (const member of this.members.values()) {
      if (!member.admin || !member.socket || member.gameId === null) continue
      const game = this.games.get(member.gameId)
      if (!game || game.status !== RoomStatus.Playing) continue
      member.socket.sendGame(frame)
    }
  }

  private rename(client: Member, value: unknown) {
    const game = this.gameOf(client)
    if (game?.status === RoomStatus.Playing) return
    const name = cleanName(value)
    if (!name) return
    client.name = name
    if (game) {
      for (const slot of game.slots) {
        if (slot.kind === SlotKind.Human && slot.clientId === client.id) slot.name = name
      }
      this.refreshGame(game)
    }
    this.refreshWaiting()
  }

  private createGame(client: Member) {
    if (client.gameId !== null) return
    const game = this.blankGame(client)
    client.gameId = game.id
    game.memberIds.push(client.id)
    this.refreshWaiting()
    this.queueGenerate(game)
    this.checkpoint()
  }

  private joinGame(client: Member, gameId: unknown) {
    if (client.gameId !== null || typeof gameId !== 'number') return
    const game = this.games.get(gameId)
    if (!game) return
    client.gameId = game.id
    game.memberIds.push(client.id)
    if (game.status === RoomStatus.Playing && game.match) {
      const view = game.match.factions[0]?.playerId ?? 0
      const seat = game.match.host.attach(view, false, (message) => client.socket?.sendGame(message))
      game.match.seats.set(client.id, seat)
      this.refreshGame(game)
      this.refreshWaiting()
      seat.sync()
      return
    }
    this.refreshGame(game)
    this.refreshWaiting()
    this.sendPreview(game, client)
  }

  private leaveGame(client: Member) {
    const game = this.gameOf(client)
    if (!game) return
    if (game.status === RoomStatus.Playing && game.match?.seats.get(client.id)?.playing) this.forfeit(game, client)
    this.dropFromGame(client, true)
    if (this.games.has(game.id) && game.status === RoomStatus.Playing && this.liveHumans(game) === 0) this.endGame(game)
    this.refreshWaiting()
  }

  private takeSlot(client: Member, index: unknown) {
    const game = this.waitingGame(client)
    const slot = this.slotAt(game, index)
    if (!game || !slot || slot.kind !== SlotKind.Open) return
    this.vacate(game, client.id)
    slot.kind = SlotKind.Human
    slot.clientId = client.id
    slot.name = client.name
    this.refreshGame(game)
    this.refreshWaiting()
  }

  private fillAi(client: Member, index: unknown) {
    const game = this.waitingGame(client)
    const slot = this.slotAt(game, index)
    if (!game || !slot || slot.kind !== SlotKind.Open) return
    slot.kind = SlotKind.Ai
    slot.clientId = 0
    slot.name = 'AI'
    this.refreshGame(game)
    this.refreshWaiting()
  }

  private clearSlot(client: Member, index: unknown) {
    const game = this.waitingGame(client)
    const slot = this.slotAt(game, index)
    if (!game || !slot) return
    const own = slot.kind === SlotKind.Human && slot.clientId === client.id
    if (!own && slot.kind !== SlotKind.Ai) return
    this.open(slot)
    this.refreshGame(game)
    this.refreshWaiting()
  }

  private resize(client: Member, size: unknown) {
    const game = this.waitingGame(client)
    if (!game || game.hostId !== client.id || typeof size !== 'number' || !isMapSize(size) || size === game.mapSize) return
    const previousSize = game.mapSize
    const previousSlots = game.slots.map((slot) => ({ ...slot }))
    const count = slotsForSize(size)
    if (count < game.slots.length) game.slots.length = count
    while (game.slots.length < count) game.slots.push(openSlot())
    game.mapSize = size
    this.queueGenerate(game, () => {
      game.mapSize = previousSize
      game.slots = previousSlots
    })
  }

  private setLandform(client: Member, landform: unknown) {
    const game = this.waitingGame(client)
    if (!game || game.hostId !== client.id || typeof landform !== 'number' || !isLandform(landform) || landform === game.landform) return
    const previous = game.landform
    game.landform = landform
    this.queueGenerate(game, () => {
      game.landform = previous
    })
  }

  private setLakes(client: Member, value: unknown) {
    const game = this.waitingGame(client)
    if (!game || game.hostId !== client.id || typeof value !== 'number') return
    const lakes = clampLakes(value)
    if (lakes === game.lakes) return
    const previous = game.lakes
    game.lakes = lakes
    this.queueGenerate(game, () => {
      game.lakes = previous
    })
  }

  private regenerate(client: Member) {
    const game = this.waitingGame(client)
    if (!game || game.hostId !== client.id) return
    this.queueGenerate(game)
  }

  private setAiPace(client: Member, value: unknown) {
    const game = this.gameOf(client)
    if (!game || typeof value !== 'number') return
    const pace = clampAiPace(value)
    if (pace === game.aiPace) return
    game.aiPace = pace
    game.match?.host.setAiPace(pace)
    this.refreshGame(game)
  }

  private start(client: Member) {
    const game = this.waitingGame(client)
    if (!game || game.hostId !== client.id || game.generating) return
    const occupied = game.slots.flatMap((slot, index) => (slot.kind === SlotKind.Open ? [] : [{ slot, index }]))
    if (!occupied.some((entry) => entry.slot.kind === SlotKind.Human)) return
    if (!game.island || game.island.towns.length < occupied.length) {
      if (!this.generate(game) || !game.island || game.island.towns.length < occupied.length) return
    }
    const starts = this.startsFor(game)
    const towns = occupied.map((entry) => starts[entry.index])
    if (towns.some((town) => !town)) return
    let sim: ReturnType<typeof seatIsland>
    try {
      sim = seatIsland(
        game.island,
        occupied.map((entry) => ({
          ai: entry.slot.kind === SlotKind.Ai,
          color: PLAYER_COLORS[entry.index % PLAYER_COLORS.length],
        })),
        towns,
      )
    } catch {
      return
    }
    const factions: Faction[] = occupied.map((entry, order) => ({
      playerId: sim.players[order].id,
      name: entry.slot.kind === SlotKind.Ai ? 'AI' : entry.slot.name,
      color: sim.players[order].color,
      ai: entry.slot.kind === SlotKind.Ai,
      defeated: false,
    }))
    const bots = occupied.flatMap((entry, order) =>
      entry.slot.kind === SlotKind.Ai ? [sim.players[order]] : [],
    )
    const host = new ServerHost(sim.game)
    for (const player of bots) {
      const port = host.join(player)
      host.addAi(new AiPlayer(port))
      host.sync(player.id)
    }
    host.setAiPace(game.aiPace)
    const seats = new Map<number, RemotePlay>()
    const owners = new Map<number, number>()
    game.status = RoomStatus.Playing
    game.match = { host, factions, seats, owners }
    for (const id of game.memberIds) {
      const member = this.members.get(id)
      if (!member) continue
      const order = occupied.findIndex((entry) => entry.slot.kind === SlotKind.Human && entry.slot.clientId === id)
      const playing = order >= 0
      const playerId = playing ? sim.players[order].id : factions[0].playerId
      if (playing) owners.set(playerId, id)
      if (!member.socket) continue
      const link = member.socket
      const seat = host.attach(playerId, playing, (message) => link.sendGame(message))
      seats.set(id, seat)
    }
    this.refreshGame(game)
    this.refreshWaiting()
    for (const seat of seats.values()) seat.sync()
    this.checkpoint()
  }

  private say(client: Member, value: unknown) {
    const text = cleanText(value)
    if (!text) return
    const game = this.gameOf(client)
    if (game?.status === RoomStatus.Playing) return
    const line = { name: client.name, text }
    const log = game ? game.chat : this.hallChat
    log.push(line)
    if (log.length > CHAT_LIMIT) log.shift()
    if (game) this.refreshGame(game)
    else this.refreshWaiting()
  }

  private viewAs(client: Member, playerId: unknown) {
    const game = this.gameOf(client)
    if (!game?.match || typeof playerId !== 'number') return
    const seat = game.match.seats.get(client.id)
    if (!seat || seat.playing) return
    if (!game.match.factions.some((faction) => faction.playerId === playerId)) return
    seat.setView(playerId)
  }

  private noteDefeats(game: GameRoom) {
    const match = game.match
    if (!match) return
    const fallen: Faction[] = []
    for (const faction of match.factions) {
      if (faction.defeated || standing(match.host.game, faction.playerId)) continue
      faction.defeated = true
      fallen.push(faction)
      match.host.silence(faction.playerId)
      const owner = match.owners.get(faction.playerId)
      const seat = owner === undefined ? undefined : match.seats.get(owner)
      seat?.retire()
    }
    if (fallen.length === 0) return
    this.refreshGame(game)
    const watch = match.factions.find((faction) => !faction.defeated)
    if (!watch) return
    for (const faction of fallen) {
      const owner = match.owners.get(faction.playerId)
      const seat = owner === undefined ? undefined : match.seats.get(owner)
      seat?.setView(watch.playerId)
    }
  }

  private boardChanged(changed: boolean) {
    if (changed) this.refreshWaiting()
  }

  private destroyGame(client: Member, gameId: unknown) {
    if (!client.admin || typeof gameId !== 'number') return
    const game = this.games.get(gameId)
    if (!game) return
    this.endGame(game)
  }

  private endGame(game: GameRoom) {
    game.token += 1
    game.generating = false
    const memberIds = game.memberIds.slice()
    const match = game.match
    if (match) {
      for (const seat of match.seats.values()) seat.close()
      match.seats.clear()
      match.host.dispose()
      game.match = null
    }
    game.memberIds = []
    this.games.delete(game.id)
    for (const id of memberIds) {
      const member = this.members.get(id)
      if (!member) continue
      member.gameId = null
    }
    this.refreshWaiting()
    this.checkpoint()
  }

  private forfeit(game: GameRoom, client: Member) {
    const match = game.match
    if (!match) return
    for (const faction of match.factions) {
      if (faction.ai || faction.defeated) continue
      if (match.owners.get(faction.playerId) !== client.id) continue
      faction.defeated = true
      match.host.silence(faction.playerId)
    }
    match.seats.get(client.id)?.retire()
  }

  private liveHumans(game: GameRoom): number {
    const match = game.match
    if (!match) return 0
    let count = 0
    for (const faction of match.factions) {
      if (!faction.ai && !faction.defeated) count += 1
    }
    return count
  }

  private onRoomChanged(game: GameRoom) {
    if (!this.games.has(game.id) || game.status !== RoomStatus.Playing) return
    if (game.memberIds.length > 0) return
    if (this.liveHumans(game) === 0) this.endGame(game)
  }

  private dropFromGame(client: Member, tell: boolean) {
    const game = client.gameId === null ? undefined : this.games.get(client.gameId)
    client.gameId = null
    if (!game) return
    game.memberIds = game.memberIds.filter((id) => id !== client.id)
    const seat = game.match?.seats.get(client.id)
    seat?.close()
    game.match?.seats.delete(client.id)
    let removed = false
    if (game.status === RoomStatus.Waiting) {
      for (const slot of game.slots) {
        if (slot.kind === SlotKind.Human && slot.clientId === client.id) this.open(slot)
      }
      if (game.hostId === client.id) this.transferHost(game)
      if (game.memberIds.length === 0) {
        this.games.delete(game.id)
        removed = true
      }
    } else this.onRoomChanged(game)
    this.refreshGame(game)
    if (tell) client.socket?.send(this.waitingState(client))
    if (removed) this.checkpoint()
  }

  private reenter(client: Member) {
    const game = this.gameOf(client)
    if (!game) {
      client.gameId = null
      this.refreshWaiting()
      return
    }
    if (!game.memberIds.includes(client.id)) game.memberIds.push(client.id)
    if (game.status === RoomStatus.Playing && game.match) {
      this.seatReturning(game, client)
      this.refreshGame(game)
      this.refreshWaiting()
      game.match.seats.get(client.id)?.sync()
      return
    }
    this.refreshGame(game)
    this.refreshWaiting()
    this.sendPreview(game, client)
  }

  private seatReturning(game: GameRoom, client: Member) {
    const match = game.match
    const link = client.socket
    if (!match || !link) return
    const playerId = this.seatId(game, client.id)
    const faction = match.factions.find((item) => item.playerId === playerId)
    const playing = playerId !== 0 && !!faction && !faction.defeated
    const view = playing ? playerId : (match.factions.find((item) => !item.defeated)?.playerId ?? match.factions[0]?.playerId ?? 0)
    const seat = match.host.attach(view, playing, (message) => link.sendGame(message))
    match.seats.set(client.id, seat)
  }

  private replace(client: Member, socket: LobbySocket) {
    this.detachSeat(client)
    socket.send({ kind: LobbyServerKind.Replaced })
    socket.close()
  }

  private dropAway() {
    let dropped = false
    for (const game of this.games.values()) {
      if (game.status !== RoomStatus.Waiting) continue
      for (const id of game.memberIds) {
        const member = this.members.get(id)
        if (!member || member.leftAt === null || this.clock - member.leftAt < WAITING_HOLD_SECONDS) continue
        this.dropFromGame(member, false)
        dropped = true
      }
    }
    if (dropped) this.refreshWaiting()
  }

  private detachSeat(client: Member) {
    const game = this.gameOf(client)
    const seat = game?.match?.seats.get(client.id)
    seat?.close()
    game?.match?.seats.delete(client.id)
  }

  private awake(game: GameRoom): boolean {
    for (const id of game.memberIds) {
      if (this.members.get(id)?.socket) return true
    }
    return false
  }

  private live(member: LobbyMember): Member | undefined {
    const client = this.members.get(member.id)
    return client?.socket === member.socket ? client : undefined
  }

  private memberByToken(token: string): Member | undefined {
    const id = this.tokens.get(token)
    return id === undefined ? undefined : this.members.get(id)
  }

  private mintToken(): string {
    let token = randomBytes(16).toString('hex')
    while (this.tokens.has(token)) token = randomBytes(16).toString('hex')
    return token
  }

  private transferHost(game: GameRoom) {
    for (const slot of game.slots) {
      if (slot.kind === SlotKind.Human && this.members.has(slot.clientId)) {
        game.hostId = slot.clientId
        return
      }
    }
    for (const id of game.memberIds) {
      if (this.members.has(id)) {
        game.hostId = id
        return
      }
    }
  }

  private blankGame(host: Member): GameRoom {
    const mapSize = DEFAULT_MAP_SIZE
    const game: GameRoom = {
      id: this.nextGame++,
      hostId: host.id,
      status: RoomStatus.Waiting,
      mapSize,
      landform: DEFAULT_LANDFORM,
      lakes: LAKE_DEFAULT,
      slots: Array.from({ length: slotsForSize(mapSize) }, openSlot),
      memberIds: [],
      chat: [],
      island: null,
      preview: '',
      previewWidth: mapSize,
      previewHeight: mapSize,
      starts: [],
      match: null,
      generating: false,
      token: 0,
      aiPace: AI_PACE_DEFAULT,
    }
    this.games.set(game.id, game)
    return game
  }

  private queueGenerate(game: GameRoom, rollback?: () => void) {
    const token = ++game.token
    game.generating = true
    this.refreshGame(game)
    this.refreshWaiting()
    setImmediate(() => {
      if (!this.games.has(game.id) || game.token !== token) return
      const ok = this.generate(game)
      if (!this.games.has(game.id) || game.token !== token) return
      game.generating = false
      if (!ok) {
        rollback?.()
        this.refreshGame(game)
        this.refreshWaiting()
        this.checkpoint()
        return
      }
      this.publishPreview(game)
      this.refreshGame(game)
      this.refreshWaiting()
      this.checkpoint()
    })
  }

  private generate(game: GameRoom): boolean {
    const need = slotsForSize(game.mapSize)
    let island: Island | null = null
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const seed = Math.floor(this.random() * 0x7fffffff) + 1
        const next = generateIsland(seed, game.mapSize, game.mapSize, { landform: game.landform, lakes: game.lakes })
        island = next
        if (next.towns.length >= need) break
      } catch {
        island = null
      }
    }
    if (!island) return false
    game.island = island
    game.preview = Buffer.from(island.terrain).toString('base64')
    game.previewWidth = island.width
    game.previewHeight = island.height
    game.starts = spreadTowns(island, game.slots.length)
    return true
  }

  private startsFor(game: GameRoom): MapPoint[] {
    if (!game.island) return game.starts
    if (game.starts.length === game.slots.length) return game.starts
    game.starts = spreadTowns(game.island, game.slots.length)
    return game.starts
  }

  private waitingGame(client: Member): GameRoom | undefined {
    const game = this.gameOf(client)
    if (!game || game.status !== RoomStatus.Waiting) return undefined
    return game
  }

  private gameOf(client: Member): GameRoom | undefined {
    if (client.gameId === null) return undefined
    return this.games.get(client.gameId)
  }

  private slotAt(game: GameRoom | undefined, index: unknown): Slot | undefined {
    if (!game || typeof index !== 'number' || !Number.isInteger(index)) return undefined
    return game.slots[index]
  }

  private vacate(game: GameRoom, clientId: number) {
    for (const slot of game.slots) {
      if (slot.kind === SlotKind.Human && slot.clientId === clientId) this.open(slot)
    }
  }

  private open(slot: Slot) {
    slot.kind = SlotKind.Open
    slot.clientId = 0
    slot.name = ''
  }

  private refreshWaiting() {
    for (const member of this.members.values()) {
      if (member.gameId === null) member.socket?.send(this.waitingState(member))
    }
  }

  private refreshGame(game: GameRoom) {
    if (!this.games.has(game.id)) return
    for (const id of game.memberIds) {
      const member = this.members.get(id)
      member?.socket?.send(this.gameState(game, member))
    }
  }

  private publishPreview(game: GameRoom) {
    for (const id of game.memberIds) {
      const member = this.members.get(id)
      if (member) this.sendPreview(game, member)
    }
  }

  private sendPreview(game: GameRoom, member: Member) {
    if (!game.preview || !member.socket) return
    member.socket.send(this.previewMessage(game))
  }

  private waitingState(member: Member): WaitingRoom {
    const people: Person[] = []
    for (const client of this.members.values()) {
      if (client.gameId === null && client.socket) people.push({ id: client.id, name: client.name })
    }
    const games: GameCard[] = []
    for (const game of this.games.values()) {
      games.push({
        id: game.id,
        status: game.status,
        mapSize: game.mapSize,
        landform: game.landform,
        lakes: game.lakes,
        slots: this.slotViews(game),
        waiting: this.waitingPeople(game).map((person) => person.name),
      })
    }
    return {
      kind: LobbyServerKind.Waiting,
      you: { id: member.id, name: member.name },
      people,
      games,
      chat: this.hallChat.slice(),
      requests: this.board.cards(member.id),
    }
  }

  private gameState(game: GameRoom, member: Member): GameLobbyState {
    return {
      kind: LobbyServerKind.GameLobby,
      you: { id: member.id, name: member.name },
      gameId: game.id,
      hostId: game.hostId,
      status: game.status,
      mapSize: game.mapSize,
      landform: game.landform,
      lakes: game.lakes,
      slots: this.slotViews(game),
      waiting: this.waitingPeople(game),
      chat: game.chat.slice(),
      spectating: this.watching(game, member.id),
      factions: game.match?.factions ?? [],
      generating: game.generating,
      seatId: this.seatId(game, member.id),
      aiPace: game.aiPace,
    }
  }

  private watching(game: GameRoom, clientId: number): boolean {
    if (game.status !== RoomStatus.Playing) return false
    const seat = game.match?.seats.get(clientId)
    if (!seat) return true
    return !seat.playing
  }

  private seatId(game: GameRoom, clientId: number): number {
    const owners = game.match?.owners
    if (!owners) return 0
    for (const [playerId, owner] of owners) {
      if (owner === clientId) return playerId
    }
    return 0
  }

  private previewMessage(game: GameRoom): MapPreview {
    return {
      kind: LobbyServerKind.Preview,
      gameId: game.id,
      width: game.previewWidth,
      height: game.previewHeight,
      terrain: game.preview,
      starts: game.starts.map((town) => ({ x: town.x, y: town.y })),
    }
  }

  private slotViews(game: GameRoom): SlotView[] {
    return game.slots.map((slot, index) => {
      const color = PLAYER_COLORS[index % PLAYER_COLORS.length]
      if (slot.kind === SlotKind.Human) {
        const member = this.members.get(slot.clientId)
        return { kind: slot.kind, name: member?.name ?? slot.name, clientId: slot.clientId, color }
      }
      if (slot.kind === SlotKind.Ai) return { kind: slot.kind, name: 'AI', clientId: 0, color }
      return { kind: SlotKind.Open, name: '', clientId: 0, color }
    })
  }

  private waitingPeople(game: GameRoom): Person[] {
    const seated = new Set(
      game.slots.flatMap((slot) => (slot.kind === SlotKind.Human ? [slot.clientId] : [])),
    )
    const people: Person[] = []
    for (const id of game.memberIds) {
      if (seated.has(id)) continue
      const member = this.members.get(id)
      if (member?.socket) people.push({ id: member.id, name: member.name })
    }
    return people
  }
}

function openSlot(): Slot {
  return { kind: SlotKind.Open, clientId: 0, name: '' }
}

function standing(game: { units: { ownerId: number; health: number }[]; cityStates(): { ownerId: number }[] }, playerId: number): boolean {
  for (const unit of game.units) {
    if (unit.ownerId === playerId && unit.health > 0) return true
  }
  for (const city of game.cityStates()) {
    if (city.ownerId === playerId) return true
  }
  return false
}

function cleanToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim().toLowerCase()
  return /^[a-f0-9]{32}$/.test(token) ? token : null
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().slice(0, NAME_LIMIT)
  return name.length > 0 ? name : null
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().slice(0, TEXT_LIMIT)
  return text.length > 0 ? text : null
}
