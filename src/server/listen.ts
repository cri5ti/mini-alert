import { createServer } from 'node:http'
import { Buffer } from 'node:buffer'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { decodeClientMessage, encodeServerFrame } from '../shared/codec.ts'
import { Channel, type LobbyClientMessage } from '../shared/lobby.ts'
import { SIM_STEP } from '../shared/motion.ts'
import type { ServerFrame } from '../shared/protocol.ts'
import { runFixedStep } from './clock.ts'
import { Lobby, type LobbySocket } from './lobby.ts'
import { loadSaves, saveIntervalMs, saveSaves } from './save.ts'
import { serveClient } from './static.ts'
import { instantBuilds } from './instant.ts'
import { __TRACE__, traceCommit, traceDrain, traceReset, traceTally } from './trace.ts'

const PORT = Number(process.env.PORT) || 8787
const STEP = SIM_STEP
const PING_MS = 5000
const MISSED_PINGS = 3
const REPORT_MS = 60_000
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist')

const lobby = new Lobby()
loadSaves(lobby)
lobby.onSave = () => {
  try {
    saveSaves(lobby)
  } catch (err) {
    console.error('save failed', err)
  }
}
const httpServer = createServer((req, res) => {
  serveClient(clientRoot, req, res)
})
const sockets = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  perMessageDeflate: { threshold: 0 },
})

const missed = new WeakMap<WebSocket, number>()

sockets.on('connection', (socket, request) => {
  missed.set(socket, 0)
  socket.on('pong', () => missed.set(socket, 0))
  const link: LobbySocket = {
    send(message) {
      send(socket, Channel.Lobby, message)
    },
    sendGame(message) {
      sendGame(socket, message)
    },
    close() {
      socket.close()
    },
  }
  const member = lobby.connect(link, query(request.url, 'seat'))
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      const command = decodeClientMessage(bytesOf(data))
      if (command) lobby.onGame(member, command.message, command.seq, command.tick)
      return
    }
    const wire = readWire(data)
    if (!wire) return
    if (wire.channel === Channel.Lobby) lobby.onLobby(member, wire.message as LobbyClientMessage)
  })
  socket.on('close', () => lobby.disconnect(member))
})

const load = { ticks: 0, busy: 0, worst: 0, since: performance.now() }
runFixedStep(STEP * 1000, () => {
  __TRACE__ && traceReset()
  const started = performance.now()
  lobby.tick(STEP)
  const spent = performance.now() - started
  load.ticks += 1
  load.busy += spent
  load.worst = Math.max(load.worst, spent)
  if (!__TRACE__) return
  const report = traceCommit(spent, STEP * 1000)
  if (!report) return
  lobby.pushTrace(report.samples, report.budget)
  traceTally(report)
})
setInterval(() => {
  const seconds = (performance.now() - load.since) / 1000
  const rate = load.ticks / seconds
  console.log(`ticks ${rate.toFixed(1)}/s of ${(1 / STEP).toFixed(0)}, avg ${(load.busy / Math.max(1, load.ticks)).toFixed(1)} ms, max ${load.worst.toFixed(1)} ms`)
  const trace = traceDrain()
  if (trace) console.log(trace)
  Object.assign(load, { ticks: 0, busy: 0, worst: 0, since: performance.now() })
}, REPORT_MS)
setInterval(() => {
  for (const socket of sockets.clients) {
    const count = missed.get(socket) ?? 0
    if (count >= MISSED_PINGS) {
      socket.terminate()
      continue
    }
    missed.set(socket, count + 1)
    socket.ping()
  }
}, PING_MS)
setInterval(() => lobby.onSave(), saveIntervalMs())

let closed = false
function shutdown() {
  if (closed) return
  closed = true
  lobby.onSave()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`server listening on ${PORT}${instantBuilds() ? ', instant builds' : ''}`)
})

function query(url: string | undefined, name: string): string | null {
  if (!url) return null
  return new URL(url, 'http://localhost').searchParams.get(name)
}

function send(socket: { readyState: number; send(data: string): void }, channel: Channel, message: unknown) {
  if (socket.readyState !== 1) return
  socket.send(JSON.stringify({ channel, message }))
}

function sendGame(socket: { readyState: number; send(data: Uint8Array): void }, message: ServerFrame) {
  if (socket.readyState !== 1) return
  socket.send(encodeServerFrame(message))
}

function bytesOf(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (typeof data === 'string') return Buffer.from(data)
  return new Uint8Array(data)
}

function textOf(data: RawData): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString()
  if (Array.isArray(data)) return Buffer.concat(data).toString()
  return data.toString()
}

function readWire(data: RawData): { channel: number; message: unknown } | null {
  try {
    const text = textOf(data)
    const wire = JSON.parse(text) as { channel?: unknown; message?: unknown }
    if (!wire || typeof wire.channel !== 'number' || !wire.message || typeof wire.message !== 'object') return null
    return { channel: wire.channel, message: wire.message }
  } catch {
    return null
  }
}
