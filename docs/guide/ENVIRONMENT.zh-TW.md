# 環境變數與模型設定

一般部署分成模型服務、共用模型目錄、音訊 worker、聲紋辨識與儲存／登入五組。所有設定需重新啟動讀取；既有程序的環境變數優先於 .env（dotenv override=false）。本次只整理設定與修正載入順序，未更換 ASR、翻譯、embedding 或權重。

## 模型選擇

|設定|用途|是否改變模型|
|---|---|---|
|S2T_ASR_ENDPOINT / MODEL / API_KEY|預設 ASR 服務|會；需成套設定|
|S2T_ASR_MODELS_JSON|多個環境 ASR profile|有效陣列建立候選；實際仍由 UI 選用 profile 決定|
|S2T_TRANSLATION_ENDPOINT / MODEL / API_KEY|翻譯服務|會；與 ASR 獨立|
|S2T_SUMMARY_ENDPOINT / MODEL / API_KEY|摘要服務|會；目前全部留空|
|S2T_DIARIZATION_MODEL|講者分離後端|nemotron-3-diarization 且 endpoint 空白＝本機 CPU；model 空白＝sherpa，不是停用|
|S2T_DIARIZATION_ENDPOINT|遠端分離服務|設定 endpoint＋model 會優先使用遠端|

環境值不會刪除帳戶保存的模型清單、API key 或 UI 選擇。已存的自訂模型可能另行決定請求目的地；不能把 .env 的預設模型視為每個帳戶正在使用的模型。本輪未讀寫帳戶模型清單或聲紋資料。

## 本機模型目錄

```dotenv
S2T_MODELS_DIR=./models
S2T_DIARIZATION_MODEL=nemotron-3-diarization
S2T_DIARIZATION_ENDPOINT=
S2T_DIARIZATION_API_KEY=
```

|子目錄|內容|
|---|---|
|sherpa-onnx/|sherpa segmentation 與現有 512 維 embedding|
|silero-vad/|silero_vad.onnx|
|nemotron-3-diarization/|Q8_0 權重與 runtime/<platform>-<arch>/|

優先序：單檔覆寫（S2T_SHERPA_SEGMENTATION_MODEL、S2T_SHERPA_EMBEDDING_MODEL、S2T_SILERO_VAD_MODEL）＞舊 S2T_SHERPA_MODELS_DIR（限 sherpa）＞S2T_MODELS_DIR＞工作目錄下 models/。一般使用者不需要填單檔路徑。改共用目錄只改位置，不選模型；新目錄須保留相同子目錄與對應平台 runtime。

本機 .env 的舊 sherpa／Silero 覆寫已移除，因前後解析為同一批檔案。若搬到不同目錄，先檢查所有檔案存在，再重啟。Docker 預設 /models；macOS runtime 不能直接在 Linux 使用。

## 運算與匹配

- S2T_SHERPA_WORKERS、FAST_WORKERS、各 QUEUE／TIMEOUT／AUDIO_CACHE 參數是共用 worker 設定，也影響 Nemotron 排隊／快取／逾時；舊命名保留相容，不在本輪大量改名。
- S2T_SHERPA_INFER_THREADS 與 CLUSTERING_THRESHOLD、SHORT_AUDIO_SEC、MIN_DURATION_ON/OFF 只調 sherpa；不改 Nemotron 的 native 設定。
- Nemotron 的 CPU 幾何與 cache=528 目前固定在已驗證實作，沒有新增可誤設的環境旋鈕。
- S2T_VOICEPRINT_* 調整姓名匹配、抽樣與拒識，不更換講者分離模型。調高門檻可能增加匿名標籤。
- S2T_VOICEPRINT_EMBEDDING_MODEL_NAME／VERSION 是聲紋相容性標記，不是權重下載器。真正更換 embedding 權重需同步版本與重新建立相容聲紋；本輪未改。
- S2T_SILERO_VAD_SHA256 是模型校驗值；不要為了讓陌生權重通過就隨意更改。

## 載入與其他設定

Gateway 現在先讀 .env，再建立 worker pool，避免檔案裡的 worker 數／逾時被初始化預設值忽略。目前本機未指定這些 worker 變數，修正不改本機現有預設並行數。

儲存、登入、CORS、gateway URL 與測試工具變數保持原值；.env.local-storage 不會被 gateway 自動合併，它由 compose／明確選用的工具流程讀取。服務分組不要半套設定。範例 ASR／翻譯／摘要 endpoint 改成留空，示範網址只放註解，避免複製後變成半套模型設定。

已刪除 .env 中無程式讀取的 VITE_S2T_ASR_ENDPOINT／MODEL；瀏覽器從 gateway config 取得模型資訊，API key 維持伺服器端。

## 本次驗證

重複鍵／不明啟用變數：皆無。其餘 .env 值逐項不變；Breeze-ASR-25、HY-MT1.5-1.8B、Nemotron 與所有解析後模型／runtime 檔案位置維持。已補 TTL／音訊快取大小三個缺少的正式 worker 變數說明。

路徑優先序與真實 Nemotron／sherpa 回退已驗證；gateway .env 載入與 process.env 優先序另以隔離啟動測試驗證。測試命令：

```sh
node tests/smoke/model-paths-smoke-test.cjs
node tests/smoke/gateway-env-smoke-test.cjs
node tests/smoke/nemotron-diarization-smoke-test.cjs
```
