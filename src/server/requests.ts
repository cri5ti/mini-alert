import { cleanRequestText, postBlock, REQUEST_DONE_KEPT, RequestStatus, type RequestCard } from '../shared/lobby.ts'

type Request = {
  id: number
  text: string
  authorId: number
  author: string
  voters: Set<number>
}

export type SavedRequest = {
  id: number
  text: string
  authorId: number
  author: string
  voters: number[]
}

export type RequestsSave = {
  nextId: number
  open: SavedRequest[]
  done: SavedRequest[]
}

/** Votes and authors are member ids, so a vote follows the seat, not the connection. */
export class RequestBoard {
  private nextId = 1
  /** Ranked: votes descending, ties older first. */
  private open: Request[] = []
  /** In marking order, oldest first. */
  private done: Request[] = []

  /** Posting votes for the request; text matching an open one votes for that one instead. */
  post(authorId: number, author: string, value: unknown): boolean {
    const text = cleanRequestText(value)
    if (text === null) return false
    if (postBlock(this.open.length, this.openBy(authorId)) !== null) return false
    const key = requestKey(text)
    const same = this.open.find((request) => requestKey(request.text) === key)
    if (!same) this.open.push({ id: this.nextId++, text, authorId, author, voters: new Set([authorId]) })
    else if (same.voters.has(authorId)) return false
    else same.voters.add(authorId)
    this.rank()
    return true
  }

  toggle(memberId: number, requestId: unknown): boolean {
    const request = this.open.find((item) => item.id === requestId)
    if (!request) return false
    if (!request.voters.delete(memberId)) request.voters.add(memberId)
    this.rank()
    return true
  }

  markDone(requestId: unknown): boolean {
    const index = this.open.findIndex((item) => item.id === requestId)
    if (index < 0) return false
    this.done.push(...this.open.splice(index, 1))
    if (this.done.length > REQUEST_DONE_KEPT) this.done.shift()
    return true
  }

  remove(requestId: unknown): boolean {
    for (const list of [this.open, this.done]) {
      const index = list.findIndex((item) => item.id === requestId)
      if (index < 0) continue
      list.splice(index, 1)
      return true
    }
    return false
  }

  cards(memberId: number): RequestCard[] {
    const cards = this.open.map((request) => card(request, memberId, RequestStatus.Open))
    for (let i = this.done.length - 1; i >= 0; i--) cards.push(card(this.done[i], memberId, RequestStatus.Done))
    return cards
  }

  saved(): RequestsSave {
    return { nextId: this.nextId, open: this.open.map(saveRequest), done: this.done.map(saveRequest) }
  }

  /** Throws on any bad record without touching the board. */
  load(data: unknown) {
    const file = data as Partial<RequestsSave> | null
    if (!file || typeof file.nextId !== 'number' || !Array.isArray(file.open) || !Array.isArray(file.done)) {
      throw new Error('requests save has no board')
    }
    const open = file.open.map(readRequest)
    const done = file.done.map(readRequest)
    this.open = open
    this.done = done
    this.nextId = file.nextId
  }

  private openBy(authorId: number): number {
    let count = 0
    for (const request of this.open) {
      if (request.authorId === authorId) count += 1
    }
    return count
  }

  private rank() {
    this.open.sort((a, b) => b.voters.size - a.voters.size || a.id - b.id)
  }
}

function requestKey(text: string): string {
  return text.replace(/\s/g, '').toLowerCase()
}

function card(request: Request, memberId: number, status: RequestStatus): RequestCard {
  return {
    id: request.id,
    text: request.text,
    author: request.author,
    votes: request.voters.size,
    voted: request.voters.has(memberId),
    mine: request.authorId === memberId,
    status,
  }
}

function saveRequest(request: Request): SavedRequest {
  return { ...request, voters: [...request.voters] }
}

function readRequest(value: unknown): Request {
  const saved = value as Partial<SavedRequest> | null
  if (
    !saved ||
    typeof saved.id !== 'number' ||
    typeof saved.text !== 'string' ||
    typeof saved.authorId !== 'number' ||
    typeof saved.author !== 'string' ||
    !Array.isArray(saved.voters) ||
    !saved.voters.every((voter) => typeof voter === 'number')
  ) {
    throw new Error(`requests save has a bad record: ${JSON.stringify(value)}`)
  }
  return { id: saved.id, text: saved.text, authorId: saved.authorId, author: saved.author, voters: new Set(saved.voters) }
}
