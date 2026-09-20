# 自有模型接入契約

## 已實作的 WebSocket 第一版

在設定頁填入 `ws://` 或 `wss://` 端點後，應用會建立 `WebSocketModelAdapter`。它會先傳送下列 JSON，再持續傳送單聲道、原生位元組序的 `Float32Array` 二進位訊框：

```json
{"type":"start","audioFormat":"f32le","channels":1,"sampleRate":48000,"language":"zh-TW","targetLanguage":"en"}
```

停止時會傳送 `{"type":"stop"}`。伺服器可持續回傳以下 JSON；`id` 相同且 `revision` 較高的事件會取代先前字幕：

```json
{"type":"transcript","id":"seg-1","revision":1,"status":"final","startMs":0,"endMs":1320,"sourceText":"你好","translatedText":"Hello"}
```

這是應用端的暫定整合協定，並非 Breeze TTS 2 的介面。你的 STT／翻譯服務只要實作此協定，即可直接顯示即時字幕。

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
