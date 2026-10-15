import './style.css'
import { adminEnabled } from './client/admin.ts'
import { Commander } from './client/commander.ts'
import { LobbyView } from './client/lobby-ui.ts'
import { sound } from './client/sound.ts'
import { rememberedName, rememberName } from './client/player-name.ts'
import { bindMenu } from './client/menu.ts'
import { Net } from './client/net.ts'
import { bindInput, orderAt } from './client/input/pointer.ts'
import { typing } from './client/input/keys.ts'
import { Replica } from './client/replica.ts'
import { seatLink } from './client/seat.ts'
import { GameView } from './client/render/view.ts'
import { bindTrace } from './client/trace-pie.ts'
import { HALL_SPAN, populationOf } from './shared/cities.ts'
import { baysFree } from './shared/flight.ts'
import { LobbyClientKind, LobbyServerKind, RoomStatus, type Faction, type MapPreview } from './shared/lobby.ts'
import { ClientMessageKind, ServerEventKind, type ClientPort, type TrainJob, type UnitSnapshot } from './shared/protocol.ts'
import { AIRPORT, ARTILLERY, CRUISER, FACTORY, GUNSHIP, HEAVY_TANK, HELIPAD, JET, Locomotion, MED_TANK, SCOUT, SHIPYARD, TURRET, UNIT_TYPES, UnitTypeId, yardOf } from './shared/unit-types.ts'

const canvas = document.querySelector<HTMLCanvasElement>('#view')
const lobbyRoot = document.querySelector<HTMLElement>('#lobby')
const traceRoot = document.querySelector<HTMLElement>('#trace')
const vision = document.querySelector<HTMLElement>('#vision')
const legend = document.querySelector<HTMLElement>('#legend')
const outcome = document.querySelector<HTMLElement>('#outcome')
const outcomeTitle = document.querySelector<HTMLElement>('#outcome-title')
const outcomeText = document.querySelector<HTMLElement>('#outcome-text')
const outcomeClose = document.querySelector<HTMLButtonElement>('#outcome-close')
const elsewhere = document.querySelector<HTMLElement>('#elsewhere')
const playHere = document.querySelector<HTMLButtonElement>('#elsewhere-play')
if (!canvas || !lobbyRoot || !traceRoot || !vision || !legend || !outcome || !outcomeTitle || !outcomeText || !outcomeClose || !elsewhere || !playHere) {
  throw new Error('missing game canvas')
}
const viewCanvas = canvas
const tracePie = bindTrace(traceRoot)
const visionBar = vision
const legendBar = legend
const outcomeLayer = outcome
const outcomeHeading = outcomeTitle
const outcomeCopy = outcomeText
outcomeClose.addEventListener('click', () => {
  outcomeLayer.hidden = true
})
outcomeLayer.addEventListener('click', (event) => {
  if (event.target === outcomeLayer) outcomeLayer.hidden = true
})

const replica = new Replica()
const net = new Net()
const port: ClientPort = {
  send(message) {
    return net.sendGame(message, replica.localTick)
  },
  onServer() {},
}
const player = new Commander(replica, port)
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

bindMenu({
  onMusic(on) {
    sound.setMuted(!on)
  },
  onSurrender() {
    net.sendLobby({ kind: LobbyClientKind.LeaveRoom })
  },
})
document.body.classList.add('lobby')
window.addEventListener('pointerdown', () => sound.resume())

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
    sound.lobby()
    net.sendLobby({ kind: LobbyClientKind.CreateGame })
  },
  joinGame(id) {
    sound.lobby()
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
}, admin)

