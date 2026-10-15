import type { Faction } from '../shared/lobby.ts'
import { UNIT_TYPES, UnitTypeId } from '../shared/unit-types.ts'
import { BuildTab, focusLabel, HealthBand, PingState, TileBlock, TileKind, Trend, type HudModel, type HudTile, type QueueChip, type SelectedRow, type Selection } from './hud-model.ts'
import { closeMenu } from './menu.ts'
import { bindTrace, type TracePaint } from './trace-pie.ts'
import '@fontsource/saira-stencil-one/latin-400.css'
import './console.css'
import './hud.css'

export type HudActions = {
  armBuilding(typeId: UnitTypeId): void
  cancelBuild(typeId: UnitTypeId): void
  armCity(): void
  spawn(typeId: UnitTypeId): void
  cancelSpawn(typeId: UnitTypeId, yardId: number): void
  cancelQueued(typeId: UnitTypeId): void
  setCityFocus(step: number): void
  viewAs(playerId: number): void
  leave(): void
}

export type CreditReadout = { shown: number; trend: Trend }

const MARKUP = `
<header id="menubar">
  <p class="hud-logo">MINI ALERT</p>
  <p id="battle"></p>
  <div id="stats">
    <p class="readout"><span class="readout-label">Credits</span><span class="readout-value"><span id="credits"></span><span class="trend" aria-hidden="true"></span></span></p>
    <p class="readout"><span class="readout-label">Units</span><span class="readout-value"><span id="forces"></span><span> / </span><span class="cap"></span></span></p>
    <p class="readout pop"><span class="readout-label">Pop</span><span class="readout-value" id="population"></span></p>
    <p class="readout"><span class="readout-label">Cities</span><span class="readout-value" id="cities"></span></p>
  </div>
  <div class="hud-controls">
    <p class="ping" title="Round trip to the server"><span id="ping"></span><span class="ping-dot" aria-hidden="true">◉</span></p>
    <div id="menu" class="menu">
      <button type="button" class="plate" data-open="menu">Menu</button>
      <div class="dropdown">
        <div class="menu-group" role="group" aria-label="Settings">
          <button type="button" data-toggle="music" aria-pressed="true">Music <span class="mark">On</span></button>
          <div class="volume">
            <label for="music-volume">Music volume</label>
            <output class="mark" for="music-volume"></output>
            <input type="range" id="music-volume" data-volume="musicVolume" min="0" max="100" step="5" value="40">
          </div>
          <button type="button" data-toggle="sounds" aria-pressed="true">Sounds <span class="mark">On</span></button>
          <div class="volume">
            <label for="sounds-volume">Sounds volume</label>
            <output class="mark" for="sounds-volume"></output>
            <input type="range" id="sounds-volume" data-volume="soundsVolume" min="0" max="100" step="5" value="100">
          </div>
          <button type="button" data-toggle aria-pressed="true">Input <span class="mark">On</span></button>
        </div>
        <div class="menu-group">
          <button type="button" data-open="changelog">Changelog</button>
          <button type="button" data-open="fullscreen">Full screen <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg></button>
          <button type="button" class="danger" data-dismiss>Surrender</button>
        </div>
      </div>
    </div>
    <button type="button" class="plate" data-open="help" aria-label="Help" title="Help">?</button>
  </div>
</header>
<div id="sheet" hidden>
  <div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <header>
      <h2 id="sheet-title"></h2>
      <button type="button" class="plate" id="sheet-close">Close</button>
    </header>
    <div id="sheet-body"></div>
  </div>
</div>
<aside id="side">
  <section class="hud-panel" id="radar-panel" aria-labelledby="radar-title">
    <header class="panel-head"><span class="panel-index" aria-hidden="true">01</span><h2 id="radar-title">Radar</h2></header>
    <div class="radar-frame">
      <div id="minimap">
        <canvas id="minimap-map"></canvas>
        <canvas id="minimap-marks"></canvas>
      </div>
      <span class="radar-ring" aria-hidden="true"></span>
    </div>
  </section>
  <section class="hud-panel" id="build-panel" aria-labelledby="build-title">
    <header class="panel-head"><span class="panel-index" aria-hidden="true">02</span><h2 id="build-title">Build</h2></header>
    <div class="build-tabs" role="tablist" aria-label="Build category" hidden></div>
    <div class="panel-scroll" id="build-scroll">
      <div id="orders" hidden></div>
      <div id="queue" role="group" aria-labelledby="queue-label" hidden>
        <p id="queue-label">Queue</p>
        <div class="chips"></div>
      </div>
    </div>
  </section>
  <section class="hud-panel" id="vision-panel" aria-labelledby="vision-title" hidden>
    <header class="panel-head"><span class="panel-index" aria-hidden="true">02</span><h2 id="vision-title">Vision</h2></header>
    <div class="panel-scroll" id="plates"></div>
  </section>
</aside>
<div id="legend" hidden></div>
<section class="hud-panel" id="selected" aria-labelledby="selected-title" hidden>
  <header class="panel-head"><span class="panel-index" aria-hidden="true">03</span><h2 id="selected-title">Selected</h2><span id="group" hidden></span></header>
  <div id="selected-rows"></div>
  <div id="city-focus" hidden>
    <p id="city-focus-name">City hall</p>
    <p id="city-focus-label">Balanced</p>
    <input id="city-focus-range" type="range" min="-2" max="2" step="1" value="0" aria-label="City focus">
  </div>
</section>
<div id="outcome" hidden>
  <div class="outcome-card" role="dialog" aria-modal="true" aria-labelledby="outcome-title">
    <h2 id="outcome-title"></h2>
    <p id="outcome-text"></p>
    <button type="button" class="plate" id="outcome-close">Close</button>
  </div>
</div>
<div id="trace" hidden>
  <div id="trace-pie"><span id="trace-hole"></span></div>
  <div id="trace-readout">
    <ul id="trace-list"></ul>
    <p id="trace-total"></p>
  </div>
</div>
`

