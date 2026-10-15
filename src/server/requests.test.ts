import { describe, expect, it } from 'vitest'
import {
  LobbyClientKind,
  LobbyServerKind,
  RequestStatus,
  type LobbyClientMessage,
  type LobbyServerMessage,
  type RequestCard,
  type WaitingRoom,
} from '../shared/lobby.ts'
import { Lobby, type LobbyMember, type LobbySocket } from './lobby.ts'

type Seat = { member: LobbyMember; sock: LobbySocket & { lobby: LobbyServerMessage[] } }

function fake(): Seat['sock'] {
  const lobby: LobbyServerMessage[] = []
  return {
    lobby,
    send(message) {
      lobby.push(message)
    },
    sendGame() {},
    close() {},
  }
}

function seat(lobby: Lobby, name: string, token?: string): Seat {
  const sock = fake()
  const member = lobby.connect(sock, token)
  lobby.onLobby(member, { kind: LobbyClientKind.SetName, name })
  return { member, sock }
}

function board(seat: Seat): RequestCard[] {
  for (let i = seat.sock.lobby.length - 1; i >= 0; i--) {
    const message = seat.sock.lobby[i]
    if (message.kind === LobbyServerKind.Waiting) return (message as WaitingRoom).requests
  }
  throw new Error('missing hall state')
}

function texts(seat: Seat): string[] {
  return board(seat).map((card) => card.text)
}

function find(seat: Seat, text: string): RequestCard {
  const card = board(seat).find((item) => item.text === text)
  if (!card) throw new Error(`missing request ${text}`)
  return card
}

function post(lobby: Lobby, seat: Seat, text: unknown) {
  lobby.onLobby(seat.member, { kind: LobbyClientKind.PostRequest, text } as LobbyClientMessage)
}

function vote(lobby: Lobby, seat: Seat, text: string) {
  lobby.onLobby(seat.member, { kind: LobbyClientKind.ToggleVote, requestId: find(seat, text).id })
}

function markDone(lobby: Lobby, seat: Seat, text: string) {
  lobby.onLobby(seat.member, { kind: LobbyClientKind.MarkRequestDone, requestId: find(seat, text).id })
}

function remove(lobby: Lobby, seat: Seat, text: string) {
  lobby.onLobby(seat.member, { kind: LobbyClientKind.DeleteRequest, requestId: find(seat, text).id })
}

