/** A touch can start audio only on its release, not its press. */
const GESTURES = ['pointerup', 'keydown']

type AudioOutput = { connect(context: AudioContext): void }

export function unlockAudio(target: Pick<EventTarget, 'addEventListener'>, outputs: readonly AudioOutput[]) {
  let context: AudioContext | null = null
  const unlock = () => {
    if (!context) {
      if (!('AudioContext' in globalThis)) return
      context = new AudioContext()
      for (const output of outputs) output.connect(context)
    }
    if (context.state !== 'running') context.resume().catch(() => {})
  }
  for (const gesture of GESTURES) target.addEventListener(gesture, unlock)
}
