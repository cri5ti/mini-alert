import lobby1Url from '../../assets/music/lobby1.mp3?url'
import lobby2Url from '../../assets/music/lobby2.mp3?url'

const tracks = import.meta.glob('../../assets/music/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
})

const LOBBY = [lobby1Url, lobby2Url]
export const BATTLE = Object.entries(tracks)
  .filter(([path]) => !/\/lobby\d+\.mp3$/.test(path))
  .map((entry) => entry[1])

export class Music {
  private readonly audio = new Audio()
  private output: GainNode | null = null
  private volume = 1
  private queue: string[] = []
  private index = 0
  private mode: 'silent' | 'lobby' | 'match' = 'silent'
  private muted = false
  private blocked = false

  constructor() {
    this.audio.addEventListener('ended', () => this.advance())
  }

  /** iOS ignores a media element's volume, so once audio unlocks the level lives on a gain the element plays through. */
  connect(context: AudioContext) {
    this.output = context.createGain()
    this.output.gain.value = this.volume
    this.output.connect(context.destination)
    context.createMediaElementSource(this.audio).connect(this.output)
    this.audio.volume = 1
  }

  lobby() {
    if (this.mode === 'lobby') return
    this.mode = 'lobby'
    this.queue = LOBBY
    this.index = 0
    this.play(this.queue[0])
  }

  match() {
    if (this.mode === 'match') return
    this.mode = 'match'
    this.queue = shuffle(BATTLE)
    this.index = 0
    this.play(this.queue[0])
  }

  silent() {
    if (this.mode === 'silent') return
    this.mode = 'silent'
    this.audio.pause()
  }

  setVolume(volume: number) {
    this.volume = volume
    if (this.output) this.output.gain.value = volume
    else this.audio.volume = volume
  }

  setMuted(muted: boolean) {
    this.muted = muted
    if (muted) {
      this.audio.pause()
      return
    }
    if (this.mode === 'silent' || !this.audio.src) return
    this.audio
      .play()
      .then(() => {
        this.blocked = false
      })
      .catch(() => {
        this.blocked = true
      })
  }

  resume() {
    if (this.muted || !this.blocked || this.mode === 'silent') return
    this.audio
      .play()
      .then(() => {
        this.blocked = false
      })
      .catch(() => {})
  }

  private advance() {
    if (this.mode === 'silent' || this.queue.length === 0) return
    this.index += 1
    if (this.index >= this.queue.length) {
      this.queue = this.mode === 'match' ? shuffle(BATTLE) : LOBBY
      this.index = 0
    }
    this.play(this.queue[this.index])
  }

  private play(url: string | undefined) {
    if (!url) return
    this.audio.src = url
    if (this.muted) return
    this.audio
      .play()
      .then(() => {
        this.blocked = false
      })
      .catch(() => {
        this.blocked = true
      })
  }
}

function shuffle(urls: readonly string[]): string[] {
  const next = urls.slice()
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = next[i]
    next[i] = next[j]
    next[j] = swap
  }
  return next
}
