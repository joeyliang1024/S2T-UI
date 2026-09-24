# 程式目錄與責任

## Renderer

| 位置 | 責任 |
| --- | --- |
| `src/renderer/src/features/app/` | 應用程式狀態協調與既有畫面組裝。 |
| `src/renderer/src/features/capture/` | VAD 與 AudioWorklet 收音處理。 |
| `src/renderer/src/features/models/` | ASR 模型 adapter 與字幕事件契約。 |
| `src/renderer/src/features/speakers/` | 講者分離結果解析與字幕對應。 |
| `src/renderer/src/features/transcript/` | WAV 批次讀取與轉錄分段。 |
| `src/renderer/src/shared/services/` | 瀏覽器層的音訊、下載、HTTP、設定、暫存 storage 與逐字稿純函式。 |
| `src/renderer/src/shared/types.ts` | 跨 feature 共用型別。 |

`App.tsx` 只負責掛載 controller 與 view。後續新增功能必須放在對應 feature，不再把服務邏輯回填至 `App.tsx`。

## Server

| 位置 | 責任 |
| --- | --- |
| `server/index.cjs` | HTTP gateway 的路由組裝。 |
| `server/storage/config.cjs` | storage 環境變數驗證。 |
| `server/storage/local.cjs` | 本機 blob、config、vector fallback。 |
| `server/storage/remote.cjs` | MinIO、PostgreSQL、Milvus adapter 與 PostgreSQL 基礎 schema。 |
| `server/storage/index.cjs` | 建立並公開 `blob`、`config`、`vector` 三個 storage 介面。 |

遠端服務只要任一組環境變數已開始設定，就必須全部設定完整；完全未設定時才使用本機 adapter。憑證不能經 renderer 傳送或回傳。
