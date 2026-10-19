// Silero VAD 機率產生器（評測用）：把 16 kHz PCM 逐 512 樣本視窗打分，回傳
// 每視窗一個機率的 Float32Array。餵法契約與 server/silero-vad.cjs 完全一致
// （前一視窗尾 64 樣本 + 本視窗 512 樣本 = 576，recurrent state 跨視窗延續）；
// 少餵 context 不會報錯，但機率會塌到 ~0.003，全部誤判為靜音。
//
// 用法：
//   const { createSileroScorer } = require('./silero-probabilities.cjs')
//   const scorer = await createSileroScorer()               // 載入模型一次
//   const probabilities = await scorer.probabilities16k(samples16k)

const WINDOW_SAMPLES = 512
const CONTEXT_SAMPLES = 64

const modelFile = () => require('../../server/silero-vad.cjs').modelPath()

const createSileroScorer = async () => {
  process.env.ORT_DISABLE_TELEMETRY_EVENTS = '1'
  const ort = require('onnxruntime-node')
  const session = await ort.InferenceSession.create(modelFile(), { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 1 })
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  let context = new Float32Array(CONTEXT_SAMPLES)

  /** @param {Float32Array} samples16k 16 kHz 單聲道 PCM。 @returns {Promise<Float32Array>} 每 512 樣本（32 ms）一個機率。 */
  const probabilities16k = async (samples16k) => {
    const frameCount = samples16k.length > 0 ? Math.ceil(samples16k.length / WINDOW_SAMPLES) : 0
    const probabilities = new Float32Array(frameCount)
    for (let offset = 0, index = 0; offset < samples16k.length; offset += WINDOW_SAMPLES, index += 1) {
      // 每次呼叫都開新 buffer：onnxruntime 可能在推論期間持有 reference。
      const frame = new Float32Array(WINDOW_SAMPLES + CONTEXT_SAMPLES)
      frame.set(context, 0)
      frame.set(samples16k.subarray(offset, Math.min(offset + WINDOW_SAMPLES, samples16k.length)), CONTEXT_SAMPLES)
      const output = await session.run({ input: new ort.Tensor('float32', frame, [1, WINDOW_SAMPLES + CONTEXT_SAMPLES]), state, sr: new ort.Tensor('int64', BigInt64Array.of(16_000n), []) })
      probabilities[index] = Number(output.output.data[0])
      state = output.stateN
      context = frame.slice(-CONTEXT_SAMPLES)
    }
    return probabilities
  }

  /** 注意：state/context 會跨呼叫延續；每個評測 preset 應各自 createSileroScorer。 */
  return { probabilities16k }
}

module.exports = { createSileroScorer, WINDOW_SAMPLES, CONTEXT_SAMPLES }
