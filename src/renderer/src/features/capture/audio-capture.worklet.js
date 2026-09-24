class S2tAudioCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    if (input) {
      const frame = input.slice()
      this.port.postMessage(frame.buffer, [frame.buffer])
    }
    for (const output of outputs[0] ?? []) output.fill(0)
    return true
  }
}

registerProcessor('s2t-audio-capture', S2tAudioCaptureProcessor)
