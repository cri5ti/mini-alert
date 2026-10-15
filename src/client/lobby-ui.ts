import {
  AI_PACE_DEFAULT,
  AI_PACE_MAX,
  AI_PACE_MIN,
  clampLakes,
  cleanRequestText,
  LAKE_DEFAULT,
  LAKE_MAX,
  LAKE_MIN,
  Landform,
  MAP_SIZES,
  type MapSize,
  PostBlock,
  postBlock,
  REQUEST_SEAT_LIMIT,
  REQUEST_TEXT_LIMIT,
  RequestStatus,
  RoomStatus,
  SlotKind,
  slotsForSize,
  type ChatLine,
  type GameCard,
  type GameLobbyState,
  type MapPreview,
  type Person,
  type RequestCard,
  type SlotView,
  type StartPoint,
  type WaitingRoom,
} from '../shared/lobby.ts'
import { isMinimapShore, minimapRgb } from '../shared/minimap.ts'
import type { Terrain } from '../shared/tiles.ts'
import '@fontsource/saira-stencil-one/latin-400.css'
import './console.css'
import './lobby.css'

export type LobbyActions = {
  setName(name: string): void
  copyLink(): Promise<void>
  createGame(): void
  joinGame(id: number): void
  leave(): void
  takeSlot(index: number): void
  setSlotAi(index: number): void
  clearSlot(index: number): void
  setMapSize(size: MapSize): void
  setLandform(landform: Landform): void
  setLakes(lakes: number): void
  regenerate(): void
  start(): void
  setAiPace(pace: number): void
  chat(text: string): void
  destroyGame(id: number): void
  postRequest(text: string): void
  toggleVote(id: number): void
  markRequestDone(id: number): void
  deleteRequest(id: number): void
  playHere(): void
}

export class LobbyView {
  private readonly title: HTMLElement
  private readonly status: HTMLElement
  private readonly statusDot: HTMLElement
  private readonly statusText: Text
  private readonly nameInput: HTMLInputElement
  private readonly grid: HTMLElement
  private readonly peopleTitle: HTMLElement
  private readonly people: HTMLElement
  private readonly mainTitle: HTMLElement
  private readonly main: HTMLElement
  private readonly preview: HTMLElement
  private readonly marks: SVGSVGElement
  private readonly canvas: HTMLCanvasElement
  private readonly drawing: HTMLElement
  private readonly scope: HTMLElement
  private readonly blips: HTMLElement
  private readonly chatLog: HTMLElement
  private readonly chatInput: HTMLInputElement
  private readonly requests: HTMLElement
  private readonly requestInput: HTMLInputElement
  private readonly post: HTMLButtonElement
  private readonly postHint: HTMLElement
  private readonly requestList: HTMLElement
  private readonly paceRow: HTMLLabelElement
  private readonly paceInput: HTMLInputElement
  private readonly paceValue: HTMLElement
  private readonly lakesRow: HTMLLabelElement
  private readonly lakesInput: HTMLInputElement
  private readonly lakesValue: HTMLElement
  private lakesAmount = LAKE_DEFAULT
  private lakesEditing = false
  private readonly replaced: HTMLElement
  private chatKey = ''
  private requestsKey = ''
  private previewKey = ''
  private slots: SlotView[] = []
  private starts: StartPoint[] = []
  private mapWidth = 0
  private mapHeight = 0
  private connected = false
  private mode: 'wait' | 'game' | 'hidden' = 'wait'

