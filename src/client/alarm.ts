import { ContactKind } from './render/radar.ts'

const samples = import.meta.glob('../../assets/alarm/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
})

type Takes<T> = { horns: T[]; lines: Record<ContactKind, T[]> }

export const TAKES: Takes<string> = {
  horns: takes('horn'),
  lines: { [ContactKind.Base]: takes('base'), [ContactKind.Unit]: takes('unit') },
}

export class Alarm {
  private output: GainNode | null = null
  private buffers: Takes<AudioBuffer> | null = null
  private playing: AudioBufferSourceNode | null = null
  private until = 0
  private on = true
  private volume = 1

  connect(context: AudioContext) {
    this.output = context.createGain()
    this.output.gain.value = this.volume
    this.output.connect(context.destination)
    decode(context).then((buffers) => {
      this.buffers = buffers
    })
  }

  setVolume(volume: number) {
    this.volume = volume
    if (this.output) this.output.gain.value = volume
  }

  setOn(on: boolean) {
    this.on = on
    if (on) return
    this.playing?.stop()
    this.playing = null
    this.until = 0
  }

  sound(kind: ContactKind) {
    const output = this.output
    if (!this.on || !output || !this.buffers || output.context.currentTime < this.until) return
    const sample = pick(pick([this.buffers.horns, this.buffers.lines[kind]]))
    this.playing = play(output, sample)
    this.until = output.context.currentTime + sample.duration
  }
}

function takes(name: string): string[] {
  return Object.entries(samples)
    .filter(([path]) => new RegExp(`/${name}-\\d+\\.mp3$`).test(path))
    .map((entry) => entry[1])
}

async function decode(context: AudioContext): Promise<Takes<AudioBuffer>> {
  const load = (urls: string[]) =>
    Promise.all(urls.map(async (url) => context.decodeAudioData(await (await fetch(url)).arrayBuffer())))
  const [horns, base, unit] = await Promise.all([
    load(TAKES.horns),
    load(TAKES.lines[ContactKind.Base]),
    load(TAKES.lines[ContactKind.Unit]),
  ])
  return { horns, lines: { [ContactKind.Base]: base, [ContactKind.Unit]: unit } }
}

function pick<T>(takes: T[]): T {
  return takes[Math.floor(Math.random() * takes.length)]
}

function play(output: AudioNode, buffer: AudioBuffer): AudioBufferSourceNode {
  const source = output.context.createBufferSource()
  source.buffer = buffer
  source.connect(output)
  source.start()
  return source
}
