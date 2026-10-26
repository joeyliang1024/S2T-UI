# Nemotron diarization

[繁體中文](../guide/NEMOTRON.zh-TW.md) | English

Set `S2T_DIARIZATION_MODEL=nemotron-3-diarization`. Prepare the GGUF and matching native `nemo-speech` runtime under `models/`, or use the container runtime path described in [models](MODELS.md). The Python audio engine converts input with FFmpeg and invokes the local runtime. Complete CPU backend images use the `audio` target; optional standalone CLI packaging is `deploy/docker/nemotron.Dockerfile`.

Linux ARM64 CPU has functional validation. GPU/H100/H200 hardware has not been validated. Requested CUDA must not silently become CPU. Diarization identifies turns, not transcription/translation, and still needs prepared weights; enabling it does not start a local ASR model. See [GPU](GPU.md) and [deployment](DEPLOYMENT.md).
