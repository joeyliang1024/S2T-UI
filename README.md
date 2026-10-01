# S2T-UI

以 Electron、TypeScript 與 Web gateway 建立的即時語音轉文字、雙語字幕、會議整理與錄音應用。支援 Web 與 Electron；Web 版透過 gateway 保護模型憑證與帳號隔離的 Storage。

- **待辦與需求（唯一來源）**：[Enhancement.md](Enhancement.md)
- **文件索引（四類分檔）**：[docs/README.md](docs/README.md)

ASR／翻譯等模型由使用者提供並以環境變數或帳號模型列表設定；模型 key 只由 gateway 或 Electron 主程序持有，不進瀏覽器。講者分離可選用本機 sherpa-onnx，Linux x64 可直接從 Docker Hub 取得離線模型包。實作不等於上線驗收，三項急迫需求（語者分離、斷句速度、翻譯模式）與具體缺口以 [Enhancement.md](Enhancement.md) 為準。

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
| 量測報告 `reports` | [字幕延遲調校（P95 ≤ 2.5 秒）](docs/reports/CAPTION_LATENCY.zh-TW.md)、[聲紋準確率量測](docs/reports/VOICEPRINT_ACCURACY.zh-TW.md) |

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

## 專案結構

| 位置 | 內容 |
| --- | --- |
| `src/renderer/` | React UI：收音、字幕、翻譯、歷史、摘要、模型與聲紋管理 |
| `src/main/`、`src/preload/` | Electron 主程序與 IPC 橋接 |
| `server/` | Web gateway：登入、模型 key、Storage 與 ASR／翻譯代理 |
| `scripts/` | smoke 測試與量測腳本（`package.json` 可見完整對應） |
| `docs/` | 分類文件（[索引](docs/README.md)） |
| `eval-reports/` | 量測原始數據（字幕延遲、聲紋、分離時間軸） |

目錄責任細節見[程式目錄與責任](docs/reference/ARCHITECTURE.zh-TW.md)。
