import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Landform,
  LobbyClientKind,
  LobbyServerKind,
  MapSize,
  RequestStatus,
  RoomStatus,
  type Faction,
  type GameLobbyState,
  type LobbyServerMessage,
  type WaitingRoom,
} from '../shared/lobby.ts'
import { mulberry32 } from '../shared/noise.ts'
import { ServerEventKind, type ServerFrame } from '../shared/protocol.ts'
import { Terrain } from '../shared/tiles.ts'
import { Game } from './game.ts'
import { createIslandMatch } from './island-match.ts'
import { Lobby, type LobbySocket } from './lobby.ts'
import { MAP_VERSION } from './mapgen/version.ts'
import { pack, unpack } from './persist.ts'
import { loadSaves, saveSaves } from './save.ts'
import './state.ts'

const dirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('saved games', () => {
  it('round-trips maps, bytes, and a live match', () => {
    const scores = new Map<number, string>([[2, 'a']])
    const grid = new Uint8Array([1, 2, 3, 4])
    const packed = unpack(pack({ scores, grid, names: new Set(['ada']) })) as {
      scores: Map<number, string>
      grid: Uint8Array
      names: Set<string>
    }
    expect([...packed.scores.keys()]).toEqual([2])
    expect(packed.scores.get(2)).toBe('a')
    expect(packed.grid).toEqual(grid)
    expect([...packed.names]).toEqual(['ada'])

    const { game, human } = createIslandMatch(3)
    const unit = game.units.find((item) => item.ownerId === human.id)
    expect(unit).toBeTruthy()
    if (!unit) return
    unit.health = 17
    unit.speed = 1.25
    unit.path = [{ x: 3, y: 4 }]
    unit.attackPoint = { x: 1.5, z: 2.5 }
    human.credits = 9989.5
    game.world.setTerrain(0, 0, Terrain.Land)
    const block = game.cityLayouts().flatMap((layout) => layout.buildings)[0]

    const revived = unpack(pack(game)) as Game
    expect(revived).toBeInstanceOf(Game)
    expect(revived.world.width).toBe(game.world.width)
    expect(revived.world.terrainAt(0, 0)).toBe(Terrain.Land)
    expect(revived.world.shiftAt(1, 1)).toBe(game.world.shiftAt(1, 1))
    expect(revived.scenery.seed).toBe(game.scenery.seed)
    expect(revived.scenery.towns).toEqual(game.scenery.towns)
    const copy = revived.units.find((item) => item.id === unit.id)
    expect(copy?.health).toBe(17)
    expect(copy?.speed).toBeCloseTo(1.25)
    expect(copy?.path).toEqual([{ x: 3, y: 4 }])
    expect(copy?.attackPoint).toEqual({ x: 1.5, z: 2.5 })
    expect(copy?.type).toBe(unit.type)
    expect(revived.pathfinder.occupant(unit.tile.x, unit.tile.y)).toBe(unit.id)
    if (block) expect(revived.pathfinder.isWalkable(block.x, block.y, -1)).toBe(false)
    expect(revived.player(human.id)?.credits).toBeCloseTo(9989.5)
    expect(revived.cityStates().map((city) => city.ownerId)).toEqual(game.cityStates().map((city) => city.ownerId))
    const before = revived.player(human.id)?.credits ?? 0
    revived.tick(10)
    expect(revived.player(human.id)?.credits).toBeGreaterThan(before)
  })

  it('restores every game and seats the same client again', async () => {
    const dir = scratch()
    const token = 'abc123abc123abc123abc123abc123ab'
    const lobby = new Lobby(mulberry32(1))
    const sock = fake()
    const host = lobby.connect(sock, token)
    lobby.onLobby(host, { kind: LobbyClientKind.SetName, name: 'Ada' })
    lobby.onLobby(host, { kind: LobbyClientKind.CreateGame })
    await settled()
    const created = latest<GameLobbyState>(sock, LobbyServerKind.GameLobby)
    lobby.onLobby(host, { kind: LobbyClientKind.TakeSlot, index: 0 })
    lobby.onLobby(host, { kind: LobbyClientKind.SetSlotAi, index: 1 })
    lobby.onLobby(host, { kind: LobbyClientKind.SetMapSize, size: MapSize.Tiny })
    await settled()
    lobby.onLobby(host, { kind: LobbyClientKind.StartGame })
    const playing = latest<GameLobbyState>(sock, LobbyServerKind.GameLobby)
    expect(playing.status).toBe(RoomStatus.Playing)

    const match = opened(lobby).games.get(created.gameId)?.match
    expect(match).toBeTruthy()
    if (!match) return
    const human = match.factions.find((faction) => !faction.ai)
    expect(human).toBeTruthy()
    if (!human) return
    const scout = match.host.game.units.find((unit) => unit.ownerId === human.playerId)
    expect(scout).toBeTruthy()
    if (!scout) return
    scout.health = 17
    lobby.tick(10)
    const credits = match.host.game.player(human.playerId)?.credits ?? 0
    const ids = match.host.game.units.map((unit) => unit.id).sort()
    lobby.disconnect(host)
    saveSaves(lobby, dir)

    const file = JSON.parse(readFileSync(join(dir, `game-${created.gameId}.json`), 'utf8')) as { mapVersion: number }
    expect(file.mapVersion).toBe(MAP_VERSION)

    const restored = new Lobby()
    loadSaves(restored, dir)
    const backSock = fake()
    const back = restored.connect(backSock, token)
    expect(back.id).toBe(host.id)
    const resumed = latest<GameLobbyState>(backSock, LobbyServerKind.GameLobby)
    expect(resumed.gameId).toBe(created.gameId)
    expect(resumed.status).toBe(RoomStatus.Playing)
    expect(resumed.seatId).toBe(playing.seatId)
    expect(resumed.you.name).toBe('Ada')
    expect(gameEvents(backSock).some((event) => event.kind === ServerEventKind.Welcome && event.playerId === playing.seatId)).toBe(true)

    const again = opened(restored).games.get(created.gameId)?.match
    expect(again?.host.game.player(human.playerId)?.credits).toBeCloseTo(credits)
    expect(again?.host.game.units.map((unit) => unit.id).sort()).toEqual(ids)
    expect(again?.host.game.units.find((unit) => unit.id === scout.id)?.health).toBe(17)
    expect((again?.host as unknown as { ais: unknown[] }).ais).toHaveLength(1)

    restored.onLobby(back, { kind: LobbyClientKind.LeaveRoom })
    saveSaves(restored, dir)
    expect(existsSync(join(dir, `game-${created.gameId}.json`))).toBe(false)
  })

  it('restores a waiting room with its island', async () => {
    const dir = scratch()
    const token = 'fed000fed000fed000fed000fed000fe'
    const lobby = new Lobby()
    const sock = fake()
    const host = lobby.connect(sock, token)
    lobby.onLobby(host, { kind: LobbyClientKind.CreateGame })
    await settled()
    const created = latest<GameLobbyState>(sock, LobbyServerKind.GameLobby)
    lobby.onLobby(host, { kind: LobbyClientKind.SetMapSize, size: MapSize.Tiny })
    await settled()
    lobby.onLobby(host, { kind: LobbyClientKind.SetLandform, landform: Landform.Land })
    await settled()
    lobby.onLobby(host, { kind: LobbyClientKind.SetLakes, lakes: 0.5 })
    await settled()
    saveSaves(lobby, dir)

    const restored = new Lobby()
    loadSaves(restored, dir)
    const backSock = fake()
    const back = restored.connect(backSock, token)
    expect(back.id).toBe(host.id)
    const room = latest<GameLobbyState>(backSock, LobbyServerKind.GameLobby)
    expect(room.gameId).toBe(created.gameId)
    expect(room.status).toBe(RoomStatus.Waiting)
    expect(room.mapSize).toBe(MapSize.Tiny)
    expect(room.landform).toBe(Landform.Land)
    expect(room.lakes).toBe(0.5)
    expect(room.hostId).toBe(host.id)
    const island = (restored as unknown as { games: Map<number, { island: { terrain: Uint8Array; width: number } | null }> }).games.get(created.gameId)?.island
    expect(island?.width).toBe(MapSize.Tiny)
    expect(island?.terrain.length).toBe(MapSize.Tiny * MapSize.Tiny)
  })

  it('skips a save whose map version is not the current one', () => {
    const dir = scratch()
    const token = 'def456def456def456def456def456de'
    writeFileSync(join(dir, 'hall.json'), JSON.stringify({
      nextId: 2,
      nextGame: 5,
      hallChat: [],
      members: [{ id: 1, token, name: 'Ada', gameId: 4, admin: false }],
    }))
    writeFileSync(join(dir, 'game-4.json'), JSON.stringify({ mapVersion: MAP_VERSION + 1, game: { id: 4 } }))
    const lobby = new Lobby()
    loadSaves(lobby, dir)
    const sock = fake()
    const member = lobby.connect(sock, token)
    expect(member.id).toBe(1)
    expect(latest<WaitingRoom>(sock, LobbyServerKind.Waiting).games).toEqual([])
    saveSaves(lobby, dir)
    expect(existsSync(join(dir, 'game-4.json'))).toBe(true)
  })

  it('restores the request board with every seat’s votes, and numbers the next request after it', () => {
    const dir = scratch()
    const adaToken = 'ada0ada0ada0ada0ada0ada0ada0ada0'
    const boToken = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'
    const lobby = new Lobby()
    const adaSock = fake()
    const boSock = fake()
    const ada = lobby.connect(adaSock, adaToken)
    const bo = lobby.connect(boSock, boToken)
    lobby.onLobby(ada, { kind: LobbyClientKind.SetName, name: 'Ada' })
    lobby.onLobby(bo, { kind: LobbyClientKind.SetName, name: 'Bo' })
    lobby.onLobby(ada, { kind: LobbyClientKind.PostRequest, text: 'Naval units' })
    lobby.onLobby(ada, { kind: LobbyClientKind.PostRequest, text: 'Replay viewer' })
    lobby.onLobby(bo, { kind: LobbyClientKind.PostRequest, text: 'Fog of war' })
    const [naval, replay] = latest<WaitingRoom>(adaSock, LobbyServerKind.Waiting).requests
    lobby.onLobby(bo, { kind: LobbyClientKind.ToggleVote, requestId: replay.id })
    lobby.onLobby(ada, { kind: LobbyClientKind.ClaimAdmin })
    lobby.onLobby(ada, { kind: LobbyClientKind.MarkRequestDone, requestId: naval.id })
    const adaCards = latest<WaitingRoom>(adaSock, LobbyServerKind.Waiting).requests
    const boCards = latest<WaitingRoom>(boSock, LobbyServerKind.Waiting).requests
    expect(adaCards.map((card) => [card.text, card.votes, card.voted, card.mine, card.status])).toEqual([
      ['Replay viewer', 2, true, true, RequestStatus.Open],
      ['Fog of war', 1, false, false, RequestStatus.Open],
      ['Naval units', 1, true, true, RequestStatus.Done],
    ])
    saveSaves(lobby, dir)

    const restored = new Lobby()
    loadSaves(restored, dir)
    const adaBack = fake()
    const boBack = fake()
    const adaAgain = restored.connect(adaBack, adaToken)
    restored.connect(boBack, boToken)
    expect(latest<WaitingRoom>(adaBack, LobbyServerKind.Waiting).requests).toEqual(adaCards)
    expect(latest<WaitingRoom>(boBack, LobbyServerKind.Waiting).requests).toEqual(boCards)

    restored.onLobby(adaAgain, { kind: LobbyClientKind.PostRequest, text: 'Bigger maps' })
    const next = latest<WaitingRoom>(adaBack, LobbyServerKind.Waiting).requests.find((card) => card.text === 'Bigger maps')
    expect(next?.id).toBeGreaterThan(Math.max(...adaCards.map((card) => card.id)))
  })

  it('leaves the board empty and every seat intact when requests.json does not read', () => {
    const dir = scratch()
    const adaToken = 'ada0ada0ada0ada0ada0ada0ada0ada0'
    const boToken = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'
    writeFileSync(join(dir, 'hall.json'), JSON.stringify({
      nextId: 3,
      nextGame: 1,
      hallChat: [],
      members: [
        { id: 1, token: adaToken, name: 'Ada', gameId: null, admin: true },
        { id: 2, token: boToken, name: 'Bo', gameId: null, admin: false },
      ],
    }))
    writeFileSync(join(dir, 'requests.json'), JSON.stringify({
      nextId: 2,
      open: [{ id: 1, text: 'Naval units', authorId: 1, author: 'Ada', voters: 7 }],
      done: [],
    }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lobby = new Lobby()
    loadSaves(lobby, dir)
    expect(errors).toHaveBeenCalledWith('skip requests save', expect.any(Error))

    const adaSock = fake()
    const boSock = fake()
    const ada = lobby.connect(adaSock, adaToken)
    const bo = lobby.connect(boSock, boToken)
    expect(latest<WaitingRoom>(adaSock, LobbyServerKind.Waiting).you).toEqual({ id: 1, name: 'Ada' })
    expect(latest<WaitingRoom>(boSock, LobbyServerKind.Waiting).you).toEqual({ id: 2, name: 'Bo' })
    expect(latest<WaitingRoom>(boSock, LobbyServerKind.Waiting).requests).toEqual([])

    lobby.onLobby(bo, { kind: LobbyClientKind.PostRequest, text: 'Naval units' })
    const requestId = latest<WaitingRoom>(boSock, LobbyServerKind.Waiting).requests[0].id
    lobby.onLobby(bo, { kind: LobbyClientKind.MarkRequestDone, requestId })
    expect(latest<WaitingRoom>(boSock, LobbyServerKind.Waiting).requests[0].status).toBe(RequestStatus.Open)
    lobby.onLobby(ada, { kind: LobbyClientKind.MarkRequestDone, requestId })
    expect(latest<WaitingRoom>(boSock, LobbyServerKind.Waiting).requests[0].status).toBe(RequestStatus.Done)
  })
})

function scratch(): string {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-saves-'))
  dirs.push(dir)
  return dir
}

function fake(): LobbySocket & { lobby: LobbyServerMessage[]; game: ServerFrame[] } {
  const lobby: LobbyServerMessage[] = []
  const game: ServerFrame[] = []
  return {
    lobby,
    game,
    send(message) {
      lobby.push(message)
    },
    sendGame(message) {
      game.push(message)
    },
    close() {},
  }
}

function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function gameEvents(sock: { game: ServerFrame[] }) {
  return sock.game.flatMap((frame) => frame.events)
}

function latest<T extends LobbyServerMessage>(sock: { lobby: LobbyServerMessage[] }, kind: T['kind']): T {
  for (let i = sock.lobby.length - 1; i >= 0; i--) {
    const message = sock.lobby[i]
    if (message.kind === kind) return message as T
  }
  throw new Error(`missing ${kind}`)
}

function opened(lobby: Lobby) {
  return lobby as unknown as {
    games: Map<number, { match: { host: { game: Game }; factions: Faction[] } | null }>
  }
}
