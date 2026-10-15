import '../style.css'
import { drawingRoom, guestRoom, hall, hostRoom, roomPreview } from './lobby-fixtures.ts'
import { LobbyView, type LobbyActions } from './lobby-ui.ts'

const SCREENS = ['hall', 'host', 'guest', 'drawing', 'offline', 'replaced'] as const
type Screen = (typeof SCREENS)[number]

function isScreen(value: string | null): value is Screen {
  return SCREENS.some((screen) => screen === value)
}

function log(name: string) {
  return (...args: unknown[]) => console.info(`lobby ${name}`, ...args)
}

const actions: LobbyActions = {
  setName: log('setName'),
  copyLink: async () => log('copyLink')(),
  createGame: log('createGame'),
  joinGame: log('joinGame'),
  leave: log('leave'),
  takeSlot: log('takeSlot'),
  setSlotAi: log('setSlotAi'),
  clearSlot: log('clearSlot'),
  setMapSize: log('setMapSize'),
  setLandform: log('setLandform'),
  setLakes: log('setLakes'),
  regenerate: log('regenerate'),
  start: log('start'),
  setAiPace: log('setAiPace'),
  chat: log('chat'),
  destroyGame: log('destroyGame'),
  postRequest: log('postRequest'),
  toggleVote: log('toggleVote'),
  markRequestDone: log('markRequestDone'),
  deleteRequest: log('deleteRequest'),
  playHere: log('playHere'),
}

function show(view: LobbyView, screen: Screen) {
  view.setConnected(screen !== 'offline')
  if (screen === 'host') view.showGame(hostRoom(), roomPreview())
  else if (screen === 'guest') view.showGame(guestRoom(), roomPreview())
  else if (screen === 'drawing') {
    view.showGame(hostRoom(), roomPreview())
    view.showGame(drawingRoom(), roomPreview())
  } else view.showWaiting(hall())
  if (screen === 'replaced') view.showReplaced()
}

function phoneStrip(admin: boolean): HTMLElement {
  const strip = document.createElement('main')
  strip.className = 'mock-phones'
  for (const screen of SCREENS) {
    const figure = document.createElement('figure')
    const caption = document.createElement('figcaption')
    caption.textContent = screen
    const frame = document.createElement('iframe')
    frame.title = screen
    frame.width = '390'
    frame.height = '844'
    frame.src = `${location.pathname}?screen=${screen}${admin ? '&admin=1' : ''}`
    figure.append(caption, frame)
    strip.append(figure)
  }
  return strip
}

const params = new URLSearchParams(location.search)
const admin = params.get('admin') === '1'
if (params.get('frame') === 'phone') {
  document.body.replaceChildren(phoneStrip(admin))
} else {
  const root = document.querySelector<HTMLElement>('#lobby')
  if (!root) throw new Error('missing lobby root')
  const screen = params.get('screen')
  show(new LobbyView(root, actions, admin), isScreen(screen) ? screen : 'hall')
}
