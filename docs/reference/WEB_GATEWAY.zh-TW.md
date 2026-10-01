# Web ASR Gateway

Web 版使用 Node.js BFF，避免將 ASR API key 暴露給瀏覽器。實作位於 [`server/index.cjs`](../../server/index.cjs)。

```text
Browser microphone
  → React AudioContext / VAD / WAV chunk
  → POST /api/transcriptions
  → Node BFF（環境模型或登入帳號的加密模型憑證）
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

- Request body：WAV、MP3、M4A/AAC、OGG、WebM、FLAC、MP4 或 MOV，單次上限 100 MB。
- Headers：`content-type`、`authorization: Bearer <token>`、`x-s2t-language`，可選 `x-s2t-prompt`、`x-s2t-model-id`。
- Response：`{ "text": "..." }`。
- 限制：每個來源 IP 每分鐘 60 次；不支援的 MIME 回傳 415，未支援的語言回傳 400。

### 帳號模型 registry

登入後可讀寫 `GET`／`POST /api/data/model-registry`，以版本號 CAS 保存 ASR、翻譯、摘要、講者分離與 Embedding 的名稱、endpoint、model ID、用途、能力與是否需要 key。模型 key 只可用 `POST /api/data/model-credentials/:modelId` 單向寫入，或以 `DELETE` 移除；讀取 registry 不會回傳 key。

Web 端對 `/api/transcriptions`、`/api/translations`、`/api/summaries`、`/api/diarizations` 傳入已註冊的 `x-s2t-model-id` 時，gateway 只會在同一登入帳號範圍解析 endpoint、model 和加密憑證。不能以 model ID 讀取其他帳號設定。

## 環境變數

| 變數 | 用途 |
| --- | --- |
| `S2T_ASR_API_KEY` | ASR key；只由 Electron Main 和 BFF 使用。 |
| `S2T_ASR_ENDPOINT` | 完整 `/v1/audio/transcriptions` URL。 |
| `S2T_ASR_MODEL` | 例如 `Breeze-ASR-25`。 |
| `S2T_ASR_MODELS_JSON` | 選用，多個環境 ASR profile 的 JSON array。 |
| `S2T_TRANSLATION_*`、`S2T_SUMMARY_*`、`S2T_DIARIZATION_*` | 各服務唯一的 endpoint、model、key 設定。 |
| `S2T_WEB_PORT` | BFF port，預設 8787。 |
| `S2T_WEB_ORIGINS` | 逗號分隔的額外允許 Web origin；同源部署自動允許。 |
| `S2T_AUTH_SECRET` | 正式部署必填的長隨機登入／模型憑證加密根密鑰；本機未設定時會在 local data directory 生成受權限保護的值。 |
| `S2T_LOG_LEVEL` | `debug` / `info`（預設）/ `warn` / `error` / `silent`。 |
| `S2T_LOG_FORMAT` | `text`（預設，人可讀）或 `json`（每行一個 JSON 物件，供 K8s 查詢）。 |

`VITE_*` 只能含可公開的顯示資訊，絕不可包含 API key。

## 日誌

Server 統一由 `server/logger.cjs` 輸出到 stdout，取代散落的 `console.log/error`。預設人可讀格式：

```
2026-10-01T10:12:31.381+08:00 INFO  gateway.started role=all pod=s2t-api-7d9c port=8787
2026-10-01T10:12:35.244+08:00 WARN  model.unavailable reason="找不到 Silero VAD 模型"
2026-10-01T10:12:40.952+08:00 INFO  http.request requestId=9f2c… method=POST path=/api/transcriptions status=200 durationMs=842
```

- 每行固定帶 `role`（`S2T_PROCESS_ROLE`）、`pod`（`HOSTNAME`）；在 HTTP request 內還會帶 `requestId`。
- 每個 HTTP request 生成一個 UUID，回傳在 `x-request-id` response header，並沿用到 ASR、翻譯、storage 與從該請求排入的背景 job；同一 ID 可跨服務串起整條請求。
- 分級：`info` 啟動／關閉、storage 連線、job 開始完成；`warn` 503、429、CAS conflict（409）、模型未就緒、queue 接近滿、登入失敗；`error` 未處理的 request 例外、worker crash、migration 失敗；`debug` 每個 request、ASR chunk、翻譯呼叫與 health probe，需 `S2T_LOG_LEVEL=debug` 才輸出。
- 絕不印出 API key、Authorization、Cookie、密碼、音檔、逐字稿全文與 prompt 全文，敏感欄位一律以 `[redacted]` 或長度標記取代。

## 部署注意事項

1. 使用 HTTPS；麥克風 API 在正式部署需要 secure context。
2. 以反向代理將靜態 `out/renderer` 與 BFF 掛在同一 origin，避免寬鬆 CORS。
3. gateway 已要求 Bearer token、登入限流、token 撤銷與各服務限流；正式服務仍應加反向代理 rate limit、request log 與監控。
4. BFF 只轉錄短 WAV chunks；大檔批次上傳需另建可取消的 job API。
