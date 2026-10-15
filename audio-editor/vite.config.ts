import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Connect, type Plugin } from 'vite'

const dir = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(dir, '..')
const presets = path.join(repo, 'packages/audio/presets')
const ALLOWED = new Set(['oneshots.json', 'engines.json', 'music.json', 'voice.json', 'space.json'])

function readBody(req: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function savePlugin(): Plugin {
  const handle: Connect.NextHandleFunction = (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    void readBody(req).then((raw) => {
      const body = JSON.parse(raw) as { file?: string; data?: unknown }
      if (!body.file || !ALLOWED.has(body.file)) {
        res.statusCode = 400
        res.end('unknown preset')
        return
      }
      fs.writeFileSync(path.join(presets, body.file), JSON.stringify(body.data, null, 2) + '\n')
      res.end('ok')
    }).catch((err: unknown) => {
      res.statusCode = 400
      res.end(err instanceof Error ? err.message : 'bad json')
    })
  }
  return {
    name: 'save-presets',
    configureServer(server) {
      server.middlewares.use('/__save', handle)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/__save', handle)
    },
  }
}

export default defineConfig({
  root: dir,
  server: {
    port: 5180,
    strictPort: true,
    fs: { allow: [repo] },
  },
  plugins: [savePlugin()],
})
