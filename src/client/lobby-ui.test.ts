// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Landform, REQUEST_OPEN_LIMIT, REQUEST_TEXT_LIMIT, RequestStatus, RoomStatus, SlotKind } from '../shared/lobby.ts'
import { drawingRoom, emptyHall, guestRoom, hall, hostRoom, ROOM_ID, roomPreview, seatLimitHall } from './lobby-fixtures.ts'
import { LobbyView, type LobbyActions } from './lobby-ui.ts'

function spies() {
  return {
    setName: vi.fn<LobbyActions['setName']>(),
    copyLink: vi.fn<LobbyActions['copyLink']>(() => Promise.resolve()),
    createGame: vi.fn<LobbyActions['createGame']>(),
    joinGame: vi.fn<LobbyActions['joinGame']>(),
    leave: vi.fn<LobbyActions['leave']>(),
    takeSlot: vi.fn<LobbyActions['takeSlot']>(),
    setSlotAi: vi.fn<LobbyActions['setSlotAi']>(),
    clearSlot: vi.fn<LobbyActions['clearSlot']>(),
    setMapSize: vi.fn<LobbyActions['setMapSize']>(),
    setLandform: vi.fn<LobbyActions['setLandform']>(),
    setLakes: vi.fn<LobbyActions['setLakes']>(),
    regenerate: vi.fn<LobbyActions['regenerate']>(),
    start: vi.fn<LobbyActions['start']>(),
    setAiPace: vi.fn<LobbyActions['setAiPace']>(),
    chat: vi.fn<LobbyActions['chat']>(),
    destroyGame: vi.fn<LobbyActions['destroyGame']>(),
    postRequest: vi.fn<LobbyActions['postRequest']>(),
    toggleVote: vi.fn<LobbyActions['toggleVote']>(),
    markRequestDone: vi.fn<LobbyActions['markRequestDone']>(),
    deleteRequest: vi.fn<LobbyActions['deleteRequest']>(),
    playHere: vi.fn<LobbyActions['playHere']>(),
  } satisfies LobbyActions
}

function mount(admin = false) {
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  const actions = spies()
  const view = new LobbyView(root, actions, admin)
  return { root, view, actions }
}

function one<T extends Element = HTMLElement>(scope: ParentNode, selector: string): T {
  const found = scope.querySelector<T>(selector)
  if (!found) throw new Error(`no ${selector}`)
  return found
}

function all<T extends Element = HTMLElement>(scope: ParentNode, selector: string): T[] {
  return [...scope.querySelectorAll<T>(selector)]
}

function texts(scope: ParentNode, selector: string): string[] {
  return all(scope, selector).map((element) => element.textContent ?? '')
}

function labels(scope: ParentNode): string[] {
  return texts(scope, 'button')
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>(scope, 'button').find((element) => element.textContent === label)
  if (!found) throw new Error(`no ${label} button`)
  return found
}

function field(scope: ParentNode, label: string): HTMLInputElement {
  return one<HTMLInputElement>(scope, `input[aria-label="${label}"]`)
}

function gameRow(scope: ParentNode, id: number): HTMLElement {
  const found = all(scope, '.game-row').find((row) => one(row, 'h3').textContent === `#${id}`)
  if (!found) throw new Error(`no row for game ${id}`)
  return found
}

function requestCard(scope: ParentNode, text: string): HTMLElement {
  const found = all(scope, '.request-card').find((card) => one(card, '.request-text').textContent === text)
  if (!found) throw new Error(`no card for ${text}`)
  return found
}

