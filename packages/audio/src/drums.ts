// Drum kits. Each hit is (t, gain, dest, extra).
import { burst, metal, tone } from './synth.ts'

export type Hit = (t: number, gain: number, dest: AudioNode, extra?: number | boolean) => void
export type Kit = { kick: Hit; snare: Hit; hat: Hit; tom: Hit; crash: Hit }

const idx = (extra?: number | boolean) => (typeof extra === 'number' ? extra : 0)
const open = (extra?: number | boolean) => extra === true

export const KITS: Record<string, Kit> = {
  acoustic: {
    kick: (t, g, dest) => tone(t, { f0: 110, f1: 42, d: 0.3, gain: 0.55 * g, glide: 0.08, dest }),
    snare(t, g, dest) {
      burst(t, { filter: 'bandpass', f0: 1800, q: 0.8, d: 0.15, gain: 0.25 * g, wet: 0.25, dest })
      tone(t, { type: 'triangle', f0: 190, f1: 150, d: 0.08, gain: 0.15 * g, dest })
    },
    hat: (t, g, dest, extra) => burst(t, { filter: 'highpass', f0: 7000, d: open(extra) ? 0.06 : 0.03, gain: (open(extra) ? 0.07 : 0.04) * g, dest }),
    tom: (t, g, dest, extra) => tone(t, { f0: 170 - idx(extra) * 20, f1: 80, d: 0.22, gain: 0.35 * g, dest }),
    crash: (t, g, dest) => burst(t, { filter: 'highpass', f0: 5000, d: 1.4, gain: 0.12 * g, wet: 0.4, dest }),
  },
  electro: {
    kick: (t, g, dest) => tone(t, { f0: 150, f1: 45, d: 0.6, gain: 0.7 * g, glide: 0.05, drive: 2, dest }),
    snare(t, g, dest) {
      for (const dt of [0, 0.011, 0.023]) burst(t + dt, { filter: 'bandpass', f0: 1200, q: 1, d: 0.02, gain: 0.25 * g, dest })
      burst(t + 0.03, { filter: 'bandpass', f0: 1200, q: 1, d: 0.18, gain: 0.25 * g, wet: 0.3, dest })
    },
    hat: (t, g, dest, extra) => burst(t, { filter: 'highpass', f0: 9000, d: open(extra) ? 0.08 : 0.02, gain: (open(extra) ? 0.08 : 0.05) * g, dest }),
    tom: (t, g, dest, extra) => tone(t, { f0: 220 - idx(extra) * 30, f1: 120, d: 0.2, gain: 0.4 * g, dest }),
    crash: (t, g, dest) => burst(t, { filter: 'highpass', f0: 6000, d: 1.2, gain: 0.1 * g, wet: 0.3, dest }),
  },
  tight: {
    kick(t, g, dest) {
      tone(t, { f0: 180, f1: 60, d: 0.12, gain: 0.6 * g, glide: 0.03, dest })
      burst(t, { filter: 'highpass', f0: 3000, d: 0.005, gain: 0.2 * g, dest })
    },
    snare(t, g, dest) {
      tone(t, { type: 'triangle', f0: 330, f1: 250, d: 0.06, gain: 0.2 * g, dest })
      burst(t, { filter: 'highpass', f0: 2500, d: 0.09, gain: 0.3 * g, wet: 0.15, dest })
    },
    hat: (t, g, dest, extra) => burst(t, { filter: 'highpass', f0: 10000, d: open(extra) ? 0.04 : 0.015, gain: (open(extra) ? 0.08 : 0.05) * g, dest }),
    tom: (t, g, dest, extra) => tone(t, { f0: 300 - idx(extra) * 40, f1: 180, d: 0.1, gain: 0.35 * g, dest }),
    crash: (t, g, dest) => burst(t, { filter: 'highpass', f0: 7000, d: 0.8, gain: 0.1 * g, wet: 0.3, dest }),
  },
  industrial: {
    kick(t, g, dest) {
      tone(t, { f0: 120, f1: 40, d: 0.35, gain: 0.45 * g, glide: 0.06, drive: 6, dest })
      burst(t, { color: 'brown', filter: 'lowpass', f0: 300, d: 0.1, gain: 0.3 * g, drive: 4, dest })
    },
    snare(t, g, dest) {
      burst(t, { filter: 'bandpass', f0: 2500, q: 0.5, d: 0.2, gain: 0.25 * g, drive: 6, wet: 0.3, dest })
      metal(t, { f: 420, d: 0.25, gain: 0.06 * g, wet: 0.2, dest })
    },
    hat: (t, g, dest, extra) => burst(t, { filter: 'bandpass', f0: 5000, q: 6, d: open(extra) ? 0.08 : 0.04, gain: (open(extra) ? 0.12 : 0.08) * g, dest }),
    tom: (t, g, dest, extra) => tone(t, {
      type: 'square', f0: 120 - idx(extra) * 15, f1: 60, d: 0.2, gain: 0.15 * g,
      filter: 'lowpass', fc: 600, drive: 3, dest,
    }),
    crash: (t, g, dest) => burst(t, { filter: 'highpass', f0: 3000, d: 1.5, gain: 0.1 * g, drive: 3, wet: 0.4, dest }),
  },
  taiko: {
    kick(t, g, dest) {
      tone(t, { f0: 90, f1: 50, d: 0.7, gain: 0.7 * g, glide: 0.1, dest })
      burst(t, { color: 'brown', filter: 'lowpass', f0: 500, d: 0.2, gain: 0.4 * g, wet: 0.4, dest })
    },
    snare(t, g, dest) {
      tone(t, { type: 'triangle', f0: 900, d: 0.03, gain: 0.2 * g, dest })
      burst(t, { filter: 'bandpass', f0: 3000, q: 3, d: 0.03, gain: 0.2 * g, wet: 0.3, dest })
    },
    hat: (t, g, dest, extra) => burst(t, { filter: 'bandpass', f0: 6000, q: 1, a: 0.01, d: open(extra) ? 0.06 : 0.035, gain: 0.05 * g, dest }),
    tom(t, g, dest, extra) {
      const i = idx(extra)
      tone(t, { f0: 140 - i * 15, f1: 70, d: 0.4, gain: 0.5 * g, dest })
      burst(t, { color: 'brown', filter: 'lowpass', f0: 400, d: 0.15, gain: 0.25 * g, dest })
    },
    crash(t, g, dest) {
      tone(t, { f0: 70, f1: 40, d: 1.2, gain: 0.5 * g, wet: 0.5, dest })
      burst(t, { color: 'brown', filter: 'lowpass', f0: 600, d: 0.8, gain: 0.4 * g, wet: 0.5, dest })
    },
  },
}
