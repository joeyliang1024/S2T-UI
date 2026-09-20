# S2T-UI

以 Electron + TypeScript 規劃的即時語音轉文字、翻譯字幕與錄音桌面應用。

- [功能研究與分階段開發計劃（繁體中文）](docs/PLAN.zh-TW.md)

- [語音處理技術參考與自有模型整合方案](docs/OPEN_SOURCE_BACKENDS.zh-TW.md)
- [自有模型接入契約](docs/MODEL_ADAPTER.md)

目前階段：可取得麥克風、切換輸入、顯示音量、停止後輸出 PCM16 WAV、匯出 TXT／SRT／JSON，並使用即時轉錄、記錄、匯入檔案、設定四個工作區。模型適配器目前是測試用空實作，等待串接自有模型。

模型由使用者提供；faster-whisper 與 sherpa-onnx 僅供語音處理設計參考，不作預設執行依賴。

## 開發

安裝依賴後執行 `npm run dev` 啟動桌面程式，使用 `npm run build` 產生 production bundle。首次啟動請允許麥克風權限。

自有模型整合入口在 `src/renderer/src/model-adapter.ts`。將 `NoopModelAdapter` 替換為符合 `ModelAdapter` 的適配器，即可接收每個 PCM 音訊分塊並回傳 partial／final 字幕事件。瀏覽器預覽會下載檔案；Electron 執行時則使用系統儲存對話框。
