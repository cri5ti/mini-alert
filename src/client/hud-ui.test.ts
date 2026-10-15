// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { version } from '../../package.json'
import { UnitTypeId } from '../shared/unit-types.ts'
import { armedHud, armyHud, baseHud, factoryHud, hallHud, spectateHud, strainedHud, traceFrame, type HudFixture } from './hud-fixtures.ts'
import { hudModel, Trend, type HudInput } from './hud-model.ts'
import { HudView, type CreditReadout, type HudActions } from './hud-ui.ts'
import { bindMenu } from './menu.ts'

const STEADY: CreditReadout = { shown: 0, trend: Trend.Steady }

function spies() {
  return {
    armBuilding: vi.fn<HudActions['armBuilding']>(),
    cancelBuild: vi.fn<HudActions['cancelBuild']>(),
    armCity: vi.fn<HudActions['armCity']>(),
    spawn: vi.fn<HudActions['spawn']>(),
    cancelSpawn: vi.fn<HudActions['cancelSpawn']>(),
    cancelQueued: vi.fn<HudActions['cancelQueued']>(),
    setCityFocus: vi.fn<HudActions['setCityFocus']>(),
    viewAs: vi.fn<HudActions['viewAs']>(),
    leave: vi.fn<HudActions['leave']>(),
  } satisfies HudActions
}

function mount() {
  const root = document.createElement('div')
  root.id = 'hud'
  document.body.replaceChildren(root)
  const actions = spies()
  const view = new HudView(root, actions)
  return { root, view, actions }
}

function paint(view: HudView, input: HudInput, credits = STEADY) {
  view.paint(hudModel(input), credits)
}

function fired(actions: ReturnType<typeof spies>): [string, unknown[]][] {
  return Object.entries(actions)
    .flatMap(([name, spy]) => spy.mock.calls.map((args, index) => ({ order: spy.mock.invocationCallOrder[index], call: [name, args] as [string, unknown[]] })))
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.call)
}

function one<T extends Element = HTMLElement>(scope: ParentNode, selector: string): T {
  const found = scope.querySelector<T>(selector)
  if (!found) throw new Error(`no ${selector}`)
  return found
}

function all<T extends Element = HTMLElement>(scope: ParentNode, selector: string): T[] {
  return [...scope.querySelectorAll<T>(selector)]
}

function shown(element: Element): boolean {
  return element.closest('[hidden]') === null
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = all<HTMLButtonElement>(scope, 'button').find((element) => element.textContent === label)
  if (!found) throw new Error(`no ${label} button`)
  return found
}

function tiles(root: ParentNode): HTMLButtonElement[] {
  return all<HTMLButtonElement>(root, '.tile').filter(shown)
}

function tile(root: ParentNode, name: string): HTMLButtonElement {
  const found = tiles(root).find((entry) => one(entry, '.name').textContent === name)
  if (!found) throw new Error(`no ${name} tile`)
  return found
}

function face(entry: HTMLElement) {
  const badge = one(entry, '.badge')
  return {
    name: one(entry, '.name').textContent,
    cost: one(entry, '.cost').textContent,
    state: one(entry, '.state').textContent,
    badge: shown(badge) ? badge.textContent : null,
    hotkey: one(entry, '.hotkey').textContent,
  }
}

function tabs(root: ParentNode): HTMLButtonElement[] {
  return all<HTMLButtonElement>(one(root, '[role="tablist"]'), '[role="tab"]')
}

function openTab(root: ParentNode): string | null {
  const open = tabs(root).filter((entry) => shown(entry) && entry.getAttribute('aria-selected') === 'true')
  return open.length === 1 ? open[0].textContent : null
}

function chips(root: ParentNode): HTMLButtonElement[] {
  return all<HTMLButtonElement>(root, '#queue .chip').filter(shown)
}

function chip(root: ParentNode, name: string): HTMLButtonElement {
  const found = chips(root).find((entry) => one(entry, '.name').textContent === name)
  if (!found) throw new Error(`no ${name} chip`)
  return found
}

