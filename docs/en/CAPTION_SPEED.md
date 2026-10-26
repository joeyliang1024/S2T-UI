# Caption speed and display merging

[繁體中文](../guide/CAPTION_SPEED.zh-TW.md) | English

Updated 2026-10-26. Capture cadence and display-row merging are separate settings.

| Position | Label | Chunk target limit | Silence threshold |
| --- | --- | ---: | ---: |
| 1 | Fast | 1200ms | 150ms |
| 2 | — | 1500ms | 250ms |
| 3 | Normal | 3000ms | 250ms |
| 4 | — | 4000ms | 250ms |
| 5 | Slow | 6000ms | 250ms |

Common settings are 120ms onset, 300ms pre-roll, 12dB noise offset and 700ms configured minimum. Natural endpoints may dispatch earlier and normal short utterances may be shorter than the minimum. Under queue pressure, non-strict limits can expand to six seconds. Saved administrator overrides take precedence; the table describes healthy-load presets, not a universal hard limit.

Compatible punctuated rows below 40 normalized characters can accept the next chunk, previously 24. Speech boundaries, timing gaps, speaker/language changes, frozen groups and existing ten-second/70-character checks remain. A row can still split for these reasons. Canonical IDs, text and translations remain separate stored events. This changes display grouping, not ASR scheduling or model inference.

The four-second/400ms capture experiment was withdrawn. Historical model-quality figures do not measure the current display change. See [caption results](CAPTION_MERGE_2026-10-26.md) and [reproduction](REPRODUCE.md).
