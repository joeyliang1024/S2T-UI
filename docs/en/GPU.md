# Optional GPU deployment

[繁體中文](../guide/GPU.zh-TW.md) | English

The optional Python CUDA image is `deploy/docker/audio-cuda.Dockerfile`; Compose overlay is `deploy/compose/gpu.yaml`. Prepare compatible NVIDIA driver/container GPU support, model weights and the native runtime. Configure backend settings, not frontend secrets. `S2T_INFERENCE_BACKEND=cuda` selects the supported native CUDA path; requested CUDA does not silently fall back to CPU. Sherpa/Silero retain their configured CPU strategy.

H100/H200 deployment has not been tested on physical GPU hardware. Verified Linux ARM64 CPU behavior does not establish GPU support or capacity. This option does not change external ASR/translation/summary inference. Temporary Apple Silicon MLX research is a separate test environment, not the deployed backend's GPU implementation. See [models](MODELS.md), [deployment](DEPLOYMENT.md) and [reproduction](REPRODUCE.md).