function panel(root: ParentNode, heading: string): HTMLElement {
  const found = all(root, 'section').find((entry) => one(entry, 'h2').textContent === heading)
  if (!found) throw new Error(`no ${heading} panel`)
  return found
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

function classes(element: Element): string[] {
  return [...element.classList]
}

function shiftClick(element: Element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
}

function rightClick(element: Element): boolean {
  return element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
}

function escape() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

describe('hud readouts', () => {
  it('groups the credits en-US and marks their trend', () => {
    const { root, view } = mount()
    const credits = one(root, '#credits')
    paint(view, baseHud().input, { shown: 12_345.6, trend: Trend.Up })
    expect([credits.textContent, classes(credits)]).toEqual(['12,346', ['up']])
    paint(view, baseHud().input, { shown: 999, trend: Trend.Down })
    expect([credits.textContent, classes(credits)]).toEqual(['999', ['down']])
    paint(view, baseHud().input, { shown: 999, trend: Trend.Steady })
    expect(classes(credits)).toEqual([])
  })

  it('counts units, population and cities, and marks the units over the population', () => {
    const { root, view } = mount()
    const read = () => ['#forces', '#population', '#cities'].map((id) => one(root, id).textContent)
    paint(view, baseHud().input)
    expect(read()).toEqual(['23', '42', '2'])
    expect(classes(one(root, '#forces'))).toEqual([])
    paint(view, { ...baseHud().input, cities: [], layouts: [] })
    expect(read()).toEqual(['23', '0', '0'])
    expect(classes(one(root, '#forces'))).toEqual(['over'])
  })

  it('reads the ping as – or N ms, slow above 150 ms and bad above 300 ms', () => {
    const { root, view } = mount()
    const ping = one(root, '#ping')
    const at = (rtt: number | null) => {
      paint(view, { ...baseHud().input, rtt })
      return [ping.textContent, classes(ping)]
    }
    expect(at(null)).toEqual(['–', []])
    expect(at(48)).toEqual(['48 ms', []])
    expect(at(210)).toEqual(['210 ms', ['slow']])
    expect(at(420)).toEqual(['420 ms', ['slow', 'bad']])
  })
})

describe('hud top bar', () => {
  it('holds the logotype, the battle, the labelled readouts, the ping, Menu and Help', () => {
    const { root, view } = mount()
    const { input, credits } = baseHud()
    view.setBattle(12)
    paint(view, input, credits)
    const bar = one(root, '#menubar')
    expect([one(bar, '.hud-logo').textContent, one(bar, '#battle').textContent]).toEqual(['MINI ALERT', 'Battle #12'])
    expect(all(bar, '.readout').map((entry) => [one(entry, '.readout-label').textContent, one(entry, '.readout-value').textContent])).toEqual([
      ['Credits', '12,450'],
      ['Units', '23 / 42'],
      ['Pop', '42'],
      ['Cities', '2'],
    ])
    expect([one(bar, '.ping-dot').textContent, one(bar, '#ping').textContent]).toEqual(['◉', '48 ms'])
    expect(one(bar, '[data-open="menu"]').textContent).toBe('Menu')
    expect(one(bar, '[data-open="help"]').getAttribute('aria-label')).toBe('Help')
  })

  it('marks rising credits with ▲ and falling credits with ▼', () => {
    const { root, view } = mount()
    const trend = (readout: CreditReadout) => {
      paint(view, baseHud().input, readout)
      return one(root, '#stats .trend').textContent
    }
    expect([trend({ shown: 10, trend: Trend.Up }), trend({ shown: 10, trend: Trend.Down }), trend(STEADY)]).toEqual(['▲', '▼', ''])
  })

  it('drops down Music, Sounds and Input, then Changelog, Full screen and Surrender', () => {
    const { root } = mount()
    const items = all(one(root, '#menu .dropdown'), 'button').map((entry) => entry.textContent?.trim())
    expect(items).toEqual(['Music On', 'Sounds On', 'Input On', 'Changelog', 'Full screen', 'Surrender'])
  })
})

describe('hud sidebar', () => {
  it('holds the minimap in panel 01 Radar and the tiles in panel 02 Build', () => {
    const { root, view } = mount()
    paint(view, baseHud().input)
    const radar = panel(root, 'Radar')
    const build = panel(root, 'Build')
    const index = (entry: HTMLElement) => {
      const tag = one(entry, '.panel-index')
      return [tag.textContent, tag.getAttribute('aria-hidden')]
    }
    expect([index(radar), index(build)]).toEqual([
      ['01', 'true'],
      ['02', 'true'],
    ])
    expect(radar.contains(one(root, '#minimap'))).toBe(true)
    expect(tiles(build).map((entry) => face(entry).name)).toEqual(['Factory', 'Turret', 'Airport', 'Helipad', 'Shipyard', 'Building'])
    expect(tiles(root)).toEqual(tiles(build))
  })
})

describe('hud tiles', () => {
  it('show each tile of the open tab with its name, cost line, state line, badge and F-label', () => {
    const { root, view } = mount()
    paint(view, factoryHud().input)
    expect(tiles(root).map(face)).toEqual([
      { name: 'Scout', cost: '200 · 1', state: '', badge: '1', hotkey: 'F1' },
      { name: 'Med Tank', cost: '800 · 2', state: '40%', badge: '2', hotkey: 'F2' },
      { name: 'Heavy Tank', cost: '2,000 · 4', state: '', badge: null, hotkey: 'F3' },
      { name: 'Artillery', cost: '1,500 · 3', state: '', badge: null, hotkey: 'F4' },
    ])
    paint(view, armedHud().input)
    const armed = face(tile(root, 'Turret')).state
    paint(view, strainedHud().input)
    expect([armed, face(tile(root, 'Turret')).state]).toEqual(['Ready · place', 'Needs population'])
  })

  it('fire the add action on a click only while ready', () => {
    const { root, view, actions } = mount()
    paint(view, baseHud().input)
    tile(root, 'Factory').click()
    tile(root, 'Building').click()
    paint(view, factoryHud().input)
    tile(root, 'Scout').click()
    paint(view, strainedHud().input)
    expect(classes(tile(root, 'Turret'))).not.toContain('ready')
    tile(root, 'Turret').click()
    expect(fired(actions)).toEqual([
      ['armBuilding', [UnitTypeId.Factory]],
      ['armCity', []],
      ['spawn', [UnitTypeId.Scout]],
    ])
  })

  it('fire the remove action on Shift-click and right-click, ready or not', () => {
    const { root, view, actions } = mount()
    paint(view, baseHud().input)
    shiftClick(tile(root, 'Factory'))
    paint(view, strainedHud().input)
    shiftClick(tile(root, 'Turret'))
    expect(rightClick(tile(root, 'Turret'))).toBe(false)
    const capped = factoryHud().input
    paint(view, { ...capped, cities: [], layouts: [] })
    shiftClick(tile(root, 'Med Tank'))
    rightClick(tile(root, 'Heavy Tank'))
    const yard = capped.yard?.id
    expect(fired(actions)).toEqual([
      ['cancelBuild', [UnitTypeId.Factory]],
      ['cancelBuild', [UnitTypeId.Turret]],
      ['cancelBuild', [UnitTypeId.Turret]],
      ['cancelSpawn', [UnitTypeId.MedTank, yard]],
      ['cancelSpawn', [UnitTypeId.HeavyTank, yard]],
    ])
  })

  it('fire nothing on Shift-click or right-click of a train tile whose yard is not selected', () => {
    const { root, view, actions } = mount()
    paint(view, factoryHud().input)
    button(root, 'Air').click()
    shiftClick(tile(root, 'Jet'))
    expect(rightClick(tile(root, 'Gunship'))).toBe(false)
    expect(view.pressSlot(1, true)).toBe(true)
    expect(fired(actions)).toEqual([])
  })

  it('fill the bar of a tile by its progress, and mark ready only a tile nothing blocks', () => {
    const { root, view } = mount()
    const bar = (name: string) => one(tile(root, name), '.pie').style.getPropertyValue('--p')
    paint(view, factoryHud().input)
    expect([bar('Med Tank'), bar('Heavy Tank')]).toEqual(['0.4', '0'])
    expect(classes(tile(root, 'Heavy Tank'))).toEqual(['tile', 'ready'])
    paint(view, strainedHud().input)
    expect(classes(tile(root, 'Turret'))).toEqual(['tile'])
  })

  it('keep their nodes when the same model is painted twice', () => {
    const { root, view } = mount()
    paint(view, factoryHud().input)
    const first = all(root, '.tile')
    paint(view, factoryHud().input)
    const second = all(root, '.tile')
    expect(second).toHaveLength(first.length)
    expect(second.every((entry, index) => entry === first[index])).toBe(true)
  })
})

describe('hud build tabs', () => {
  it('sit in a tablist labelled Build category, opening the tab of the selected yard and Base otherwise', () => {
    const { root, view } = mount()
    paint(view, baseHud().input)
    expect(one(root, '[role="tablist"]').getAttribute('aria-label')).toBe('Build category')
    expect(tabs(root).map((entry) => [entry.textContent, entry.getAttribute('aria-selected')])).toEqual([
      ['Base', 'true'],
      ['Land', 'false'],
      ['Air', 'false'],
      ['Sea', 'false'],
    ])
    const opened = (input: HudInput) => {
      paint(view, input)
      return [openTab(root), tiles(root).map((entry) => face(entry).name)]
    }
    expect([opened(factoryHud().input), opened(baseHud().input)]).toEqual([
      ['Land', ['Scout', 'Med Tank', 'Heavy Tank', 'Artillery']],
      ['Base', ['Factory', 'Turret', 'Airport', 'Helipad', 'Shipyard', 'Building']],
    ])
  })

  it('keep a clicked tab through repaints of the same selection, and drop it when another selection replaces it', () => {
    const { root, view } = mount()
    const army = armyHud().input
    const tanks = { ...army, selected: [4, 5] }
    paint(view, tanks)
    button(root, 'Air').click()
    expect([openTab(root), tiles(root).map((entry) => face(entry).name)]).toEqual(['Air', ['Jet', 'Gunship']])
    paint(view, { ...army, selected: [4, 5] })
    expect(openTab(root)).toBe('Air')
    paint(view, { ...army, selected: [7, 8] })
    expect(openTab(root)).toBe('Base')
    paint(view, tanks)
    expect(openTab(root)).toBe('Base')
    const idle = { ...army, selected: [] }
    paint(view, idle)
    button(root, 'Sea').click()
    paint(view, { ...idle, hall: 0 })
    expect(openTab(root)).toBe('Base')
    paint(view, idle)
    expect(openTab(root)).toBe('Base')
  })
})

describe('hud queue', () => {
  it('shows a chip per type in production, sites first, with ×count above 1 and a progress underline', () => {
    const { root, view } = mount()
    const line = () => chips(root).map((entry) => [one(entry, '.name').textContent, one(entry, '.count').textContent, one(entry, '.pie').style.getPropertyValue('--p')])
    paint(view, factoryHud().input)
    expect(one(root, '#queue-label').textContent).toBe('Queue')
    expect(line()).toEqual([
      ['Scout', '', '0'],
      ['Med Tank', '×2', '0.4'],
      ['Jet', '', '0.6'],
    ])
    paint(view, strainedHud().input)
    expect(line().map(([name]) => name)).toEqual(['Factory', 'Turret', 'Airport', 'Helipad', 'Shipyard', 'Scout', 'Med Tank', 'Heavy Tank', 'Artillery', 'Jet', 'Gunship', 'Cruiser'])
  })

  it('fires cancelBuild for a structure chip and cancelQueued for a unit chip on a click, Shift-click or right-click', () => {
    const { root, view, actions } = mount()
    paint(view, strainedHud().input)
    chip(root, 'Turret').click()
    shiftClick(chip(root, 'Scout'))
    expect(rightClick(chip(root, 'Cruiser'))).toBe(false)
    expect(fired(actions)).toEqual([
      ['cancelBuild', [UnitTypeId.Turret]],
      ['cancelQueued', [UnitTypeId.Scout]],
      ['cancelQueued', [UnitTypeId.Cruiser]],
    ])
  })

  it('hides while nothing is in production', () => {
    const { root, view } = mount()
    const queue = one(root, '#queue')
    paint(view, factoryHud().input)
    expect(shown(queue)).toBe(true)
    paint(view, baseHud().input)
    expect([shown(queue), chips(root)]).toEqual([false, []])
  })

  it('keeps its chip nodes when the same model is painted twice', () => {
    const { root, view } = mount()
    paint(view, strainedHud().input)
    const first = chips(root)
    paint(view, strainedHud().input)
    const second = chips(root)
    expect(second).toHaveLength(12)
    expect(second.every((entry, index) => entry === first[index])).toBe(true)
  })
})

describe('hud F-slots', () => {
  it('press the tile carrying that F-label, and drop instead with Shift', () => {
    const { root, view, actions } = mount()
    paint(view, baseHud().input)
    const labelled = tiles(root).find((entry) => face(entry).hotkey === 'F2')
    expect(labelled && face(labelled).name).toBe('Turret')
    expect(view.pressSlot(2, false)).toBe(true)
    expect(view.pressSlot(2, true)).toBe(true)
    expect(fired(actions)).toEqual([
      ['armBuilding', [UnitTypeId.Turret]],
      ['cancelBuild', [UnitTypeId.Turret]],
    ])
  })

  it('ignore the press on a tile that is not ready', () => {
    const { view, actions } = mount()
    paint(view, strainedHud().input)
    expect(view.pressSlot(1, false)).toBe(true)
    expect(fired(actions)).toEqual([])
  })

  it('follow the open tab', () => {
    const { root, view, actions } = mount()
    paint(view, factoryHud().input)
    view.pressSlot(1, false)
    button(root, 'Base').click()
    expect(face(tiles(root)[0])).toMatchObject({ name: 'Factory', hotkey: 'F1' })
    view.pressSlot(1, false)
    button(root, 'Sea').click()
    expect([view.pressSlot(1, false), view.pressSlot(2, false)]).toEqual([true, false])
    expect(fired(actions)).toEqual([
      ['spawn', [UnitTypeId.Scout]],
      ['armBuilding', [UnitTypeId.Factory]],
    ])
  })

  it('do nothing while the grid is hidden', () => {
    const { view, actions } = mount()
    paint(view, spectateHud().input)
    expect([view.pressSlot(1, false), view.pressSlot(1, true)]).toEqual([false, false])
    expect(fired(actions)).toEqual([])
  })

  it('do nothing after clear, until a paint opens the tab of its selection', () => {
    const { root, view, actions } = mount()
    paint(view, baseHud().input)
    button(root, 'Sea').click()
    view.clear()
    expect([1, 2, 3, 4, 5, 6].map((slot) => view.pressSlot(slot, false))).toEqual([false, false, false, false, false, false])
    expect(view.pressSlot(1, true)).toBe(false)
    expect(fired(actions)).toEqual([])
    expect(tiles(root)).toEqual([])
    paint(view, baseHud().input)
    expect(view.pressSlot(1, false)).toBe(true)
    expect(fired(actions)).toEqual([['armBuilding', [UnitTypeId.Factory]]])
  })
})

describe('hud selected panel', () => {
  function rows(root: ParentNode) {
    return all(one(root, '#selected'), '.unit-row').map((row) => {
      const bar = one(row, '.bar')
      return [one(row, '.name').textContent, one(row, '.state').textContent, classes(bar), bar.style.getPropertyValue('--h')]
    })
  }

  it('is panel 03 Selected, hidden while no live unit or hall is selected and for spectators', () => {
    const { root, view } = mount()
    const selected = panel(root, 'Selected')
    const army = armyHud().input
    const dead = army.units.map((unit) => (army.selected.includes(unit.id) ? { ...unit, health: 0 } : unit))
    const seen = (input: HudInput) => {
      paint(view, input)
      return shown(selected)
    }
    expect([one(selected, '.panel-index').textContent, selected.id]).toEqual(['03', 'selected'])
    expect([seen(baseHud().input), seen(army), seen({ ...army, units: dead }), seen({ ...army, spectating: true })]).toEqual([false, true, false, false])
  })

  it('reads a row per type as <label> ×N, with a health bar carrying its band and scale', () => {
    const { root, view } = mount()
    paint(view, armyHud().input)
    expect(rows(root)).toEqual([
      ['Med Tank ×4', '', ['bar', 'healthy'], '0.65'],
      ['Scout ×3', '', ['bar', 'healthy'], '1'],
      ['Heavy Tank ×2', '', ['bar', 'damaged'], '0.3'],
      ['Artillery', '', ['bar', 'critical'], '0.15'],
      ['Jet', '', ['bar', 'healthy'], '1'],
      ['Gunship', '', ['bar', 'healthy'], '1'],
    ])
    const base = baseHud().input
    const [factory] = base.units
    paint(view, { ...base, units: [{ ...factory, progress: 0.42 }, ...base.units.slice(1)], selected: [factory.id] })
    expect(rows(root)).toEqual([['Factory', '42%', ['bar', 'healthy'], '1']])
  })

  it('tags its head Group N while the selection is that group', () => {
    const { root, view } = mount()
    const group = one(root, '#group')
    paint(view, armyHud().input)
    expect([shown(group), group.textContent]).toEqual([true, 'Group 1'])
    paint(view, { ...armyHud().input, group: null })
    expect(shown(group)).toBe(false)
  })

  it('keeps its row nodes when the same selection is painted twice', () => {
    const { root, view } = mount()
    paint(view, armyHud().input)
    const first = all(root, '.unit-row')
    paint(view, armyHud().input)
    const second = all(root, '.unit-row')
    expect(second).toHaveLength(6)
    expect(second.every((entry, index) => entry === first[index])).toBe(true)
  })
})

describe('hud city hall', () => {
  it('shows City hall, the focus label and the slider in Selected, and Base in Build', () => {
    const { root, view } = mount()
    paint(view, hallHud().input)
    const selected = one(root, '#selected')
    expect(shown(selected)).toBe(true)
    expect([one(selected, '#city-focus-name').textContent, one(selected, '#city-focus-label').textContent]).toEqual(['City hall', 'Growth ×2'])
    expect(one<HTMLInputElement>(selected, 'input[aria-label="City focus"]').value).toBe('1')
    expect(one(root, '#side').querySelector('input[aria-label="City focus"]')).toBeNull()
    expect([openTab(root), tiles(root).map((entry) => face(entry).name)]).toEqual(['Base', ['Factory', 'Turret', 'Airport', 'Helipad', 'Shipyard', 'Building']])
    paint(view, baseHud().input)
    expect(shown(one(root, '#city-focus'))).toBe(false)
  })

  it('lets the F-keys press the Base tiles', () => {
    const { view, actions } = mount()
    paint(view, hallHud().input)
    expect(view.pressSlot(1, false)).toBe(true)
    expect(fired(actions)).toEqual([['armBuilding', [UnitTypeId.Factory]]])
  })

  it('fires setCityFocus with the step on input', () => {
    const { root, view, actions } = mount()
    paint(view, hallHud().input)
    const slider = one<HTMLInputElement>(root, 'input[aria-label="City focus"]')
    slider.value = '-2'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    expect(fired(actions)).toEqual([['setCityFocus', [-2]]])
    expect(one(root, '#city-focus-label').textContent).toBe('Money ×4')
  })

  it('keeps a focused slider at its value through paint', () => {
    const { root, view } = mount()
    paint(view, hallHud().input)
    const slider = one<HTMLInputElement>(root, 'input[aria-label="City focus"]')
    slider.focus()
    slider.value = '2'
    paint(view, hallHud().input)
    expect(slider.value).toBe('2')
    slider.blur()
    paint(view, hallHud().input)
    expect(slider.value).toBe('1')
  })
})

describe('hud menu', () => {
  const SEEN = 'rts.seen-version'

  function bind() {
    const mounted = mount()
    const menu = {
      onMusic: vi.fn(),
      onSounds: vi.fn(),
      onMusicVolume: vi.fn<(volume: number) => void>(),
      onSoundsVolume: vi.fn<(volume: number) => void>(),
      onSurrender: vi.fn(),
    }
    bindMenu(menu)
    return { ...mounted, menu }
  }

  function opener(root: ParentNode, name: string): HTMLElement {
    return one(root, `[data-open="${name}"]`)
  }

  function slider(root: ParentNode, name: string): HTMLInputElement {
    return one(root, `input[data-volume="${name}"]`)
  }

  function readout(root: ParentNode, name: string): string | null {
    return one(root, `output[for="${slider(root, name).id}"]`).textContent
  }

  function sheet(root: ParentNode): string | null {
    return shown(one(root, '#sheet')) ? one(root, '#sheet-title').textContent : null
  }

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(SEEN, version)
  })

  afterEach(() => {
    Reflect.deleteProperty(document, 'fullscreenElement')
    Reflect.deleteProperty(document, 'exitFullscreen')
    Reflect.deleteProperty(document.documentElement, 'requestFullscreen')
  })

  it('opens and closes the dropdown; Surrender closes it and fires onSurrender', () => {
    const { root, menu } = bind()
    const dropdown = one(root, '#menu')
    opener(root, 'menu').click()
    expect(dropdown.classList.contains('open')).toBe(true)
    opener(root, 'menu').click()
    expect(dropdown.classList.contains('open')).toBe(false)
    opener(root, 'menu').click()
    button(root, 'Surrender').click()
    expect(dropdown.classList.contains('open')).toBe(false)
    expect(menu.onSurrender).toHaveBeenCalledOnce()
  })

  it('flips Music, remembers it as rts.music and fires onMusic', () => {
    const { root, menu } = bind()
    const music = one(root, '[data-toggle="music"]')
    music.click()
    expect([music.getAttribute('aria-pressed'), localStorage.getItem('rts.music')]).toEqual(['false', 'off'])
    expect(menu.onMusic.mock.calls).toEqual([[false]])
    const again = bind()
    expect(one(again.root, '[data-toggle="music"]').getAttribute('aria-pressed')).toBe('false')
    expect(again.menu.onMusic.mock.calls).toEqual([[false]])
  })

  it('wires Sounds through data-toggle="sounds" to onSounds', () => {
    const { root, menu } = bind()
    one(root, '[data-toggle="sounds"]').click()
    expect(menu.onSounds.mock.calls).toEqual([[false]])
    expect(localStorage.getItem('rts.sounds')).toBe('off')
  })

  it('starts the volumes at 40% for Music and 100% for Sounds', () => {
    const { root, menu } = bind()
    expect([menu.onMusicVolume.mock.calls, menu.onSoundsVolume.mock.calls]).toEqual([[[0.4]], [[1]]])
    expect([readout(root, 'musicVolume'), readout(root, 'soundsVolume')]).toEqual(['40%', '100%'])
  })

  it('applies a volume as its slider moves, and brings it back where it was left', () => {
    const first = bind()
    const music = slider(first.root, 'musicVolume')
    music.value = '25'
    music.dispatchEvent(new Event('input', { bubbles: true }))
    expect(first.menu.onMusicVolume).toHaveBeenLastCalledWith(0.25)
    expect([readout(first.root, 'musicVolume'), localStorage.getItem('rts.musicVolume')]).toEqual(['25%', '25'])
    const next = bind()
    expect(slider(next.root, 'musicVolume').value).toBe('25')
    expect(next.menu.onMusicVolume.mock.calls).toEqual([[0.25]])
  })

  it('flips Input and its mark', () => {
    const { root } = bind()
    const input = button(root, 'Input On')
    input.click()
    expect([input.getAttribute('aria-pressed'), input.textContent]).toEqual(['false', 'Input Off'])
  })

  it('opens Changelog, marking the version seen, and Help in the sheet', () => {
    const { root } = bind()
    localStorage.setItem(SEEN, '0.0.0')
    opener(root, 'changelog').click()
    expect([sheet(root), localStorage.getItem(SEEN)]).toEqual(['Changelog', version])
    opener(root, 'help').click()
    expect(sheet(root)).toBe('Help')
  })

  it('closes the sheet on Close, Escape and a click on the backdrop', () => {
    const { root } = bind()
    opener(root, 'help').click()
    button(one(root, '#sheet'), 'Close').click()
    expect(sheet(root)).toBeNull()
    opener(root, 'help').click()
    escape()
    expect(sheet(root)).toBeNull()
    opener(root, 'help').click()
    one(root, '#sheet-body').click()
    expect(sheet(root)).toBe('Help')
    one(root, '#sheet').click()
    expect(sheet(root)).toBeNull()
  })

  it('opens the changelog on its own for an unseen version', () => {
    localStorage.removeItem(SEEN)
    const { root } = bind()
    expect([sheet(root), localStorage.getItem(SEEN)]).toEqual(['Changelog', version])
  })

  it('requests full screen from a click on its icon, and exits it when already full screen, closing the menu', () => {
    const { root } = bind()
    const request = vi.fn(() => Promise.resolve())
    const exit = vi.fn(() => Promise.resolve())
    Object.assign(document.documentElement, { requestFullscreen: request })
    Object.assign(document, { exitFullscreen: exit })
    const icon = one(opener(root, 'fullscreen'), 'svg')
    const press = () => icon.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
    opener(root, 'menu').click()
    press()
    expect([request.mock.calls.length, exit.mock.calls.length]).toEqual([1, 0])
    expect(one(root, '#menu').classList.contains('open')).toBe(false)
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.documentElement })
    press()
    expect([request.mock.calls.length, exit.mock.calls.length]).toEqual([1, 1])
  })
})

