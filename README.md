# S2T-UI

以 Electron、TypeScript 與 Web gateway 建立的即時語音轉文字、雙語字幕、會議整理與錄音應用。支援 Web 與 Electron；Web 版透過 gateway 保護模型憑證與帳號隔離的 Storage。

- **待辦與需求（唯一來源）**：[Enhancement.md](docs/Enhancement.md)
- **文件索引（四類分檔）**：[docs/README.md](docs/README.md)

ASR／翻譯等模型由使用者提供並以環境變數或帳號模型列表設定；模型 key 只由 gateway 或 Electron 主程序持有，不進瀏覽器。講者分離可選用本機 sherpa-onnx，Linux x64 可直接從 Docker Hub 取得離線模型包。實作不等於上線驗收，三項急迫需求（語者分離、斷句速度、翻譯模式）與具體缺口以 [Enhancement.md](docs/Enhancement.md) 為準。

即時字幕／翻譯限流與排程修正、零 API 用量的 10 分鐘本機驗證及重跑方式，見 [穩定性報告](docs/reports/CAPTION_STABILITY.zh-TW.md)。Web 的 ASR／翻譯每帳號每分鐘額度可分別透過 `S2T_ASR_REQUESTS_PER_MINUTE`、`S2T_TRANSLATION_REQUESTS_PER_MINUTE` 設定，預設各 180。

## 功能狀態

| 範圍 | 可用功能 | 尚待真人／正式環境驗收 |
| --- | --- | --- |
| 即時收音 | 麥克風／系統音訊、回應速度滑桿（快／正常／慢）、即時與整句翻譯策略 | 斷句延遲、不同裝置與長時間收音品質 |
| 講者 | sherpa 分群、聲紋註冊／NT 比對、字幕講者手動編輯與 VTT 匯出 | 多人重疊、長會議與誤配率 |
| 資料 | 登入隔離、歷史、搜尋、排序、複製、摘要模板、術語與 MinIO／PostgreSQL／Milvus | 正式外部 HTTPS 部署與故障情境 |
| 介面 | 繁中、簡中、英文、日文、德文與深／淺／系統主題 | 全頁窄視窗、無障礙與視覺回歸 |

## 文件導覽

| 類別 | 文件 |
| --- | --- |
| 操作指南 `guide` | [部署、Storage 與遷移](docs/guide/DEPLOYMENT.zh-TW.md)、[驗收手冊](docs/guide/VALIDATION.zh-TW.md)、[sherpa-onnx 安裝](docs/guide/SHERPA_ONNX.zh-TW.md)、[Silero VAD worker](docs/guide/SILERO_VAD.zh-TW.md)、[K8s 容量測試](docs/guide/CAPACITY_TEST.zh-TW.md) |
| 契約與架構 `reference` | [程式目錄責任](docs/reference/ARCHITECTURE.zh-TW.md)、[模型接入契約](docs/reference/MODEL_ADAPTER.md)、[Web Gateway](docs/reference/WEB_GATEWAY.zh-TW.md)、[講者分離 API](docs/reference/DIARIZATION_API.zh-TW.md)、[音訊品質與取樣率](docs/reference/AUDIO_QUALITY.zh-TW.md) |
| 研究與規劃 `research` | [K8s 擴充計畫（0930）](docs/research/K8S_SCALE_PLAN.zh-TW.md)、[早期功能研究](docs/research/PLAN.zh-TW.md)、[開源後端方案](docs/research/OPEN_SOURCE_BACKENDS.zh-TW.md) |
| 量測報告 `reports` | [字幕延遲調校（P95 ≤ 2.5 秒）](docs/reports/CAPTION_LATENCY.zh-TW.md)、[聲紋準確率量測](docs/reports/VOICEPRINT_ACCURACY.zh-TW.md)、[五分鐘字幕比較與顯示修正](docs/reports/CAPTION_COMPARISON_2026-10-04.zh-TW.md) |

研究類文件為歷史參考，不覆蓋 Enhancement.md 的決策。

## 快速開始

### 1. 安裝與設定

```bash
npm install
cp .env.example .env
```

編輯 `.env`，至少填入 ASR 的 `S2T_ASR_API_KEY`、`S2T_ASR_ENDPOINT`、`S2T_ASR_MODEL`（OpenAI 相容 Breeze ASR 的預設值已附在範例）。`.env` 會被忽略，不應提交到 Git。

