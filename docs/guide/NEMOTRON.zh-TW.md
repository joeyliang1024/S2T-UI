# Nemotron 本機 CPU 講者分離

以 Nemotron-3-Diarization 在本機 CPU 執行講者分離，沿用既有環境變數，在 `.env` 設定：

```dotenv
S2T_DIARIZATION_ENDPOINT=
S2T_DIARIZATION_MODEL=nemotron-3-diarization
S2T_DIARIZATION_API_KEY=
```

重啟 gateway／Electron 後生效。`MODEL` 留空或設為 `sherpa-onnx-speaker-diarization` 可回到 sherpa；設定遠端 `ENDPOINT` 時沿用原遠端流程。ASR、翻譯與姓名 embedding 模型不需更換。

## 模型與 runtime

- 權重：`models/nemotron-3-diarization/Nemotron-3-Diarization.q8_0.gguf`
- runtime：`models/nemotron-3-diarization/runtime/<platform>-<arch>/bin/nemo-speech`，與同套發布的 `lib/` 一起保留

各平台需自行安裝相容的官方 NeMo-Speech.cpp CPU runtime，不會自動下載。檔案來源、SHA256 與授權見該 `models` 目錄的 README／provenance.json。`models/` 維持 Git 忽略。

## 行為與限制

完整錄音在 heavy worker 中以 native v0.2.0 v3-offline 幾何的狀態機一次處理至尾段（speaker cache=528 frames；CPU chunk=264、right/left context=1、FIFO=0、update=188；CLI 不混用 preset 與覆寫）。每場最多 8 個匿名講者，不保證人數或姓名一定正確；此設定已在長時間重複素材驗證，但未驗證自然中文長會議。

預覽 API 送獨立視窗並由 renderer 對齊標籤；沒有跨 HTTP 請求的持續 native stream，完整錄音完成後才做整場標註。回傳保留字串 speaker、原始重疊區間與既有姓名匹配／人工改名流程；`exclusive_diarization` 是相容欄位名稱，不代表原生輸出已去除重疊。CPU 與 ASR 同時運作的速度仍需實際部署驗收。

Electron 本機設定使用 `s2t-local://diarization`，直接載入工作目錄下的 `server/` CPU worker，不新增音訊外送或 token 轉送；桌面直接路徑回傳匿名講者與選用 embedding，gateway 路徑維持既有已註冊姓名匹配。打包部署須另保留 server、模型與對應平台 runtime。

## 驗證

```sh
node tests/smoke/nemotron-diarization-smoke-test.cjs
```

共用模型根目錄與路徑優先序見 [環境設定](ENVIRONMENT.zh-TW.md)；sherpa-onnx 安裝見 [sherpa-onnx 指南](SHERPA_ONNX.zh-TW.md)。