describe('hud factions', () => {
  it('list a legend row per faction with its swatch and name, dimming and tagging the defeated', () => {
    const { root, view } = mount()
    view.setFactions(baseHud().factions, false, 1)
    const legend = one(root, '#legend')
    expect(shown(legend)).toBe(true)
    const rows = [...legend.children].map((row) => ({
      swatch: one(row, 'i').style.background,
      name: one(row, '.name').textContent,
      tag: row.querySelector('.tag')?.textContent ?? null,
      dimmed: row.classList.contains('defeated'),
    }))
    expect(rows).toEqual([
      { swatch: '#2f7edb', name: 'Ada', tag: null, dimmed: false },
      { swatch: '#d64545', name: 'Bo', tag: null, dimmed: false },
      { swatch: '#3cde73', name: 'Cy', tag: null, dimmed: false },
      { swatch: '#f0c040', name: 'Dee', tag: 'defeated', dimmed: true },
    ])
  })

  it('give spectators panel 02 Vision instead of Build: a plate per faction, pressed on the viewed one, then Leave', () => {
    const { root, view, actions } = mount()
    const { input, factions } = spectateHud()
    paint(view, input)
    view.setFactions(factions, false, 1)
    expect([shown(panel(root, 'Build')), shown(panel(root, 'Vision'))]).toEqual([true, false])
    view.setFactions(factions, true, 3)
    const vision = panel(root, 'Vision')
    expect([shown(panel(root, 'Build')), shown(vision), one(vision, '.panel-index').textContent]).toEqual([false, true, '02'])
    expect([tiles(root), root.querySelector('#vision')]).toEqual([[], null])
    const plates = all(vision, '.faction-plate').map((plate) => ({
      swatch: one(plate, '.swatch').style.background,
      name: one(plate, '.name').textContent,
      pressed: plate.getAttribute('aria-pressed'),
    }))
    expect(plates).toEqual(factions.map((faction) => ({ swatch: hex(faction.color), name: faction.name, pressed: String(faction.playerId === 3) })))
    expect(all(vision, 'button').at(-1)?.textContent).toBe('Leave')
    button(vision, 'Eve').click()
    button(vision, 'Leave').click()
    expect(fired(actions)).toEqual([
      ['viewAs', [5]],
      ['leave', []],
    ])
  })
})

