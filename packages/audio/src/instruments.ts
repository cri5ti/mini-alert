// Melodic instruments. (t, midi, dur, vel, dest, o) — vel is the channel level.
import { fm, tone } from './synth.ts'

export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

export type ToneOpts = { bright: number; pan?: number }
export type NoteFn = (t: number, midi: number, dur: number, vel: number, dest: AudioNode, o: ToneOpts) => void

const sub = (t: number, f: number, dur: number, g: number, dest: AudioNode) => tone(t, { f0: f, d: dur, gain: g, dest })

export const BASSES: Record<string, NoteFn> = {
  sub(t, m, dur, v, dest) {
    const f = mtof(m)
    sub(t, f, dur, 0.5 * v, dest)
    tone(t, { type: 'triangle', f0: f * 2, d: dur * 0.5, gain: 0.1 * v, dest })
  },
  electric(t, m, dur, v, dest) {
    const f = mtof(m)
    tone(t, {
      type: 'sawtooth', f0: f, a: 0.003, d: dur + 0.05, gain: 0.22 * v, filter: 'lowpass',
      fc: 2400, fcEnd: 350, fdecay: 0.15, q: 1.5, drive: 1.5, dest,
    })
    sub(t, f, dur, 0.38 * v, dest)
  },
  acid(t, m, dur, v, dest) {
    const f = mtof(m)
    tone(t, {
      type: 'sawtooth', f0: f, d: dur + 0.03, gain: 0.12 * v, filter: 'lowpass',
      fc: 3200, fcEnd: 220, fdecay: Math.max(0.08, dur * 0.8), q: 10, drive: 2.5, dest,
    })
    sub(t, f, dur, 0.35 * v, dest)
  },
  reese(t, m, dur, v, dest) {
    const f = mtof(m)
    for (const detune of [-15, 15])
      tone(t, { type: 'sawtooth', f0: f, detune, a: 0.01, d: dur, gain: 0.12 * v, filter: 'lowpass', fc: 900, drive: 2.5, dest })
    sub(t, f, dur, 0.35 * v, dest)
  },
  fm(t, m, dur, v, dest) {
    const f = mtof(m)
    fm(t, { f, ratio: 1, index: 4, indexEnd: 0.6, d: dur, gain: 0.25 * v, dest })
    sub(t, f, dur, 0.3 * v, dest)
  },
}

export const LEADS: Record<string, NoteFn> = {
  soft(t, m, dur, v, dest) {
    tone(t, {
      type: 'triangle', f0: mtof(m), a: 0.02, hold: dur * 0.6, d: dur * 0.6 + 0.1, gain: 0.12 * v,
      vibrato: 3, vibratoRate: 5, wet: 0.45, dest,
    })
  },
  square(t, m, dur, v, dest) {
    tone(t, {
      type: 'square', f0: mtof(m), a: 0.01, hold: dur * 0.6, d: dur * 0.5 + 0.08, gain: 0.06 * v,
      filter: 'lowpass', fc: 2500, vibrato: 4, vibratoRate: 6, wet: 0.35, dest,
    })
  },
  supersaw(t, m, dur, v, dest) {
    for (const detune of [-14, 0, 14])
      tone(t, {
        type: 'sawtooth', f0: mtof(m), detune, a: 0.01, hold: dur * 0.7, d: dur * 0.4 + 0.1, gain: 0.04 * v,
        filter: 'lowpass', fc: 3800, wet: 0.4, dest,
      })
  },
  brass(t, m, dur, v, dest) {
    const f = mtof(m)
    tone(t, {
      type: 'sawtooth', f0: f, a: 0.03, hold: dur * 0.7, d: dur * 0.3 + 0.1, gain: 0.08 * v,
      filter: 'lowpass', fc: 3200, fcEnd: 1100, fdecay: dur, q: 1.5, vibrato: 2, vibratoRate: 5, wet: 0.35, dest,
    })
    tone(t, { type: 'square', f0: f / 2, a: 0.03, hold: dur * 0.7, d: dur * 0.3, gain: 0.025 * v, filter: 'lowpass', fc: 1200, dest })
  },
  guitar(t, m, dur, v, dest) {
    for (const iv of [0, 7, 12])
      tone(t, {
        type: 'sawtooth', f0: mtof(m + iv), a: 0.004, hold: dur * 0.8, d: 0.15, gain: 0.035 * v,
        filter: 'lowpass', fc: 2800, drive: 6, wet: 0.25, dest,
      })
  },
  bell(t, m, dur, v, dest) {
    fm(t, { f: mtof(m), ratio: 3.5, index: 4, indexEnd: 0.1, d: dur + 0.8, gain: 0.1 * v, wet: 0.45, dest })
  },
  organ(t, m, dur, v, dest) {
    ;[1, 2, 3, 4].forEach((h, i) =>
      tone(t, { f0: mtof(m) * h, a: 0.01, hold: dur, d: 0.06, gain: [0.07, 0.045, 0.03, 0.02][i] * v, wet: 0.3, dest }))
  },
}