net.onOpen = () => {
  lobby.setConnected(true)
  if (admin) net.sendLobby({ kind: LobbyClientKind.ClaimAdmin })
}
net.onClose = () => {
  claimedName = null
  lobby.setConnected(false)
}
playHere.addEventListener('click', () => {
  elsewhere.hidden = true
  net.connect()
})
net.onLobby = (message) => {
  if (message.kind === LobbyServerKind.Replaced) {
    net.pause()
    leaveMatch()
    sound.silent()
    elsewhere.hidden = false
    return
  }
  if (message.kind === LobbyServerKind.Preview) {
    preview = message
    lobby.showPreview(message)
    return
  }
  if (message.kind === LobbyServerKind.Waiting) {
    leaveMatch()
    sound.silent()
    preview = null
    lobby.showWaiting(message)
    claimName(message.you.name)
    return
  }
  factions = message.factions
  seatId = message.seatId
  if (message.spectating !== spectating) {
    spectating = message.spectating
    player.setSpectating(spectating)
  }
  if (message.status === RoomStatus.Playing) {
    showMatch()
    sound.match()
    paintVision()
    paintLegend()
    noteOutcome()
    return
  }
  leaveMatch()
  sound.lobby()
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
    if (event.kind === ServerEventKind.Trace) tracePie.paint(event)
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
    paintVision()
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
  document.body.classList.toggle('spectate', spectating)
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
  sound.reset()
  replica.reset()
  live.view?.dispose()
  live.view = null
  document.body.classList.add('lobby')
  document.body.classList.remove('match', 'spectate')
  visionBar.hidden = true
  visionBar.replaceChildren()
  legendBar.hidden = true
  legendBar.replaceChildren()
  outcomeLayer.hidden = true
  tracePie.hide()
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
  view.resize()
  aimed = false
  shownCredits = replica.credits
  aimOnce()
  paintVision()
  paintLegend()
}

function aimOnce() {
  if (aimed || !live.view) return
  const lead = replica.units.find((unit) => unit.ownerId === replica.playerId && unit.health > 0)
  if (!lead) return
  aimed = true
  if (!spectating) player.select(lead.id)
  live.view.focus(lead.x, lead.z)
}

function paintVision() {
  visionBar.hidden = !spectating
  visionBar.replaceChildren()
  if (!spectating) return
  for (const faction of factions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = faction.name
    button.style.color = cssColor(faction.color)
    button.classList.toggle('on', faction.playerId === replica.playerId)
    button.addEventListener('click', () => {
      net.sendLobby({ kind: LobbyClientKind.ViewAs, playerId: faction.playerId })
    })
    visionBar.append(button)
  }
  const leave = document.createElement('button')
  leave.type = 'button'
  leave.textContent = 'Leave'
  leave.addEventListener('click', () => net.sendLobby({ kind: LobbyClientKind.LeaveRoom }))
  visionBar.append(leave)
}

function paintLegend() {
  legendBar.hidden = false
  legendBar.replaceChildren()
  for (const faction of factions) {
    const row = document.createElement('div')
    row.className = 'legend-row'
    row.classList.toggle('defeated', faction.defeated)
    const swatch = document.createElement('i')
    swatch.style.background = cssColor(faction.color)
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = faction.name
    row.append(swatch, name)
    if (faction.defeated) {
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = 'defeated'
      row.append(tag)
    }
    legendBar.append(row)
  }
}

function noteOutcome() {
  const mine = factions.find((faction) => faction.playerId === seatId)
  if (mine?.defeated && !toldDefeat) {
    toldDefeat = true
    sound.outcome(false)
    showOutcome('Defeated', 'Your forces are gone.')
  }
  const alive = factions.filter((faction) => !faction.defeated)
  if (mine && !mine.defeated && !toldWin && alive.length === 1 && factions.some((faction) => faction.defeated)) {
    toldWin = true
    sound.outcome(true)
    showOutcome('Victory', 'You are the last player.')
  }
}

function showOutcome(title: string, text: string) {
  outcomeHeading.textContent = title
  outcomeCopy.textContent = text
  outcomeLayer.hidden = false
}

function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

