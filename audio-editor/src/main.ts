/// <reference types="vite/client" />
import {
  audioLoadText,
  audioStarted,
  applySpace,
  createEngine,
  enginePresets,
  getAnalyser,
  musicPresets,
  oneshots,
  playAt,
  playRecipe,
  setListener,
  setMasterVolume,
  setPanningModel,
  setReverb,
  space,
  useVoiceClips,
  voicePresets,
  type EngineProfile,
  type Step,
} from '../../packages/audio/src/index.ts'
import { button, choice, fmt, h, slider, type Range } from './dom.ts'
import { mountMusic } from './music-panel.ts'
import { mountVoice } from './voice-panel.ts'

const voiceClips = import.meta.glob('../../assets/voices/*/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
})
useVoiceClips(voiceClips)

const GROUPS = [
  ['weapon', 'Weapons'],
  ['impact', 'Impacts'],
  ['interface', 'Interface'],
  ['engine', 'Engines'],
  ['music', 'Music'],
  ['voice', 'Voices'],
] as const

type Group = (typeof GROUPS)[number][0]

const FIELD_ORDER = ['at', 'type', 'color', 'filter', 'f0', 'f1', 'f1Mul', 'fc', 'fcEnd', 'fdecay', 'q', 'a', 'hold', 'd', 'glide', 'detune', 'gain', 'drive', 'wet', 'pan', 'vibrato', 'vibratoRate', 'ratio', 'index', 'indexEnd', 'dur', 'count', 'skew', 'every', 'jitter']
const CHOICES: Record<string, readonly string[]> = {
  type: ['sine', 'square', 'sawtooth', 'triangle'],
  color: ['white', 'pink', 'brown'],
  filter: ['lowpass', 'highpass', 'bandpass', 'notch'],
}
const SOUND_RANGE: Record<string, Range> = {
  at: [0, 4, 0.01, false],
  f0: [20, 14000, 1, true],
  f1: [20, 14000, 1, true],
  f: [20, 8000, 1, true],
  fc: [20, 14000, 1, true],
  fcEnd: [20, 14000, 1, true],
  fdecay: [0.01, 3, 0.01, false],
  f1Mul: [0.25, 4, 0.01, false],
  q: [0.1, 18, 0.1, false],
  a: [0.001, 2, 0.001, false],
  hold: [0, 2, 0.01, false],
  d: [0.001, 4, 0.001, false],
  glide: [0.001, 2, 0.01, false],
  detune: [-100, 100, 1, false],
  gain: [0, 1.5, 0.01, false],
  drive: [0, 12, 0.1, false],
  wet: [0, 1.5, 0.01, false],
  pan: [-1, 1, 0.01, false],
  vibrato: [0, 40, 0.1, false],
  vibratoRate: [0, 30, 0.1, false],
  ratio: [0.25, 8, 0.01, false],
  index: [0, 12, 0.1, false],
  indexEnd: [0, 4, 0.01, false],
  dur: [0, 4, 0.01, false],
  count: [1, 40, 1, false],
  skew: [0.2, 3, 0.05, false],
  every: [0.02, 1, 0.005, false],
  jitter: [0, 0.5, 0.01, false],
}

const top = document.querySelector('#top') as HTMLElement
const groups = document.querySelector('#groups') as HTMLElement
const list = document.querySelector('#list') as HTMLElement
const stage = document.querySelector('#stage') as HTMLElement

let dirty = false
let group: Group = 'weapon'
let selected = ''
let distance = 8
let loop = 0
let cleanup = () => {}
const dirtyEl = h('span', top, { text: 'Saved', class: 'clean', title: '' })

function touch() {
  dirty = true
  dirtyEl.textContent = 'Unsaved'
  dirtyEl.className = ''
  dirtyEl.id = 'dirty'
}

function markClean() {
  dirty = false
  dirtyEl.textContent = 'Saved'
  dirtyEl.className = 'clean'
  dirtyEl.id = 'dirty'
}

function hear() {
  setListener(0, 0, space.listenerHeight)
}

function stopLoop() {
  if (loop) window.clearInterval(loop)
  loop = 0
}

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return
  e.preventDefault()
})

