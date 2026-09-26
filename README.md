# S2T-UI

以 Electron + TypeScript 規劃的即時語音轉文字、翻譯字幕與錄音桌面應用。

- [統一需求與改善清單（唯一待辦來源）](Enhancement.md)
- [早期功能研究（歷史參考）](docs/PLAN.zh-TW.md)

- [語音處理技術參考與自有模型整合方案](docs/OPEN_SOURCE_BACKENDS.zh-TW.md)
- [自有模型接入契約](docs/MODEL_ADAPTER.md)
- [Web ASR Gateway](docs/WEB_GATEWAY.zh-TW.md)
- [驗收手冊](docs/VALIDATION.zh-TW.md)

目前已有麥克風與系統音訊收音、PCM16 WAV、HTTP ASR、翻譯、登入、歷史紀錄、摘要、模型及聲紋管理等功能路徑；逐字稿支援 TXT／VTT／JSON／CSV。實作不等於上線驗收，具體缺口與三項急迫需求以 [Enhancement.md](Enhancement.md) 為準。

ASR／翻譯等模型由使用者提供；gateway 另有可選的 sherpa-onnx 本機聲紋與分離路徑，需自行配置模型檔。

## Web 版（Breeze-ASR-25）

Web 版不會把模型 API key 放入 Vite 環境變數或瀏覽器。複製 `.env.example` 為 `.env`，填入 `S2T_ASR_API_KEY`、endpoint 與 model，然後執行 `npm run web:serve`。

開發時另開一個終端執行 `npm run dev`，瀏覽器開啟 `http://127.0.0.1:5173/`。Vite 會將 `/api` 代理至 Web BFF；BFF 只公開模型名稱與 `/api/transcriptions`，由 server-side `.env` 持有 key。部署前先跑 `npm run build`，再執行 `npm run web:serve`，於 `http://127.0.0.1:8787/` 開啟。

## 開發

安裝依賴後執行 `npm run dev` 啟動桌面程式，使用 `npm run build` 產生 production bundle。首次啟動請允許麥克風權限。

自有模型整合入口在 `src/renderer/src/features/models/model-adapter.ts`。將 `NoopModelAdapter` 替換為符合 `ModelAdapter` 的適配器，即可接收每個 PCM 音訊分塊並回傳 partial／final 字幕事件。瀏覽器預覽會下載檔案；Electron 執行時則使用系統儲存對話框。

OpenAI 相容 Breeze ASR 可使用環境變數：複製 `.env.example` 為 `.env`，填入 `S2T_ASR_API_KEY`；endpoint 與模型預設值已附在範例中。`.env` 會被忽略，不應提交到 Git。停止收音只會建立尚未保存的記錄，請在「記錄」頁按「保存工作階段」才選擇正式資料夾。
