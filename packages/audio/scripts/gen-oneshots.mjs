// Initial one-shot presets. oneshots.json is the file the editor saves.
// Regenerating replaces that file: node packages/audio/scripts/gen-oneshots.mjs --force
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const r = (n, d = 3) => {
  const m = 10 ** d
  return Math.round((n + Number.EPSILON) * m) / m
}

function cannon(s, wet, at = 0) {
  return [
    { op: 'burst', at, color: 'white', filter: 'highpass', f0: 1500, d: r(0.03 + 0.03 * s), gain: 0.7, drive: 6, wet: r(wet) },
    {
      op: 'burst', at, color: 'pink', filter: 'lowpass', f0: r(6000 - 2000 * s, 0), f1: 180, a: 0.001,
      hold: r(0.02 + 0.04 * s), d: r(0.35 + s), gain: 1, drive: 8, wet: r(wet),
    },
    {
      op: 'burst', at, color: 'brown', filter: 'lowpass', f0: 180, f1: 60, q: 0.9, a: 0.006,
      hold: r(0.05 * s), d: r(0.8 + 1.8 * s), gain: r(0.8 + 0.2 * s), wet: r(wet * 1.5),
    },
    {
      op: 'burst', at: r(at + 0.25 + 0.2 * s), color: 'pink', filter: 'lowpass', f0: 900, f1: 200, a: 0.02,
      d: r(0.6 + s), gain: r(0.15 + 0.2 * s), wet: 0.9,
    },
  ]
}

function explosion(p) {
  const wet = r(0.35 + 0.5 * p)
  const steps = [
    { op: 'burst', at: 0, color: 'white', filter: 'highpass', f0: 900, d: r(0.04 + 0.06 * p), gain: 0.6, drive: 5, wet },
    {
      op: 'burst', at: 0, color: 'pink', filter: 'lowpass', f0: r(2000 + 3000 * p, 0), f1: 150, a: 0.004,
      hold: r(0.03 + 0.12 * p), d: r(0.5 + 2 * p), gain: 1, drive: 6, wet,
    },
    {
      op: 'burst', at: 0, color: 'brown', filter: 'lowpass', f0: 220, f1: 55, q: 0.9, a: r(0.02 + 0.05 * p),
      hold: r(0.1 + 0.4 * p), d: r(1.2 + 3.5 * p), gain: 0.9, wet,
    },
    {
      op: 'tone', at: 0, type: 'sine', f0: r(55 - 15 * p, 1), f1: 28, a: 0.01,
      hold: r(0.05 + 0.2 * p), d: r(0.8 + 2 * p), gain: r(0.5 + 0.3 * p),
    },
    {
      op: 'scatter', at: 0.05, dur: r(0.5 + 2 * p), count: Math.round(6 + 30 * p), skew: 1.5,
      steps: [{ op: 'burst', color: 'white', filter: 'bandpass', f0: [800, 3000], q: 2, d: [0.01, 0.04], gain: [0.03, 0.12], pan: [-0.4, 0.4] }],
    },
  ]
  if (p > 0.4) {
    steps.push(
      { op: 'burst', at: [0.25, 0.4], color: 'pink', filter: 'lowpass', f0: 500, f1: 150, a: 0.05, d: r(1 + p), gain: r(0.3 * p), wet: 0.9 },
      { op: 'burst', at: [0.7, 0.9], color: 'pink', filter: 'lowpass', f0: 350, f1: 120, a: 0.08, d: r(1.2 + p), gain: r(0.2 * p), wet: 0.9 },
    )
  }
  return steps
}

function shift(steps, dt) {
  return steps.map((s) => {
    if (s.op === 'repeat') return s
    const at = s.at ?? 0
    const next = Array.isArray(at) ? [r(at[0] + dt), r(at[1] + dt)] : r(at + dt)
    return { ...s, at: next }
  })
}

