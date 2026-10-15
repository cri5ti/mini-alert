import './style.css'
import { adminEnabled } from './client/admin.ts'
import { Alarm } from './client/alarm.ts'
import { unlockAudio } from './client/audio.ts'
import { Commander } from './client/commander.ts'
import { CreditCounter, functionSlot, hudModel, type HudInput } from './client/hud-model.ts'
import { HudView } from './client/hud-ui.ts'
import { LobbyView } from './client/lobby-ui.ts'
import { Music } from './client/music.ts'
import { rememberedName, rememberName } from './client/player-name.ts'
import { bindMenu } from './client/menu.ts'
import { Net } from './client/net.ts'
import { bindInput, orderAt } from './client/input/pointer.ts'
import { typing } from './client/input/keys.ts'
import { Replica } from './client/replica.ts'
import { seatLink } from './client/seat.ts'
import { GameView } from './client/render/view.ts'
import { HALL_SPAN } from './shared/cities.ts'
import { LobbyClientKind, LobbyServerKind, RoomStatus, type Faction, type MapPreview } from './shared/lobby.ts'
import { ClientMessageKind, ServerEventKind, type ClientPort } from './shared/protocol.ts'

const canvas = document.querySelector<HTMLCanvasElement>('#view')
const lobbyRoot = document.querySelector<HTMLElement>('#lobby')
const hudRoot = document.querySelector<HTMLElement>('#hud')
if (!canvas || !lobbyRoot || !hudRoot) throw new Error('missing game canvas')
const viewCanvas = canvas

const replica = new Replica({ rollback: true })
const net = new Net()
const port: ClientPort = {
  send(message) {
    return net.sendGame(message, replica.localTick)
  },
  onServer() {},
}
const player = new Commander(replica, port)
const hud = new HudView(hudRoot, {
  armBuilding: (typeId) => player.armBuilding(typeId),
  cancelBuild: (typeId) => player.cancelBuild(typeId),
  armCity: () => player.armCity(),
  spawn: (typeId) => player.spawn(typeId),
  cancelSpawn: (typeId, yardId) => player.cancelSpawn(typeId, yardId),
  cancelQueued: (typeId) => player.cancelSpawn(typeId),
  setCityFocus: (step) => player.setCityFocus(step),
  viewAs: (playerId) => net.sendLobby({ kind: LobbyClientKind.ViewAs, playerId }),
  leave: () => net.sendLobby({ kind: LobbyClientKind.LeaveRoom }),
})
const live: { view: GameView | null } = { view: null }
const viewApi = new Proxy({} as GameView, {
  get(_target, key) {
    const current = live.view
    if (!current) return () => undefined
    const value = current[key as keyof GameView]
    return typeof value === 'function' ? value.bind(current) : value
  },
})
bindInput(canvas, replica, player, viewApi)

let spectating = false
let factions: Faction[] = []
let seatId = 0
let toldDefeat = false
let toldWin = false
let preview: MapPreview | null = null
let aimed = false

const music = new Music()
const alarm = new Alarm()
bindMenu({
  onMusic(on) {
    music.setMuted(!on)
  },
  onSounds(on) {
    alarm.setOn(on)
  },
  onMusicVolume(volume) {
    music.setVolume(volume)
  },
  onSoundsVolume(volume) {
    alarm.setVolume(volume)
  },
  onSurrender() {
    net.sendLobby({ kind: LobbyClientKind.LeaveRoom })
  },
})
document.body.classList.add('lobby')
window.addEventListener('pointerdown', () => music.resume())
unlockAudio(window, [music, alarm])

let claimedName: string | null = null
const admin = adminEnabled(location.search)

