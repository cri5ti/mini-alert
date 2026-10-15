// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { version } from '../../package.json'
import { AA, declarations, hasColourLiteral, inks, motionFaults, moves } from './css-audit.ts'
import { airportHud, armedHud, armyHud, baseHud, factoryHud, hallHud, spectateHud, strainedHud, traceFrame, traceHud, type HudFixture } from './hud-fixtures.ts'
import { hudModel } from './hud-model.ts'
import { HudView, type HudActions } from './hud-ui.ts'
import { bindMenu } from './menu.ts'

const read = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8')
const tokens = read('console.css')
const css = read('hud.css')
const lobby = read('lobby.css')

const sheet = document.createElement('style')
sheet.textContent = tokens + css
document.head.append(sheet)

const actions = new Proxy({} as HudActions, { get: () => () => undefined })

type Scene = (view: HudView, root: HTMLElement) => void

function fixture(make: () => HudFixture): Scene {
  return (view) => {
    const { input, credits, factions } = make()
    view.setBattle(12)
    view.paint(hudModel(input), credits)
    view.setFactions(factions, input.spectating, input.playerId)
  }
}

function open(name: string): Scene {
  return (view, root) => {
    fixture(baseHud)(view, root)
    bindMenu()
    root.querySelector<HTMLElement>(`[data-open="${name}"]`)?.click()
  }
}

const SCENES: Scene[] = [
  ...[baseHud, armedHud, factoryHud, airportHud, hallHud, armyHud, spectateHud, strainedHud].map(fixture),
  open('menu'),
  open('help'),
  open('changelog'),
  (view, root) => {
    fixture(baseHud)(view, root)
    view.setOutcome({ title: 'Defeated', text: 'Your forces are gone.' })
  },
  (view, root) => {
    fixture(traceHud)(view, root)
    view.paintTrace(traceFrame())
  },
]

function render(scene: Scene): HTMLElement {
  localStorage.setItem('rts.seen-version', version)
  const root = document.createElement('div')
  root.id = 'hud'
  document.body.replaceChildren(root)
  scene(new HudView(root, actions), root)
  return root
}

describe('hud.css', () => {
  it('leaves every colour to console.css, which is the :root block alone', () => {
    expect(tokens.replace(/\/\*[\s\S]*?\*\//g, '').trim()).toMatch(/^:root\s*\{[^{}]*\}$/)
    expect(declarations(tokens).filter(hasColourLiteral).length).toBeGreaterThan(0)
    expect([...declarations(css), ...declarations(lobby)].filter(hasColourLiteral)).toEqual([])
  })

  it('moves only under prefers-reduced-motion: no-preference, and only transform and opacity', () => {
    const all = declarations(css)
    expect(all.filter(moves).length).toBeGreaterThan(0)
    expect(motionFaults(all)).toEqual([])
  })

  it('draws every text at full opacity and at 4.5:1 or more against the surface behind it', () => {
    const drawn = SCENES.flatMap((scene) => inks(render(scene)))
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.filter(({ opacity }) => opacity !== 1)).toEqual([])
    expect(drawn.filter(({ ratio }) => ratio < AA)).toEqual([])
  })

  it('stays within 20 000 bytes', () => {
    expect(Buffer.byteLength(css)).toBeLessThanOrEqual(20_000)
  })
})