buildHeader()
for (const [id, label] of GROUPS) {
  const b = button(groups, label, () => setGroup(id))
  b.dataset.group = id
}
setGroup('weapon')
requestAnimationFrame(meter)
window.setInterval(() => {
  const load = document.querySelector('#load')
  if (load) load.textContent = audioLoadText()
}, 500)

function setGroup(next: Group) {
  group = next
  for (const b of groups.querySelectorAll('button')) b.classList.toggle('active', b.dataset.group === next)
  cleanup()
  stopLoop()
  cleanup = () => {}
  stage.replaceChildren()
  if (next === 'music') {
    list.replaceChildren()
    cleanup = mountMusic(stage, touch)
    return
  }
  if (next === 'voice') {
    list.replaceChildren()
    cleanup = mountVoice(stage, touch)
    return
  }
  const items = next === 'engine'
    ? Object.entries(enginePresets.units).map(([id, unit]) => ({ id, label: unit.label, game: unit.game }))
    : oneshots.filter((s) => s.group === next).map((s) => ({ id: s.id, label: s.label, game: s.game }))
  selected = items[0]?.id ?? ''
  fillList(items)
  openSelected()
}

function fillList(items: { id: string; label: string; game: string }[]) {
  list.replaceChildren()
  for (const item of items) {
    const b = h('button', list, { class: 'sound' })
    b.type = 'button'
    h('span', b, { text: item.label })
    h('small', b, { text: item.game })
    b.dataset.id = item.id
    b.onclick = () => {
      selected = item.id
      for (const other of list.querySelectorAll('button')) other.classList.toggle('active', other.dataset.id === selected)
      openSelected()
    }
  }
}

function openSelected() {
  for (const other of list.querySelectorAll('button')) other.classList.toggle('active', other.dataset.id === selected)
  cleanup()
  stopLoop()
  stage.replaceChildren()
  if (group === 'engine') cleanup = mountEngine(selected)
  else cleanup = mountSound(selected)
}

function mountSound(id: string) {
  const sound = oneshots.find((s) => s.id === id)
  if (!sound) return () => {}
  h('h2', stage, { text: sound.label })
  h('p', stage, { text: sound.id, class: 'id' })
  h('p', stage, { text: sound.game, class: 'game' })
  const row = h('div', stage, { class: 'row' })
  let looping = false
  const play = () => {
    hear()
    if (sound.spatial && distance > 0.25) playAt(distance, 0, (t) => playRecipe(sound.steps, t))
    else playRecipe(sound.steps)
  }
  button(row, 'Play', play, 'primary')
  const loopBtn = button(row, sound.repeatMs ? `Loop ${sound.repeatMs} ms` : 'Loop', () => {
    if (looping) {
      stopLoop()
      looping = false
      loopBtn.textContent = sound.repeatMs ? `Loop ${sound.repeatMs} ms` : 'Loop'
      return
    }
    play()
    loop = window.setInterval(play, sound.repeatMs ?? 700)
    looping = true
    loopBtn.textContent = 'Stop loop'
  })
  if (sound.spatial) {
    const box = h('div', stage, { class: 'fields' })
    slider(box, 'Distance', distance, [0, 60, 0.5, false], (n) => { distance = n })
  }
  for (const step of sound.steps) renderStep(step, stage)
  return stopLoop
}

function renderStep(step: Step, parent: HTMLElement) {
  const box = h('fieldset', parent, { class: 'step' })
  const legend = h('legend', box)
  h('span', legend, { text: step.op })
  button(legend, 'Layer', () => {
    hear()
    playRecipe([step])
  }, 'tiny')
  const fields = h('div', box, { class: 'fields' })
  const record = step as unknown as Record<string, unknown>
  const keys = Object.keys(record).filter((key) => key !== 'op' && key !== 'steps')
  keys.sort((a, b) => orderOf(a) - orderOf(b))
  for (const key of keys) bindField(fields, record, key)
  if (step.op === 'scatter' || step.op === 'repeat') {
    for (const child of step.steps) renderStep(child, box)
  }
}