const lobby = new LobbyView(lobbyRoot, {
  setName(name) {
    rememberName(name)
    const saved = rememberedName()
    if (!saved) return
    claimedName = saved
    net.sendLobby({ kind: LobbyClientKind.SetName, name: saved })
  },
  async copyLink() {
    await navigator.clipboard.writeText(seatLink(net.seat))
  },
  createGame() {
    music.lobby()
    net.sendLobby({ kind: LobbyClientKind.CreateGame })
  },
  joinGame(id) {
    music.lobby()
    net.sendLobby({ kind: LobbyClientKind.JoinGame, gameId: id })
  },
  leave() {
    net.sendLobby({ kind: LobbyClientKind.LeaveRoom })
  },
  takeSlot(index) {
    net.sendLobby({ kind: LobbyClientKind.TakeSlot, index })
  },
  setSlotAi(index) {
    net.sendLobby({ kind: LobbyClientKind.SetSlotAi, index })
  },
  clearSlot(index) {
    net.sendLobby({ kind: LobbyClientKind.ClearSlot, index })
  },
  setMapSize(size) {
    lobby.setBusy(true)
    net.sendLobby({ kind: LobbyClientKind.SetMapSize, size })
  },
  setLandform(landform) {
    lobby.setBusy(true)
    net.sendLobby({ kind: LobbyClientKind.SetLandform, landform })
  },
  setLakes(lakes) {
    lobby.setBusy(true)
    net.sendLobby({ kind: LobbyClientKind.SetLakes, lakes })
  },
  regenerate() {
    lobby.setBusy(true)
    net.sendLobby({ kind: LobbyClientKind.Regenerate })
  },
  start() {
    net.sendLobby({ kind: LobbyClientKind.StartGame })
  },
  setAiPace(pace) {
    net.sendLobby({ kind: LobbyClientKind.SetAiPace, pace })
  },
  chat(text) {
    net.sendLobby({ kind: LobbyClientKind.Chat, text })
  },
  destroyGame(id) {
    net.sendLobby({ kind: LobbyClientKind.DestroyGame, gameId: id })
  },
  postRequest(text) {
    net.sendLobby({ kind: LobbyClientKind.PostRequest, text })
  },
  toggleVote(id) {
    net.sendLobby({ kind: LobbyClientKind.ToggleVote, requestId: id })
  },
  markRequestDone(id) {
    net.sendLobby({ kind: LobbyClientKind.MarkRequestDone, requestId: id })
  },
  deleteRequest(id) {
    net.sendLobby({ kind: LobbyClientKind.DeleteRequest, requestId: id })
  },
  playHere() {
    net.connect()
  },
}, admin)

net.onOpen = () => {
  lobby.setConnected(true)
  if (admin) net.sendLobby({ kind: LobbyClientKind.ClaimAdmin })
}
net.onClose = () => {
  claimedName = null
  lobby.setConnected(false)
}
net.onLobby = (message) => {
  if (message.kind === LobbyServerKind.Replaced) {
    net.pause()
    leaveMatch()
    music.silent()
    lobby.showReplaced()
    return
  }
  if (message.kind === LobbyServerKind.Preview) {
    preview = message
    lobby.showPreview(message)
    return
  }
  if (message.kind === LobbyServerKind.Waiting) {
    leaveMatch()
    music.silent()
    preview = null
    lobby.showWaiting(message)
    claimName(message.you.name)
    return
  }
  factions = message.factions
  seatId = message.seatId
  hud.setBattle(message.gameId)
  if (message.spectating !== spectating) {
    spectating = message.spectating
    player.setSpectating(spectating)
  }
  if (message.status === RoomStatus.Playing) {
    showMatch()
    music.match()
    paintFactions()
    noteOutcome()
    return
  }
  leaveMatch()
  music.lobby()
  lobby.showGame(message, preview)
  claimName(message.you.name)
}

function claimName(serverName: string) {
  const saved = rememberedName()
  if (!saved || saved === serverName) return
  lobby.holdName(saved)
  if (claimedName === saved) return
  claimedName = saved
  net.sendLobby({ kind: LobbyClientKind.SetName, name: saved })
}
net.onGame = (frame) => {
  for (const event of frame.events) {
    if (event.kind === ServerEventKind.Trace) hud.paintTrace(event)
  }
  if (frame.events.length > 0 && frame.events.every((event) => event.kind === ServerEventKind.Trace)) return
  const previous = replica.playerId
  const hadWorld = replica.world
  replica.apply(frame)
  const welcome = frame.events.find((event) => event.kind === ServerEventKind.Welcome)
  if (welcome && spectating && welcome.playerId !== previous) {
    live.view?.forgetVision(replica.world?.known)
    player.select(null)
    aimed = false
    paintFactions()
    if (replica.world) mountWorld()
    return
  }
  if (!hadWorld && replica.world) mountWorld()
  if (frame.events.some((event) => event.kind === ServerEventKind.Snapshot)) aimOnce()
  if (replica.advance(0)) net.sendGame({ kind: ClientMessageKind.RequestSnapshot }, replica.localTick)
}
net.connect()

function showMatch() {
  document.body.classList.add('match')
  document.body.classList.remove('lobby')
  lobby.hide()
}