type TileNode = {
  tile: HudTile
  button: HTMLButtonElement
  pie: HTMLElement
  badge: HTMLElement
  hotkey: HTMLElement
  cost: HTMLElement
  state: HTMLElement
}

type ChipNode = {
  chip: QueueChip
  button: HTMLButtonElement
  count: HTMLElement
  pie: HTMLElement
}

type RowNode = {
  row: HTMLElement
  name: HTMLElement
  state: HTMLElement
  bar: HTMLElement
}

const TABS: readonly (readonly [BuildTab, string])[] = [
  [BuildTab.Base, 'Base'],
  [BuildTab.Land, 'Land'],
  [BuildTab.Air, 'Air'],
  [BuildTab.Sea, 'Sea'],
]

const BLOCK_TEXT: Record<TileBlock, string> = {
  [TileBlock.NeedsFactory]: 'Needs a factory',
  [TileBlock.NeedsPopulation]: 'Needs population',
  [TileBlock.SelectFactory]: 'Select a factory',
  [TileBlock.SelectAirport]: 'Select an airport',
  [TileBlock.SelectHelipad]: 'Select a helipad',
  [TileBlock.SelectShipyard]: 'Select a shipyard',
  [TileBlock.NotFinished]: 'Not finished',
  [TileBlock.ApronFull]: 'Apron full',
}

const BAND_CLASS: Record<HealthBand, string> = {
  [HealthBand.Healthy]: 'bar healthy',
  [HealthBand.Damaged]: 'bar damaged',
  [HealthBand.Critical]: 'bar critical',
}

const NO_MATCH: HudModel = {
  army: 0,
  population: 0,
  cities: 0,
  over: false,
  ping: { state: PingState.None },
  tiles: [],
  tab: null,
  queue: [],
  selection: { ids: [], hall: null },
  rows: [],
  group: null,
  hall: null,
}

const NO_CREDITS: CreditReadout = { shown: 0, trend: Trend.Steady }

const NO_TRACE: TracePaint = { samples: [], budget: 0 }

const BALANCED = { focus: 0, label: focusLabel(0) }

export class HudView {
  private readonly battle: HTMLElement
  private readonly credits: HTMLElement
  private readonly trend: HTMLElement
  private readonly forces: HTMLElement
  private readonly cap: HTMLElement
  private readonly population: HTMLElement
  private readonly cities: HTMLElement
  private readonly ping: HTMLElement
  private readonly menu: HTMLElement
  private readonly tablist: HTMLElement
  private readonly tabs: { tab: BuildTab; button: HTMLButtonElement }[]
  private readonly orders: HTMLElement
  private readonly queue: HTMLElement
  private readonly chipRow: HTMLElement
  private readonly selectedPanel: HTMLElement
  private readonly group: HTMLElement
  private readonly rowList: HTMLElement
  private readonly cityFocus: HTMLElement
  private readonly focusLabel: HTMLElement
  private readonly focusRange: HTMLInputElement
  private readonly build: HTMLElement
  private readonly vision: HTMLElement
  private readonly plates: HTMLElement
  private readonly leave: HTMLButtonElement
  private readonly legend: HTMLElement
  private readonly outcome: HTMLElement
  private readonly outcomeTitle: HTMLElement
  private readonly outcomeText: HTMLElement
  private readonly trace: ReturnType<typeof bindTrace>
  private readonly tiles: TileNode[] = []
  private readonly chips = new Map<UnitTypeId, ChipNode>()
  private readonly rows = new Map<UnitTypeId, RowNode>()
  private selectionTab: BuildTab | null = null
  private selection: Selection = NO_MATCH.selection
  private clicked: { tab: BuildTab; selection: Selection } | null = null
  private open: BuildTab | null = null