function orderOf(key: string) {
  const i = FIELD_ORDER.indexOf(key)
  return i < 0 ? 100 : i
}

function bindField(parent: HTMLElement, record: Record<string, unknown>, key: string) {
  const value = record[key]
  const range = SOUND_RANGE[key] ?? [0, 10, 0.01, false] as Range
  if (typeof value === 'number') {
    slider(parent, key, value, range, (n) => {
      record[key] = n
      touch()
    })
    return
  }
  if (isPair(value)) {
    slider(parent, `${key} min`, value[0], range, (n) => {
      value[0] = n
      touch()
    })
    slider(parent, `${key} max`, value[1], range, (n) => {
      value[1] = n
      touch()
    })
    return
  }
  if (typeof value === 'string' && CHOICES[key]) {
    choice(parent, key, value, CHOICES[key], (v) => {
      record[key] = v
      touch()
    })
  }
}

function isPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
}

function mountEngine(id: string) {
  const profile = enginePresets.units[id]
  if (!profile) return () => {}
  let voice = createEngine(id)
  h('h2', stage, { text: profile.label })
  h('p', stage, { text: id, class: 'id' })
  h('p', stage, { text: profile.game, class: 'game' })
  const state = h('p', stage, { text: 'off', class: 'hint' })
  voice.onChange = () => { state.textContent = voice.state }
  const row = h('div', stage, { class: 'row' })
  button(row, 'Ignite', () => {
    hear()
    voice.setPosition(distance, 0)
    voice.ignite()
  }, 'primary')
  button(row, 'Shutdown', () => voice.shutdown())
  button(row, 'Restart', () => restart(voice.target))
  const controls = h('div', stage, { class: 'fields' })
  slider(controls, 'Speed', 0, [0, 1, 0.01, false], (n) => voice.setSpeed(n))
  slider(controls, 'Distance', distance, [0, 60, 0.5, false], (n) => {
    distance = n
    voice.setPosition(n, 0)
  })
  if (profile.domain === 'land') {
    choice(controls, 'Ground', 'grass', Object.keys(enginePresets.terrains), (key) => {
      voice.setTerrain(key)
    })
  }
  h('p', stage, {
    text: 'Wave, drive, chug, noise colour, and rotor are wired when the engine starts. Restart after those.',
    class: 'hint',
  })
  section('Engine', (box) => {
    choice(box, 'Wave', profile.core.wave, CHOICES.type, (v) => {
      profile.core.wave = v as EngineProfile['core']['wave']
      touch()
    })
    pair(box, 'Hz', profile.core.hz, 'hz')
    pair(box, 'Lowpass', profile.core.lp, 'lp')
    num(box, 'Resonance', profile.core, 'q')
    num(box, 'Drive', profile.core, 'drive')
    num(box, 'Gain', profile.core, 'gain')
    num(box, 'Chug', profile.core, 'chug')
    num(box, 'Chug ratio', profile.core, 'chugRatio')
  })
  section('Noise', (box) => {
    choice(box, 'Colour', profile.noise.color, CHOICES.color, (v) => {
      profile.noise.color = v as EngineProfile['noise']['color']
      touch()
    })
    choice(box, 'Filter', profile.noise.type, CHOICES.filter, (v) => {
      profile.noise.type = v as BiquadFilterType
      touch()
    })
    pair(box, 'Hz', profile.noise.f, 'f')
    num(box, 'Resonance', profile.noise, 'q')
    pair(box, 'Gain', profile.noise.gain, 'gain')
    choice(box, 'Follows', profile.noise.by ?? 'speed', ['speed', 'rpm'], (v) => {
      profile.noise.by = v as 'speed' | 'rpm'
      touch()
    })
    num(box, 'Swell', profile.noise, 'swell')
  })
  if (profile.tracks) {
    section('Tracks', (box) => {
      const tracks = profile.tracks!
      num(box, 'Rate', tracks, 'rate')
      num(box, 'Clank Hz', tracks, 'f')
      num(box, 'Resonance', tracks, 'q')
      num(box, 'Gain', tracks, 'gain')
    })
  }
  if (profile.rotor) {
    section('Rotor', (box) => pair(box, 'Rate', profile.rotor!.rate, 'rate'))
  }
  section('Motion', (box) => {
    num(box, 'Accel', profile, 'accel')
    num(box, 'Decel', profile, 'decel')
    num(box, 'Start', profile, 'startTime')
    num(box, 'Stop', profile, 'stopTime')
    if (profile.alt != null) num(box, 'Altitude', profile, 'alt')
    if (profile.gears != null) num(box, 'Gears', profile, 'gears')
  })
  if (profile.domain === 'land') {
    const details = h('details', stage)
    h('summary', details, { text: 'Ground' })
    for (const [key, terrain] of Object.entries(enginePresets.terrains)) {
      h('h3', details, { text: terrain.label })
      const box = h('div', details, { class: 'fields' })
      h('p', box, { text: key, class: 'id' })
      for (const field of ['rumbleF', 'rumbleG', 'clank', 'load', 'grit'] as const) {
        slider(box, field, terrain[field], engineRange(field), (n) => {
          terrain[field] = n
          touch()
        })
      }
    }
  }

  function restart(speed: number) {
    const terrain = voice.terrainKey
    voice.stop()
    voice = createEngine(id)
    voice.onChange = () => { state.textContent = voice.state }
    voice.setTerrain(terrain)
    voice.setPosition(distance, 0)
    voice.setSpeed(speed)
    hear()
    voice.ignite()
  }

  return () => voice.stop()
}

