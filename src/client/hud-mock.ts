import '../style.css'
import { version } from '../../package.json'
import {
  airportHud,
  armedHud,
  armyHud,
  baseHud,
  factoryHud,
  hallHud,
  RADAR_VIEW,
  radarWorld,
  spectateHud,
  strainedHud,
  traceFrame,
  traceHud,
  type HudFixture,
} from './hud-fixtures.ts'
import { hudModel } from './hud-model.ts'
import { HudView, type HudActions } from './hud-ui.ts'
import { bindMenu } from './menu.ts'
import { Minimap } from './render/minimap.ts'

const SCENES = ['base', 'armed', 'factory', 'airport', 'hall', 'army', 'spectate', 'strained', 'menu', 'help', 'outcome', 'trace'] as const
type Scene = (typeof SCENES)[number]

const FIXTURES: Record<Scene, () => HudFixture> = {
  base: baseHud,
  armed: armedHud,
  factory: factoryHud,
  airport: airportHud,
  hall: hallHud,
  army: armyHud,
  spectate: spectateHud,
  strained: strainedHud,
  menu: baseHud,
  help: baseHud,
  outcome: baseHud,
  trace: traceHud,
}

const PHONE_FRAMES = [
  [390, 844],
  [844, 390],
] as const

function isScene(value: string | null): value is Scene {
  return SCENES.some((scene) => scene === value)
}

function log(name: string) {
  return (...args: unknown[]) => console.info(`hud ${name}`, ...args)
}

function one<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error(`missing ${selector}`)
  return found
}

const actions: HudActions = {
  armBuilding: log('armBuilding'),
  cancelBuild: log('cancelBuild'),
  armCity: log('armCity'),
  spawn: log('spawn'),
  cancelSpawn: log('cancelSpawn'),
  cancelQueued: log('cancelQueued'),
  setCityFocus: log('setCityFocus'),
  viewAs: log('viewAs'),
  leave: log('leave'),
}

function show(scene: Scene) {
  const fixture = FIXTURES[scene]()
  const view = new HudView(one('#hud'), actions)
  // An unseen version opens the changelog over every scene.
  localStorage.setItem('rts.seen-version', version)
  bindMenu({ onMusic: log('onMusic'), onSounds: log('onSounds'), onMusicVolume: log('onMusicVolume'), onSoundsVolume: log('onSoundsVolume'), onSurrender: log('onSurrender') })
  document.body.classList.add('match')
  view.setBattle(12)
  view.paint(hudModel(fixture.input), fixture.credits)
  view.setFactions(fixture.factions, fixture.input.spectating, fixture.input.playerId)
  showRadar(fixture)
  if (scene === 'menu') one('[data-open="menu"]').click()
  else if (scene === 'help') one('[data-open="help"]').click()
  else if (scene === 'outcome') view.setOutcome({ title: 'Victory', text: 'You are the last player.' })
  else if (scene === 'trace') view.paintTrace(traceFrame())
}

function showRadar(fixture: HudFixture) {
  const minimap = new Minimap(one('#minimap'), one<HTMLCanvasElement>('#minimap-map'), one<HTMLCanvasElement>('#minimap-marks'), radarWorld(), log('jump'))
  minimap.setCommand(log('command'))
  const selected = new Set(fixture.input.selected)
  const draw = () => minimap.draw(fixture.input.units, selected, fixture.input.playerId, RADAR_VIEW)
  draw()
  window.addEventListener('resize', draw)
}

function phoneStrip(): HTMLElement {
  const strip = document.createElement('main')
  strip.className = 'mock-phones'
  for (const scene of SCENES) {
    const figure = document.createElement('figure')
    const caption = document.createElement('figcaption')
    caption.textContent = scene
    figure.append(caption)
    for (const [width, height] of PHONE_FRAMES) {
      const frame = document.createElement('iframe')
      frame.title = `${scene} ${width}×${height}`
      frame.width = String(width)
      frame.height = String(height)
      frame.src = `${location.pathname}?scene=${scene}`
      figure.append(frame)
    }
    strip.append(figure)
  }
  return strip
}

const params = new URLSearchParams(location.search)
if (params.get('frame') === 'phone') {
  document.body.replaceChildren(phoneStrip())
} else {
  const scene = params.get('scene')
  show(isScene(scene) ? scene : 'base')
}
