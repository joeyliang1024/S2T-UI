# 自動講者分離 API 契約

S2T UI 不以音量、停頓或 VAD 推測講者。錄音結束後，使用者從「記錄」選擇「自動識別講者」，Electron Main 會以 `multipart/form-data` 上傳完整 PCM16 WAV。

## Request

```text
POST <設定的講者分離 endpoint>
Authorization: Bearer <儲存在 Electron safeStorage 的 API key>
Content-Type: multipart/form-data

model=<設定的 model ID>
file=@recording.wav;type=audio/wav
```

## Response

接受下列任一根節點：`exclusive_diarization`、`segments`、`diarization`。每個 turn 使用秒或毫秒時間戳。

```json
{
  "exclusive_diarization": [
    { "start": 0.24, "end": 2.91, "speaker": "SPEAKER_00" },
    { "start": 2.91, "end": 5.12, "speaker": "SPEAKER_01" }
  ]
}
```

或：

```json
{ "segments": [{ "start_ms": 240, "end_ms": 2910, "speaker": "講者 1" }] }
```

`exclusive_diarization` 優先，因為它不包含重疊講者 turn，最適合映射到單一字幕。S2T UI 對每個 ASR segment 選擇時間重疊最多的 turn，保留 ASR 原本的時間範圍與文字。

此 API 不屬於 OpenAI 通用規格。設定 endpoint、model 和 API key 後，在「記錄」執行一次即可；API key 不會傳入 Renderer 或 Web 版。
