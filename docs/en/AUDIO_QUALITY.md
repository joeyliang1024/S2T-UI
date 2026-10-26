# Sample rates and audio quality

[繁體中文](../reference/AUDIO_QUALITY.zh-TW.md) | English

Saved PCM/WAV uses the actual `AudioContext.sampleRate`; header and sample data must agree. When the selected ASR input rate differs, transform a separate inference branch using real streaming resampling; never relabel 48kHz samples as 16kHz. Original sample offsets remain the timing basis. Speaker embeddings use genuine conversion to their expected model rate.

Browser `noiseSuppression` is a requested getUserMedia constraint, not a guaranteed effect. It affects newly opened/replaced microphone streams and does not rewrite saved recordings. The selected processed stream supplies recording and ASR paths.

Compare native/16kHz inputs, suppression on/off, recognition error, speaker matching, actual WAV duration, subtitle offsets, transport size and end-to-end timing using representative speech. Functional conversion tests do not establish accuracy for every device or codec. See [models](MODELS.md), [recording](RECORDING_RELIABILITY.md) and [reproduction](REPRODUCE.md).
