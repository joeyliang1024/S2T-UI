# Local audio models and optional GPU deployment

[繁體中文](../guide/SHERPA_ONNX.zh-TW.md) | English

Install Python audio dependencies from `backend/requirements-audio.lock`. Weights and native binaries live under `S2T_MODEL_DIR`, defaulting to `./models` from the repository root. They are mounted read-only and are not downloaded automatically at application startup.

```text
models/
├── silero-vad/
│   └── silero_vad.onnx
├── sherpa-onnx/
│   ├── sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx
│   └── 3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx
└── nemotron-3-diarization/
    ├── Nemotron-3-Diarization.q8_0.gguf
    └── runtime/<platform>-<architecture>/bin/nemo-speech
```

The native runtime resolver also checks `/opt/nemo-speech/bin/nemo-speech` for container installations. See `backend/app/audio_engine.py` for exact path selection and checksum validation.

Set `S2T_DIARIZATION_MODEL=sherpa-onnx-speaker-diarization` or `nemotron-3-diarization` for local diarization; leave remote endpoint/key empty. FFmpeg must be installed or supplied through `S2T_FFMPEG_PATH`. The full CPU backend image uses the `audio` target in `deploy/docker/backend.Dockerfile`.

## GPU

The optional H100/H200 image is `deploy/docker/audio-cuda.Dockerfile`, with the Compose overlay `deploy/compose/gpu.yaml`. Use `S2T_INFERENCE_BACKEND=cuda` for the supported native CUDA path. The host needs a compatible NVIDIA driver and container GPU support.

Nemotron checks CUDA runtime/device compatibility; requested CUDA does not silently fall back to CPU. Sherpa and Silero retain the application's CPU strategy. This setting does not control external ASR, translation, or summary services.

GPU deployment has not been verified on GPU hardware. The verified native path is Linux ARM64 CPU; see the [validation report](VALIDATION-REPORT-2026-10-24.md). A standalone optional Nemotron CLI image is defined by `deploy/docker/nemotron.Dockerfile`.

## Audio quality

Saved WAV files use the actual capture sample rate. Resampling must transform samples rather than only change the WAV header. Speaker embedding processing uses real resampling to the model input rate. Browser noise suppression is a requested browser constraint, not guaranteed denoising. Evaluate recognition and speaker quality with representative recordings before production use.
