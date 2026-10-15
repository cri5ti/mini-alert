import { clipFile, speak, voicePresets } from '../../packages/audio/src/index.ts'
import { button, h, slider } from './dom.ts'

export function mountVoice(stage: HTMLElement, touch: () => void) {
  h('h2', stage, { text: 'Voice' })
  h('p', stage, {
    text: `Onyx only. Each line is a generated clip. Repeating orders pick a different take.`,
    class: 'game',
  })
  let phraseId = voicePresets.phrases[0]?.id ?? ''

  const row = h('div', stage, { class: 'row' })
  const rate = h('label', row, { text: 'Rate' })
  const rateInput = h('input', rate)
  rateInput.type = 'range'
  rateInput.min = '0.5'
  rateInput.max = '2'
  rateInput.step = '0.05'
  rateInput.value = String(voicePresets.rate)
  rateInput.oninput = () => {
    voicePresets.rate = Number(rateInput.value)
    touch()
  }
  const pitch = h('label', row, { text: 'Pitch' })
  const pitchInput = h('input', pitch)
  pitchInput.type = 'range'
  pitchInput.min = '0.5'
  pitchInput.max = '2'
  pitchInput.step = '0.05'
  pitchInput.value = String(voicePresets.pitch)
  pitchInput.oninput = () => {
    voicePresets.pitch = Number(pitchInput.value)
    touch()
  }
  const radio = h('label', row, { text: 'Radio' })
  const radioInput = h('input', radio)
  radioInput.type = 'checkbox'
  radioInput.checked = voicePresets.radio.enabled
  radioInput.onchange = () => {
    voicePresets.radio.enabled = radioInput.checked
    touch()
  }

  const phrases = h('div', stage, { class: 'songs' })
  const form = h('div', stage, { class: 'stack' })

  const paint = () => {
    phrases.replaceChildren()
    for (const phrase of voicePresets.phrases) {
      const b = button(phrases, phrase.lines[0] ?? phrase.id, () => {
        phraseId = phrase.id
        show()
      })
      b.classList.toggle('active', phrase.id === phraseId)
    }
  }

  const show = () => {
    const phrase = voicePresets.phrases.find((item) => item.id === phraseId)
    form.replaceChildren()
    paint()
    if (!phrase) return
    button(form, 'Play', () => void speak(phrase.id), 'primary')
    h('p', form, { text: phrase.id, class: 'id' })
    const textRow = h('label', form)
    h('span', textRow, { text: 'Takes' })
    const text = h('textarea', textRow)
    text.value = phrase.lines.join('\n')
    text.rows = Math.max(3, phrase.lines.length)
    text.oninput = () => {
      phrase.lines = text.value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      files.textContent = phrase.lines.map((line) => clipFile(line)).join('  ')
      touch()
      paint()
    }
    const gameRow = h('label', form)
    h('span', gameRow, { text: 'When' })
    const game = h('input', gameRow)
    game.value = phrase.game
    game.oninput = () => {
      phrase.game = game.value
      touch()
    }
    const files = h('p', form, { text: phrase.lines.map((line) => clipFile(line)).join('  '), class: 'id' })
  }

  h('h3', stage, { text: 'Radio filter' })
  const filter = h('div', stage, { class: 'fields' })
  const radioPreset = voicePresets.radio
  slider(filter, 'Highpass', radioPreset.highpass, [80, 1000, 1, true], (n) => { radioPreset.highpass = n; touch() })
  slider(filter, 'Lowpass', radioPreset.lowpass, [800, 8000, 1, true], (n) => { radioPreset.lowpass = n; touch() })
  slider(filter, 'Drive', radioPreset.drive, [0, 8, 0.1, false], (n) => { radioPreset.drive = n; touch() })
  slider(filter, 'Gain', radioPreset.gain, [0, 1.5, 0.01, false], (n) => { radioPreset.gain = n; touch() })
  slider(filter, 'Squelch', radioPreset.squelchGain, [0, 0.4, 0.01, false], (n) => { radioPreset.squelchGain = n; touch() })
  slider(filter, 'Squelch Hz', radioPreset.squelchF, [200, 4000, 1, true], (n) => { radioPreset.squelchF = n; touch() })
  slider(filter, 'Blip Hz', radioPreset.squelchTone, [200, 4000, 1, true], (n) => { radioPreset.squelchTone = n; touch() })
  slider(filter, 'Blip gain', radioPreset.squelchToneGain, [0, 0.2, 0.005, false], (n) => { radioPreset.squelchToneGain = n; touch() })
  slider(filter, 'Lead in', radioPreset.squelchLead, [0, 0.3, 0.01, false], (n) => { radioPreset.squelchLead = n; touch() })

  show()
  return () => {}
}