function cookoff(at, dur, count) {
  return {
    op: 'scatter', at, dur, count, skew: 1,
    steps: [
      { op: 'burst', color: 'white', filter: 'highpass', f0: 1500, d: 0.04, gain: [0.2, 0.4], drive: 3, wet: 0.4 },
      { op: 'burst', color: 'brown', filter: 'lowpass', f0: 250, d: 0.3, gain: 0.4 },
    ],
  }
}

const notes = [523.25, 659.25, 783.99, 1046.5]
const complete = []
for (let i = 0; i < notes.length; i++) {
  const last = i === notes.length - 1
  const at = r(i * 0.1)
  const hold = last ? 0.2 : 0
  const d = last ? 0.6 : 0.25
  const wet = last ? 0.4 : 0.15
  complete.push({ op: 'tone', at, type: 'triangle', f0: notes[i], hold, d, gain: 0.18, wet })
  complete.push({ op: 'tone', at, type: 'square', f0: r(notes[i] * 2, 2), hold, d, gain: 0.03, wet })
}

const invalid = []
for (const at of [0, 0.2]) {
  invalid.push(
    { op: 'tone', at, type: 'square', f0: 130, hold: 0.1, d: 0.05, gain: 0.15, filter: 'lowpass', fc: 1200 },
    { op: 'tone', at, type: 'sawtooth', f0: 137, hold: 0.1, d: 0.05, gain: 0.15, filter: 'lowpass', fc: 1200 },
  )
}

function sound(id, group, label, game, spatial, steps, extra = {}) {
  return { id, group, label, game, spatial, ...extra, steps }
}