  constructor(
    root: HTMLElement,
    private readonly actions: LobbyActions,
    private readonly admin = false,
  ) {
    root.className = 'lobby-screen'
    const head = document.createElement('header')
    head.className = 'lobby-head lobby-frame'
    const logo = document.createElement('p')
    logo.className = 'lobby-logo'
    logo.textContent = 'MINI ALERT'
    this.title = document.createElement('h1')
    const titleRow = document.createElement('div')
    titleRow.className = 'lobby-title'
    titleRow.append(this.title)
    if (admin) {
      const mark = document.createElement('span')
      mark.className = 'admin-mark'
      mark.textContent = 'Admin'
      titleRow.append(mark)
    }
    this.nameInput = document.createElement('input')
    this.nameInput.type = 'text'
    this.nameInput.maxLength = 16
    this.nameInput.spellcheck = false
    this.nameInput.setAttribute('aria-label', 'Name')
    this.nameInput.addEventListener('change', () => this.actions.setName(this.nameInput.value))
    const you = document.createElement('div')
    you.className = 'lobby-you'
    const copyLink = document.createElement('button')
    copyLink.type = 'button'
    const copyLabel = 'Copy my link'
    copyLink.textContent = copyLabel
    copyLink.title = 'Open this link on another device to play as you there. Anyone who opens it plays as you.'
    const say = (text: string) => {
      copyLink.textContent = text
      window.setTimeout(() => (copyLink.textContent = copyLabel), 2000)
    }
    copyLink.addEventListener('click', () => {
      this.actions.copyLink().then(
        () => say('Link copied'),
        () => say('Copy failed'),
      )
    })
    you.append(this.nameInput, copyLink)
    this.status = document.createElement('p')
    this.status.className = 'lobby-status'
    this.statusDot = document.createElement('span')
    this.statusDot.className = 'lobby-dot'
    this.statusDot.setAttribute('aria-hidden', 'true')
    this.statusText = document.createTextNode('')
    this.status.append(this.statusDot, this.statusText)
    head.append(logo, titleRow, you, this.status)

    this.peopleTitle = document.createElement('h2')
    const peoplePanel = panel('section', 'lobby-people', '01', this.peopleTitle)
    this.people = document.createElement('div')
    this.people.className = 'lobby-list'
    peoplePanel.append(this.people)

    this.mainTitle = document.createElement('h2')
    const battlePanel = panel('section', 'lobby-battle', '02', this.mainTitle)
    this.main = document.createElement('div')
    this.main.className = 'lobby-main'
    battlePanel.append(this.main)

    const previewTitle = document.createElement('h2')
    previewTitle.textContent = 'Radar'
    this.preview = panel('section', 'lobby-preview', '03', previewTitle)
    this.canvas = document.createElement('canvas')
    this.marks = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.marks.classList.add('lobby-marks')
    this.drawing = document.createElement('p')
    this.drawing.className = 'lobby-drawing'
    this.drawing.setAttribute('role', 'status')
    this.drawing.setAttribute('aria-label', 'Drawing map')
    this.drawing.textContent = 'Drawing map'
    this.drawing.hidden = true
    const map = document.createElement('div')
    map.className = 'lobby-map'
    map.append(radar(this.canvas, sweep(), this.marks, this.drawing))
    this.preview.append(map)

    const scopeTitle = document.createElement('h2')
    scopeTitle.textContent = 'Radar'
    this.scope = panel('section', 'lobby-scope', '03', scopeTitle)
    this.scope.setAttribute('aria-hidden', 'true')
    this.blips = document.createElement('div')
    this.blips.className = 'scope-blips'
    this.scope.append(radar(sweep(), this.blips))

    const chatTitle = document.createElement('h2')
    chatTitle.textContent = 'Comms'
    const chat = panel('form', 'lobby-chat', '04', chatTitle)
    this.chatLog = document.createElement('div')
    this.chatLog.className = 'lobby-log'
    const compose = document.createElement('div')
    compose.className = 'lobby-compose'
    this.chatInput = document.createElement('input')
    this.chatInput.type = 'text'
    this.chatInput.maxLength = 200
    this.chatInput.placeholder = 'Chat'
    this.chatInput.setAttribute('aria-label', 'Chat')
    const send = document.createElement('button')
    send.type = 'submit'
    send.textContent = 'Send'
    compose.append(this.chatInput, send)
    chat.append(this.chatLog, compose)
    chat.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = this.chatInput.value.trim()
      if (!text) return
      this.actions.chat(text)
      this.chatInput.value = ''
    })

    const requestsTitle = document.createElement('h2')
    requestsTitle.textContent = 'Requests'
    this.requests = panel('section', 'lobby-requests', '05', requestsTitle)
    const postForm = document.createElement('form')
    postForm.className = 'request-post'
    this.requestInput = document.createElement('input')
    this.requestInput.type = 'text'
    this.requestInput.maxLength = REQUEST_TEXT_LIMIT
    this.requestInput.placeholder = 'Request a feature'
    this.requestInput.setAttribute('aria-label', 'Request a feature')
    this.post = document.createElement('button')
    this.post.type = 'submit'
    this.post.className = 'primary'
    this.post.textContent = 'Post'
    this.postHint = document.createElement('p')
    this.postHint.className = 'request-hint'
    this.postHint.hidden = true
    postForm.append(this.requestInput, this.post, this.postHint)
    postForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = cleanRequestText(this.requestInput.value)
      if (text === null) return
      this.actions.postRequest(text)
      this.requestInput.value = ''
    })
    this.requestList = document.createElement('div')
    this.requestList.className = 'request-list'
    this.requests.append(postForm, this.requestList)

    this.replaced = document.createElement('div')
    this.replaced.id = 'elsewhere'
    this.replaced.hidden = true
    const replacedCard = document.createElement('div')
    replacedCard.className = 'lobby-frame lobby-dialog'
    replacedCard.setAttribute('role', 'dialog')
    replacedCard.setAttribute('aria-modal', 'true')
    replacedCard.setAttribute('aria-labelledby', 'elsewhere-title')
    const replacedTitle = document.createElement('h2')
    replacedTitle.id = 'elsewhere-title'
    replacedTitle.textContent = 'Open in another tab'
    const replacedText = document.createElement('p')
    replacedText.textContent = 'This game is open in another tab or window.'
    const playHere = document.createElement('button')
    playHere.type = 'button'
    playHere.className = 'primary'
    playHere.textContent = 'Play here'
    playHere.addEventListener('click', () => {
      this.replaced.hidden = true
      this.actions.playHere()
    })
    const replacedBody = document.createElement('div')
    replacedBody.className = 'lobby-dialog-body'
    replacedBody.append(replacedText, playHere)
    replacedCard.append(panelHead(replacedTitle), replacedBody)
    this.replaced.append(replacedCard)

    this.grid = document.createElement('div')
    this.grid.className = 'lobby-grid'
    this.grid.append(peoplePanel, battlePanel, this.preview, this.scope, this.requests, chat)
    root.replaceChildren(head, this.grid, this.replaced)
    this.paceRow = document.createElement('label')
    this.paceRow.className = 'pace-row'
    this.paceRow.append(document.createTextNode('AI pace'))
    this.paceInput = document.createElement('input')
    this.paceInput.type = 'range'
    this.paceInput.min = String(AI_PACE_MIN)
    this.paceInput.max = String(AI_PACE_MAX)
    this.paceInput.step = '0.25'
    this.paceInput.value = String(AI_PACE_DEFAULT)
    this.paceValue = document.createElement('span')
    this.paceValue.textContent = AI_PACE_DEFAULT.toFixed(2)
    this.paceInput.addEventListener('input', () => {
      const pace = Number(this.paceInput.value)
      this.paceValue.textContent = pace.toFixed(2)
      this.actions.setAiPace(pace)
    })
    this.paceRow.append(this.paceInput, this.paceValue)
    this.lakesRow = document.createElement('label')
    this.lakesRow.className = 'lakes-row'
    this.lakesRow.append(document.createTextNode('Lakes'))
    this.lakesInput = document.createElement('input')
    this.lakesInput.type = 'range'
    this.lakesInput.min = String(LAKE_MIN)
    this.lakesInput.max = String(LAKE_MAX)
    this.lakesInput.step = '0.05'
    this.lakesInput.value = String(LAKE_DEFAULT)
    this.lakesValue = document.createElement('span')
    this.lakesValue.textContent = lakeLabel(LAKE_DEFAULT)
    this.lakesInput.addEventListener('input', () => {
      this.lakesValue.textContent = lakeLabel(Number(this.lakesInput.value))
    })
    this.lakesInput.addEventListener('change', () => {
      const lakes = clampLakes(Number(this.lakesInput.value))
      this.lakesValue.textContent = lakeLabel(lakes)
      if (!this.lakesEditing || lakes === this.lakesAmount) return
      this.setBusy(true)
      this.actions.setLakes(lakes)
    })
    this.lakesRow.append(this.lakesInput, this.lakesValue)
    this.paintStatus()
  }

  setConnected(on: boolean) {
    this.connected = on
    this.paintStatus()
  }

  hide() {
    this.mode = 'hidden'
  }

  showWaiting(state: WaitingRoom) {
    this.mode = 'wait'
    this.previewKey = ''
    this.paintStatus()
    this.title.textContent = 'Waiting room'
    this.nameInput.disabled = false
    this.setName(state.you.name)
    this.grid.classList.remove('room')
    this.peopleTitle.textContent = 'Operators'
    this.mainTitle.textContent = 'Battles'
    this.preview.hidden = true
    this.scope.hidden = false
    this.requests.hidden = false
    this.fillPeople(state.people)
    this.fillGames(state.games)
    this.blips.replaceChildren(...state.games.map(blip))
    this.fillRequests(state.requests)
    this.paintChat(state.chat, 'hall')
  }

  showGame(state: GameLobbyState, preview: MapPreview | null) {
    this.mode = 'game'
    this.paintStatus()
    const host = state.hostId === state.you.id
    const battle = `Battle #${state.gameId}`
    this.title.textContent = host ? `${battle} · host` : battle
    this.setName(state.you.name)
    this.nameInput.disabled = state.status === RoomStatus.Playing
    this.grid.classList.add('room')
    this.peopleTitle.textContent = 'Not seated'
    this.mainTitle.textContent = battle
    this.preview.hidden = false
    this.scope.hidden = true
    this.requests.hidden = true
    this.slots = state.slots
    this.setBusy(state.generating)
    this.fillPeople(state.waiting)
    this.fillSlots(state, host)
    this.paintChat(state.chat, `game:${state.gameId}`)
    if (state.generating) this.clearMarks()
    else if (preview && preview.gameId === state.gameId) this.showPreview(preview)
    else this.paintMarks()
  }

  showPreview(preview: MapPreview) {
    this.setBusy(false)
    this.starts = preview.starts
    this.mapWidth = preview.width
    this.mapHeight = preview.height
    const key = `${preview.gameId}:${preview.width}:${terrainKey(preview.terrain)}`
    if (key !== this.previewKey) {
      this.previewKey = key
      paintPreview(this.canvas, preview.width, preview.height, decodeTerrain(preview.terrain))
    }
    this.paintMarks()
  }

  setBusy(on: boolean) {
    this.preview.classList.toggle('busy', on)
    this.drawing.hidden = !on
  }

  holdName(name: string) {
    this.setName(name)
  }

  showReplaced() {
    this.replaced.hidden = false
  }

  private paintMarks() {
    drawStarts(this.marks, this.mapWidth, this.mapHeight, this.starts, this.slots)
  }

  private clearMarks() {
    this.marks.replaceChildren()
  }

  private setName(name: string) {
    if (document.activeElement === this.nameInput) return
    this.nameInput.value = name
  }

  private paintStatus() {
    const live = this.mode !== 'hidden' && this.connected
    const offline = this.mode !== 'hidden' && !this.connected
    this.status.classList.toggle('live', live)
    this.status.classList.toggle('offline', offline)
    this.statusDot.textContent = live ? '◉' : offline ? '◌' : ''
    this.statusText.data = live ? ' Live' : offline ? ' Reconnecting…' : ''
  }

  private fillPeople(people: readonly Person[]) {
    this.people.replaceChildren()
    if (people.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'lobby-empty'
      empty.textContent = 'No one waiting'
      this.people.append(empty)
      return
    }
    for (const person of people) {
      const row = document.createElement('p')
      row.textContent = person.name
      this.people.append(row)
    }
  }

  private fillGames(games: readonly GameCard[]) {
    this.main.replaceChildren()
    const create = document.createElement('button')
    create.type = 'button'
    create.className = 'primary'
    create.textContent = 'Deploy'
    create.addEventListener('click', () => this.actions.createGame())
    this.main.append(create)
    if (games.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'lobby-empty'
      empty.textContent = 'No games yet'
      this.main.append(empty)
      return
    }
    const unstarted: GameCard[] = []
    const pending: GameCard[] = []
    const playing: GameCard[] = []
    for (const game of games) {
      const phase = gamePhase(game)
      if (phase === 'live') playing.push(game)
      else if (phase === 'pending') pending.push(game)
      else unstarted.push(game)
    }
    this.appendGameSection(phaseLabel('unstarted'), 'Nobody seated yet', unstarted)
    this.appendGameSection(phaseLabel('pending'), 'Seated, waiting to start', pending)
    this.appendGameSection(phaseLabel('live'), 'Already going', playing)
  }

  private appendGameSection(title: string, hint: string, games: readonly GameCard[]) {
    if (games.length === 0) return
    const section = document.createElement('section')
    section.className = 'game-section'
    const heading = document.createElement('h2')
    heading.textContent = `${title} · ${games.length}`
    const note = document.createElement('p')
    note.className = 'game-section-note'
    note.textContent = hint
    section.append(heading, note)
    for (const game of games) section.append(this.gameRow(game))
    this.main.append(section)
  }

  private gameRow(game: GameCard): HTMLElement {
    const phase = gamePhase(game)
    const row = document.createElement('article')
    row.className = `game-row ${phase}`
    const head = document.createElement('header')
    head.className = 'game-row-head'
    const heading = document.createElement('h3')
    heading.textContent = `#${game.id}`
    const badge = document.createElement('span')
    badge.className = 'game-badge'
    badge.textContent = phaseLabel(phase)
    head.append(heading, badge)
    const meta = document.createElement('p')
    meta.className = 'game-meta'
    meta.textContent = occupancy(game)
    const slots = document.createElement('p')
    slots.textContent = game.slots.map(slotLabel).join(' · ')
    row.append(head, meta, slots)
    if (game.waiting.length > 0) {
      const waiting = document.createElement('p')
      waiting.textContent = `Waiting: ${game.waiting.join(', ')}`
      row.append(waiting)
    }
    const actions = document.createElement('div')
    actions.className = 'game-actions'
    const join = document.createElement('button')
    join.type = 'button'
    join.textContent = phase === 'live' ? 'Spectate' : 'Join'
    join.addEventListener('click', () => this.actions.joinGame(game.id))
    actions.append(join)
    if (this.admin) {
      const destroy = document.createElement('button')
      destroy.type = 'button'
      destroy.className = 'lobby-destroy danger'
      destroy.textContent = 'Destroy'
      destroy.addEventListener('click', () => {
        const ok = window.confirm(`Destroy battle #${game.id}? Everyone in it returns to the waiting room.`)
        if (!ok) return
        this.actions.destroyGame(game.id)
      })
      actions.append(destroy)
    }
    row.append(actions)
    return row
  }

  private fillRequests(cards: readonly RequestCard[]) {
    const key = JSON.stringify(cards)
    if (key === this.requestsKey) return
    this.requestsKey = key
    const open = cards.filter((card) => card.status === RequestStatus.Open)
    const done = cards.filter((card) => card.status === RequestStatus.Done)
    const block = postBlock(open.length, open.filter((card) => card.mine).length)
    this.post.disabled = block !== null
    this.postHint.hidden = block === null
    this.postHint.textContent = block === null ? '' : postBlockHint(block)
    const focused = document.activeElement
    const refocus = focused instanceof HTMLElement && this.requestList.contains(focused) ? focused.dataset.key : undefined
    this.requestList.replaceChildren()
    if (cards.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'lobby-empty'
      empty.textContent = 'No requests yet'
      this.requestList.append(empty)
    }
    for (const card of open) this.requestList.append(this.requestCard(card))
    if (done.length > 0) {
      const group = document.createElement('section')
      group.className = 'request-group'
      const heading = document.createElement('h3')
      heading.textContent = `Done · ${done.length}`
      group.append(heading, ...done.map((card) => this.requestCard(card)))
      this.requestList.append(group)
    }
    if (refocus) this.requestList.querySelector<HTMLElement>(`[data-key="${refocus}"]`)?.focus()
  }

  private requestCard(card: RequestCard): HTMLElement {
    const open = card.status === RequestStatus.Open
    const row = document.createElement('article')
    row.className = 'request-card'
    const vote = document.createElement('button')
    vote.type = 'button'
    vote.className = 'request-vote'
    vote.dataset.key = `vote:${card.id}`
    vote.disabled = !open
    vote.setAttribute('aria-pressed', String(card.voted))
    vote.setAttribute('aria-label', `Vote for ${card.text}`)
    const arrow = document.createElement('span')
    arrow.textContent = '▲'
    const count = document.createElement('span')
    count.textContent = String(card.votes)
    vote.append(arrow, count)
    vote.addEventListener('click', () => this.actions.toggleVote(card.id))
    const text = document.createElement('p')
    text.className = 'request-text'
    text.textContent = card.text
    const by = document.createElement('p')
    by.className = 'request-by'
    by.textContent = card.author
    if (card.mine) {
      const mine = document.createElement('span')
      mine.className = 'request-mine'
      mine.textContent = 'Yours'
      by.append(mine)
    }
    const body = document.createElement('div')
    body.append(text, by)
    row.append(vote, body)
    if (!this.admin) return row
    const actions = document.createElement('div')
    actions.className = 'request-actions'
    if (open) {
      const done = plate('✓ Done', () => this.actions.markRequestDone(card.id))
      done.dataset.key = `done:${card.id}`
      done.setAttribute('aria-label', `Mark ${card.text} done`)
      actions.append(done)
    }
    const remove = plate('✕ Delete', () => {
      const ok = window.confirm(`Delete the request "${card.text}" and its votes?`)
      if (!ok) return
      this.actions.deleteRequest(card.id)
    })
    remove.className = 'danger'
    remove.dataset.key = `delete:${card.id}`
    remove.setAttribute('aria-label', `Delete ${card.text}`)
    actions.append(remove)
    row.append(actions)
    return row
  }

  private fillSlots(state: GameLobbyState, host: boolean) {
    const editing = host && state.status === RoomStatus.Waiting
    const options = document.createElement('div')
    options.className = 'map-options'
    const choose = (pick: () => void) => {
      this.setBusy(true)
      pick()
    }
    options.append(
      choiceRow(
        MAP_SIZES.map((size) => ({
          label: `${size} · ${slotsForSize(size)}`,
          on: size === state.mapSize,
          disabled: !editing,
          pick: () => choose(() => this.actions.setMapSize(size)),
        })),
      ),
      choiceRow([
        {
          label: 'Island',
          on: state.landform === Landform.Island,
          disabled: !editing,
          pick: () => choose(() => this.actions.setLandform(Landform.Island)),
        },
        {
          label: 'Land',
          on: state.landform === Landform.Land,
          disabled: !editing,
          pick: () => choose(() => this.actions.setLandform(Landform.Land)),
        },
      ]),
    )
    const parts: HTMLElement[] = [options, this.lakesRow]
    this.syncLakes(state.lakes, editing)
    if (editing) {
      const regen = document.createElement('button')
      regen.type = 'button'
      regen.textContent = 'New map'
      regen.addEventListener('click', () => {
        this.setBusy(true)
        this.actions.regenerate()
      })
      parts.push(regen)
    }

    state.slots.forEach((slot, index) => {
      const row = document.createElement('div')
      row.className = 'slot-row'
      const number = document.createElement('span')
      number.className = 'slot-index'
      number.textContent = String(index + 1)
      const swatch = document.createElement('span')
      swatch.className = 'swatch'
      swatch.style.background = cssColor(slot.color)
      const label = document.createElement('span')
      label.className = 'slot-name'
      label.textContent = slot.kind === SlotKind.Open ? 'Open' : slot.name
      row.append(number, swatch, label)
      if (slot.kind === SlotKind.Open) {
        row.append(plate('Sit', () => this.actions.takeSlot(index)))
        row.append(plate('AI', () => this.actions.setSlotAi(index)))
      } else if (slot.kind === SlotKind.Human && slot.clientId === state.you.id) {
        row.append(plate('Stand', () => this.actions.clearSlot(index)))
      } else if (slot.kind === SlotKind.Ai) {
        row.append(plate('Clear', () => this.actions.clearSlot(index)))
      }
      parts.push(row)
    })

    const actions = document.createElement('div')
    actions.className = 'lobby-actions'
    const leave = document.createElement('button')
    leave.type = 'button'
    leave.textContent = 'Back'
    leave.addEventListener('click', () => this.actions.leave())
    actions.append(leave)
    if (host) {
      const start = document.createElement('button')
      start.type = 'button'
      start.className = 'lobby-start primary'
      start.textContent = 'Start'
      start.disabled = !state.slots.some((slot) => slot.kind === SlotKind.Human)
      start.addEventListener('click', () => this.actions.start())
      actions.append(start)
    }
    parts.push(actions, this.paceRow)
    this.syncPace(state.aiPace)
    // Detaching a slider row would drop its slider's focus mid-adjustment.
    const keep = new Set<Element>(parts)
    for (const child of [...this.main.children]) {
      if (!keep.has(child)) child.remove()
    }
    let at = this.main.firstElementChild
    for (const part of parts) {
      if (part === at) at = at.nextElementSibling
      else this.main.insertBefore(part, at)
    }
  }

  syncLakes(amount: number, editing: boolean) {
    this.lakesAmount = amount
    this.lakesEditing = editing
    this.lakesInput.disabled = !editing
    if (document.activeElement === this.lakesInput) return
    this.lakesInput.value = String(amount)
    this.lakesValue.textContent = lakeLabel(amount)
  }

  syncPace(pace: number) {
    if (document.activeElement === this.paceInput) return
    this.paceInput.value = String(pace)
    this.paceValue.textContent = pace.toFixed(2)
  }

  private paintChat(lines: readonly ChatLine[], scope: string) {
    const key = `${scope}\n${lines.map((line) => `${line.name}\u0000${line.text}`).join('\n')}`
    if (key === this.chatKey) return
    this.chatKey = key
    this.chatLog.replaceChildren()
    for (const line of lines) {
      const row = document.createElement('p')
      const name = document.createElement('strong')
      name.textContent = line.name
      row.append(name, document.createTextNode(` ${line.text}`))
      this.chatLog.append(row)
    }
    this.chatLog.scrollTop = this.chatLog.scrollHeight
  }
}

