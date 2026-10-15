import {
  LAKE_DEFAULT,
  Landform,
  LobbyServerKind,
  MapSize,
  RequestStatus,
  RoomStatus,
  SlotKind,
  type GameLobbyState,
  type MapPreview,
  type SlotView,
  type StartPoint,
  type WaitingRoom,
} from '../shared/lobby.ts'
import { valueNoise } from '../shared/noise.ts'
import { PLAYER_COLORS } from '../shared/players.ts'
import { Terrain } from '../shared/tiles.ts'

export const ROOM_ID = 12

const PREVIEW_STARTS: readonly StartPoint[] = [
  { x: 38, y: 40 },
  { x: 90, y: 38 },
  { x: 40, y: 88 },
  { x: 88, y: 90 },
]

function human(index: number, clientId: number, name: string): SlotView {
  return { kind: SlotKind.Human, name, clientId, color: PLAYER_COLORS[index] }
}

function ai(index: number): SlotView {
  return { kind: SlotKind.Ai, name: 'AI', clientId: 0, color: PLAYER_COLORS[index] }
}

function open(index: number): SlotView {
  return { kind: SlotKind.Open, name: '', clientId: 0, color: PLAYER_COLORS[index] }
}

/** One game per phase, listed out of phase order. */
export function hall(): WaitingRoom {
  return {
    kind: LobbyServerKind.Waiting,
    you: { id: 1, name: 'Ada' },
    people: [
      { id: 1, name: 'Ada' },
      { id: 5, name: 'Eve' },
    ],
    games: [
      {
        id: 9,
        status: RoomStatus.Playing,
        mapSize: MapSize.Medium,
        landform: Landform.Island,
        lakes: LAKE_DEFAULT,
        slots: [human(0, 4, 'Dee'), human(1, 6, 'Gus'), ai(2), ai(3), ai(4), open(5)],
        waiting: [],
      },
      {
        id: 3,
        status: RoomStatus.Waiting,
        mapSize: MapSize.Tiny,
        landform: Landform.Land,
        lakes: 0,
        slots: [ai(0), open(1)],
        waiting: ['Finn'],
      },
      {
        id: 7,
        status: RoomStatus.Waiting,
        mapSize: MapSize.Small,
        landform: Landform.Island,
        lakes: 0.5,
        slots: [human(0, 2, 'Bo'), ai(1), open(2), open(3)],
        waiting: ['Cy'],
      },
    ],
    chat: [
      { name: 'Bo', text: 'gl hf' },
      { name: 'Eve', text: 'anyone for 2v2?' },
    ],
    requests: [
      { id: 4, text: 'Naval units', author: 'Bo', votes: 12, voted: true, mine: false, status: RequestStatus.Open },
      { id: 6, text: 'Bigger maps', author: 'Ada', votes: 5, voted: true, mine: true, status: RequestStatus.Open },
      {
        id: 8,
        text: 'Allied victory when the last enemy falls',
        author: 'Eve',
        votes: 2,
        voted: false,
        mine: false,
        status: RequestStatus.Open,
      },
      { id: 2, text: 'Night mode', author: 'Cy', votes: 3, voted: false, mine: false, status: RequestStatus.Done },
    ],
  }
}

/** Ada holds as many open requests as a seat may. */
export function seatLimitHall(): WaitingRoom {
  const state = hall()
  state.requests = state.requests.map((card) =>
    card.status === RequestStatus.Open ? { ...card, author: 'Ada', mine: true } : card,
  )
  return state
}

export function emptyHall(): WaitingRoom {
  return { kind: LobbyServerKind.Waiting, you: { id: 1, name: 'Ada' }, people: [], games: [], chat: [], requests: [] }
}

export function hostRoom(): GameLobbyState {
  return {
    kind: LobbyServerKind.GameLobby,
    you: { id: 1, name: 'Ada' },
    gameId: ROOM_ID,
    hostId: 1,
    status: RoomStatus.Waiting,
    mapSize: MapSize.Small,
    landform: Landform.Island,
    lakes: LAKE_DEFAULT,
    slots: [human(0, 1, 'Ada'), human(1, 2, 'Bo'), ai(2), open(3)],
    waiting: [{ id: 3, name: 'Cy' }],
    chat: [
      { name: 'Ada', text: 'map looks good' },
      { name: 'Bo', text: 'ready' },
    ],
    spectating: false,
    factions: [],
    generating: false,
    seatId: 0,
    aiPace: 1.5,
  }
}

export function guestRoom(): GameLobbyState {
  return { ...hostRoom(), you: { id: 2, name: 'Bo' } }
}

export function drawingRoom(): GameLobbyState {
  return { ...hostRoom(), generating: true }
}

export function roomPreview(): MapPreview {
  const size = MapSize.Small
  let binary = ''
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) binary += String.fromCharCode(islandTerrain(x, y, size))
  }
  return {
    kind: LobbyServerKind.Preview,
    gameId: ROOM_ID,
    width: size,
    height: size,
    terrain: btoa(binary),
    starts: PREVIEW_STARTS.map((start) => ({ ...start })),
  }
}

export function islandTerrain(x: number, y: number, size: number): Terrain {
  const edge = Math.hypot(x / size - 0.5, y / size - 0.5) * 2
  const ground = valueNoise(x, y, 11, 0.07) * 0.45 + 0.55 - edge
  if (ground < 0) return Terrain.Water
  if (ground > 0.3 && valueNoise(x, y, 23, 0.12) > 0.8) return Terrain.Lake
  if (valueNoise(x, y, 37, 0.1) > 0.66) return Terrain.Forest
  return Terrain.Land
}
