# Sherpa ONNX models

[繁體中文](../guide/SHERPA_ONNX.zh-TW.md) | English

Install `backend/requirements-audio.lock` and mount model weights read-only under `S2T_MODEL_DIR`. Set `S2T_DIARIZATION_MODEL=sherpa-onnx-speaker-diarization` for local diarization and leave remote endpoint/key empty. Segmentation and 3Dspeaker embedding weights are separate artifacts. Exact paths and sample conversion live in `backend/app/audio_engine.py`.

Install FFmpeg or set `S2T_FFMPEG_PATH`; use the backend Docker `audio` target. Do not install removed Node native packages. Backend integration tests exercise segmentation, embeddings, persistence, matching and cleanup; these are not general speaker-accuracy benchmarks. See [models](MODELS.md), [audio quality](AUDIO_QUALITY.md) and [reproduction](REPRODUCE.md).