const credits = document.querySelector<HTMLElement>('#credits')
const forces = document.querySelector<HTMLElement>('#forces')
const population = document.querySelector<HTMLElement>('#population')
const cities = document.querySelector<HTMLElement>('#cities')
const ping = document.querySelector<HTMLElement>('#ping')
const orders = document.querySelector<HTMLElement>('#orders')
const cityFocus = document.querySelector<HTMLElement>('#city-focus')
const cityFocusLabel = document.querySelector<HTMLElement>('#city-focus-label')
const cityFocusRange = document.querySelector<HTMLInputElement>('#city-focus-range')
const FOCUS_LABEL = ['Money ×4', 'Money ×2', 'Balanced', 'Growth ×2', 'Growth ×4']
const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen')
const NEEDS_FACTORY = new Set<UnitTypeId>([UnitTypeId.Airport, UnitTypeId.Helipad, UnitTypeId.Shipyard])
const TRAINABLE = [SCOUT, MED_TANK, HEAVY_TANK, ARTILLERY, JET, GUNSHIP, CRUISER]
const tiles: OrderTile[] = []
let queueSplit: HTMLElement | null = null
if (orders) {
  for (const type of [FACTORY, TURRET, AIRPORT, HELIPAD, SHIPYARD]) {
    tiles.push(createTile(orders, type.id, false, false, type.label, type.cost, () => player.armBuilding(type.id), () => player.cancelBuild(type.id)))
  }
  tiles.push(createTile(orders, null, false, false, 'Building', 0, () => player.armCity()))
  for (const type of TRAINABLE) {
    tiles.push(createTile(orders, type.id, true, false, type.label, type.cost, () => player.spawn(type.id), () => {
      const yard = player.productionYard()
      if (yard) player.cancelSpawn(type.id, yard.id)
    }))
  }
  queueSplit = document.createElement('div')
  queueSplit.className = 'queue-split'
  queueSplit.textContent = 'Queued: '
  queueSplit.hidden = true
  orders.append(queueSplit)
  for (const type of TRAINABLE) {
    tiles.push(createTile(orders, type.id, true, true, type.label, type.cost, () => player.cancelSpawn(type.id), () => player.cancelSpawn(type.id)))
  }
  window.addEventListener('keydown', (event) => {
    if (typing(event) || event.repeat || orders.hidden) return
    const slot = functionSlot(event.code)
    if (slot === null) return
    const entry = tiles.find((tile) => tile.slot === slot)
    if (!entry) return
    event.preventDefault()
    if (event.shiftKey) entry.onRemove?.()
    else if (entry.button.classList.contains('ready')) {
      sound.click()
      entry.onAdd()
    } else refuseOrder(entry.id)
  })
}
cityFocusRange?.addEventListener('input', () => {
  const step = Number(cityFocusRange.value)
  if (cityFocusLabel) cityFocusLabel.textContent = FOCUS_LABEL[step + 2] ?? 'Balanced'
  player.setCityFocus(step)
})
fullscreen?.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void document.documentElement.requestFullscreen()
})

const COUNT_SECONDS = 0.15
const PING_MS = 2000
const STALL_MS = 6000
const SLOW_PING_MS = 150
const BAD_PING_MS = 300
let shownCredits = replica.credits

function heldCities(): { cities: number; population: number } {
  const playerId = replica.playerId
  if (playerId === null || !replica.world) return { cities: 0, population: 0 }
  const settled = replica.settledLayouts()
  let cities = 0
  let population = 0
  for (let i = 0; i < settled.length; i++) {
    const state = replica.cities[i]
    const layout = settled[i]
    if (!state || !layout || state.ownerId !== playerId) continue
    cities += 1
    population += populationOf(layout, state.ruins)
  }
  return { cities, population }
}

