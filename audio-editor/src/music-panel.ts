import {
  ARPS,
  BASSES,
  CHANNELS,
  KITS,
  LEADS,
  PADS,
  music,
  musicPresets,
  type Context,
  type MoodName,
  type Song,
} from '../../packages/audio/src/index.ts'
import { button, h, slider } from './dom.ts'

const ARP = ['updown', 'up', 'broken', 'pedal'] as const
const BASS = ['root', 'pulse', 'octave', 'walking'] as const

export function mountMusic(stage: HTMLElement, touch: () => void) {
  h('h2', stage, { text: 'Music' })
  h('p', stage, {
    text: 'Lobby, battle, and defeat each store a mix of moods. Songs in that role play under the mix.',
    class: 'game',
  })
  const row = h('div', stage, { class: 'row' })
  const context = h('select', row)
  for (const name of ['lobby', 'battle', 'defeat'] as const) {
    const o = h('option', context, { text: name })
    o.value = name
    if (name === music.context) o.selected = true
  }
  button(row, 'Play', () => music.start(), 'primary')
  button(row, 'Stop', () => music.stop())
  button(row, 'Next', () => music.queueSong(music.nextSongIndex()))
  const loop = h('label', row, { text: 'Loop song' })
  const loopInput = h('input', loop)
  loopInput.type = 'checkbox'
  loopInput.checked = music.loopSong
  loopInput.onchange = () => { music.loopSong = loopInput.checked }
  const status = h('p', stage, { text: music.status(), class: 'hint' })

  h('h3', stage, { text: 'Mood mix' })
  const moods = h('div', stage, { class: 'fields' })
  const moodSet = new Map<MoodName, (n: number) => void>()
  for (const name of Object.keys(musicPresets.moods) as MoodName[]) {
    moodSet.set(name, slider(moods, name, music.target[name] ?? 0, [0, 1, 0.01, false], (n) => {
      musicPresets.mixes[music.context][name] = n
      music.setMood(name, n)
      touch()
    }))
  }
  context.onchange = () => {
    music.setContext(context.value as Context)
    for (const name of moodSet.keys()) moodSet.get(name)?.(music.target[name] ?? 0)
    paintSongs()
  }
  const ease = h('div', stage, { class: 'fields' })
  slider(ease, 'Transition', music.transition, [0.5, 20, 0.5, false], (n) => {
    music.transition = n
    musicPresets.transition = n
    touch()
  })

  h('h3', stage, { text: 'Channels' })
  const channels = h('div', stage, { class: 'row' })
  for (const ch of CHANNELS) {
    const label = h('label', channels, { text: ch })
    const input = h('input', label)
    input.type = 'checkbox'
    input.checked = !music.muted[ch]
    input.onchange = () => music.setMute(ch, !input.checked)
  }

  h('h3', stage, { text: 'Songs' })
  const songs = h('div', stage, { class: 'songs' })
  const form = h('div', stage, { class: 'stack' })
  let editing = music.songIndex

  const paintSongs = () => {
    songs.replaceChildren()
    musicPresets.songs.forEach((song, index) => {
      const allowed = music.allows(song)
      const b = button(songs, song.title, () => {
        editing = index
        if (music.playing) music.queueSong(index)
        else music.loadSong(index)
        showSong()
        paintSongs()
      })
      b.dataset.index = String(index)
      if (!allowed) b.disabled = false
      b.classList.toggle('active', index === music.songIndex)
      if (!allowed) b.title = 'Not in this mix'
    })
  }

  const showSong = () => {
    const song = musicPresets.songs[editing]
    form.replaceChildren()
    if (!song) return
    h('h3', form, { text: song.title })
    text(form, 'Title', song.title, (value) => {
      song.title = value
      touch()
      paintSongs()
    })
    const roles = h('div', form, { class: 'checks' })
    h('span', roles, { text: 'Plays in' })
    for (const role of ['lobby', 'battle'] as const) {
      const label = h('label', roles, { text: role })
      const input = h('input', label)
      input.type = 'checkbox'
      input.checked = song.roles.includes(role)
      input.onchange = () => {
        const next = (['lobby', 'battle'] as const).filter((item) => item === role ? input.checked : song.roles.includes(item))
        song.roles = [...next]
        touch()
        paintSongs()
      }
    }
    number(form, 'Root', song.root, 24, 84, 1, (n) => { song.root = n; touch() })
    number(form, 'Tempo ×', song.tempoMul, 0.6, 1.6, 0.01, (n) => { song.tempoMul = n; touch() })
    number(form, 'Mode bias', song.modeBias, -1.5, 1.5, 0.05, (n) => { song.modeBias = n; touch() })
    number(form, 'Swing', song.swing, 0, 0.6, 0.01, (n) => { song.swing = n; touch() })
    number(form, 'Lead octave', song.leadOct, 0, 3, 1, (n) => { song.leadOct = n; touch() })
    number(form, 'Intro bars', song.intro, 0, 16, 1, (n) => { song.intro = n; touch() })
    number(form, 'Outro bars', song.outro, 0, 16, 1, (n) => { song.outro = n; touch() })
    number(form, 'Passes', song.passes, 1, 4, 1, (n) => { song.passes = n; touch() })
    pick(form, 'Lead', song.inst, 'lead', Object.keys(LEADS))
    pick(form, 'Arp', song.inst, 'arp', Object.keys(ARPS))
    pick(form, 'Pad', song.inst, 'pad', Object.keys(PADS))
    pick(form, 'Bass', song.inst, 'bass', Object.keys(BASSES))
    pick(form, 'Kit', song.inst, 'kit', Object.keys(KITS))
    select(form, 'Groove', song.groove, Object.keys(musicPresets.grooves), (value) => {
      song.groove = value
      touch()
      showSong()
    })
    select(form, 'Arp shape', song.arpStyle, ARP, (value) => {
      song.arpStyle = value
      touch()
    })
    select(form, 'Bass shape', song.bassStyle, BASS, (value) => {
      song.bassStyle = value
      touch()
    })
    text(form, 'Hook', song.hook.join(', '), (value) => {
      const nums = parseNums(value)
      if (nums) {
        song.hook = nums
        touch()
      }
    })
    text(form, 'Bridge', song.bridge.join(', '), (value) => {
      const nums = parseNums(value)
      if (nums) {
        song.bridge = nums
        touch()
      }
    })
    area(form, 'Form', song.body.map(([name, bars]) => `${name} ${bars}`).join('\n'), (value) => {
      const body = parseBody(value)
      if (!body) return
      song.body = body
      touch()
    })
    const groove = musicPresets.grooves[song.groove]
    if (groove) {
      h('h3', form, { text: `Groove “${song.groove}”` })
      h('p', form, { text: 'Shared by every song that uses this groove. Steps are 16th-notes, 0–15.', class: 'hint' })
      listField(form, 'Kick', groove.kick)
      listField(form, 'Kick (loud)', groove.kickHi)
      listField(form, 'Snare', groove.snare)
      number(form, 'Hat spacing', groove.hat, 1, 8, 1, (n) => { groove.hat = n; touch() })
    }
    button(form, 'Restart song', () => music.loadSong(editing))
  }

  const prog = h('details', stage)
  h('summary', prog, { text: 'Mood progressions and section levels' })
  for (const name of Object.keys(musicPresets.moods) as MoodName[]) {
    const mood = musicPresets.moods[name]
    area(prog, `${name} chords`, mood.prog.map((row) => row.join(' ')).join('\n'), (value) => {
      const rows = value.split('\n').map((line) => parseNums(line.trim())).filter((row): row is number[] => row !== null && row.length > 0)
      if (rows.length === 0) return
      mood.prog = rows
      touch()
    })
  }
  for (const [name, section] of Object.entries(musicPresets.sections)) {
    h('h3', prog, { text: name })
    const box = h('div', prog, { class: 'fields' })
    for (const key of ['pad', 'arp', 'lead', 'bass', 'drums', 'energy'] as const) {
      slider(box, key, section[key], [0, 1.2, 0.01, false], (n) => {
        section[key] = n
        touch()
      })
    }
  }

  paintSongs()
  showSong()
  const timer = window.setInterval(() => { status.textContent = music.status() }, 400)
  return () => {
    window.clearInterval(timer)
    music.stop()
  }

  function pick<K extends string>(parent: HTMLElement, label: string, obj: Record<K, string>, key: K, options: string[]) {
    select(parent, label, obj[key], options, (value) => {
      obj[key] = value
      touch()
    })
  }

  function listField(parent: HTMLElement, label: string, values: number[]) {
    text(parent, label, values.join(', '), (value) => {
      const nums = parseNums(value)
      if (!nums) return
      values.splice(0, values.length, ...nums)
      touch()
    })
  }
}

