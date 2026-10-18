// One deployment switch. The CUDA profile accelerates Nemotron; the small
// sherpa and Silero models keep their existing CPU implementation.
// GPU placement belongs to Docker/Kubernetes; use its first visible device.
const inferenceConfig = (env = process.env) => {
  const backend = (env.S2T_INFERENCE_BACKEND?.trim() || 'cpu').toLowerCase()
  if (!['cpu', 'cuda'].includes(backend)) throw new Error('S2T_INFERENCE_BACKEND 必須是 cpu 或 cuda')
  return { backend, deviceId: 0 }
}

const verifyNemotronCuda = (doctor, deviceId) => {
  if (doctor?.features?.backend_cuda !== true) throw new Error('Nemotron runtime 未編入 CUDA；請使用 H100/H200 CUDA 映像')
  if (doctor.accelerator_available !== true || doctor.driver_runtime_compatible !== true) throw new Error('Nemotron CUDA 裝置或 driver/runtime 不可用；請檢查 GPU 掛載、NVIDIA driver 與 CUDA_VISIBLE_DEVICES')
  const devices = Array.isArray(doctor.devices) ? doctor.devices.filter(device => device?.type === 'gpu') : []
  if (deviceId >= devices.length) throw new Error(`Nemotron CUDA 邏輯裝置 ${deviceId} 不存在；doctor 僅找到 ${devices.length} 個 GPU，請檢查 容器／K8s 的 GPU 裝置分配`)
  return { backend: 'cuda', deviceId }
}

module.exports = { inferenceConfig, verifyNemotronCuda }
