# Silero VAD in the Python backend

[繁體中文](../guide/SILERO_VAD.zh-TW.md) | English

Install the full audio lock and supply `models/silero-vad/silero_vad.onnx` through a read-only model mount. Python's audio engine loads local weights; no Node native model runtime is required. Weights are not downloaded on application startup.

Browser EnergyVad chunking, optional server speech veto and diarization audio preprocessing are separate paths. Enabling Silero does not imply semantic sentence segmentation or speaker identity. Normal browser capture stays 3000ms/250ms; display merging is described in [caption speed](CAPTION_SPEED.md). See [models](MODELS.md) for paths and [reproduction](REPRODUCE.md) for validation.