function busy(root: ParentNode): boolean {
  return one(root, '.lobby-preview').classList.contains('busy')
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('lobby status', () => {
  it('says Reconnecting… only while offline outside a match', () => {
    const { root, view } = mount()
    const status = one(root, '.lobby-status')
    view.showWaiting(hall())
    view.setConnected(false)
    expect(status.textContent).toContain('Reconnecting…')
    view.setConnected(true)
    expect(status.textContent).not.toContain('Reconnecting…')
    view.hide()
    view.setConnected(false)
    expect(status.textContent).not.toContain('Reconnecting…')
  })
})

describe('lobby header', () => {
  it('holds the logotype, the screen label, the identity controls and the link status', () => {
    const { root, view } = mount(true)
    view.showWaiting(hall())
    const head = one(root, '.lobby-head')
    expect(one(head, '.lobby-logo').textContent).toBe('MINI ALERT')
    expect(one(head, 'h1').textContent).toBe('Waiting room')
    expect(one(head, '.admin-mark').textContent).toBe('Admin')
    expect(field(head, 'Name').value).toBe('Ada')
    button(head, 'Copy my link')
    const status = one(head, '.lobby-status')
    view.setConnected(true)
    expect(status.textContent).toBe('◉ Live')
    view.setConnected(false)
    expect(status.textContent).toBe('◌ Reconnecting…')
    view.hide()
    view.setConnected(true)
    expect(status.textContent).toBe('')
  })
})

describe('lobby panels', () => {
  function headings(root: ParentNode): string[] {
    return texts(root, '.lobby-grid > .lobby-panel:not([hidden]) > .lobby-panel-head h2')
  }

  it('heads each panel of the hall and the room, beside an index tag hidden from assistive tech', () => {
    const { root, view } = mount()
    view.showWaiting(hall())
    expect(headings(root)).toEqual(['Operators', 'Battles', 'Radar', 'Requests', 'Comms'])
    view.showGame(hostRoom(), roomPreview())
    expect(headings(root)).toEqual(['Not seated', 'Battle #12', 'Radar', 'Comms'])
    expect(all(root, '.lobby-panel-head .lobby-tag').map((tag) => tag.getAttribute('aria-hidden'))).toEqual(['true', 'true', 'true', 'true', 'true', 'true'])
  })
})

describe('lobby title', () => {
  it('names the hall, a guest room and a hosted room', () => {
    const { root, view } = mount()
    const title = one(root, '.lobby-title h1')
    view.showWaiting(hall())
    expect(title.textContent).toBe('Waiting room')
    view.showGame(guestRoom(), null)
    expect(title.textContent).toBe('Battle #12')
    view.showGame(hostRoom(), null)
    expect(title.textContent).toBe('Battle #12 · host')
  })

  it('shows the Admin mark only for an admin view', () => {
    expect(mount().root.querySelector('.admin-mark')).toBeNull()
    expect(one(mount(true).root, '.admin-mark').textContent).toBe('Admin')
  })
})

describe('lobby identity', () => {
  it('sends a changed name and fills in a held one', () => {
    const { root, view, actions } = mount()
    const name = field(root, 'Name')
    expect(name.maxLength).toBe(16)
    name.value = 'Zed'
    name.dispatchEvent(new Event('change'))
    expect(actions.setName).toHaveBeenCalledWith('Zed')
    view.holdName('Ada')
    expect(name.value).toBe('Ada')
  })

  it('leaves a focused name field alone', () => {
    const { root, view } = mount()
    const name = field(root, 'Name')
    name.focus()
    name.value = 'Draf'
    view.showWaiting(hall())
    view.holdName('Bo')
    expect(name.value).toBe('Draf')
  })

  it('locks the name while the room is playing', () => {
    const { root, view } = mount()
    const name = field(root, 'Name')
    view.showGame(guestRoom(), null)
    expect(name.disabled).toBe(false)
    view.showGame({ ...guestRoom(), status: RoomStatus.Playing }, null)
    expect(name.disabled).toBe(true)
    view.showWaiting(hall())
    expect(name.disabled).toBe(false)
  })

  it('copies the seat link and says so for 2 s', async () => {
    vi.useFakeTimers()
    const { root, actions } = mount()
    const copy = button(root, 'Copy my link')
    expect(copy.title).toContain('Anyone who opens it plays as you')
    copy.click()
    expect(actions.copyLink).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(copy.textContent).toBe('Link copied')
    await vi.advanceTimersByTimeAsync(1999)
    expect(copy.textContent).toBe('Link copied')
    await vi.advanceTimersByTimeAsync(1)
    expect(copy.textContent).toBe('Copy my link')
  })

  it('says Copy failed when the copy is refused', async () => {
    vi.useFakeTimers()
    const { root, actions } = mount()
    actions.copyLink.mockRejectedValueOnce(new Error('denied'))
    const copy = button(root, 'Copy my link')
    copy.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(copy.textContent).toBe('Copy failed')
  })
})

describe('lobby hall', () => {
  it('lists the people here, or says no one is waiting', () => {
    const { root, view } = mount()
    view.showWaiting(hall())
    expect(one(root, '.lobby-people h2').textContent).toBe('Operators')
    expect(texts(root, '.lobby-people .lobby-list p')).toEqual(['Ada', 'Eve'])
    view.showWaiting(emptyHall())
    expect(texts(root, '.lobby-people .lobby-list p')).toEqual(['No one waiting'])
  })

  it('creates a game, and says No games yet when there are none', () => {
    const { root, view, actions } = mount()
    view.showWaiting(emptyHall())
    expect(texts(root, '.lobby-main .lobby-empty')).toEqual(['No games yet'])
    button(root, 'Deploy').click()
    expect(actions.createGame).toHaveBeenCalledOnce()
  })

  it('groups the games by phase, each group with its count and hint', () => {
    const { root, view } = mount()
    const state = hall()
    const unstarted = state.games.find((game) => game.id === 3)
    if (!unstarted) throw new Error('no game 3')
    state.games.push({ ...unstarted, id: 11 })
    view.showWaiting(state)
    const sections = all(root, '.game-section')
    expect(sections.map((section) => one(section, 'h2').textContent)).toEqual(['Open · 2', 'Staging · 1', 'In combat · 1'])
    expect(sections.map((section) => one(section, '.game-section-note').textContent)).toEqual([
      'Nobody seated yet',
      'Seated, waiting to start',
      'Already going',
    ])
    expect(sections.map((section) => texts(section, '.game-row h3'))).toEqual([['#3', '#11'], ['#7'], ['#9']])
  })

  it('shows each game with its phase, occupancy, slots and waiting names', () => {
    const { root, view } = mount()
    view.showWaiting(hall())
    expect(texts(root, '.game-badge')).toEqual(['Open', 'Staging', 'In combat'])
    expect(texts(root, '.game-meta')).toEqual([
      '64 · Land · No lakes · 1 AI · 1 open',
      '128 · Island · Lakes 0.50 · 1 seated · 1 AI · 2 open',
      '192 · Island · 2 seated · 3 AI · 1 open',
    ])
    const pending = gameRow(root, 7)
    expect(pending.textContent).toContain('Bo · AI · open · open')
    expect(pending.textContent).toContain('Waiting: Cy')
    expect(gameRow(root, 9).textContent).not.toContain('Waiting')
  })

  it('joins a waiting game and spectates a live one', () => {
    const { root, view, actions } = mount()
    view.showWaiting(hall())
    expect(labels(gameRow(root, 7))).toEqual(['Join'])
    expect(labels(gameRow(root, 9))).toEqual(['Spectate'])
    button(gameRow(root, 7), 'Join').click()
    expect(actions.joinGame).toHaveBeenLastCalledWith(7)
    button(gameRow(root, 9), 'Spectate').click()
    expect(actions.joinGame).toHaveBeenLastCalledWith(9)
  })

  it('lets an admin view destroy a game once confirmed', () => {
    const { root, view, actions } = mount(true)
    view.showWaiting(hall())
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    button(gameRow(root, 7), 'Destroy').click()
    expect(confirm).toHaveBeenCalledOnce()
    expect(actions.destroyGame).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    button(gameRow(root, 7), 'Destroy').click()
    expect(actions.destroyGame).toHaveBeenCalledWith(7)
  })

  it('hides the map preview', () => {
    const { root, view } = mount()
    view.showGame(hostRoom(), roomPreview())
    expect(one(root, '.lobby-preview').hidden).toBe(false)
    view.showWaiting(hall())
    expect(one(root, '.lobby-preview').hidden).toBe(true)
  })
})

describe('lobby requests', () => {
  it('lists the open cards in the order received and the done ones in a Done group', () => {
    const { root, view } = mount()
    view.showWaiting(hall())
    const panel = one(root, '.lobby-requests')
    expect(all(panel, '.request-card').map((card) => [one(card, '.request-text').textContent, one(card, '.request-vote').textContent])).toEqual([
      ['Naval units', '▲12'],
      ['Bigger maps', '▲5'],
      ['Allied victory when the last enemy falls', '▲2'],
      ['Night mode', '▲3'],
    ])
    const vote = (text: string) => one<HTMLButtonElement>(requestCard(panel, text), '.request-vote')
    expect(['Naval units', 'Bigger maps', 'Allied victory when the last enemy falls'].map((text) => vote(text).getAttribute('aria-pressed'))).toEqual([
      'true',
      'true',
      'false',
    ])
    expect(vote('Naval units').getAttribute('aria-label')).toBe('Vote for Naval units')
    const group = one(panel, '.request-group')
    expect(one(group, 'h3').textContent).toBe('Done · 1')
    expect(texts(group, '.request-text')).toEqual(['Night mode'])
    expect(vote('Night mode').disabled).toBe(true)
    expect(all<HTMLButtonElement>(panel, '.request-list > .request-card .request-vote').map((plate) => plate.disabled)).toEqual([false, false, false])
    view.showWaiting(emptyHall())
    expect(texts(panel, '.lobby-empty')).toEqual(['No requests yet'])
  })

  it('names each author and marks the requests that are mine', () => {
    const { root, view } = mount()
    view.showWaiting(hall())
    const authors = all(root, '.request-by').map((by) => [by.firstChild?.textContent, by.querySelector('.request-mine')?.textContent])
    expect(authors).toEqual([
      ['Bo', undefined],
      ['Ada', 'Yours'],
      ['Eve', undefined],
      ['Cy', undefined],
    ])
  })

  it('toggles a vote', () => {
    const { root, view, actions } = mount()
    view.showWaiting(hall())
    one(requestCard(root, 'Allied victory when the last enemy falls'), '.request-vote').click()
    expect(actions.toggleVote).toHaveBeenLastCalledWith(8)
    one(requestCard(root, 'Naval units'), '.request-vote').click()
    expect(actions.toggleVote).toHaveBeenLastCalledWith(4)
  })

  it('keeps a focused vote plate through a board update', () => {
    const { root, view } = mount()
    view.showWaiting(hall())
    one(requestCard(root, 'Bigger maps'), '.request-vote').focus()
    const state = hall()
    state.requests[1] = { ...state.requests[1], votes: 6 }
    view.showWaiting(state)
    expect(document.activeElement).toBe(one(requestCard(root, 'Bigger maps'), '.request-vote'))
    expect(document.activeElement?.textContent).toBe('▲6')
  })

  it('gives only an admin view Done and Delete, and deletes once confirmed', () => {
    const plain = mount()
    plain.view.showWaiting(hall())
    expect(labels(requestCard(plain.root, 'Naval units')).slice(1)).toEqual([])
    const { root, view, actions } = mount(true)
    view.showWaiting(hall())
    expect(labels(requestCard(root, 'Naval units')).slice(1)).toEqual(['✓ Done', '✕ Delete'])
    expect(labels(requestCard(root, 'Night mode')).slice(1)).toEqual(['✕ Delete'])
    button(requestCard(root, 'Naval units'), '✓ Done').click()
    expect(actions.markRequestDone).toHaveBeenCalledWith(4)
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    button(requestCard(root, 'Night mode'), '✕ Delete').click()
    expect(confirm).toHaveBeenCalledOnce()
    expect(actions.deleteRequest).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    button(requestCard(root, 'Night mode'), '✕ Delete').click()
    expect(actions.deleteRequest).toHaveBeenCalledWith(2)
  })

  it('posts trimmed text and clears the field, and posts nothing blank', () => {
    const { root, view, actions } = mount()
    view.showWaiting(hall())
    const input = field(root, 'Request a feature')
    expect(input.maxLength).toBe(REQUEST_TEXT_LIMIT)
    expect(input.placeholder).toBe('Request a feature')
    input.value = '  Replay viewer  '
    button(root, 'Post').click()
    expect(actions.postRequest).toHaveBeenCalledWith('Replay viewer')
    expect(input.value).toBe('')
    input.value = '   '
    button(root, 'Post').click()
    expect(actions.postRequest).toHaveBeenCalledOnce()
  })

  it('holds the Post plate with a hint at the seat limit and on a full board', () => {
    const { root, view } = mount()
    const post = () => button(root, 'Post')
    const hint = one(root, '.request-hint')
    view.showWaiting(hall())
    expect([post().disabled, hint.hidden]).toEqual([false, true])
    view.showWaiting(seatLimitHall())
    expect([post().disabled, hint.hidden, hint.textContent]).toEqual([true, false, '3 open requests each — vote instead'])
    const full = emptyHall()
    full.requests = Array.from({ length: REQUEST_OPEN_LIMIT }, (_, index) => ({
      id: index + 1,
      text: `Request ${index + 1}`,
      author: 'Bo',
      votes: 1,
      voted: false,
      mine: false,
      status: RequestStatus.Open,
    }))
    view.showWaiting(full)
    expect([post().disabled, hint.hidden, hint.textContent]).toEqual([true, false, 'Board full'])
  })
})

describe('lobby room', () => {
  it('lists the map sizes, marks the current one and lets only the host change it', () => {
    const { root, view, actions } = mount()
    const sizes = () => all<HTMLButtonElement>(root, '.map-options .size-row:first-child button')
    view.showGame(guestRoom(), roomPreview())
    expect(sizes().map((size) => size.textContent)).toEqual(['64 · 2', '128 · 4', '192 · 6', '256 · 8'])
    expect(sizes().map((size) => size.classList.contains('on'))).toEqual([false, true, false, false])
    expect(sizes().every((size) => size.disabled)).toBe(true)
    view.showGame(hostRoom(), roomPreview())
    expect(sizes().some((size) => size.disabled)).toBe(false)
    sizes()[1].click()
    expect(actions.setMapSize).not.toHaveBeenCalled()
    expect(busy(root)).toBe(false)
    sizes()[2].click()
    expect(actions.setMapSize).toHaveBeenCalledWith(192)
    expect(busy(root)).toBe(true)
  })

  it('offers Island and Land, marks the current one and lets only the host change it', () => {
    const { root, view, actions } = mount()
    const forms = () => all<HTMLButtonElement>(root, '.map-options .size-row:last-child button')
    view.showGame(guestRoom(), roomPreview())
    expect(forms().map((form) => [form.textContent, form.classList.contains('on'), form.disabled])).toEqual([
      ['Island', true, true],
      ['Land', false, true],
    ])
    view.showGame(hostRoom(), roomPreview())
    forms()[0].click()
    expect(actions.setLandform).not.toHaveBeenCalled()
    expect(busy(root)).toBe(false)
    forms()[1].click()
    expect(actions.setLandform).toHaveBeenCalledWith(Landform.Land)
    expect(busy(root)).toBe(true)
  })

  it("shows the lakes to every member and sends the host's new amount once the slider is let go", () => {
    const { root, view, actions } = mount()
    view.showGame(guestRoom(), roomPreview())
    const row = one(root, '.lakes-row')
    const lakes = one<HTMLInputElement>(row, 'input[type="range"]')
    expect([lakes.min, lakes.max, lakes.step, lakes.value, lakes.disabled]).toEqual(['0', '1', '0.05', '0.25', true])
    expect(row.textContent).toBe('Lakes0.25')
    view.showGame({ ...hostRoom(), lakes: 0 }, roomPreview())
    expect([lakes.disabled, row.textContent]).toEqual([false, 'LakesOff'])
    lakes.value = '0.5'
    lakes.dispatchEvent(new Event('input'))
    expect(row.textContent).toBe('Lakes0.50')
    expect(actions.setLakes).not.toHaveBeenCalled()
    lakes.dispatchEvent(new Event('change'))
    expect(actions.setLakes).toHaveBeenCalledWith(0.5)
    expect(busy(root)).toBe(true)
  })

  it('keeps a focused lakes slider through a room update', () => {
    const { root, view } = mount()
    view.showGame(hostRoom(), null)
    const lakes = one<HTMLInputElement>(root, '.lakes-row input')
    lakes.focus()
    lakes.value = '0.75'
    view.showGame({ ...hostRoom(), lakes: 0.5, waiting: [] }, null)
    expect(document.activeElement).toBe(lakes)
    expect(lakes.value).toBe('0.75')
  })

  it('locks the map options of a started battle, even for its host', () => {
    const { root, view } = mount()
    view.showGame({ ...hostRoom(), status: RoomStatus.Playing }, null)
    expect(all<HTMLButtonElement>(root, '.map-options button').every((choice) => choice.disabled)).toBe(true)
    expect(one<HTMLInputElement>(root, '.lakes-row input').disabled).toBe(true)
    expect(labels(root)).not.toContain('New map')
  })

  it('gives only the host New map and Start, and Start waits for a seated human', () => {
    const { root, view, actions } = mount()
    view.showGame(guestRoom(), roomPreview())
    expect(labels(root)).not.toContain('New map')
    expect(texts(root, '.lobby-actions button')).toEqual(['Back'])
    button(root, 'Back').click()
    expect(actions.leave).toHaveBeenCalledOnce()

    view.showGame(hostRoom(), roomPreview())
    button(root, 'New map').click()
    expect(actions.regenerate).toHaveBeenCalledOnce()
    expect(busy(root)).toBe(true)
    expect(texts(root, '.lobby-actions button')).toEqual(['Back', 'Start'])
    const start = button(root, 'Start')
    expect(start.disabled).toBe(false)
    start.click()
    expect(actions.start).toHaveBeenCalledOnce()

    const unseated = hostRoom()
    unseated.slots = unseated.slots.filter((slot) => slot.kind !== SlotKind.Human)
    view.showGame(unseated, null)
    expect(button(root, 'Start').disabled).toBe(true)
  })

  it('shows each slot with its number, colour and occupant', () => {
    const { root, view } = mount()
    view.showGame(hostRoom(), null)
    const rows = all(root, '.slot-row')
    expect(rows.map((row) => one(row, '.slot-index').textContent)).toEqual(['1', '2', '3', '4'])
    expect(rows.map((row) => one(row, '.swatch').style.background)).toEqual(['#2f7edb', '#d64545', '#3cde73', '#f0c040'])
    expect(rows.map((row) => one(row, '.slot-name').textContent)).toEqual(['Ada', 'Bo', 'AI', 'Open'])
  })

  it('offers each slot kind its actions', () => {
    const { root, view, actions } = mount()
    view.showGame(hostRoom(), null)
    const rows = all(root, '.slot-row')
    expect(rows.map(labels)).toEqual([['Stand'], [], ['Clear'], ['Sit', 'AI']])
    button(rows[0], 'Stand').click()
    expect(actions.clearSlot).toHaveBeenLastCalledWith(0)
    button(rows[2], 'Clear').click()
    expect(actions.clearSlot).toHaveBeenLastCalledWith(2)
    button(rows[3], 'Sit').click()
    expect(actions.takeSlot).toHaveBeenCalledWith(3)
    button(rows[3], 'AI').click()
    expect(actions.setSlotAi).toHaveBeenCalledWith(3)
  })

  it('shows the AI pace to every member and sends a new one', () => {
    const { root, view, actions } = mount()
    view.showGame(hostRoom(), null)
    expect(root.querySelector('.pace-row input')).not.toBeNull()
    view.showGame(guestRoom(), null)
    const row = one(root, '.pace-row')
    const pace = one<HTMLInputElement>(row, 'input[type="range"]')
    expect([pace.min, pace.max, pace.step]).toEqual(['0.25', '3', '0.25'])
    expect(pace.value).toBe('1.5')
    expect(row.textContent).toContain('1.50')
    pace.value = '2.25'
    pace.dispatchEvent(new Event('input'))
    expect(actions.setAiPace).toHaveBeenCalledWith(2.25)
    expect(row.textContent).toContain('2.25')
    view.showGame({ ...guestRoom(), aiPace: 0.5 }, null)
    expect(pace.value).toBe('0.5')
  })

  it('keeps a focused pace slider through a room update', () => {
    const { root, view } = mount()
    view.showGame(guestRoom(), null)
    const pace = one<HTMLInputElement>(root, '.pace-row input')
    pace.focus()
    pace.value = '2.25'
    view.showGame({ ...guestRoom(), aiPace: 0.5 }, null)
    expect(document.activeElement).toBe(pace)
    expect(pace.value).toBe('2.25')
  })

  it('lists who is not seated, or says no one is waiting', () => {
    const { root, view } = mount()
    view.showGame(hostRoom(), null)
    expect(one(root, '.lobby-people h2').textContent).toBe('Not seated')
    expect(texts(root, '.lobby-people .lobby-list p')).toEqual(['Cy'])
    view.showGame({ ...hostRoom(), waiting: [] }, null)
    expect(texts(root, '.lobby-people .lobby-list p')).toEqual(['No one waiting'])
  })
})

describe('lobby map preview', () => {
  it('sizes the canvas to the map and marks each start, filled for occupied slots', () => {
    const { root, view } = mount()
    const preview = roomPreview()
    view.showGame(hostRoom(), preview)
    const canvas = one<HTMLCanvasElement>(root, '.lobby-map canvas')
    expect([canvas.width, canvas.height]).toEqual([128, 128])
    const circles = all<SVGCircleElement>(root, '.lobby-marks circle')
    expect(circles.map((circle) => [circle.getAttribute('cx'), circle.getAttribute('cy')])).toEqual(
      preview.starts.map((start) => [String(start.x), String(start.y)]),
    )
    expect(texts(root, '.lobby-marks text')).toEqual(['1', '2', '3', '4'])
    const fills = circles.map((circle) => circle.getAttribute('fill'))
    expect(fills.slice(0, 3)).toEqual(['#2f7edb', '#d64545', '#3cde73'])
    expect(fills[3]).not.toBe('#f0c040')
  })

  it('clears the markers and shows Drawing map while the map draws', () => {
    const { root, view } = mount()
    view.showGame(hostRoom(), roomPreview())
    view.showGame(drawingRoom(), roomPreview())
    expect(all(root, '.lobby-marks circle')).toHaveLength(0)
    expect(busy(root)).toBe(true)
    expect(one(root, '.lobby-preview').querySelector('[role="status"][aria-label="Drawing map"]')).not.toBeNull()
    view.showPreview(roomPreview())
    expect(busy(root)).toBe(false)
    expect(all(root, '.lobby-marks circle')).toHaveLength(4)
  })

  it('layers the terrain, the sweep, the markers and the drawing label inside the radar frame', () => {
    const { root, view } = mount()
    view.showGame(hostRoom(), roomPreview())
    const frame = one(root, '.lobby-preview .lobby-radar')
    expect([...frame.children].map((layer) => layer.getAttribute('class') ?? layer.localName)).toEqual([
      'canvas',
      'lobby-sweep',
      'lobby-marks',
      'lobby-drawing',
    ])
    const label = one(frame, '.lobby-drawing')
    expect([busy(root), label.hidden]).toEqual([false, true])
    view.showGame(drawingRoom(), roomPreview())
    expect([busy(root), label.hidden, label.textContent]).toEqual([true, false, 'Drawing map'])
    view.showPreview(roomPreview())
    expect([busy(root), label.hidden]).toEqual([false, true])
  })

  it('ignores a preview of another game', () => {
    const { root, view } = mount()
    view.showGame(hostRoom(), { ...roomPreview(), gameId: ROOM_ID + 1 })
    expect(all(root, '.lobby-marks circle')).toHaveLength(0)
    expect(one<HTMLCanvasElement>(root, '.lobby-map canvas').width).not.toBe(128)
  })
})

describe('lobby radar scope', () => {
  function blips(root: ParentNode): Record<string, { phase: string; at: string[] }> {
    return Object.fromEntries(
      all(root, '.lobby-scope .scope-blip').map((blip) => [
        blip.textContent,
        { phase: blip.className.replace('scope-blip ', ''), at: [blip.style.left, blip.style.top] },
      ]),
    )
  }

  it('plots each battle as a blip labelled #N in its phase, hidden from assistive tech', () => {
    const { root, view } = mount()
    view.showWaiting(hall())
    expect(one(root, '.lobby-scope').getAttribute('aria-hidden')).toBe('true')
    const plotted = blips(root)
    expect(Object.entries(plotted).map(([label, { phase }]) => [label, phase])).toEqual([
      ['#9', 'live'],
      ['#3', 'unstarted'],
      ['#7', 'pending'],
    ])
    expect(new Set(Object.values(plotted).map(({ at }) => at.join())).size).toBe(3)
  })

  it('keeps a battle on its spot as the other battles come and go', () => {
    const { root, view } = mount()
    view.showWaiting(hall())
    const before = blips(root)
    const state = hall()
    state.games = state.games.filter((game) => game.id !== 9)
    view.showWaiting(state)
    expect(blips(root)).toStrictEqual({ '#3': before['#3'], '#7': before['#7'] })
  })
})

describe('lobby chat', () => {
  it('shows each line with its name, and keeps the rows of an unchanged chat', () => {
    const { root, view } = mount()
    view.showWaiting(hall())
    const rows = all(root, '.lobby-log p')
    expect(rows.map((row) => one(row, 'strong').textContent)).toEqual(['Bo', 'Eve'])
    expect(rows.map((row) => row.textContent)).toEqual(['Bo gl hf', 'Eve anyone for 2v2?'])
    view.showWaiting(hall())
    const again = all(root, '.lobby-log p')
    expect(again).toHaveLength(rows.length)
    again.forEach((row, index) => expect(row).toBe(rows[index]))
  })

  it('scrolls to the newest line when the chat changes', () => {
    const { root, view } = mount()
    const log = one(root, '.lobby-log')
    Object.defineProperty(log, 'scrollHeight', { value: 480, configurable: true })
    view.showWaiting(hall())
    expect(log.scrollTop).toBe(480)
    log.scrollTop = 0
    view.showWaiting(hall())
    expect(log.scrollTop).toBe(0)
    const state = hall()
    state.chat.push({ name: 'Ada', text: 'joining 7' })
    view.showWaiting(state)
    expect(log.scrollTop).toBe(480)
  })

  it('sends trimmed text and clears the input, and sends nothing blank', () => {
    const { root, view, actions } = mount()
    view.showWaiting(hall())
    const input = field(root, 'Chat')
    expect(input.maxLength).toBe(200)
    input.value = '  gg  '
    button(root, 'Send').click()
    expect(actions.chat).toHaveBeenCalledWith('gg')
    expect(input.value).toBe('')
    input.value = '   '
    button(root, 'Send').click()
    expect(actions.chat).toHaveBeenCalledOnce()
  })
})

describe('lobby replaced overlay', () => {
  it('opens a dialog titled Open in another tab, and Play here closes it and plays here', () => {
    const { view, actions } = mount()
    const overlay = one(document, '#elsewhere')
    expect(overlay.hidden).toBe(true)
    view.showReplaced()
    expect(overlay.hidden).toBe(false)
    const dialog = one(overlay, '[role="dialog"]')
    expect(one(document, `#${dialog.getAttribute('aria-labelledby')}`).textContent).toBe('Open in another tab')
    button(overlay, 'Play here').click()
    expect(overlay.hidden).toBe(true)
    expect(actions.playHere).toHaveBeenCalledOnce()
  })
})