export const ARPS: Record<string, NoteFn> = {
  pluck(t, m, dur, v, dest, o) {
    tone(t, {
      type: 'sawtooth', f0: mtof(m), d: Math.min(dur, 0.25) + 0.08, gain: 0.07 * v, filter: 'lowpass',
      fc: 2500 + 2500 * o.bright, fcEnd: 300, fdecay: 0.15, wet: 0.3, pan: o.pan, dest,
    })
  },
  chip(t, m, dur, v, dest, o) {
    tone(t, { type: 'square', f0: mtof(m), d: dur, gain: 0.05 * v, filter: 'lowpass', fc: 1500 + 2500 * o.bright, wet: 0.25, pan: o.pan, dest })
  },
  marimba(t, m, dur, v, dest, o) {
    void dur
    const f = mtof(m)
    tone(t, { f0: f, d: 0.3, gain: 0.16 * v, wet: 0.25, pan: o.pan, dest })
    tone(t, { f0: f * 4, d: 0.04, gain: 0.05 * v, pan: o.pan, dest })
  },
  stab(t, m, dur, v, dest, o) {
    void dur
    tone(t, { type: 'square', f0: mtof(m), d: 0.12, gain: 0.06 * v, filter: 'lowpass', fc: 3000, fcEnd: 500, fdecay: 0.1, pan: o.pan, dest })
    tone(t, { type: 'sawtooth', f0: mtof(m) / 2, d: 0.1, gain: 0.04 * v, filter: 'lowpass', fc: 1500, pan: o.pan, dest })
  },
  bell(t, m, _dur, v, dest, o) {
    fm(t, { f: mtof(m), ratio: 3.5, index: 3, indexEnd: 0.1, d: 0.5, gain: 0.07 * v, wet: 0.4, pan: o.pan, dest })
  },
  organ(t, m, dur, v, dest, o) {
    ;[1, 2, 3].forEach((h, i) =>
      tone(t, { f0: mtof(m) * h, a: 0.005, hold: dur * 0.5, d: 0.05, gain: [0.06, 0.035, 0.025][i] * v, pan: o.pan, dest }))
  },
}

export const PADS: Record<string, NoteFn> = {
  strings(t, m, dur, v, dest, o) {
    for (const detune of [-8, 8])
      tone(t, {
        type: 'sawtooth', f0: mtof(m), detune, a: Math.min(0.5, dur * 0.25), hold: dur * 0.7, d: dur * 0.5,
        gain: 0.035 * v, filter: 'lowpass', fc: 500 + 2500 * o.bright, q: 0.7, wet: 0.5, dest,
      })
  },
  choir(t, m, dur, v, dest, o) {
    for (const detune of [-6, 6])
      tone(t, {
        type: 'triangle', f0: mtof(m), detune, a: Math.min(0.6, dur * 0.3), hold: dur * 0.7, d: dur * 0.5,
        gain: 0.09 * v, filter: 'bandpass', fc: 700 + 500 * o.bright, q: 1.2, vibrato: 2, vibratoRate: 4.5, wet: 0.6, dest,
      })
  },
  synth(t, m, dur, v, dest, o) {
    for (const detune of [-10, 10])
      tone(t, {
        type: 'square', f0: mtof(m), detune, a: Math.min(0.3, dur * 0.2), hold: dur * 0.7, d: dur * 0.4,
        gain: 0.022 * v, filter: 'lowpass', fc: 400 + 1800 * o.bright, wet: 0.45, dest,
      })
  },
  organ(t, m, dur, v, dest) {
    ;[1, 2, 3].forEach((h, i) =>
      tone(t, { f0: mtof(m) * h, a: 0.05, hold: dur, d: 0.15, gain: [0.05, 0.03, 0.02][i] * v, wet: 0.4, dest }))
  },
}