首次使用本機資料可先以 `admin`／`admin` 登入；正式環境務必在第一次啟動前設定 `S2T_BOOTSTRAP_ADMIN_USERNAME`、`S2T_BOOTSTRAP_ADMIN_PASSWORD` 與長且隨機的 `S2T_AUTH_SECRET`。

### 2. Electron 桌面版

```bash
npm run dev
```

首次啟動請允許麥克風權限。生產建置用 `npm run build`（不等於可安裝包，打包待辦見 Enhancement.md F04）。停止收音只會建立尚未保存的記錄，請在「記錄」頁按「保存工作階段」才選擇正式資料夾。自有模型整合入口在 `src/renderer/src/features/models/model-adapter.ts`，契約見 [MODEL_ADAPTER.md](docs/reference/MODEL_ADAPTER.md)。

### 3. Web 版

Web 版需要同時執行兩個本機程序：

```bash
# 終端 A：gateway（登入、模型 key、Storage，預設 8787）
npm run build
npm run web:serve

# 終端 B：瀏覽器介面（固定 5173，將 /api 轉送給 gateway）
npm run web:preview
```

開啟 [http://127.0.0.1:5173/](http://127.0.0.1:5173/)；`8787` 只提供 API，不是網頁頁面。Storage 可用本機 fallback（三組 MinIO／PostgreSQL／Milvus 變數全部留空）或 Docker 外部服務；Docker Compose 啟動、驗證 smoke、備份還原與 Web 常見問題（404／Origin／port）見 [部署文件](docs/guide/DEPLOYMENT.zh-TW.md)。

### 4. 公司 Nexus 的離線 Docker Web build

`Dockerfile.web` 會從指定的內部 Nexus 安裝 npm 套件，並使用 repository 內封存的 SheetJS 與對應架構的 `ffmpeg`，避免 package URL 或 install hook 直接連向公網。請在可連到公司 Nexus、但公網 egress 已封鎖的建置環境執行：

```bash
docker build -f Dockerfile.web \
  --build-arg NPM_REGISTRY=https://nexus.example/repository/npm-group/ \
  -t s2t-web:offline .
```

`node:22-bookworm-slim` base image 必須已在 Docker daemon 快取，或透過公司的 image mirror 可取得。封存檔版本、checksum 與更新方式見 [dependencies/README.md](dependencies/README.md)。

本機載入 `.env` 並開啟完整 Web UI（包含 API）可使用：

```bash
NPM_REGISTRY=<你的核准 registry URL> docker-compose -f docker-compose.gateway.yml up -d --build
```

開啟 http://127.0.0.1:8787/。`.env` 由 Compose 載入；容器內模型根目錄、資料目錄、port 分別固定為 `/models`、`/data`、`8787`。`./models` 唯讀掛載，帳號和紀錄使用獨立 Docker volume。Nemotron 需要事先備妥符合容器架構的 `models/nemotron-3-diarization/runtime/linux-arm64` 或 `linux-x64`；建置不下載模型或 runtime。所有 npm install hooks 關閉；ARM64 ffmpeg 由 registry 套件預先提供，版本和 checksum 見 dependencies 文件。若主機支援 Compose plugin，也可使用 `docker compose`。

### 5. Kubernetes 必要設定

Kubernetes 必須將 `S2T_KUBERNETES_MODE=true`，並以 Secret 對所有 gateway Pod 注入同一個 `S2T_AUTH_SECRET`。這把密鑰用於 JWT 與帳號模型憑證加密；未設定時 readiness 會失敗。Secret 範例、Storage／模型掛載與完整部署注意事項見 [部署文件](docs/guide/DEPLOYMENT.zh-TW.md#kubernetes-的-s2t_auth_secret)。

## 常用指令

| 類別 | 指令 |
| --- | --- |
| 開發與建置 | `npm run dev`（Electron）、`npm run build`、`npm run typecheck`、`npm run web:serve`、`npm run web:preview` |
| 核心 smoke | `gateway:auth-smoke`、`import-checkpoint:smoke`、`model-adapter:smoke`、`translation-policy:smoke`、`i18n:smoke`、`vad:smoke`、`storage:smoke` |
| Storage smoke | `storage:remote:smoke`、`storage:gateway:smoke`、`storage:compensation:smoke`、`storage:grace:smoke`、`storage:outage:smoke`、`storage:voiceprint-backup:smoke`、`storage:migrate:remote` |
| 講者與聲紋 | `diarization:smoke`、`sherpa:worker:smoke`、`voiceprint:matching:smoke`、`voiceprint:blocks:smoke`、`voiceprint:eval`、`silero:vad:smoke` |
| 量測與評估 | `caption:eval`（字幕延遲）、`caption:reference`（產生標準答案 TSV）、`diarization:eval:timeline`、`capacity:gateway` |

完整清單在 `package.json` 的 `scripts`。

## 字幕延遲實測與回應速度設定

目標：**開始說話 → 首筆字幕上屏，端到端 P95 ≤ 2500 ms**（不含翻譯）。以真實收音節奏把音訊喂進 App 的 `EnergyVad + OpenAiChunkedModelAdapter` 切段邏輯、chunk 真送 Breeze-ASR-25 量測（`npm run caption:eval`）；素材為 13:47 對話影片前 300 秒、32 句標準時間軸（Silero VAD 自動產生，CER 為跨組相對比較），另有 22:36 無 BGM 旁白影片前 300 秒、18 段參考用於驗證 `minSilence/chunkMin`（見「無 BGM 素材驗證」）。完整方法與數據見[字幕延遲調校報告](docs/reports/CAPTION_LATENCY.zh-TW.md)。

### 回應速度三速（收音控制面板的單一滑桿）

| 速度 | minSilence | chunkMin | chunkMax | 延遲 p50 | 延遲 p95 | ≤2500ms | 逐句CER | 語料CER | 沒上屏 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **快** | 150 ms | 700 ms | 1200 ms | **760 ms** | 1759 ms* | 96.9% | 37.44% | 35.16% | 1/32 |
| **正常（預設）** | 250 ms | 700 ms | 1500 ms | 1029 ms | **1701 ms** | **100%** | 38.63% | 35.01% | 0/32 |
| **慢** | 800 ms | 1000 ms | 2400 ms | 1532 ms | 2760 ms† | 84.4% | **35.82%** | **28.88%** | 0/32 |

\* 該輪 ASR p95 681 ms（他輪 472–504 ms）的伺服器尖峰；快檔 chunk 等待實質低於正常檔，p50 為穩定差異。
† 「慢」定位為犧牲延遲換準度，p95 超過 2.5 s 屬預期選擇。慢檔 minSilence 於 2026-10-01 由 500 調至 800：BGM 素材不觸發 VAD 句界、此表測值兩者相同；乾淨素材差異見下表。

### 選型證據（同素材各組對照）

| 組合 | chunks | ASR p95 | 延遲 p50 | 延遲 p95 | ≤2500ms | 逐句CER | 語料CER | 字幕行 | 結論 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 舊預設 1000/2400/500（無 prompt） | 125 | 695 ms | 1485 ms | **2706 ms** | 84.4% | 39.07% | 34.64% | 32 | ❌ 不達標 |
| 新切段 700/1500/250（無 prompt） | 200 | 491 ms | 1033 ms | 1669 ms | 96.9% | 41.14% | 39.07% | 31 | 準度下滑 |
| ＋滾動上下文 prompt | 200 | 472 ms | 1029 ms | 1701 ms | **100%** | 38.63% | 35.01% | 30 | ✅ 採用（準度復原） |
| ＋600 ms 重疊 anchor | 200 | 648 ms | 983 ms | 1735 ms | 96.9% | 44.98% | 42.54% | 30 | ❌ 反而變差 |
| 16 kHz 上傳 | 200 | 504 ms | 1002 ms | 1860 ms | 96.9% | 40.84% | 38.85% | 31 | ❌ 無實測效益 |
| 快首版 500/1000/150 | 300 | 504 ms | 656 ms | 1223 ms | 87.5% | 41.14% | 39.81% | 35 | ❌ 4 句空字幕沒上屏 |
| 快 700/1200/150 | 250 | 681 ms | 760 ms | 1759 ms | 96.9% | 37.44% | 35.16% | 32 | ✅ 快檔 |
| 慢 1000/2400/800（測於 500，BGM 同值）＋prompt | 125 | 759 ms | 1532 ms | 2760 ms | 84.4% | 35.82% | 28.88% | 32 | ✅ 慢檔（準度優先） |

其他量測結論：滾動 prompt 與輸出清洗（清 `<|…|>`／`||`）已進產品碼；`minSilence/chunkMin` 在有背景音樂的素材上因 VAD 句界恆為 0 而不參與運算——第一輪的這項限制已由下節的無 BGM 素材補齊驗證。

### 無 BGM 素材驗證（2026-10-01 第二輪）

以 22:36 無 BGM 旁白影片前 300 秒、18 段 Silero 參考做七組同場對照，補齊 `minSilence/chunkMin` 的實測：

| 觀察點 | 數據 | 結論 |
| --- | --- | --- |
| minSilence 決定天然句界能否觸發 | 句界數：150 ms → 8–13 個、500 ms → 2 個、250/350/800 ms → 0 | 旁白停頓多在 150–250 ms；實務素材多數走強制切段，**只有快檔保有主動句尾偵測** |
| 快 chunkMin 700 → 500 | p50 1219 vs 1164 ms、語料CER 14.2% vs 14.0% | 無可測收益 → **維持 700** |
| 慢 minSilence 500 → 800 | 語料CER 10.27% → **8.35%**（重跑兩次同值）、過早切斷 2 → 0 | ✅ **採用 800**；BGM 上句界恆 0，28.88% 不回歸 |
| 正常 minSilence 250 → 350 | 兩者 chunk 流完全相同（200/200、語料CER 197/1616 分毫未差） | 穩定驗證通過 → **維持 250** |
| 三速乾淨素材語料 CER 梯度 | 快 14.0% → 正常 12.2% → 慢 **8.35%** | 準度梯度與定位一致 |

註：乾淨素材僅 18 段參考，p95／≤2500% 易被單次 ASR 尖峰主導（如首句 1489 ms），此節以 p50、語料 CER 與句界數為判讀依據。

## 即時字幕顯示分組與比較回放（2026-10-04）

即時字幕主視圖與 Web 字幕浮窗會將連續短片段接在同一列；收到文字即顯示，遇到停頓、自然句界、講者／語言切換或長度上限才換列。畫面分組保留原始片段 ID，展開「編輯」可操作各片段；手動翻譯與失敗重試仍對應原始片段。翻譯更新保留已有文字，歷史與匯出繼續使用原始片段。

本輪未更動 ASR、VAD 切段、模型設定或翻譯排程。移除未翻譯片段的資料合併後，部分策略的翻譯請求數可能改變。Electron 獨立浮窗仍沿用既有純文字流程。

五分鐘旁白的獨立實驗中，正常檔顯示列由 200 降為 34，短列比例由 40% 降為 0%；這是顯示投影的結果，不是辨識準確率提升或正式畫面延遲保證。參考 TSV 尚未人工校對，報告的差異率不是正式 CER。300 ms 重疊、長上下文與 LocalAgreement 均未套用到正式辨識流程。完整方法、反例及限制見[比較報告](docs/reports/CAPTION_COMPARISON_2026-10-04.zh-TW.md)。

並排回放、五分鐘音訊、核對案例與 CSV／JSON 保存在 [experiment/caption-comparison-2026-10-04](experiment/caption-comparison-2026-10-04/README.md)。從專案根目錄啟動：

```sh
python3 -m http.server 58755 --bind 127.0.0.1 --directory experiment/caption-comparison-2026-10-04
```

開啟 <http://127.0.0.1:58755/subtitle-replay.html?results=final>；兩側選相同實驗可比較原始列與顯示分組，選不同實驗可比較事件到達時間。回放使用已保存資料，不呼叫模型端點。

本輪驗證指令：

```sh
npm run typecheck
node tests/smoke/caption-display-group-smoke-test.cjs
node tests/smoke/caption-background-smoke-test.cjs
node tests/smoke/caption-regression-test.cjs
```

上述檢查已通過，涵蓋片段／譯文保留、換列邊界、停止後尾段保存與模擬翻譯故障；尚未重新量測正式畫面的 DOM 繪製延遲。

## 專案結構

| 位置 | 內容 |
| --- | --- |
| `src/renderer/` | React UI：收音、字幕、翻譯、歷史、摘要、模型與聲紋管理 |
| `src/main/`、`src/preload/` | Electron 主程序與 IPC 橋接 |
| `server/` | Web gateway：登入、模型 key、Storage 與 ASR／翻譯代理 |
| `scripts/` | smoke 測試與量測腳本（`package.json` 可見完整對應） |
| `docs/` | 分類文件（[索引](docs/README.md)） |
| `experiment/` | 獨立實驗回放與素材（[字幕比較回放](experiment/caption-comparison-2026-10-04/README.md)） |
| `experiment/evaluation-reports/` | 量測原始數據（字幕延遲、聲紋、分離時間軸） |

目錄責任細節見[程式目錄與責任](docs/reference/ARCHITECTURE.zh-TW.md)。


### Nemotron 本機 CPU 講者分離

沿用既有環境變數，在 `.env` 設定：

```dotenv
S2T_DIARIZATION_ENDPOINT=
S2T_DIARIZATION_MODEL=nemotron-3-diarization
S2T_DIARIZATION_API_KEY=
```

重啟 gateway／Electron 後生效。MODEL 留空或設為 `sherpa-onnx-speaker-diarization` 可回到 sherpa；設定遠端 ENDPOINT 時仍沿用原遠端流程。ASR、翻譯與姓名 embedding 模型不需更換。

權重：`models/nemotron-3-diarization/Nemotron-3-Diarization.q8_0.gguf`。runtime：`models/nemotron-3-diarization/runtime/<platform>-<arch>/bin/nemo-speech`，與同套發布的 `lib/` 一起保留。這台 macOS arm64 已放入官方 NeMo-Speech.cpp v0.2.0 CPU 套件；其他平台需另安裝相容的官方 CPU runtime，不會自動下載。檔案來源、SHA256 與授權見該 models 目錄的 README／provenance.json。`models/` 維持 Git 忽略。

完整錄音在 heavy worker 中以 native v0.2.0 v3-offline 幾何的狀態機一次處理至尾段，speaker cache=528 frames、CPU（chunk=264、right/left context=1、FIFO=0、update=188；CLI 不混用 preset 與覆寫）；沒有用 full-attention `--offline`。每場最多 8 個匿名講者，並不保證人數或姓名一定正確。此設定在 68 分鐘重複素材改善，但尚未驗證自然中文長會議。

現有預覽 API 仍送獨立視窗並由 renderer 對齊標籤；本次沒有加入跨 HTTP 請求的持續 native stream。完整錄音完成後才做整場標註。回傳保留字串 speaker、原始重疊區間與既有姓名匹配／人工改名流程；`exclusive_diarization` 是既有相容欄位名稱，不代表原生輸出已去除重疊。CPU 與 ASR 同時運作的速度仍需實際部署驗收。

驗證：`node tests/smoke/nemotron-diarization-smoke-test.cjs`（實際 CPU 推論與既有 worker 路徑）。

Electron 的本機設定使用 `s2t-local://diarization`，直接載入工作目錄下的 `server/` CPU worker，不新增音訊外送或 token 轉送。桌面直接路徑回傳匿名講者與選用 embedding；gateway 路徑維持既有已註冊姓名匹配。打包部署須另保留 server、模型與對應平台 runtime；目前驗證的是此專案的開發環境。

### 共用模型根目錄

`S2T_MODELS_DIR` 統一控制所有本機模型與 runtime，未設定時為工作目錄下的 `models/`。子目錄固定為 `sherpa-onnx/`、`silero-vad/`、`nemotron-3-diarization/`。容器使用 `S2T_MODELS_DIR=/models`，原目錄掛載結構維持。相對路徑以工作目錄解析。

優先順序：各模型單檔覆寫 > 舊 `S2T_SHERPA_MODELS_DIR`（只限 sherpa）> `S2T_MODELS_DIR` > 預設 `./models`。舊變數保留相容；新部署建議清空舊 sherpa 目錄變數，僅設共用根目錄，避免舊覆寫繼續生效。Nemotron runtime 也從共用根目錄讀取。驗證：`node tests/smoke/model-paths-smoke-test.cjs`。

環境變數的分組、模型選擇與覆寫優先序，見 [環境變數與模型設定](docs/guide/ENVIRONMENT.zh-TW.md)。

### 即時字幕工具列與側邊欄標題

下方工具列依序提供 A−、A＋、紀錄、收音控制、標記講者與子母視窗；圖示可透過滑鼠停留或鍵盤聚焦查看功能提示。點擊紀錄、收音控制或標記講者會展開側邊欄，隱藏 Workspace／Management 與其他導覽，讓設定從標題下方開始顯示；再次點擊會收起。

`S2T_PRODUCT_TITLE_IMAGE=icon/product_design_title.png` 指定側邊欄展開時的標題圖片。路徑以專案工作目錄為基準，使用 `icon/` 下的 PNG（最多 2 MB），不需電腦絕對路徑。Web gateway 與 Electron 均由環境設定載入；留空或檔案無法讀取時顯示「S2T UI」文字。修改後需重新啟動服務。Docker 映像包含 `icon/` 目錄，`.env` 於啟動時載入，此設定不影響模型選擇。

### 音訊／影片匯入與分頁圖示

匯入支援 WAV、MP3、M4A、AAC、OGG、WebM、FLAC、MP4、MOV、MPEG／MPG、MPGA、Opus、MKV、AVI、AIFF／AIF、WMA。PCM16 WAV 沿用原有 45 秒分段、1.5 秒重疊與斷點接續；其他格式（包含非 PCM16 WAV）先送登入中的 Gateway，由既有本機 FFmpeg 轉成單聲道、16 kHz PCM16 WAV，再分段送到選定 ASR。影片使用第一條音軌，無音軌或解碼失敗會顯示錯誤。

輸入與轉換後 WAV 上限均為 2 GB；不再套用其他格式的舊 100 MB 限制。Gateway 將輸入串流寫入暫存檔，同時僅接受一個轉換，轉換限時 10 分鐘；完成、失敗或取消後清理暫存檔。非 WAV 匯入需要可連線的 Gateway，Electron 也使用已設定的 Gateway。轉換不下載外部編解碼器或其他檔案，既有 M4A 匯出 API 不變。尚未進行完整 2 GB 壓力測試。

驗證：`node tests/smoke/import-audio-smoke-test.cjs`。已在 Mac 與 Linux ARM64 Docker 實測上述 18 個副檔名；Chrome 驗證 95 秒 MP3 分三段，以及約 110 MiB 的 300 秒浮點 WAV 轉換後分七段，並驗證取消。ASR 在整合測試使用隔離回應，這些測試驗證轉換與切段，不代表各格式的辨識準確率。

瀏覽器分頁小圖示來源為 `icon/favicon.svg`，由 Vite 打包為網站資產；獨立字幕視窗沿用相同圖示。

側邊欄導覽採共用 SVG 圖示網格、圓角線條與深淺色配色；選取、滑鼠提示及鍵盤焦點跟隨主題，並尊重減少動態效果設定。紀錄卡片右側功能按鈕上下置中。

## 專案檔案分類

| 目錄 | 用途 |
| --- | --- |
| src/、server/ | 前端、Electron、Gateway |
| config/ | 工具設定；Docker 入口保留根目錄 |
| tests/ | smoke、integration、helpers、fixtures |
| scripts/ | audio、evaluation、benchmarks、storage |
| experiment/ | 實驗、demo、evaluation-reports |
| docs/ | 指南、契約、研究、報告 |
| models/、icon/、dependencies/ | 模型、圖片、離線依賴 |
| tmp/、music/、.s2t-data/ | 現有素材與資料，保留原路徑 |

npm 指令名稱保留。見 [背景處理生命週期檢查](docs/research/SESSION_LIFECYCLE.zh-TW.md)。

### Docker 相容與 K8s 多副本

未設定 `S2T_KUBERNETES_MODE=true` 時維持同容器 `all` 模式，不新增 Redis 或獨立 worker 必要依賴。多副本部署、共享限流、任務交易、音訊 ACK、migration 與 HPA 範例見 [多副本部署指南](docs/guide/K8S_SCALE_DEPLOYMENT.zh-TW.md)；[容量測試](docs/guide/CAPACITY_TEST.zh-TW.md) 支援不同帳號與固定到達率，正式 100 人容量仍須實測。