const refreshHud = (dt: number) => {
  const target = replica.credits
  const blend = dt <= 0 ? 1 : 1 - Math.exp(-dt / COUNT_SECONDS)
  shownCredits += (target - shownCredits) * blend
  if (Math.abs(target - shownCredits) < 0.5) shownCredits = target
  if (credits) {
    credits.textContent = Math.round(shownCredits).toLocaleString('en-US')
    const gap = target - shownCredits
    credits.classList.toggle('up', gap > 30)
    credits.classList.toggle('down', gap < -30)
  }
  const held = heldCities()
  const own = replica.units.filter((unit) => unit.ownerId === replica.playerId && unit.health > 0)
  let army = 0
  for (const unit of own) army += UNIT_TYPES[unit.typeId].supply
  let queued = 0
  const queue = replica.queue()
  for (const job of queue) queued += UNIT_TYPES[job.typeId].supply
  if (forces) {
    forces.textContent = String(army)
    forces.classList.toggle('over', army > held.population)
  }
  if (population) population.textContent = String(held.population)
  if (cities) cities.textContent = String(held.cities)
  const hall = player.selectedCity()
  if (orders) orders.hidden = hall !== null
  if (cityFocus) cityFocus.hidden = hall === null
  if (hall !== null && cityFocusRange && cityFocusLabel && document.activeElement !== cityFocusRange) {
    const step = replica.cities[hall]?.focus ?? 0
    cityFocusRange.value = String(step)
    cityFocusLabel.textContent = FOCUS_LABEL[step + 2] ?? 'Balanced'
  }
  if (ping) {
    const rtt = net.rtt
    ping.textContent = rtt === null ? '–' : `${Math.round(rtt)} ms`
    ping.classList.toggle('slow', rtt !== null && rtt > SLOW_PING_MS)
    ping.classList.toggle('bad', rtt !== null && rtt > BAD_PING_MS)
  }
  const ready = new Set<number>()
  for (const unit of own) {
    if (unit.progress >= 1 && UNIT_TYPES[unit.typeId].topSpeed <= 0) ready.add(unit.typeId)
  }
  const yard = player.productionYard()
  const armed = player.placingType()
  const pending = structureQueue()
  const quoted = player.raisingCity() ? replica.cityBuildCost(player.aimedTile()) : null
  const yardJobs = tallyJobs(queue, yard?.id)
  const allJobs = tallyJobs(queue)
  if (queueSplit) queueSplit.hidden = !allJobs.any
  for (const entry of tiles) {
    if (entry.queue) {
      const count = entry.id === null ? 0 : (allJobs.count.get(entry.id) ?? 0)
      const progress = entry.id === null ? 0 : (allJobs.progress.get(entry.id) ?? 0)
      paintTile(entry, count, progress, count > 0, count > 0)
      continue
    }
    if (yard) {
      if (!entry.train || entry.id === null || yardOf(entry.id) !== yard.typeId) {
        entry.button.hidden = true
        continue
      }
      const count = yardJobs.count.get(entry.id) ?? 0
      const progress = yardJobs.progress.get(entry.id) ?? 0
      const supplyRoom = army + queued + UNIT_TYPES[entry.id].supply <= held.population
      const room = supplyRoom && (entry.id !== UnitTypeId.Jet || jetApron(own, queue, yard) > 0)
      paintTile(entry, count, progress, yard.progress >= 1 && room, true)
      continue
    }
    if (entry.train) {
      entry.button.hidden = true
      continue
    }
    if (entry.id === null) {
      entry.cost.textContent = costLine(quoted ?? 0, 1)
      paintTile(entry, 0, 0, true, true, player.raisingCity())
      continue
    }
    const site = pending.get(entry.id)
    const gate = !NEEDS_FACTORY.has(entry.id) || ready.has(UnitTypeId.Factory)
    const supplyRoom = army + queued + UNIT_TYPES[entry.id].supply <= held.population
    paintTile(entry, site?.count ?? 0, site?.progress ?? 0, gate && supplyRoom, gate || (site?.count ?? 0) > 0 || (site?.progress ?? 0) > 0, armed === entry.id)
  }
  stampHotkeys(tiles)
}

type OrderTile = {
  id: UnitTypeId | null
  train: boolean
  queue: boolean
  slot: number
  button: HTMLButtonElement
  ring: HTMLElement
  badge: HTMLElement
  hotkey: HTMLElement
  cost: HTMLElement
  onAdd: () => void
  onRemove?: () => void
}

function createTile(
  bar: HTMLElement,
  id: UnitTypeId | null,
  train: boolean,
  queue: boolean,
  name: string,
  cost: number,
  onAdd: () => void,
  onRemove?: () => void,
): OrderTile {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `tile ${tileKind(id)}`
  button.title = name
  button.hidden = queue || train || (id !== null && NEEDS_FACTORY.has(id))
  const pie = document.createElement('span')
  pie.className = 'pie'
  const label = document.createElement('span')
  label.className = 'name'
  label.textContent = name
  const price = document.createElement('span')
  price.className = 'cost'
  price.textContent = costLine(cost, id === null ? 1 : UNIT_TYPES[id].supply)
  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.hidden = true
  const hotkey = document.createElement('span')
  hotkey.className = 'hotkey'
  button.append(pie, label, price, badge, hotkey)
  button.addEventListener('click', (event) => {
    if (queue || event.shiftKey) {
      onRemove?.()
      return
    }
    if (!button.classList.contains('ready')) {
      refuseOrder(id)
      return
    }
    sound.click()
    onAdd()
  })
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    onRemove?.()
  })
  bar.append(button)
  return { id, train, queue, slot: 0, button, ring: pie, badge, hotkey, cost: price, onAdd, onRemove }
}

/** Visible build and train tiles, left to right, take F1 onward. Queued copies stay unlabeled. */
function stampHotkeys(entries: readonly OrderTile[]) {
  let slot = 0
  for (const entry of entries) {
    const next = !entry.queue && !entry.button.hidden ? ++slot : 0
    entry.slot = next
    const label = next > 0 ? `F${next}` : ''
    if (entry.hotkey.textContent !== label) entry.hotkey.textContent = label
  }
}