describe('request board', () => {
  it('shows a posted request to every hall member with cleaned text, voted and mine only for the poster', () => {
    const lobby = new Lobby()
    const ada = seat(lobby, 'Ada')
    const bo = seat(lobby, 'Bo')
    post(lobby, ada, `  Naval \n\t units ${'x'.repeat(100)}`)
    const card = { text: `Naval units ${'x'.repeat(68)}`, author: 'Ada', votes: 1, status: RequestStatus.Open }
    expect(board(ada)).toEqual([{ ...card, id: expect.any(Number), voted: true, mine: true }])
    expect(board(bo)).toEqual([{ ...card, id: board(ada)[0].id, voted: false, mine: false }])

    post(lobby, bo, ' \n\t ')
    post(lobby, bo, 7)
    expect(board(bo)).toHaveLength(1)
    expect(board(ada)).toHaveLength(1)
  })

  it('counts a post matching an open request, ignoring case and spacing, as a vote for it', () => {
    const lobby = new Lobby()
    const ada = seat(lobby, 'Ada')
    const bo = seat(lobby, 'Bo')
    post(lobby, ada, 'Naval units')
    post(lobby, bo, '  naval   UNITS ')
    expect(board(bo)).toEqual([{ id: find(ada, 'Naval units').id, text: 'Naval units', author: 'Ada', votes: 2, voted: true, mine: false, status: RequestStatus.Open }])

    post(lobby, ada, 'NAVAL UNITS')
    expect(board(ada)).toMatchObject([{ text: 'Naval units', votes: 2, voted: true, mine: true }])
  })

  it('toggles the sender’s vote, shows voted per recipient, and ignores votes on done or unknown requests', () => {
    const lobby = new Lobby()
    const ada = seat(lobby, 'Ada')
    const bo = seat(lobby, 'Bo')
    const cy = seat(lobby, 'Cy')
    post(lobby, ada, 'Naval units')
    vote(lobby, bo, 'Naval units')
    expect(find(bo, 'Naval units')).toMatchObject({ votes: 2, voted: true })
    expect(find(cy, 'Naval units')).toMatchObject({ votes: 2, voted: false })

    vote(lobby, bo, 'Naval units')
    expect(find(bo, 'Naval units')).toMatchObject({ votes: 1, voted: false })

    const before = board(bo)
    lobby.onLobby(bo.member, { kind: LobbyClientKind.ToggleVote, requestId: 999 })
    expect(board(bo)).toEqual(before)

    lobby.onLobby(ada.member, { kind: LobbyClientKind.ClaimAdmin })
    markDone(lobby, ada, 'Naval units')
    const done = board(bo)
    vote(lobby, bo, 'Naval units')
    expect(board(bo)).toEqual(done)
  })

  it('keeps a vote with the seat across connections, and the replaced connection votes for nobody', () => {
    const token = 'abc123abc123abc123abc123abc123ab'
    const lobby = new Lobby()
    const ada = seat(lobby, 'Ada')
    const first = seat(lobby, 'Bo', token)
    post(lobby, ada, 'Naval units')
    vote(lobby, first, 'Naval units')

    const sock = fake()
    const second: Seat = { member: lobby.connect(sock, token), sock }
    expect(second.member.id).toBe(first.member.id)
    expect(find(second, 'Naval units')).toMatchObject({ votes: 2, voted: true })

    vote(lobby, first, 'Naval units')
    expect(find(second, 'Naval units')).toMatchObject({ votes: 2, voted: true })

    vote(lobby, second, 'Naval units')
    expect(find(second, 'Naval units')).toMatchObject({ votes: 1, voted: false })
  })

  it('orders open requests by votes, ties older first, then done requests most recently done first', () => {
    const lobby = new Lobby()
    const ada = seat(lobby, 'Ada')
    const bo = seat(lobby, 'Bo')
    const cy = seat(lobby, 'Cy')
    post(lobby, ada, 'A')
    post(lobby, ada, 'B')
    post(lobby, bo, 'C')
    post(lobby, bo, 'D')
    post(lobby, cy, 'E')
    vote(lobby, ada, 'C')
    vote(lobby, cy, 'C')
    vote(lobby, bo, 'B')
    expect(texts(ada)).toEqual(['C', 'B', 'A', 'D', 'E'])

    lobby.onLobby(ada.member, { kind: LobbyClientKind.ClaimAdmin })
    markDone(lobby, ada, 'A')
    markDone(lobby, ada, 'E')
    expect(board(ada).map((card) => [card.text, card.status])).toEqual([
      ['C', RequestStatus.Open],
      ['B', RequestStatus.Open],
      ['D', RequestStatus.Open],
      ['E', RequestStatus.Done],
      ['A', RequestStatus.Done],
    ])
  })

  it('marks done and deletes only for a member who has claimed admin', () => {
    const lobby = new Lobby()
    const ada = seat(lobby, 'Ada')
    const bo = seat(lobby, 'Bo')
    const cy = seat(lobby, 'Cy')
    post(lobby, ada, 'Naval units')
    post(lobby, ada, 'Replay viewer')
    vote(lobby, cy, 'Naval units')
    vote(lobby, cy, 'Replay viewer')
    const before = board(bo)
    markDone(lobby, bo, 'Naval units')
    remove(lobby, bo, 'Replay viewer')
    expect(board(bo)).toEqual(before)

    lobby.onLobby(bo.member, { kind: LobbyClientKind.ClaimAdmin })
    markDone(lobby, bo, 'Naval units')
    expect(board(bo).map((card) => [card.text, card.votes, card.status])).toEqual([
      ['Replay viewer', 2, RequestStatus.Open],
      ['Naval units', 2, RequestStatus.Done],
    ])

    remove(lobby, bo, 'Naval units')
    remove(lobby, bo, 'Replay viewer')
    expect(board(cy)).toEqual([])
    post(lobby, ada, 'Replay viewer')
    expect(board(cy)).toMatchObject([{ text: 'Replay viewer', votes: 1, voted: false }])
  })

  it('refuses a seat’s fourth open request until one of its requests is done or deleted', () => {
    const lobby = new Lobby()
    const ada = seat(lobby, 'Ada')
    const bo = seat(lobby, 'Bo')
    lobby.onLobby(bo.member, { kind: LobbyClientKind.ClaimAdmin })
    post(lobby, bo, 'Shared')
    post(lobby, ada, 'A')
    post(lobby, ada, 'B')
    post(lobby, ada, 'C')
    post(lobby, ada, 'D')
    post(lobby, ada, 'shared')
    expect(board(ada).map((card) => [card.text, card.votes])).toEqual([['Shared', 1], ['A', 1], ['B', 1], ['C', 1]])

    markDone(lobby, bo, 'A')
    post(lobby, ada, 'D')
    post(lobby, ada, 'E')
    expect(texts(ada)).toEqual(['Shared', 'B', 'C', 'D', 'A'])

    remove(lobby, bo, 'B')
    post(lobby, ada, 'E')
    expect(texts(ada)).toEqual(['Shared', 'C', 'D', 'E', 'A'])
  })

  it('refuses every post once 40 requests are open', () => {
    const lobby = new Lobby()
    let poster = seat(lobby, 'P0')
    for (let i = 0; i < 40; i++) {
      if (i > 0 && i % 3 === 0) poster = seat(lobby, `P${i}`)
      post(lobby, poster, `Request ${i}`)
    }
    const late = seat(lobby, 'Late')
    expect(board(late)).toHaveLength(40)
    post(lobby, late, 'One more')
    post(lobby, late, 'request 0')
    expect(board(late)).toHaveLength(40)
    expect(find(late, 'Request 0')).toMatchObject({ votes: 1, voted: false })
  })

  it('keeps only the ten most recently done requests', () => {
    const lobby = new Lobby()
    const admin = seat(lobby, 'Admin')
    lobby.onLobby(admin.member, { kind: LobbyClientKind.ClaimAdmin })
    for (let i = 1; i <= 11; i++) {
      post(lobby, admin, `Request ${i}`)
      markDone(lobby, admin, `Request ${i}`)
    }
    expect(texts(admin)).toEqual(Array.from({ length: 10 }, (_, i) => `Request ${11 - i}`))
  })

  it('leaves the board untouched when any record of a saved board is bad', () => {
    const lobby = new Lobby()
    const ada = seat(lobby, 'Ada')
    post(lobby, ada, 'Naval units')
    const saved = lobby.savedBoard()
    const record = { id: 7, text: 'Old', authorId: ada.member.id, author: 'Ada', voters: [ada.member.id] }
    expect(() => lobby.loadBoard({ nextId: 9, open: [record], done: [{ ...record, id: 8, voters: 7 }] })).toThrow()
    expect(lobby.savedBoard()).toEqual(saved)
  })
})