describe('hud outcome and trace', () => {
  it('reveal the outcome with its title and text until Close or the backdrop', () => {
    const { root, view } = mount()
    const outcome = one(root, '#outcome')
    view.setOutcome({ title: 'Defeated', text: 'Your forces are gone.' })
    expect(shown(outcome)).toBe(true)
    expect(one(outcome, '[role="dialog"]').textContent).toContain('Defeated')
    expect(one(outcome, '[role="dialog"]').textContent).toContain('Your forces are gone.')
    button(outcome, 'Close').click()
    expect(shown(outcome)).toBe(false)
    view.setOutcome({ title: 'Victory', text: 'You are the last player.' })
    one(outcome, '[role="dialog"]').click()
    expect(shown(outcome)).toBe(true)
    outcome.click()
    expect(shown(outcome)).toBe(false)
  })

  it('paint the trace as a row per slot and the work / budget line', () => {
    const { root, view } = mount()
    const trace = one(root, '#trace')
    expect(shown(trace)).toBe(false)
    view.paintTrace(traceFrame())
    expect(shown(trace)).toBe(true)
    expect(all(trace, 'li')).toHaveLength(traceFrame().samples.length)
    expect(one(trace, '#trace-total').textContent).toBe('17.5 / 33.3 ms')
  })
})

