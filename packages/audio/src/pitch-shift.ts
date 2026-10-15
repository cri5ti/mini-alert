// Granular pitch shifter. Changes pitch without changing duration, for voice lines.
import { audio } from './core.ts'

const PROCESSOR = `
class PitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.size = 8192;
    this.win = Math.round(sampleRate * 0.04);
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0;
    this.phase = 0;
    this.alive = true;
    this.port.onmessage = () => (this.alive = false);
  }
  read(b, pos) {
    pos = ((pos % this.size) + this.size) % this.size;
    const i = Math.floor(pos), f = pos - i;
    return b[i] * (1 - f) + b[(i + 1) % this.size] * f;
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    const W = this.win, inc = (1 - params.ratio[0]) / W;
    const chans = Math.min(2, output.length);
    for (let s = 0; s < output[0].length; s++) {
      const p1 = this.phase, p2 = (p1 + 0.5) % 1;
      const g1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p1);
      const g2 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p2);
      for (let ch = 0; ch < chans; ch++) {
        const b = this.buf[ch];
        const src = input[ch] || input[0];
        b[this.w] = src ? src[s] : 0;
        output[ch][s] = g1 * this.read(b, this.w - p1 * W) + g2 * this.read(b, this.w - p2 * W);
      }
      this.w = (this.w + 1) % this.size;
      this.phase = (((p1 + inc) % 1) + 1) % 1;
    }
    return this.alive;
  }
}
registerProcessor('pitch-shift', PitchShift);
`

let ready: Promise<void> | null = null
function pitchShiftReady() {
  ready ??= audio().audioWorklet.addModule(URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' })))
  return ready
}

export type PitchNode = AudioWorkletNode & { release: () => void }

export async function createPitchShift(ratio: number): Promise<PitchNode> {
  await pitchShiftReady()
  const node = new AudioWorkletNode(audio(), 'pitch-shift') as PitchNode
  node.parameters.get('ratio')!.value = ratio
  node.release = () => {
    node.port.postMessage('stop')
    node.disconnect()
  }
  return node
}