function leaveMatch() {
  spectating = false
  factions = []
  seatId = 0
  toldDefeat = false
  toldWin = false
  aimed = false
  player.setSpectating(false)
  player.reset()
  replica.reset()
  live.view?.dispose()
  live.view = null
  document.body.classList.add('lobby')
  document.body.classList.remove('match')
  hud.clear()
}

function mountWorld() {
  const world = replica.world
  if (!world) return
  showMatch()
  live.view?.dispose()
  const view = new GameView(viewCanvas, world.width, world.height)
  live.view = view
  view.mountTerrain(world, replica.terrainRevision, replica.knownTiles)
  view.setMinimapCommand((tile, mods) => orderAt(tile, replica, player, view, mods))
  view.setMinimapHover((tile) => {
    if (player.raisingCity()) player.setAim(tile)
  })
  view.setAlert((kind) => alarm.sound(kind))
  view.resize()
  aimed = false
  creditCounter.snap(replica.credits)
  aimOnce()
  paintFactions()
}

function aimOnce() {
  if (aimed || !live.view) return
  const lead = replica.units.find((unit) => unit.ownerId === replica.playerId && unit.health > 0)
  if (!lead) return
  aimed = true
  if (!spectating) player.select(lead.id)
  live.view.focus(lead.x, lead.z)
}

function paintFactions() {
  hud.setFactions(factions, spectating, replica.playerId)
}

function noteOutcome() {
  const mine = factions.find((faction) => faction.playerId === seatId)
  if (mine?.defeated && !toldDefeat) {
    toldDefeat = true
    hud.setOutcome({ title: 'Defeated', text: 'Your forces are gone.' })
  }
  const alive = factions.filter((faction) => !faction.defeated)
  if (mine && !mine.defeated && !toldWin && alive.length === 1 && factions.some((faction) => faction.defeated)) {
    toldWin = true
    hud.setOutcome({ title: 'Victory', text: 'You are the last player.' })
  }
}

window.addEventListener('keydown', (event) => {
  if (typing(event) || event.repeat) return
  const slot = functionSlot(event.code)
  if (slot !== null && hud.pressSlot(slot, event.shiftKey)) event.preventDefault()
})

const PING_MS = 2000
const STALL_MS = 6000
const creditCounter = new CreditCounter()

function hudInput(): HudInput {
  const raising = player.raisingCity()
  return {
    playerId: replica.playerId,
    units: replica.units,
    queue: replica.queue(),
    cities: replica.cities,
    layouts: replica.settledLayouts(),
    selected: player.selected().map((unit) => unit.id),
    group: player.groupOf(),
    yard: player.productionYard(),
    placing: player.placingType(),
    raising,
    hall: player.selectedCity(),
    quote: raising ? replica.cityBuildCost(player.aimedTile()) : null,
    rtt: net.rtt,
    spectating,
  }
}

const refreshHud = (dt: number) => {
  creditCounter.ease(replica.credits, dt)
  hud.paint(hudModel(hudInput()), creditCounter)
}

let last = performance.now()
const frame = (now: number) => {
  const frameDt = Math.min(0.1, (now - last) / 1000)
  last = now
  const view = live.view
  if (view) {
    if (replica.advance(frameDt)) net.sendGame({ kind: ClientMessageKind.RequestSnapshot }, replica.localTick)
    if (replica.world) view.syncTerrain(replica.world, replica.terrainRevision, replica.knownTiles)
    view.syncCities(replica.settledLayouts(), replica.cityRevision)
    view.update(frameDt)
    refreshHud(frameDt)
    view.showExpectedSites(replica.expectedSiteList())
    const hallIndex = player.selectedCity()
    const hallLayout = hallIndex === null ? null : replica.settledLayouts()[hallIndex]
    const hallBuilding = hallLayout?.buildings.find((building) => building.keep) ?? null
    view.showHall(hallBuilding ? { x: hallBuilding.x + HALL_SPAN / 2, z: hallBuilding.y + HALL_SPAN / 2 } : null)
    view.render(
      replica.drawn(),
      player.selected(),
      replica.takeShots(),
      replica.takeHits(),
      replica.playerId,
      replica.cities,
      replica.settledLayouts(),
      replica.shownRally(),
      replica.cleared,
      replica.takeYields(),
    )
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

window.setInterval(() => {
  if (!live.view) return
  const quiet = net.quietFor()
  if (quiet !== null && quiet > STALL_MS) {
    net.drop()
    return
  }
  if (!document.hidden) net.sendGame({ kind: ClientMessageKind.Ping }, replica.localTick)
}, PING_MS)