function select<T extends string>(parent: HTMLElement, label: string, value: T, options: readonly T[], onChange: (value: T) => void) {
  const row = h('label', parent)
  h('span', row, { text: label })
  const input = h('select', row)
  for (const opt of options) {
    const o = h('option', input, { text: opt })
    o.value = opt
    if (opt === value) o.selected = true
  }
  input.onchange = () => onChange(input.value as T)
}

function text(parent: HTMLElement, label: string, value: string, onChange: (value: string) => void) {
  const row = h('label', parent)
  h('span', row, { text: label })
  const input = h('input', row)
  input.type = 'text'
  input.value = value
  input.onchange = () => onChange(input.value)
}

function number(
  parent: HTMLElement,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (n: number) => void,
) {
  const row = h('label', parent)
  h('span', row, { text: label })
  const input = h('input', row)
  input.type = 'number'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)
  input.onchange = () => onChange(Number(input.value))
}

function area(parent: HTMLElement, label: string, value: string, onChange: (value: string) => void) {
  const row = h('label', parent)
  h('span', row, { text: label })
  const input = h('textarea', row)
  input.rows = 4
  input.value = value
  input.onchange = () => onChange(input.value)
}

function parseNums(value: string) {
  if (!value.trim()) return []
  const nums = value.split(/[,\s]+/).filter(Boolean).map(Number)
  if (nums.some((n) => Number.isNaN(n))) return null
  return nums
}

function parseBody(value: string): Song['body'] | null {
  const body: Song['body'] = []
  for (const line of value.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [name, bars] = trimmed.split(/\s+/)
    if (!name || !musicPresets.sections[name] || Number.isNaN(Number(bars))) return null
    body.push([name, Number(bars)])
  }
  return body
}
