# 自有模型接入契約

## 已實作的 WebSocket 第一版

在設定頁填入 `ws://` 或 `wss://` 端點後，應用會建立 `WebSocketModelAdapter`。它會先傳送下列 JSON：

```json
{"type":"start","streamId":"uuid","audioFormat":"f32le","channels":1,"sampleRate":48000,"language":"zh-TW","targetLanguage":"en"}
```

接著每個音訊 frame 都嚴格依序傳送一個 JSON header，再傳送一個單聲道、little-endian `Float32Array` 二進位訊框：

```json
{"type":"audio","streamId":"uuid","sequence":0,"startSample":0,"frameCount":4096}
```

`sequence` 用來偵測遺失／重複 frame，`startSample` 讓後端將結果映射回原始錄音時間軸；不得只憑接收時間猜測字幕時間。遇到 WebSocket 在途資料超過 2 MB 時，應用會暫停送入新 frame，以避免無限累積記憶體；後端應記錄 sequence 缺口並將其反映為可辨識的錯誤或時間缺口。

停止時會傳送 `{"type":"stop"}`。伺服器可持續回傳以下 JSON；`id` 相同且 `revision` 較高的事件會取代先前字幕：

```json
{"type":"transcript","id":"seg-1","revision":1,"status":"final","startMs":0,"endMs":1320,"sourceText":"你好","translatedText":"Hello"}
```

這是應用端的暫定 S2T 整合協定。你的 ASR gateway 應將 ASR 與翻譯模型的回應統一成 `transcript` 事件；若翻譯稍後完成，使用相同 `id` 與更高 `revision` 重送事件，並填入 `translatedText`。如此應用不需要知道兩種模型各自的 API。

## Breeze-ASR-26

`MediaTek-Research/Breeze-ASR-26` 是台語 ASR，並以中文漢字輸出；它不提供翻譯，也不是文字轉語音模型。此 Electron／TypeScript 專案不內嵌 Python 執行環境或模型推論服務。若要使用此模型，請將模型部署在你自己的服務中，並實作上述 WebSocket 協定，再於設定頁填入該服務端點。

Electron 應用已透過 `src/renderer/src/model-adapter.ts` 將收音與字幕 UI 分離。整合自有模型時，實作 `ModelAdapter` 並替換 `NoopModelAdapter` 即可；收音、音量、錄音、逐字稿版本控制與匯出不需要重寫。

模型適配器在 `start()` 收到音訊採樣率、來源語言及目標語言。收音期間，`pushAudio()` 會收到單聲道 Float32 PCM 分塊與從會議開始累積的樣本位移。模型需要其他格式時，在適配器中重採樣、量化或封裝，不要修改錄音分支。

模型回應需透過 `onTranscript()` 發出下列資訊：

| 欄位 | 用途 |
| --- | --- |
| `id` | 同一字幕段落的穩定識別值 |
| `revision` | 同一段落的更新版本；較舊結果不會覆蓋較新結果 |
| `status` | `partial` 或 `final` |
| `startMs`、`endMs` | 相對於此次錄音的時間範圍 |
| `sourceText` | 辨識原文 |
| `translatedText` | 可選譯文；如由獨立端點產生，仍須與原文 revision 對應 |

串流模型應持續更新相同 `id` 的 partial，完成時發出 final。只支援片段請求的模型可在 adapter 外側加入切段器；切段前後的緩衝時間與原始樣本 offset 必須保留，才能維持 SRT 時間正確。

`stop()` 應排空模型端尾段並停止串流。模型故障時應讓呼叫端收到可辨識的錯誤；應用仍會保留已錄下的 WAV，避免模型問題造成錄音遺失。

## OpenAI 相容 HTTP 轉錄

設定頁可選擇「OpenAI 相容轉錄 API」，填入完整的 `/v1/audio/transcriptions` URL、模型 ID（例如 `Breeze-ASR-25`）並儲存 API key。API key 僅交給 Electron 主程序，使用 Electron `safeStorage` 加密後保存，不會寫進 renderer 設定、錄音檔或 Git。

此類 API 本身不是雙向串流，應用會將錄音切成約 2.5 秒的單聲道 PCM WAV，按順序以 `multipart/form-data` 送出 `model`、`language`、`file`。每個回應的 `text` 會立即成為一個 final 字幕段落；時間軸根據原始 sample offset 計算。API 沒有 partial 回應時，無法在該 2.5 秒片段完成前顯示同一段的暫定文字。