const sounds = [
  sound('weapon.mg', 'weapon', 'Machine gun', 'One scout round. Loop to hear the 0.08s cyclic rate.', true, [
    { op: 'burst', at: 0, color: 'white', filter: 'highpass', f0: 2500, d: 0.03, gain: 0.5, drive: 3, wet: 0.1 },
    { op: 'burst', at: 0, color: 'pink', filter: 'lowpass', f0: 3500, f1: 500, d: 0.08, gain: 0.7, drive: 4, wet: 0.2 },
    { op: 'burst', at: 0, color: 'brown', filter: 'lowpass', f0: 200, d: 0.12, gain: 0.5 },
  ], { repeatMs: 80 }),
  sound('weapon.gunship', 'weapon', 'Gunship cannon', 'Gunship shell, one round.', true, cannon(0.35, 0.35)),
  sound('weapon.shell-med', 'weapon', 'Medium shell', 'Medium tank shell, one round.', true, [
    ...cannon(0.6, 0.4),
    { op: 'metal', at: 0.6, f: 900, d: 0.25, gain: 0.03, wet: 0.1 },
  ]),
  sound('weapon.shell-heavy', 'weapon', 'Heavy shell', 'Heavy tank shell, one round.', true, cannon(1, 0.55)),
  sound('weapon.howitzer', 'weapon', 'Howitzer', 'Artillery shell, one round. The sim fires the pair 0.4s apart.', true, [
    ...cannon(1, 0.6),
    { op: 'burst', at: 0.9, color: 'pink', filter: 'lowpass', f0: 400, f1: 120, a: 0.08, d: 1.6, gain: 0.22, wet: 0.95 },
  ]),
  sound('weapon.incoming', 'weapon', 'Incoming shell', 'Artillery round in the air, played at the target.', true, [
    { op: 'tone', at: 0, type: 'sine', f0: 900, f1: 280, a: 0.05, d: 0.7, gain: 0.08, filter: 'bandpass', fc: 1200, q: 2 },
    { op: 'burst', at: 0, color: 'white', filter: 'bandpass', f0: 700, f1: 1400, q: 0.8, a: 0.1, d: 0.55, gain: 0.12 },
  ]),
  sound('weapon.rocket', 'weapon', 'Rocket launch', 'Jet rocket leaving the rail.', true, [
    { op: 'burst', at: 0, color: 'white', filter: 'highpass', f0: 2200, d: 0.02, gain: 0.35, drive: 3 },
    { op: 'burst', at: 0, color: 'pink', filter: 'bandpass', f0: 400, f1: 2400, q: 0.8, a: 0.04, d: 0.45, gain: 0.55, wet: 0.2 },
    { op: 'burst', at: 0, color: 'brown', filter: 'lowpass', f0: 200, f1: 80, a: 0.02, d: 0.5, gain: 0.4 },
    { op: 'tone', at: 0, type: 'sawtooth', f0: 90, f1: 140, a: 0.05, d: 0.35, gain: 0.08, filter: 'lowpass', fc: 600 },
  ]),
  sound('weapon.naval', 'weapon', 'Naval gun', 'Cruiser shell, one round, with the slap off the water.', true, [
    ...cannon(0.9, 0.95),
    { op: 'burst', at: 0.5, color: 'pink', filter: 'lowpass', f0: 500, d: 1.2, gain: 0.2, wet: 0.9 },
  ]),
  sound('weapon.turret', 'weapon', 'Turret gun', 'Turret shell, one round, with the breech cycling.', true, [
    ...cannon(0.65, 0.45),
    { op: 'burst', at: 0.28, color: 'white', filter: 'bandpass', f0: 1200, q: 3, d: 0.06, gain: 0.25 },
    { op: 'metal', at: 0.3, f: 500, d: 0.3, gain: 0.05, wet: 0.1 },
  ]),
  sound('weapon.turret-slew', 'weapon', 'Turret slew', 'Turret acquiring a new target. Not every round.', true, [
    { op: 'tone', at: 0, type: 'sawtooth', f0: 180, f1: 260, a: 0.04, hold: 0.25, d: 0.08, gain: 0.1, filter: 'lowpass', fc: 900, vibrato: 4, vibratoRate: 18 },
    { op: 'burst', at: 0.32, color: 'brown', filter: 'lowpass', f0: 300, d: 0.08, gain: 0.35 },
  ]),

  sound('impact.bullet', 'impact', 'Bullet hit', 'A scout round that does not destroy the target.', true, [
    { op: 'burst', at: 0, color: 'white', filter: 'highpass', f0: 3000, d: 0.015, gain: 0.25 },
    { op: 'burst', at: 0, color: 'pink', filter: 'bandpass', f0: 1800, q: 1.2, d: 0.04, gain: 0.3 },
    { op: 'burst', at: 0, color: 'brown', filter: 'lowpass', f0: 250, d: 0.06, gain: 0.2 },
  ]),
  sound('impact.shell', 'impact', 'Shell hit', 'A shell impact that does not destroy the target.', true, explosion(0.22)),
  sound('impact.rocket', 'impact', 'Rocket hit', 'A jet rocket impact that does not destroy the target.', true, [
    ...explosion(0.62),
    { op: 'burst', at: 0.05, color: 'pink', filter: 'bandpass', f0: 300, f1: 900, a: 0.1, d: 1.1, gain: 0.45, wet: 0.35 },
  ]),
  sound('impact.splash', 'impact', 'Water impact', 'A round hitting open water.', true, [
    { op: 'burst', at: 0, color: 'white', filter: 'bandpass', f0: 800, f1: 2200, q: 0.7, a: 0.04, d: 0.9, gain: 0.45, wet: 0.35 },
    { op: 'burst', at: 0.12, color: 'white', filter: 'highpass', f0: 3000, a: 0.15, d: 0.8, gain: 0.12 },
    {
      op: 'scatter', at: 0.15, dur: 0.8, count: 8, skew: 1.2,
      steps: [{ op: 'tone', type: 'sine', f0: [500, 1100], f1Mul: 2.2, d: 0.04, gain: 0.04 }],
    },
  ]),
  sound('death.scout', 'impact', 'Scout destroyed', 'Scout car destroyed.', true, [
    ...explosion(0.3),
    { op: 'burst', at: 0.05, color: 'pink', filter: 'bandpass', f0: 300, f1: 900, a: 0.1, d: 1, gain: 0.4, wet: 0.3 },
    { op: 'scatter', at: 0.3, dur: 1, count: 4, skew: 1, steps: [{ op: 'metal', f: [900, 1600], d: 0.2, gain: 0.04 }] },
  ]),
  sound('death.med-tank', 'impact', 'Medium tank destroyed', 'Medium tank destroyed.', true, [
    ...explosion(0.55),
    { op: 'metal', at: 0, f: 220, d: 1.5, gain: 0.12, wet: 0.5 },
    cookoff(0.6, 2, 4),
  ]),
  sound('death.heavy-tank', 'impact', 'Heavy tank destroyed', 'Heavy tank destroyed.', true, [
    ...explosion(0.8),
    { op: 'metal', at: 0, f: 140, d: 2, gain: 0.15, wet: 0.5 },
    ...shift(explosion(0.3), 0.4),
    cookoff(0.8, 3, 8),
  ]),
  sound('death.artillery', 'impact', 'Artillery destroyed', 'Artillery destroyed. The ready ammunition cooks off.', true, [
    ...explosion(0.42),
    cookoff(0.25, 2.4, 7),
  ]),
  sound('death.gunship', 'impact', 'Gunship destroyed', 'Gunship shot down.', true, [
    ...explosion(0.5),
    { op: 'scatter', at: 0.3, dur: 1.5, count: 5, skew: 1.2, steps: [{ op: 'metal', f: [400, 1200], d: 0.3, gain: 0.04 }] },
  ]),
  sound('death.jet', 'impact', 'Jet destroyed', 'Jet shot down.', true, [
    { op: 'burst', at: 0, color: 'white', filter: 'bandpass', f0: 1800, f1: 400, q: 1, a: 0.9, d: 0.2, gain: 0.5 },
    ...shift(explosion(0.85), 1),
    { op: 'burst', at: 1, color: 'pink', filter: 'lowpass', f0: 900, a: 0.2, d: 2.5, gain: 0.4, wet: 0.4 },
  ]),
  sound('death.cruiser', 'impact', 'Cruiser destroyed', 'Cruiser sunk.', true, [
    ...explosion(0.5),
    { op: 'burst', at: 0.05, color: 'white', filter: 'bandpass', f0: 600, f1: 2500, q: 0.7, a: 0.05, d: 1.6, gain: 0.6, wet: 0.4 },
    { op: 'burst', at: 0.3, color: 'white', filter: 'highpass', f0: 3000, a: 0.3, d: 2, gain: 0.15 },
    {
      op: 'scatter', at: 0.6, dur: 2, count: 20, skew: 1.2,
      steps: [{ op: 'tone', type: 'sine', f0: [500, 1100], f1Mul: 2.2, d: 0.04, gain: 0.05 }],
    },
  ]),
  sound('death.turret', 'impact', 'Turret destroyed', 'Turret destroyed.', true, [
    ...explosion(0.48),
    { op: 'metal', at: 0, f: 180, d: 1.3, gain: 0.1, wet: 0.4 },
    cookoff(0.35, 1.6, 3),
  ]),
  sound('death.structure', 'impact', 'Structure destroyed', 'Factory, airport, helipad, or shipyard destroyed.', true, [
    ...explosion(0.75),
    { op: 'metal', at: 0, f: 90, d: 2.4, gain: 0.16, wet: 0.5 },
    { op: 'burst', at: 0.2, color: 'brown', filter: 'lowpass', f0: 140, f1: 40, a: 0.08, d: 2.8, gain: 0.75, wet: 0.45 },
    { op: 'scatter', at: 0.15, dur: 1.8, count: 8, skew: 1.3, steps: [{ op: 'metal', f: [200, 900], d: [0.3, 0.9], gain: [0.03, 0.08] }] },
  ]),
  sound('death.tree', 'impact', 'Tree felled', 'A tree is brought down.', true, [
    { op: 'burst', at: 0, color: 'white', filter: 'highpass', f0: 2000, d: 0.04, gain: 0.6, drive: 2 },
    { op: 'scatter', at: 0, dur: 0.35, count: 8, skew: 1.2, steps: [{ op: 'burst', color: 'white', filter: 'bandpass', f0: [1500, 3500], q: 3, d: 0.03, gain: [0.1, 0.3] }] },
    { op: 'tone', at: 0.15, type: 'sawtooth', f0: 90, f1: 55, a: 0.2, hold: 0.6, d: 0.5, gain: 0.25, filter: 'bandpass', fc: 700, q: 6, vibrato: 4, vibratoRate: 9 },
    { op: 'burst', at: 0.6, color: 'white', filter: 'bandpass', f0: 600, f1: 2500, q: 0.8, a: 1.1, d: 0.3, gain: 0.3 },
    { op: 'burst', at: 1.95, color: 'brown', filter: 'lowpass', f0: 300, f1: 70, d: 0.8, gain: 1, wet: 0.3 },
    { op: 'burst', at: 1.95, color: 'white', filter: 'bandpass', f0: 3000, q: 0.6, d: 0.8, gain: 0.25 },
    { op: 'scatter', at: 1.95, dur: 0.5, count: 10, skew: 1.5, steps: [{ op: 'burst', color: 'white', filter: 'bandpass', f0: [1200, 3000], q: 3, d: 0.025, gain: [0.05, 0.2] }] },
  ]),
  sound('death.city', 'impact', 'City razed', 'A city block is destroyed.', true, [
    ...explosion(1),
    { op: 'metal', at: 0.05, f: 70, d: 2.8, gain: 0.14, wet: 0.55 },
    { op: 'burst', at: 0.3, color: 'brown', filter: 'lowpass', f0: 100, f1: 35, a: 0.1, d: 3.2, gain: 0.8, wet: 0.5 },
    { op: 'scatter', at: 0.1, dur: 2.4, count: 14, skew: 1.4, steps: [{ op: 'burst', color: 'pink', filter: 'bandpass', f0: [400, 2000], q: 1.5, d: [0.04, 0.12], gain: [0.04, 0.12] }] },
  ]),

  sound('ui.select', 'interface', 'Select', 'A unit is selected.', false, [
    { op: 'tone', at: 0, type: 'triangle', f0: 740, f1: 1180, d: 0.045, gain: 0.14 },
  ]),
  sound('ui.move', 'interface', 'Move order', 'A move order is accepted. The voice line carries the acknowledgement.', false, [
    { op: 'tone', at: 0, type: 'sine', f0: 660, d: 0.05, gain: 0.2 },
    { op: 'tone', at: 0.06, type: 'sine', f0: 990, d: 0.08, gain: 0.2 },
  ]),
  sound('ui.attack', 'interface', 'Attack order', 'An attack order is accepted.', false, [
    { op: 'tone', at: 0, type: 'square', f0: 520, d: 0.05, gain: 0.15, filter: 'lowpass', fc: 2500 },
    { op: 'tone', at: 0.06, type: 'square', f0: 390, d: 0.06, gain: 0.15, filter: 'lowpass', fc: 2500 },
    { op: 'tone', at: 0.12, type: 'sawtooth', f0: 260, d: 0.12, gain: 0.18, filter: 'lowpass', fc: 1800 },
  ]),
  sound('ui.click', 'interface', 'Click', 'A button or build tile is clicked.', false, [
    { op: 'tone', at: 0, type: 'triangle', f0: 1800, f1: 1200, d: 0.02, gain: 0.2 },
    { op: 'burst', at: 0, color: 'white', filter: 'highpass', f0: 4000, d: 0.008, gain: 0.15 },
  ]),
  sound('ui.invalid', 'interface', 'Invalid', 'The order is refused. A voice line gives the reason.', false, invalid),
  sound('ui.place', 'interface', 'Building placed', 'A structure starts construction.', true, [
    { op: 'burst', at: 0, color: 'brown', filter: 'lowpass', f0: 300, f1: 80, a: 0.003, d: 0.35, gain: 0.9, drive: 2 },
    { op: 'burst', at: 0, color: 'pink', filter: 'bandpass', f0: 500, q: 1.5, d: 0.12, gain: 0.35 },
    { op: 'metal', at: 0.01, f: 170, d: 0.4, gain: 0.08, wet: 0.2 },
    { op: 'burst', at: 0.18, color: 'white', filter: 'bandpass', f0: 1400, q: 4, d: 0.02, gain: 0.2 },
    { op: 'burst', at: 0.24, color: 'white', filter: 'bandpass', f0: 1100, q: 4, d: 0.025, gain: 0.25 },
  ]),
  sound('ui.construct', 'interface', 'Construction', 'Played on a loop at the site while a structure is building.', true, [
    { op: 'burst', at: 0, color: 'brown', filter: 'lowpass', f0: 400, d: 0.05, gain: 0.25 },
    { op: 'burst', at: 0, color: 'white', filter: 'bandpass', f0: 1200, q: 2, d: 0.02, gain: 0.12 },
  ], { repeatMs: 260 }),
  sound('ui.complete', 'interface', 'Construction complete', 'A structure finishes. Pairs with the construction-complete voice line.', true, complete),
  sound('ui.ready', 'interface', 'Unit ready', 'A trained unit leaves the bay. Pairs with the unit-ready voice line.', true, [
    { op: 'tone', at: 0, type: 'triangle', f0: 523.25, d: 0.12, gain: 0.16, wet: 0.15 },
    { op: 'tone', at: 0.09, type: 'triangle', f0: 659.25, d: 0.12, gain: 0.16, wet: 0.15 },
    { op: 'tone', at: 0.18, type: 'triangle', f0: 783.99, hold: 0.08, d: 0.28, gain: 0.18, wet: 0.3 },
  ]),
  sound('ui.credits-in', 'interface', 'Credits in', 'Income tick. Loop while credits are arriving.', false, [
    { op: 'tone', at: 0, type: 'sine', f0: 2400, d: 0.03, gain: 0.14 },
    { op: 'tone', at: 0, type: 'triangle', f0: 3600, d: 0.015, gain: 0.05 },
  ], { repeatMs: 70 }),
  sound('ui.credits-out', 'interface', 'Credits out', 'Spend tick. Loop while credits are leaving.', false, [
    { op: 'tone', at: 0, type: 'square', f0: 900, d: 0.025, gain: 0.08, filter: 'lowpass', fc: 2500 },
    { op: 'burst', at: 0, color: 'white', filter: 'highpass', f0: 3000, d: 0.005, gain: 0.05 },
  ], { repeatMs: 70 }),
  sound('ui.radar', 'interface', 'Radar alert', 'Contact warning, with the under-attack voice line.', false, [
    { op: 'tone', at: 0, type: 'sine', f0: 1200, d: 0.25, gain: 0.12, wet: 0.3 },
    { op: 'tone', at: 0.12, type: 'square', f0: 880, d: 0.07, gain: 0.1, filter: 'lowpass', fc: 3000 },
    { op: 'tone', at: 0.22, type: 'square', f0: 660, d: 0.09, gain: 0.1, filter: 'lowpass', fc: 3000 },
  ]),
  sound('ui.capture', 'interface', 'City captured', 'A city flips. Pairs with the city-conquered voice line.', true, [
    { op: 'tone', at: 0, type: 'triangle', f0: 392, d: 0.09, gain: 0.16, wet: 0.25 },
    { op: 'tone', at: 0.1, type: 'triangle', f0: 523.25, d: 0.09, gain: 0.16, wet: 0.25 },
    { op: 'tone', at: 0.2, type: 'triangle', f0: 659.25, hold: 0.12, d: 0.4, gain: 0.18, wet: 0.4 },
    { op: 'tone', at: 0.2, type: 'sine', f0: 196, hold: 0.12, d: 0.45, gain: 0.08, wet: 0.3 },
  ]),
]

const out = join(dirname(fileURLToPath(import.meta.url)), '../presets/oneshots.json')
if (existsSync(out) && !process.argv.includes('--force')) {
  console.error('oneshots.json already exists. Pass --force to regenerate it.')
  process.exit(1)
}
writeFileSync(out, JSON.stringify(sounds, null, 2) + '\n')
console.log(sounds.length, 'sounds')
