import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Lobby } from './lobby.ts'
import { MAP_VERSION } from './mapgen/version.ts'
import './state.ts'

/** Seconds between full-state writes. Override with the SAVE_SECONDS environment variable. */
export const SAVE_SECONDS = 30

const retain = new Map<string, Set<string>>()

export function saveIntervalMs(): number {
  const raw = Number(process.env.SAVE_SECONDS)
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : SAVE_SECONDS
  return seconds * 1000
}

export function saveDir(): string {
  return resolve(process.env.SAVE_DIR || 'saves')
}

export function loadSaves(lobby: Lobby, dir = saveDir()) {
  const root = resolve(dir)
  const kept = new Set<string>()
  retain.set(root, kept)
  if (!existsSync(root)) return
  const hallPath = join(root, 'hall.json')
  if (existsSync(hallPath)) {
    try {
      lobby.loadHall(JSON.parse(readFileSync(hallPath, 'utf8')))
    } catch (err) {
      console.error('skip hall save', err)
    }
  }
  const requestsPath = join(root, 'requests.json')
  if (existsSync(requestsPath)) {
    try {
      lobby.loadBoard(JSON.parse(readFileSync(requestsPath, 'utf8')))
    } catch (err) {
      console.error('skip requests save', err)
    }
  }
  let restored = 0
  for (const name of readdirSync(root)) {
    if (gameFileId(name) === null) continue
    const path = join(root, name)
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { mapVersion?: unknown; game?: unknown }
      if (file.mapVersion !== MAP_VERSION) {
        console.log(`skipped ${name}: map version ${String(file.mapVersion)}, server is ${MAP_VERSION}`)
        kept.add(name)
        continue
      }
      if (lobby.loadGame(file.game)) restored += 1
    } catch (err) {
      console.error(`skipped ${name}`, err)
      kept.add(name)
    }
  }
  lobby.loadDone()
  if (restored > 0) console.log(`restored ${restored} ${restored === 1 ? 'game' : 'games'}`)
}

export function saveSaves(lobby: Lobby, dir = saveDir()) {
  const root = resolve(dir)
  mkdirSync(root, { recursive: true })
  const active = new Set<number>()
  const failed = new Set<number>()
  for (const id of lobby.gameIds()) {
    try {
      atomicWrite(join(root, `game-${id}.json`), { mapVersion: MAP_VERSION, game: lobby.saveGame(id) })
      active.add(id)
    } catch (err) {
      failed.add(id)
      console.error(`save game ${id} failed`, err)
    }
  }
  const kept = retain.get(root) ?? new Set<string>()
  for (const name of readdirSync(root)) {
    const id = gameFileId(name)
    if (id === null || active.has(id) || failed.has(id) || kept.has(name)) continue
    unlinkSync(join(root, name))
  }
  atomicWrite(join(root, 'hall.json'), lobby.savedHall())
  atomicWrite(join(root, 'requests.json'), lobby.savedBoard())
}

function atomicWrite(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, file)
}

function gameFileId(name: string): number | null {
  const match = /^game-(\d+)\.json$/.exec(name)
  if (!match) return null
  return Number(match[1])
}
