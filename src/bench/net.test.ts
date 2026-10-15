import { describe, expect, it } from 'vitest'
import { Link, runCase, Scenario, type CaseSpec, type Row } from './net.ts'

function untimed(row: Row) {
  return { ...row, server: null }
}

describe('network bench', () => {
  it.each<[string, CaseSpec]>([
    ['battle-128 wan', { scenario: Scenario.Battle, size: 128, link: Link.Wan, seed: 11, seconds: 5 }],
    ['cities-128 bad', { scenario: Scenario.Cities, size: 128, link: Link.Bad, seed: 11, seconds: 5 }],
  ])('repeats %s exactly apart from the ms timings', async (_name, spec) => {
    const first = await runCase(spec)
    const second = await runCase(spec)
    expect(first.clients[0].framesPerSec).toBeGreaterThan(0)
    expect(first.commands.length).toBeGreaterThan(0)
    expect(untimed(second)).toEqual(untimed(first))
  }, 60_000)
})
