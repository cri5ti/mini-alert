import type { ClientMessage, ServerFrame } from './protocol.ts'

export const enum Channel {
  Lobby = 1,
  Game = 2,
}

export const enum MapSize {
  Tiny = 64,
  Small = 128,
  Medium = 192,
  Large = 256,
}

export const MAP_SIZES = [MapSize.Tiny, MapSize.Small, MapSize.Medium, MapSize.Large] as const

export const DEFAULT_MAP_SIZE = MapSize.Small

export const enum Landform {
  Island = 0,
  Land = 1,
}

export const DEFAULT_LANDFORM = Landform.Island

export const LAKE_MIN = 0
export const LAKE_MAX = 1
export const LAKE_DEFAULT = 0.25

export function isLandform(value: number): value is Landform {
  return value === Landform.Island || value === Landform.Land
}

export function clampLakes(value: number): number {
  if (!Number.isFinite(value)) return LAKE_DEFAULT
  const stepped = Math.round(value / 0.05) * 0.05
  return Math.min(LAKE_MAX, Math.max(LAKE_MIN, Number(stepped.toFixed(2))))
}

export function slotsForSize(size: MapSize): number {
  if (size === MapSize.Tiny) return 2
  if (size === MapSize.Small) return 4
  if (size === MapSize.Medium) return 6
  return 8
}

export function isMapSize(value: number): value is MapSize {
  return value === MapSize.Tiny || value === MapSize.Small || value === MapSize.Medium || value === MapSize.Large
}

export const enum LobbyClientKind {
  SetName = 1,
  CreateGame = 2,
  JoinGame = 3,
  LeaveRoom = 4,
  TakeSlot = 5,
  SetSlotAi = 6,
  ClearSlot = 7,
  SetMapSize = 8,
  StartGame = 9,
  Chat = 10,
  ViewAs = 11,
  Regenerate = 12,
  SetAiPace = 13,
  ClaimAdmin = 14,
  DestroyGame = 15,
  PostRequest = 16,
  ToggleVote = 17,
  MarkRequestDone = 18,
  DeleteRequest = 19,
  SetLandform = 20,
  SetLakes = 21,
}

export const enum LobbyServerKind {
  Waiting = 1,
  GameLobby = 2,
  Preview = 3,
  Replaced = 4,
}

export const enum SlotKind {
  Open = 0,
  Human = 1,
  Ai = 2,
}

export const enum RoomStatus {
  Waiting = 1,
  Playing = 2,
}

export const enum RequestStatus {
  Open = 1,
  Done = 2,
}

export const enum PostBlock {
  SeatLimit = 1,
  BoardFull = 2,
}

export type Person = {
  id: number
  name: string
}

export type ChatLine = {
  name: string
  text: string
}

export type SlotView = {
  kind: SlotKind
  name: string
  clientId: number
  color: number
}

export type GameCard = {
  id: number
  status: RoomStatus
  mapSize: MapSize
  landform: Landform
  lakes: number
  slots: SlotView[]
  waiting: string[]
}

/** A request as one seat sees it: voted and mine are that seat's. */
export type RequestCard = {
  id: number
  text: string
  author: string
  votes: number
  voted: boolean
  mine: boolean
  status: RequestStatus
}

export type Faction = {
  playerId: number
  name: string
  color: number
  ai: boolean
  defeated: boolean
}

export type SetName = {
  kind: LobbyClientKind.SetName
  name: string
}

export type CreateGame = {
  kind: LobbyClientKind.CreateGame
}

export type JoinGame = {
  kind: LobbyClientKind.JoinGame
  gameId: number
}

export type LeaveRoom = {
  kind: LobbyClientKind.LeaveRoom
}

export type TakeSlot = {
  kind: LobbyClientKind.TakeSlot
  index: number
}

export type SetSlotAi = {
  kind: LobbyClientKind.SetSlotAi
  index: number
}

export type ClearSlot = {
  kind: LobbyClientKind.ClearSlot
  index: number
}

export type SetMapSize = {
  kind: LobbyClientKind.SetMapSize
  size: MapSize
}