function section(title: string, fill: (box: HTMLElement) => void) {
  h('h3', stage, { text: title })
  const box = h('div', stage, { class: 'fields' })
  fill(box)
}

function pair(parent: HTMLElement, label: string, tuple: [number, number] | number[], key: string) {
  const range = engineRange(key)
  slider(parent, `${label} low`, tuple[0], range, (n) => {
    tuple[0] = n
    touch()
  })
  slider(parent, `${label} high`, tuple[1], range, (n) => {
    tuple[1] = n
    touch()
  })
}

function num(parent: HTMLElement, label: string, obj: object, key: string) {
  const record = obj as Record<string, number | undefined>
  slider(parent, label, record[key] ?? 0, engineRange(key), (n) => {
    record[key] = n
    touch()
  })
}

function engineRange(key: string): Range {
  switch (key) {
    case 'hz': return [10, 400, 1, false]
    case 'lp':
    case 'f': return [40, 8000, 1, true]
    case 'q': return [0.1, 18, 0.1, false]
    case 'gain': return [0, 1.5, 0.01, false]
    case 'drive': return [0, 8, 0.1, false]
    case 'chug':
    case 'swell':
    case 'load':
    case 'grit': return [0, 1, 0.01, false]
    case 'chugRatio': return [0.05, 2, 0.01, false]
    case 'rate': return [0.5, 40, 0.1, false]
    case 'accel':
    case 'decel': return [0.02, 2, 0.01, false]
    case 'startTime':
    case 'stopTime': return [0.1, 4, 0.05, false]
    case 'alt': return [0, 8, 0.1, false]
    case 'gears': return [1, 8, 1, false]
    case 'rumbleF': return [0.2, 3, 0.01, false]
    case 'rumbleG': return [0, 1.5, 0.01, false]
    case 'clank': return [0.2, 2, 0.01, false]
    default: return [0, 10, 0.01, false]
  }
}