describe('hud clear', () => {
  function dom(node: Node, depth = 0): string {
    const indent = '  '.repeat(depth)
    if (!(node instanceof Element)) return indent + JSON.stringify(node.textContent)
    // Dropping the last class or inline property leaves an empty attribute behind.
    const attributes = [...node.attributes]
      .filter((attribute) => attribute.value !== '' || (attribute.name !== 'class' && attribute.name !== 'style'))
      .map((attribute) => ` ${attribute.name}="${attribute.value}"`)
      .sort()
    const value = node instanceof HTMLInputElement ? ` .value="${node.value}"` : ''
    return [`${indent}<${node.localName}${attributes.join('')}${value}>`, ...[...node.childNodes].map((child) => dom(child, depth + 1))].join('\n')
  }

  it('returns #hud to the DOM a fresh view builds, whatever was painted or opened', () => {
    const { root, view } = mount()
    bindMenu()
    const fresh = dom(root)
    const fixture = (make: () => HudFixture) => () => {
      const { input, credits, factions } = make()
      view.setBattle(12)
      paint(view, input, credits)
      view.setFactions(factions, input.spectating, input.playerId)
    }
    const scenes: [string, () => void][] = [
      ['army', fixture(armyHud)],
      ['hall', fixture(hallHud)],
      ['strained', fixture(strainedHud)],
      ['spectate', fixture(spectateHud)],
      ['outcome', () => view.setOutcome({ title: 'Victory', text: 'You are the last player.' })],
      ['trace', () => view.paintTrace(traceFrame())],
      ['menu', () => one(root, '[data-open="menu"]').click()],
    ]
    for (const [name, scene] of scenes) {
      scene()
      view.clear()
      expect(dom(root), name).toBe(fresh)
    }
  })
})