export type StartGame = {
  kind: LobbyClientKind.StartGame
}

export type Chat = {
  kind: LobbyClientKind.Chat
  text: string
}

export type ViewAs = {
  kind: LobbyClientKind.ViewAs
  playerId: number
}

export type Regenerate = {
  kind: LobbyClientKind.Regenerate
}

export type SetAiPace = {
  kind: LobbyClientKind.SetAiPace
  pace: number
}

export type ClaimAdmin = {
  kind: LobbyClientKind.ClaimAdmin
}

export type DestroyGame = {
  kind: LobbyClientKind.DestroyGame
  gameId: number
}

export type PostRequest = {
  kind: LobbyClientKind.PostRequest
  text: string
}

export type ToggleVote = {
  kind: LobbyClientKind.ToggleVote
  requestId: number
}

export type MarkRequestDone = {
  kind: LobbyClientKind.MarkRequestDone
  requestId: number
}

export type DeleteRequest = {
  kind: LobbyClientKind.DeleteRequest
  requestId: number
}

export type SetLandform = {
  kind: LobbyClientKind.SetLandform
  landform: Landform
}

export type SetLakes = {
  kind: LobbyClientKind.SetLakes
  lakes: number
}

export const AI_PACE_MIN = 0.25
export const AI_PACE_MAX = 3
export const AI_PACE_DEFAULT = 1

export function clampAiPace(value: number): number {
  if (!Number.isFinite(value)) return AI_PACE_DEFAULT
  const stepped = Math.round(value / 0.25) * 0.25
  return Math.min(AI_PACE_MAX, Math.max(AI_PACE_MIN, stepped))
}

export const REQUEST_TEXT_LIMIT = 80
export const REQUEST_SEAT_LIMIT = 3
export const REQUEST_OPEN_LIMIT = 40
export const REQUEST_DONE_KEPT = 10

export function cleanRequestText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim().slice(0, REQUEST_TEXT_LIMIT).trimEnd()
  return text.length > 0 ? text : null
}

/** Why a seat holding `mine` of the board's `open` requests may not post; null when it may. */
export function postBlock(open: number, mine: number): PostBlock | null {
  if (open >= REQUEST_OPEN_LIMIT) return PostBlock.BoardFull
  if (mine >= REQUEST_SEAT_LIMIT) return PostBlock.SeatLimit
  return null
}

export type LobbyClientMessage =
  | SetName
  | CreateGame
  | JoinGame
  | LeaveRoom
  | TakeSlot
  | SetSlotAi
  | ClearSlot
  | SetMapSize
  | StartGame
  | Chat
  | ViewAs
  | Regenerate
  | SetAiPace
  | ClaimAdmin
  | DestroyGame
  | PostRequest
  | ToggleVote
  | MarkRequestDone
  | DeleteRequest
  | SetLandform
  | SetLakes

export type WaitingRoom = {
  kind: LobbyServerKind.Waiting
  you: Person
  people: Person[]
  games: GameCard[]
  chat: ChatLine[]
  requests: RequestCard[]
}

export type GameLobbyState = {
  kind: LobbyServerKind.GameLobby
  you: Person
  gameId: number
  hostId: number
  status: RoomStatus
  mapSize: MapSize
  landform: Landform
  lakes: number
  slots: SlotView[]
  waiting: Person[]
  chat: ChatLine[]
  spectating: boolean
  factions: Faction[]
  generating: boolean
  seatId: number
  aiPace: number
}

export type MapPreview = {
  kind: LobbyServerKind.Preview
  gameId: number
  width: number
  height: number
  terrain: string
  starts: StartPoint[]
}

export type StartPoint = {
  x: number
  y: number
}

/** A newer connection took this seat; the receiving tab stays offline until asked to play again. */
export type Replaced = {
  kind: LobbyServerKind.Replaced
}

export type LobbyServerMessage = WaitingRoom | GameLobbyState | MapPreview | Replaced

export type WireToServer = {
  channel: Channel
  message: LobbyClientMessage | ClientMessage
}

export type WireToClient = {
  channel: Channel
  message: LobbyServerMessage | ServerFrame
}