function panel(kind: 'section' | 'form', name: string, index: string, heading: HTMLElement): HTMLElement {
  const element = document.createElement(kind)
  element.className = `lobby-frame lobby-panel ${name}`
  element.append(panelHead(heading, index))
  return element
}

function panelHead(heading: HTMLElement, index?: string): HTMLElement {
  const head = document.createElement('header')
  head.className = 'lobby-panel-head'
  if (index) {
    const tag = document.createElement('span')
    tag.className = 'lobby-tag'
    tag.setAttribute('aria-hidden', 'true')
    tag.textContent = index
    head.append(tag)
  }
  head.append(heading)
  return head
}

function radar(...layers: Element[]): HTMLElement {
  const frame = document.createElement('div')
  frame.className = 'lobby-radar'
  frame.append(...layers)
  return frame
}

function sweep(): HTMLElement {
  const layer = document.createElement('div')
  layer.className = 'lobby-sweep'
  return layer
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2

function blip(game: GameCard): HTMLElement {
  const angle = game.id * GOLDEN_ANGLE
  // 0.2–0.8 of the scope's radius keeps a blip off the centre and its label inside the frame.
  const radius = 0.2 + 0.6 * ((game.id * GOLDEN_RATIO) % 1)
  const element = document.createElement('span')
  element.className = `scope-blip ${gamePhase(game)}`
  element.style.left = `${(50 + 50 * radius * Math.cos(angle)).toFixed(2)}%`
  element.style.top = `${(50 + 50 * radius * Math.sin(angle)).toFixed(2)}%`
  const label = document.createElement('span')
  label.textContent = `#${game.id}`
  element.append(label)
  return element
}

function lakeLabel(amount: number): string {
  return amount <= 0 ? 'Off' : amount.toFixed(2)
}

function choiceRow(choices: readonly { label: string; on: boolean; disabled: boolean; pick: () => void }[]): HTMLElement {
  const row = document.createElement('div')
  row.className = 'size-row'
  for (const choice of choices) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = choice.label
    button.disabled = choice.disabled
    button.classList.toggle('on', choice.on)
    button.addEventListener('click', () => {
      if (choice.on || choice.disabled) return
      choice.pick()
    })
    row.append(button)
  }
  return row
}

