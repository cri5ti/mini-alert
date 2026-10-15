// Generate the Onyx radio lines in packages/audio/presets/voice.json.
// Skips takes that already exist. Pass --force to replace them.
//
//   OPENAI_API_KEY=sk-... node packages/audio/scripts/gen-voices.mjs
//   OPENAI_API_KEY=sk-... node packages/audio/scripts/gen-voices.mjs --force
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODEL = 'gpt-4o-mini-tts'
const VOICE = 'onyx'
const INSTRUCTIONS = 'Battle-hardened commander on a military radio. Low, calm, authoritative. Clipped and short.'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const presetPath = join(root, 'presets/voice.json')
const outDir = join(root, '../../assets/voices', VOICE)

const key = process.env.OPENAI_API_KEY
if (!key) {
  console.error('Set OPENAI_API_KEY')
  process.exit(1)
}
const force = process.argv.includes('--force')
const preset = JSON.parse(await readFile(presetPath, 'utf8'))
const lines = [...new Set(preset.phrases.flatMap((phrase) => phrase.lines))]

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const exists = (file) => access(file).then(() => true, () => false)

await mkdir(outDir, { recursive: true })
for (const text of lines) {
  const file = join(outDir, `${slug(text)}.mp3`)
  if (!force && (await exists(file))) {
    console.log(`keep ${VOICE}/${slug(text)}.mp3`)
    continue
  }
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, instructions: INSTRUCTIONS, response_format: 'mp3' }),
  })
  if (!res.ok) {
    console.error(`${text}: ${res.status} ${await res.text()}`)
    process.exit(1)
  }
  await writeFile(file, Buffer.from(await res.arrayBuffer()))
  console.log(`${VOICE}/${slug(text)}.mp3`)
}
await writeFile(join(outDir, '..', 'manifest.json'), JSON.stringify({ voices: [VOICE] }, null, 2) + '\n')
console.log('done')
