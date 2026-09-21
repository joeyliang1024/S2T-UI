# S2T UI 待辦清單

本清單依賴關係排序；標記為「等待模型介面」的項目需要自有模型 API／SDK 資訊。

## 下一輪：不依賴模型 API

- [x] 將 Electron 錄音改為持續寫入 16-bit PCM 暫存 WAV，停止時回填 WAV 檔頭並複製至工作階段；瀏覽器預覽保留記憶體後備模式。
- [x] 建立 Electron 工作階段資料結構：`session.json`、`audio.wav`、`transcript.txt`、`transcript.jsonl`、`events.jsonl`。
- [x] 將歷史紀錄改為可讀取已儲存的工作階段，支援音檔播放、WAV 下載與 TXT／SRT／JSON 重新匯出。（桌面跨重啟資料夾工作階段仍在保存架構項目處理。）
- [x] 停止收音與保存工作階段分離：停止只建立未保存記錄，於「記錄」頁選擇正式保存位置。
- [x] 支援裝置拔除、音軌結束後的明確錯誤提示與音源切換復原；睡眠喚醒待實機驗證。
- [x] 補齊檔案匯入的本機驗證、格式與大小提示。
- [x] 實作系統音訊和麥克風混音：可在開始前勾選，透過系統分享選擇器擷取音訊並混入同一 WAV 與模型 frame。
- [x] 實作 Electron 可置頂的浮動字幕視窗；實機顯示驗證待 Electron 執行環境可用時進行。
- [ ] 加入 Electron 打包設定與 macOS／Windows 實機驗證。

## 等待模型介面

- [x] 實作自有模型的 WebSocket `ModelAdapter` 第一版：連線、音訊送入、字幕事件與關閉流程；認證待模型規格確認。
- [x] 定義並實作第一版音訊契約：單聲道 `f32le`、實際 AudioContext 取樣率、4096 sample frame、`streamId`／`sequence`／`startSample`／`frameCount` header、2 MB WebSocket 背壓上限。
- [x] 支援模型設定檔：使用者可新增、選擇、編輯與刪除符合 WebSocket 協定的 ASR／翻譯 gateway。
- [ ] 擴充使用者自訂模型：已支援以 Electron 安全儲存區保存 API Token，並加入 OpenAI 相容 HTTP 分段 Adapter；連線測試、能力宣告（ASR／翻譯／partial／時間戳）待做。
- [ ] 將 Breeze-ASR-26 部署於自有服務並以 WebSocket 協定實機驗證；本專案依需求不使用 Python。
- [ ] 接收並呈現 partial、final、revision 字幕及其時間戳。
- [x] 接收或請求翻譯字幕，處理原文與譯文對齊：已加入 OpenAI 相容 Chat Completions 翻譯 Adapter。
- [x] 將匯入檔案送到模型的離線／批次轉錄流程：已支援 100 MB 以下檔案以 OpenAI 相容 ASR API 上傳；大型檔案分段上傳待後端 API。
- [ ] 對模型錯誤、逾時、重連與超載提供可恢復的 UI。

## Breeze TTS 2

- [x] 整合本機 Breeze TTS 2 `/v1/audio/speech` API：提交文字與可選語音指令，將 24 kHz PCM 轉為 WAV 並在應用程式播放。
- [ ] 以實際啟動的 Breeze TTS 服務驗證 API；需要 Linux、CUDA GPU、模型權重與服務程序。

## 後續能力

- [ ] VAD 與語句切分、斷線重送及 60 分鐘長時間錄音測試。（HTTP ASR 已用本機能量閾值於停頓切段；斷線重送與長時間實測待做。）
- [ ] 字幕搜尋、編輯、說話者標記、自訂術語與摘要。（搜尋、人工編輯、人工講者標記、術語提示與摘要 API 已完成；自動說話者分離待 API 規格。）
- [ ] MP3／M4A 匯出（僅在產品需求確認後加入）。
- [ ] 系統睡眠、低磁碟空間、強制關閉與復原測試。