function buildHeader() {
  h('h1', top, { text: 'Audio editor' })
  const master = h('label', top, { text: 'Master' })
  const masterInput = h('input', master)
  masterInput.type = 'range'
  masterInput.min = '0'
  masterInput.max = '1'
  masterInput.step = '0.01'
  masterInput.value = String(space.master)
  const masterOut = h('output', master, { text: fmt(space.master) })
  masterInput.oninput = () => {
    space.master = Number(masterInput.value)
    masterOut.textContent = fmt(space.master)
    if (audioStarted()) setMasterVolume(space.master)
    touch()
  }
  const reverb = h('label', top, { text: 'Reverb' })
  const reverbInput = h('input', reverb)
  reverbInput.type = 'range'
  reverbInput.min = '0'
  reverbInput.max = '1.5'
  reverbInput.step = '0.01'
  reverbInput.value = String(space.reverb)
  const reverbOut = h('output', reverb, { text: fmt(space.reverb) })
  reverbInput.oninput = () => {
    space.reverb = Number(reverbInput.value)
    reverbOut.textContent = fmt(space.reverb)
    if (audioStarted()) setReverb(space.reverb)
    touch()
  }
  const ref = h('label', top, { text: 'Full volume within' })
  const refInput = h('input', ref)
  refInput.type = 'range'
  refInput.min = '2'
  refInput.max = '40'
  refInput.step = '0.5'
  refInput.value = String(space.refDistance)
  const refOut = h('output', ref, { text: fmt(space.refDistance) })
  refInput.oninput = () => {
    space.refDistance = Number(refInput.value)
    refOut.textContent = fmt(space.refDistance)
    applySpace()
    touch()
  }
  const air = h('label', top, { text: 'Air muffles over' })
  const airInput = h('input', air)
  airInput.type = 'range'
  airInput.min = '8'
  airInput.max = '80'
  airInput.step = '1'
  airInput.value = String(space.airDistance)
  const airOut = h('output', air, { text: fmt(space.airDistance) })
  airInput.oninput = () => {
    space.airDistance = Number(airInput.value)
    airOut.textContent = fmt(space.airDistance)
    touch()
  }
  const ear = h('label', top, { text: 'Ear height' })
  const earInput = h('input', ear)
  earInput.type = 'range'
  earInput.min = '2'
  earInput.max = '40'
  earInput.step = '0.5'
  earInput.value = String(space.listenerHeight)
  const earOut = h('output', ear, { text: fmt(space.listenerHeight) })
  earInput.oninput = () => {
    space.listenerHeight = Number(earInput.value)
    earOut.textContent = fmt(space.listenerHeight)
    setListener(0, 0, space.listenerHeight)
    touch()
  }
  const pan = h('label', top, { text: 'Pan' })
  const panSel = h('select', pan)
  for (const model of ['HRTF', 'equalpower'] as const) {
    const o = h('option', panSel, { text: model })
    o.value = model
    if (model === space.panning) o.selected = true
  }
  panSel.onchange = () => {
    setPanningModel(panSel.value as PanningModelType)
    touch()
  }
  h('canvas', top, { class: 'meter' })
  h('span', top, { text: 'Audio idle', class: 'hint' }).id = 'load'
  h('span', top, { class: 'spacer' })
  button(top, 'Revert', () => {
    if (!dirty || window.confirm('Discard unsaved preset changes?')) location.reload()
  })
  button(top, 'Save', () => void save(), 'primary')
  top.appendChild(dirtyEl)
  dirtyEl.id = 'dirty'
}

async function save() {
  const files: Record<string, unknown> = {
    'oneshots.json': oneshots,
    'engines.json': enginePresets,
    'music.json': musicPresets,
    'voice.json': voicePresets,
    'space.json': space,
  }
  try {
    for (const [file, data] of Object.entries(files)) {
      const res = await fetch('/__save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, data }),
      })
      if (!res.ok) throw new Error(await res.text())
    }
    markClean()
  } catch (err) {
    dirtyEl.textContent = err instanceof Error ? err.message : 'Save failed'
  }
}

function meter() {
  const canvas = document.querySelector('canvas.meter') as HTMLCanvasElement | null
  if (canvas) {
    canvas.width = 88
    canvas.height = 28
  }
  const ctx = canvas?.getContext('2d')
  const data = new Uint8Array(64)
  const draw = () => {
    requestAnimationFrame(draw)
    if (!canvas || !ctx || !audioStarted()) return
    const analyser = getAnalyser()
    analyser.getByteFrequencyData(data)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#c9843a'
    const w = canvas.width / data.length
    for (let i = 0; i < data.length; i++) {
      const bar = (data[i] / 255) * canvas.height
      ctx.fillRect(i * w, canvas.height - bar, Math.max(1, w - 1), bar)
    }
  }
  draw()
}