  constructor(
    root: HTMLElement,
    private readonly actions: HudActions,
  ) {
    root.innerHTML = MARKUP
    const find = <T extends HTMLElement = HTMLElement>(selector: string): T => {
      const found = root.querySelector<T>(selector)
      if (!found) throw new Error(`missing ${selector}`)
      return found
    }
    this.battle = find('#battle')
    this.credits = find('#credits')
    this.trend = find('#stats .trend')
    this.forces = find('#forces')
    this.cap = find('#stats .cap')
    this.population = find('#population')
    this.cities = find('#cities')
    this.ping = find('#ping')
    this.menu = find('#menu')
    this.tablist = find('.build-tabs')
    this.tabs = TABS.map(([tab, label]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'plate'
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', 'false')
      button.textContent = label
      button.addEventListener('click', () => {
        this.clicked = { tab, selection: this.selection }
        this.showTab()
      })
      this.tablist.append(button)
      return { tab, button }
    })
    this.orders = find('#orders')
    this.queue = find('#queue')
    this.chipRow = find('#queue .chips')
    this.selectedPanel = find('#selected')
    this.group = find('#group')
    this.rowList = find('#selected-rows')
    this.cityFocus = find('#city-focus')
    this.focusLabel = find('#city-focus-label')
    this.focusRange = find<HTMLInputElement>('#city-focus-range')
    this.focusRange.addEventListener('input', () => {
      const step = Number(this.focusRange.value)
      this.focusLabel.textContent = focusLabel(step)
      this.actions.setCityFocus(step)
    })
    this.build = find('#build-panel')
    this.vision = find('#vision-panel')
    this.plates = find('#plates')
    this.leave = document.createElement('button')
    this.leave.type = 'button'
    this.leave.className = 'plate'
    this.leave.textContent = 'Leave'
    this.leave.addEventListener('click', () => this.actions.leave())
    this.legend = find('#legend')
    this.outcome = find('#outcome')
    this.outcomeTitle = find('#outcome-title')
    this.outcomeText = find('#outcome-text')
    find('#outcome-close').addEventListener('click', () => {
      this.outcome.hidden = true
    })
    this.outcome.addEventListener('click', (event) => {
      if (event.target === this.outcome) this.outcome.hidden = true
    })
    this.trace = bindTrace(find('#trace'))
    this.clear()
  }

  paint(model: HudModel, credits: CreditReadout) {
    setText(this.credits, Math.round(credits.shown).toLocaleString('en-US'))
    this.credits.classList.toggle('up', credits.trend === Trend.Up)
    this.credits.classList.toggle('down', credits.trend === Trend.Down)
    setText(this.trend, credits.trend === Trend.Up ? '▲' : credits.trend === Trend.Down ? '▼' : '')
    setText(this.forces, String(model.army))
    this.forces.classList.toggle('over', model.over)
    setText(this.cap, String(model.population))
    setText(this.population, String(model.population))
    setText(this.cities, String(model.cities))
    const ping = model.ping
    setText(this.ping, ping.state === PingState.None ? '–' : `${ping.ms} ms`)
    this.ping.classList.toggle('slow', ping.state === PingState.Slow || ping.state === PingState.Bad)
    this.ping.classList.toggle('bad', ping.state === PingState.Bad)
    this.paintSelected(model.rows, model.group, model.hall)
    for (let i = 0; i < model.tiles.length; i++) {
      const tile = model.tiles[i]
      paintTile(this.tiles[i] ?? this.createTile(tile), tile)
    }
    for (const node of this.tiles.splice(model.tiles.length)) node.button.remove()
    this.paintQueue(model.queue)
    if (this.clicked && !sameSelection(this.clicked.selection, model.selection)) this.clicked = null
    this.selectionTab = model.tab
    this.selection = model.selection
    this.showTab()
  }