function functionSlot(code: string): number | null {
  const match = /^F(\d+)$/.exec(code)
  if (!match) return null
  const slot = Number(match[1])
  return slot >= 1 ? slot : null
}

function paintTile(entry: OrderTile, count: number, progress: number, enabled: boolean, visible: boolean, armed = false) {
  entry.button.hidden = !visible
  const amount = Math.max(0, Math.min(1, progress))
  entry.ring.style.setProperty('--p', String(amount))
  entry.ring.classList.toggle('on', amount > 0)
  const marked = count > 1 || (count === 1 && amount <= 0)
  entry.badge.hidden = !marked
  entry.badge.textContent = marked ? String(count) : ''
  entry.button.classList.toggle('ready', enabled)
  entry.button.classList.toggle('live', count > 0 || progress > 0 || armed)
  entry.button.classList.toggle('armed', armed)
}

function jetApron(own: readonly UnitSnapshot[], training: readonly TrainJob[], airport: UnitSnapshot): number {
  const parked: { x: number; y: number; bay: number }[] = []
  for (const unit of own) {
    if (unit.health <= 0 || unit.typeId !== UnitTypeId.Jet || !unit.home || (unit.bay ?? -1) < 0) continue
    if (unit.home.x !== airport.tileX || unit.home.y !== airport.tileY) continue
    parked.push({ x: unit.home.x, y: unit.home.y, bay: unit.bay ?? -1 })
  }
  let queued = 0
  for (const job of training) if (job.typeId === UnitTypeId.Jet && job.yardId === airport.id) queued += 1
  return baysFree([{ x: airport.tileX, y: airport.tileY }], parked) - queued
}

function tallyJobs(jobs: readonly TrainJob[], yardId?: number): { count: Map<UnitTypeId, number>; progress: Map<UnitTypeId, number>; any: boolean } {
  const count = new Map<UnitTypeId, number>()
  const progress = new Map<UnitTypeId, number>()
  const heads = new Set<number>()
  let any = false
  for (const job of jobs) {
    if (yardId !== undefined && job.yardId !== yardId) continue
    any = true
    count.set(job.typeId, (count.get(job.typeId) ?? 0) + 1)
    if (heads.has(job.yardId)) continue
    heads.add(job.yardId)
    if (job.progress > (progress.get(job.typeId) ?? 0)) progress.set(job.typeId, job.progress)
  }
  return { count, progress, any }
}

function structureQueue(): Map<UnitTypeId, { count: number; progress: number }> {
  const queue = new Map<UnitTypeId, { count: number; progress: number }>()
  for (const unit of replica.units) {
    if (unit.ownerId !== replica.playerId || unit.health <= 0 || unit.progress >= 1) continue
    if (UNIT_TYPES[unit.typeId].topSpeed > 0) continue
    const site = queue.get(unit.typeId) ?? { count: 0, progress: 0 }
    site.count += 1
    if (unit.progress > site.progress) site.progress = unit.progress
    queue.set(unit.typeId, site)
  }
  return queue
}

function refuseOrder(id: UnitTypeId | null) {
  const price = id === null ? replica.cityBuildCost(player.aimedTile()) : UNIT_TYPES[id].cost
  sound.refused(price !== null && replica.credits < price)
}

function costLine(credits: number, supply: number): string {
  const price = credits > 0 ? credits.toLocaleString('en-US') : ''
  if (supply <= 0) return price
  return price ? `${price} · ${supply}` : String(supply)
}

function tileKind(id: UnitTypeId | null): 'structure' | 'vehicle' | 'air' | 'boat' {
  if (id === null) return 'structure'
  const type = UNIT_TYPES[id]
  if (type.topSpeed <= 0) return 'structure'
  if (type.locomotion === Locomotion.Plane || type.locomotion === Locomotion.Rotor) return 'air'
  if (type.locomotion === Locomotion.Hull) return 'boat'
  return 'vehicle'
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
    const drawn = replica.drawn()
    const shots = replica.takeShots()
    const hits = replica.takeHits()
    const selected = player.selected()
    sound.sync({
      units: drawn,
      shots,
      hits,
      cities: replica.cities,
      credits: replica.credits,
      playerId: replica.playerId,
      terrain: replica.world?.terrain ?? null,
      width: replica.world?.width ?? 0,
      selected: selected.map((unit) => unit.id),
      ear: view.ear(),
      dt: frameDt,
    })
    view.render(
      drawn,
      selected,
      shots,
      hits,
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
