# S2T UI 待辦清單

本清單依賴關係排序；標記為「等待模型介面」的項目需要自有模型 API／SDK 資訊。

## 下一輪：不依賴模型 API

- [ ] 將錄音由停止後產生的記憶體 WAV 改為可持續寫入的 WAV 工作階段檔案，避免長時間錄音佔用記憶體。
- [x] 建立 Electron 工作階段資料結構：`session.json`、`audio.wav`、`transcript.txt`、`transcript.jsonl`、`events.jsonl`。
- [x] 將歷史紀錄改為可讀取已儲存的工作階段，支援音檔播放、WAV 下載與 TXT／SRT／JSON 重新匯出。（桌面跨重啟資料夾工作階段仍在保存架構項目處理。）
- [x] 支援裝置拔除、音軌結束後的明確錯誤提示與音源切換復原；睡眠喚醒待實機驗證。
- [x] 補齊檔案匯入的本機驗證、格式與大小提示。
- [ ] 實作系統音訊和麥克風混音的 Electron 流程。
- [x] 實作 Electron 可置頂的浮動字幕視窗；實機顯示驗證待 Electron 執行環境可用時進行。
- [ ] 加入 Electron 打包設定與 macOS／Windows 實機驗證。

## 等待模型介面

- [x] 實作自有模型的 WebSocket `ModelAdapter` 第一版：連線、音訊送入、字幕事件與關閉流程；認證待模型規格確認。
- [x] 定義並實作第一版音訊契約：單聲道 `f32le`、實際 AudioContext 取樣率、4096 sample frame、`streamId`／`sequence`／`startSample`／`frameCount` header、2 MB WebSocket 背壓上限。
- [x] 支援模型設定檔：使用者可新增、選擇、編輯與刪除符合 WebSocket 協定的 ASR／翻譯 gateway。
- [ ] 擴充使用者自訂模型：API Token 的安全保存、連線測試、模型能力宣告（ASR／翻譯／partial／時間戳）與非 WebSocket Adapter。
- [ ] 將 Breeze-ASR-26 部署於自有服務並以 WebSocket 協定實機驗證；本專案依需求不使用 Python。
- [ ] 接收並呈現 partial、final、revision 字幕及其時間戳。
- [ ] 接收或請求翻譯字幕，處理原文與譯文對齊。
- [ ] 將匯入檔案送到模型的離線／批次轉錄流程。
- [ ] 對模型錯誤、逾時、重連與超載提供可恢復的 UI。

## Breeze TTS 2

- [x] 整合本機 Breeze TTS 2 `/v1/audio/speech` API：提交文字與可選語音指令，將 24 kHz PCM 轉為 WAV 並在應用程式播放。
- [ ] 以實際啟動的 Breeze TTS 服務驗證 API；需要 Linux、CUDA GPU、模型權重與服務程序。

## 後續能力

- [ ] VAD 與語句切分、斷線重送及 60 分鐘長時間錄音測試。
- [ ] 字幕搜尋、編輯、說話者標記、自訂術語與摘要。（搜尋與人工編輯已完成；其餘待做。）
- [ ] MP3／M4A 匯出（僅在產品需求確認後加入）。
- [ ] 系統睡眠、低磁碟空間、強制關閉與復原測試。