function plate(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', onClick)
  return button
}

function postBlockHint(block: PostBlock): string {
  if (block === PostBlock.SeatLimit) return `${REQUEST_SEAT_LIMIT} open requests each — vote instead`
  return 'Board full'
}

type GamePhase = 'unstarted' | 'pending' | 'live'

function gamePhase(game: GameCard): GamePhase {
  if (game.status === RoomStatus.Playing) return 'live'
  for (const slot of game.slots) {
    if (slot.kind === SlotKind.Human) return 'pending'
  }
  return 'unstarted'
}

function phaseLabel(phase: GamePhase): string {
  if (phase === 'live') return 'In combat'
  if (phase === 'pending') return 'Staging'
  return 'Open'
}

function occupancy(game: GameCard): string {
  let humans = 0
  let ais = 0
  let open = 0
  for (const slot of game.slots) {
    if (slot.kind === SlotKind.Human) humans += 1
    else if (slot.kind === SlotKind.Ai) ais += 1
    else open += 1
  }
  const parts = [String(game.mapSize), game.landform === Landform.Land ? 'Land' : 'Island']
  if (game.lakes === 0) parts.push('No lakes')
  else if (game.lakes !== LAKE_DEFAULT) parts.push(`Lakes ${game.lakes.toFixed(2)}`)
  if (humans > 0) parts.push(humans === 1 ? '1 seated' : `${humans} seated`)
  if (ais > 0) parts.push(ais === 1 ? '1 AI' : `${ais} AI`)
  if (open > 0) parts.push(open === 1 ? '1 open' : `${open} open`)
  return parts.join(' · ')
}

