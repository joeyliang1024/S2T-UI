# Web ASR Gateway

Web 版使用 Node.js BFF，避免將 ASR API key 暴露給瀏覽器。實作位於 [`server/index.cjs`](../server/index.cjs)。

```text
Browser microphone
  → React AudioContext / VAD / WAV chunk
  → POST /api/transcriptions
  → Node BFF（.env 的 key）
  → OpenAI-compatible /v1/audio/transcriptions
  → { text }
  → final subtitle
```

## API

### `GET /api/config`

回傳 Web 可顯示的模型名稱與 model id，不回傳 endpoint 私密設定或 key。

```json
{
  "configured": true,
  "model": {
    "id": "web-environment-asr",
    "name": "Breeze-ASR-25",
    "model": "Breeze-ASR-25",
    "kind": "openai-http"
  }
}
```

### `POST /api/transcriptions`

- Request body：PCM16 WAV bytes。
- Headers：`content-type: audio/wav`、`x-s2t-language`，可選 `x-s2t-prompt`。
- Response：`{ "text": "..." }`。
- 限制：單次 12 MB、每個來源 IP 每分鐘 60 次。

## 環境變數

| 變數 | 用途 |
| --- | --- |
| `S2T_ASR_API_KEY` | ASR key；只由 Electron Main 和 BFF 使用。 |
| `S2T_ASR_ENDPOINT` | 完整 `/v1/audio/transcriptions` URL。 |
| `S2T_ASR_MODEL` | 例如 `Breeze-ASR-25`。 |
| `S2T_WEB_PORT` | BFF port，預設 8787。 |
| `S2T_WEB_ASR_*` | 可覆寫 Web 專用 endpoint、model、key、顯示名稱。 |
| `S2T_WEB_ORIGINS` | 逗號分隔的額外允許 Web origin；同源部署自動允許。 |

`VITE_*` 只能含可公開的顯示資訊，絕不可包含 API key。

## 部署注意事項

1. 使用 HTTPS；麥克風 API 在正式部署需要 secure context。
2. 以反向代理將靜態 `out/renderer` 與 BFF 掛在同一 origin，避免寬鬆 CORS。
3. 正式服務應再加登入 session／短期 token、反向代理 rate limit、request log 與監控。
4. BFF 只轉錄短 WAV chunks；大檔批次上傳需另建可取消的 job API。