  setBattle(gameId: number | null) {
    setText(this.battle, gameId === null ? '' : `Battle #${gameId}`)
  }

  setFactions(factions: readonly Faction[], spectating: boolean, viewedId: number | null) {
    this.build.hidden = spectating
    this.vision.hidden = !spectating
    this.plates.replaceChildren()
    if (spectating) {
      for (const faction of factions) {
        const plate = document.createElement('button')
        plate.type = 'button'
        plate.className = 'faction-plate'
        plate.setAttribute('aria-pressed', String(faction.playerId === viewedId))
        plate.append(...factionMark(faction))
        plate.addEventListener('click', () => this.actions.viewAs(faction.playerId))
        this.plates.append(plate)
      }
      this.plates.append(this.leave)
    }
    this.legend.hidden = factions.length === 0
    this.legend.replaceChildren()
    for (const faction of factions) {
      const row = document.createElement('div')
      row.className = 'legend-row'
      row.classList.toggle('defeated', faction.defeated)
      row.append(...factionMark(faction))
      if (faction.defeated) {
        const tag = document.createElement('span')
        tag.className = 'tag'
        tag.textContent = 'defeated'
        row.append(tag)
      }
      this.legend.append(row)
    }
  }

  setOutcome(outcome: { title: string; text: string } | null) {
    setText(this.outcomeTitle, outcome?.title ?? '')
    setText(this.outcomeText, outcome?.text ?? '')
    this.outcome.hidden = outcome === null
  }

  paintTrace(frame: TracePaint) {
    this.trace.paint(frame)
  }

  clear() {
    this.clicked = null
    this.paint(NO_MATCH, NO_CREDITS)
    this.setBattle(null)
    this.setFactions([], false, null)
    this.setOutcome(null)
    this.paintTrace(NO_TRACE)
    closeMenu(this.menu)
  }

  /** Presses the tile labelled F<slot>; false when no shown tile carries that label. */
  pressSlot(slot: number, shift: boolean): boolean {
    const node = this.tiles.find((entry) => entry.tile.tab === this.open && entry.tile.slot === slot)
    if (!node) return false
    if (shift) this.remove(node.tile)
    else if (node.tile.block === null) this.add(node.tile)
    return true
  }

  private showTab() {
    const open = this.selectionTab === null ? null : (this.clicked?.tab ?? this.selectionTab)
    this.open = open
    this.tablist.hidden = open === null
    this.orders.hidden = open === null
    this.queue.hidden = open === null || this.chipRow.childElementCount === 0
    for (const { tab, button } of this.tabs) {
      const selected = String(tab === open)
      if (button.getAttribute('aria-selected') !== selected) button.setAttribute('aria-selected', selected)
    }
    for (const node of this.tiles) node.button.hidden = node.tile.tab !== open
  }

  private paintQueue(queue: readonly QueueChip[]) {
    const buttons = queue.map((chip) => {
      const node = this.chips.get(chip.type) ?? this.createChip(chip)
      paintChip(node, chip)
      return node.button
    })
    arrange(this.chipRow, buttons)
  }

  private paintSelected(rows: readonly SelectedRow[], group: number | null, hall: HudModel['hall']) {
    this.selectedPanel.hidden = rows.length === 0 && hall === null
    this.group.hidden = group === null
    setText(this.group, group === null ? '' : `Group ${group}`)
    this.paintRows(rows)
    this.cityFocus.hidden = hall === null
    if (document.activeElement !== this.focusRange) {
      const { focus, label } = hall ?? BALANCED
      const value = String(focus)
      if (this.focusRange.value !== value) this.focusRange.value = value
      setText(this.focusLabel, label)
    }
  }

  private paintRows(rows: readonly SelectedRow[]) {
    const nodes = rows.map((row) => {
      const node = this.rows.get(row.type) ?? this.createRow(row.type)
      paintRow(node, row)
      return node.row
    })
    arrange(this.rowList, nodes)
  }

  private drop(chip: QueueChip) {
    if (chip.kind === TileKind.Structure) this.actions.cancelBuild(chip.type)
    else this.actions.cancelQueued(chip.type)
  }

  private add(tile: HudTile) {
    if (tile.kind === TileKind.City) this.actions.armCity()
    else if (tile.kind === TileKind.Structure) this.actions.armBuilding(tile.type)
    else if (tile.kind === TileKind.Train) this.actions.spawn(tile.type)
  }