function slotLabel(slot: SlotView): string {
  if (slot.kind === SlotKind.Ai) return 'AI'
  if (slot.kind === SlotKind.Human) return slot.name
  return 'open'
}

function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function drawStarts(svg: SVGSVGElement, width: number, height: number, starts: readonly StartPoint[], slots: readonly SlotView[]) {
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.replaceChildren()
  if (width <= 0 || height <= 0) return
  const span = Math.max(width, height)
  const radius = span * 0.032
  const ring = span * 0.004
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const slot = slots[i]
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('cx', String(start.x))
    circle.setAttribute('cy', String(start.y))
    circle.setAttribute('r', String(radius))
    circle.setAttribute('stroke-width', String(ring))
    if (slot && slot.kind !== SlotKind.Open) {
      circle.setAttribute('fill', cssColor(slot.color))
      circle.setAttribute('stroke', '#14160f')
    } else {
      circle.setAttribute('fill', 'rgba(20, 22, 15, 0.72)')
      circle.setAttribute('stroke', '#f6f1dc')
    }
    const number = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    number.setAttribute('x', String(start.x))
    number.setAttribute('y', String(start.y))
    number.setAttribute('text-anchor', 'middle')
    number.setAttribute('dominant-baseline', 'central')
    number.setAttribute('fill', '#f6f1dc')
    number.setAttribute('stroke', '#14160f')
    number.setAttribute('stroke-width', String(ring * 0.7))
    number.setAttribute('paint-order', 'stroke')
    number.setAttribute('font-size', String(radius * 1.15))
    number.setAttribute('font-family', 'ui-sans-serif, system-ui, sans-serif')
    number.setAttribute('font-weight', '700')
    number.textContent = String(i + 1)
    svg.append(circle, number)
  }
}

function terrainKey(terrain: string): number {
  let hash = 0
  const step = Math.max(1, Math.floor(terrain.length / 48))
  for (let i = 0; i < terrain.length; i += step) hash = (hash * 33 + terrain.charCodeAt(i)) >>> 0
  return hash
}

function decodeTerrain(value: string): Uint8Array {
  const binary = atob(value)
  const terrain = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) terrain[i] = binary.charCodeAt(i)
  return terrain
}

function paintPreview(canvas: HTMLCanvasElement, width: number, height: number, terrain: Uint8Array) {
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const image = ctx.createImageData(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const tile = terrain[index] as Terrain
      const shore = isMinimapShore(terrain, width, height, x, y)
      const [r, g, b] = minimapRgb(tile, shore)
      const pixel = index * 4
      image.data[pixel] = r
      image.data[pixel + 1] = g
      image.data[pixel + 2] = b
      image.data[pixel + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
}