  private remove(tile: HudTile) {
    if (tile.kind === TileKind.Structure) this.actions.cancelBuild(tile.type)
    else if (tile.kind === TileKind.Train && tile.yard !== null) this.actions.cancelSpawn(tile.type, tile.yard)
  }

  private createTile(tile: HudTile): TileNode {
    const name = tile.kind === TileKind.City ? 'Building' : UNIT_TYPES[tile.type].label
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tile'
    button.title = name
    const pie = document.createElement('span')
    pie.className = 'pie'
    const label = document.createElement('span')
    label.className = 'name'
    label.textContent = name
    const cost = document.createElement('span')
    cost.className = 'cost'
    const state = document.createElement('span')
    state.className = 'state'
    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.hidden = true
    const hotkey = document.createElement('span')
    hotkey.className = 'hotkey'
    button.append(pie, label, cost, state, badge, hotkey)
    const node: TileNode = { tile, button, pie, badge, hotkey, cost, state }
    button.addEventListener('click', (event) => {
      if (event.shiftKey) this.remove(node.tile)
      else if (node.tile.block === null) this.add(node.tile)
    })
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.remove(node.tile)
    })
    this.orders.append(button)
    this.tiles.push(node)
    return node
  }

  private createChip(chip: QueueChip): ChipNode {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'chip'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = UNIT_TYPES[chip.type].label
    const count = document.createElement('span')
    count.className = 'count'
    const pie = document.createElement('span')
    pie.className = 'pie'
    button.append(name, count, pie)
    const node: ChipNode = { chip, button, count, pie }
    button.addEventListener('click', () => this.drop(node.chip))
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      this.drop(node.chip)
    })
    this.chips.set(chip.type, node)
    return node
  }

  private createRow(type: UnitTypeId): RowNode {
    const row = document.createElement('div')
    row.className = 'unit-row'
    const name = document.createElement('span')
    name.className = 'name'
    const state = document.createElement('span')
    state.className = 'state'
    const health = document.createElement('span')
    health.className = 'health'
    health.setAttribute('aria-hidden', 'true')
    const bar = document.createElement('span')
    health.append(bar)
    row.append(name, state, health)
    const node: RowNode = { row, name, state, bar }
    this.rows.set(type, node)
    return node
  }
}

function paintTile(node: TileNode, tile: HudTile) {
  node.tile = tile
  node.pie.style.setProperty('--p', String(fraction(tile.progress)))
  node.badge.hidden = !tile.badge
  setText(node.badge, tile.badge ? String(tile.count) : '')
  node.button.classList.toggle('ready', tile.block === null)
  node.button.classList.toggle('armed', tile.armed)
  setText(node.cost, tile.cost)
  setText(node.state, stateLine(tile))
  setText(node.hotkey, `F${tile.slot}`)
}

function stateLine(tile: HudTile): string {
  if (tile.block !== null) return BLOCK_TEXT[tile.block]
  if (tile.armed) return 'Ready · place'
  if (tile.progress > 0) return percent(tile.progress)
  return ''
}

function paintChip(node: ChipNode, chip: QueueChip) {
  node.chip = chip
  setText(node.count, chip.count > 1 ? `×${chip.count}` : '')
  node.pie.style.setProperty('--p', String(fraction(chip.progress)))
}

function paintRow(node: RowNode, row: SelectedRow) {
  const label = UNIT_TYPES[row.type].label
  setText(node.name, row.count > 1 ? `${label} ×${row.count}` : label)
  setText(node.state, row.progress === null ? '' : percent(row.progress))
  node.bar.style.setProperty('--h', String(fraction(row.health)))
  if (node.bar.className !== BAND_CLASS[row.band]) node.bar.className = BAND_CLASS[row.band]
}

function arrange(parent: HTMLElement, children: readonly HTMLElement[]) {
  const shown = parent.children
  if (children.length !== shown.length || children.some((child, index) => shown[index] !== child)) parent.replaceChildren(...children)
}

function fraction(progress: number): number {
  return Math.max(0, Math.min(1, progress))
}

function percent(progress: number): string {
  return `${Math.floor(fraction(progress) * 100)}%`
}

function sameSelection(a: Selection, b: Selection): boolean {
  return a.hall === b.hall && a.ids.length === b.ids.length && a.ids.every((id, index) => b.ids[index] === id)
}

function factionMark(faction: Faction): [HTMLElement, HTMLElement] {
  const swatch = document.createElement('i')
  swatch.className = 'swatch'
  swatch.style.background = cssColor(faction.color)
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = faction.name
  return [swatch, name]
}

function setText(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text
}

function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}
