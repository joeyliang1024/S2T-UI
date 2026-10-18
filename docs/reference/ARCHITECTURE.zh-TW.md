# 系統架構與程式責任

狀態：現行程式架構＋有標註的可選部署。更新日期：2026-10-18。

本文件以 repository 實作為架構來源；「目前本機」另以執行中容器的唯讀檢查核對。沒有將範例 K8s、遠端 Storage 或 GPU 畫成已在本機啟用。

## 部署現況與邊界

| 項目 | 目前本機 AP | 可選部署／限制 |
| --- | --- | --- |
| 對外入口 | Docker AP `8787`，role=`all` | K8s 可拆 API／Audio Service／Audio Worker |
| config／blob／vector | 全部為 local adapters，掛在 `/data` 持久化 Volume | 可各自切換 PostgreSQL／MinIO／Milvus；不是自動故障時切成本機 |
| 音訊服務 | AP 內本機 runtime，未設定獨立 Audio Service | 可透過 private token HTTP 移到 Audio Service |
| 模型權重 | `/models` 唯讀掛載 | K8s 使用唯讀模型 PVC；可另選 CPU／CUDA，未在本圖聲稱 GPU 已驗收 |
| 模板 | `/data/template` 唯讀共享模板，個人模板另存 config | 共享檔案與帳號個人副本分開 |
| 加密密鑰 | 未設定環境 `S2T_AUTH_SECRET`，目前使用已存在的 `/data/auth-secret` | 正式／K8s 要求固定且所有 Pod 相同的 Secret |
| Redis／Sentinel | 目前 AP 未配置 | 分散限流／admission 依 scale 模式配置 |
| 監控 | 另行部署，Grafana 本機入口 `13000` | 監控可觀察其他服務，不表示 AP 正在使用那些 Storage |
| 映像與工作目錄 | 作業期間已重新部署為 `s2t-ui:nemotron-cpu-local`，工作目錄 `/app`，Web 輸出為 `/app/out/web`，server 為模組化目錄 | 本輪最後的 Transcript 空白列修正已同步到執行中容器；正式再部署仍須由最新 source build 映像，不能只依賴 runtime 複製的檔案 |

實線表示主要資料／呼叫關係；虛線表示監控、控制或可選路徑。節點中的檔案位置是邏輯責任，不是把所有 API 都當成不同的獨立服務。

## 目前本機完整系統

這是 2026-10-18 對執行中的 AP 做唯讀檢查所得現況。瀏覽器、Gateway 與持久化 Volume 是主要執行路徑；監控服務是分開的部署。

```mermaid
flowchart TB
  U["使用者 · 瀏覽器"] --> UI["React / TypeScript UI<br/>即時字幕 · 紀錄 · 摘要 · 品質校正<br/>模型管理 · 聲紋 · 設定／帳號"]
  subgraph CLIENT["瀏覽器邊界"]
    UI --> CTRL["App Controller<br/>錄音／任務編排 · 選用模型 · 取消／重試"]
    CTRL --> CAP["AudioWorklet／VAD<br/>PCM 分句 · 重採樣 · 字幕與翻譯佇列"]
    CTRL --> LOCAL["OPFS：錄音檢查點<br/>IndexedDB：待同步與恢復資料"]
    CTRL --> HTTP["同源 authenticated HTTP ports<br/>登入 Cookie／Token · 帳號隔離"]
  end
  subgraph AP["目前 Docker AP :8787"]
    WEB["靜態前端＋深連結路由"]
    AUTH["JWT／帳號權限<br/>限流 · 帳號刪除圍欄"]
    API["API 代理與應用服務<br/>模型／紀錄／摘要／校正／聲紋"]
    KEY["模型目錄＋憑證解析<br/>AES-256-GCM 解密於服務端"]
    AUDIO["本機音訊處理<br/>Silero VAD · Sherpa worker pool<br/>Nemotron · FFmpeg"]
    JOB["背景講者工作 runner<br/>持久化工作 · lease／generation"]
    STORE["Storage 三種介面<br/>config · blob · vector"]
    AUTH --> API
    API --> KEY
    API --> AUDIO
    API --> JOB
    API --> STORE
    JOB --> AUDIO
    JOB --> STORE
  end
  U --> WEB
  CAP --> HTTP
  HTTP --> AUTH
  subgraph DATA["持久化／唯讀掛載"]
    CFG[("/data/config.json<br/>帳號／模型目錄／加密 key／紀錄／工作")]
    WAV[("/data/blobs<br/>音檔與聲紋樣本")]
    VEC[("/data/vectors.json<br/>聲紋向量")]
    SECRET[("/data/auth-secret<br/>目前的持久化加密密鑰")]
    MODELS["/models · 唯讀模型權重"]
    TPL["/data/template · 唯讀共享摘要模板"]
  end
  STORE --> CFG & WAV & VEC
  KEY --> CFG
  SECRET --> KEY
  MODELS --> AUDIO
  TPL --> API
  KEY --> UP["外部模型服務<br/>ASR／Translation／Summary<br/>可選遠端 Diarization／Embedding"]
  AP -. "/metrics 抓取" .-> PROM["Prometheus"]
  PROM --> GRAF["Grafana · 本機入口 :13000<br/>一週／30 秒刷新 · 部門／NT"]
```

[可縮放 SVG](diagrams/architecture/01-current-system.svg) · [Mermaid 原始碼](diagrams/architecture/01-current-system.mmd)

## 前端頁面、功能邊界與兩種執行平台

Web 是目前優先開發路徑；Electron 保留 DesktopBridge／IPC、本機錄音及推論契約，不能把 Web 的 /api 路徑直接當成所有 Electron 操作的實際呼叫路徑。

```mermaid
flowchart LR
  subgraph V["頁面與入口"]
    LIVE["即時字幕／收音"]
    HIST["紀錄<br/>搜尋／排序／分頁／更多操作"]
    QUALITY["品質校正<br/>修正項目複選<br/>字幕／講者／翻譯比對"]
    SUMMARY["摘要<br/>原文／翻譯分頁<br/>依當前分頁生成"]
    MODEL["模型管理<br/>六類篩選／註冊<br/>卡片：設定／API 測試"]
    SETTINGS["設定／Admin<br/>模板／術語／帳號／分享授權"]
  end
  HIST -- "導頁＋選中紀錄；不自動執行" --> QUALITY & SUMMARY
  LIVE & HIST & QUALITY & SUMMARY & MODEL & SETTINGS --> APP["features/app<br/>AppView 組裝<br/>useAppController 編排"]
  APP --> DOMAIN["功能 domain／services<br/>字幕群組 · 搜尋正規化 · 差異<br/>摘要分層 · session rebase · 講者映射"]
  DOMAIN --> PORT["ports／adapters<br/>ASR · Text completion · Summary<br/>Session storage · PCM sinks"]
  PORT --> WEB["Web：authenticated HTTP<br/>同源 Gateway :8787"]
  PORT -. "Electron 保留路徑" .-> BRIDGE["preload DesktopBridge<br/>IPC → main → 模型／本機錄音"]
  CONTRACT["src/shared/contracts + validation<br/>跨 renderer／main／server 中立契約"] -. "型別與 runtime 驗證" .-> APP & PORT
  APP --> GUARD["操作保護<br/>處理中鎖定 · AbortSignal<br/>帳號 epoch · request generation"]
```

[可縮放 SVG](diagrams/architecture/02-frontend-boundaries.svg) · [Mermaid 原始碼](diagrams/architecture/02-frontend-boundaries.mmd)

## 即時收音、ASR、翻譯與延遲量測

t1～t7 是量測分類，並非編號順序完全等於時間順序；例如 t2 的 VAD／分句發生在 t1 的送出佇列之前。E2E tail 從最後語音樣本算到譯文實際繪出；導航或背景分頁不把舊回應補算成新延遲。

```mermaid
flowchart TB
  MIC["麥克風／系統音訊"] --> PCM["AudioWorklet · PCM 樣本時鐘"]
  PCM --> WRITER["持續寫入錄音 sink<br/>與 ASR 送出速度解耦"]
  PCM --> VAD["VAD／分句<br/>停頓＋回應速度設定<br/>t2：偵測／分句／可選 Silero gate"]
  VAD --> QUEUE["ASR 佇列／編碼／上傳<br/>t1：queue＋encode＋upload"]
  QUEUE --> GW["Gateway<br/>帳號限流／並行 admission"]
  GW --> ASR["外部 ASR<br/>t3：gateway／queue／model"]
  ASR --> POST["文字清理與字幕群組<br/>t4：postprocess"]
  POST --> PAINT["字幕實際呈現<br/>t5：network＋paint"]
  POST --> TQ["翻譯策略與佇列<br/>僅針對需要翻譯的字幕"]
  TQ --> TR["Gateway → 翻譯模型<br/>t6：wait／queue／model／gateway"]
  TR --> TP["譯文實際呈現<br/>t7：network＋paint"]
  VAD -. "最後語音樣本時間" .-> E2E["E2E translation tail<br/>最後語音 → 譯文實際呈現<br/>P90 目標小於 3 秒"]
  TP --> E2E
  GW -. "Server-Timing" .-> METRIC["caption-metrics<br/>只計算 live view 新資料的實際 paint"]
  PAINT & TP & E2E --> METRIC
  METRIC --> TELE["/api/telemetry/captions → /metrics"]
```

[可縮放 SVG](diagrams/architecture/03-capture-and-latency.svg) · [Mermaid 原始碼](diagrams/architecture/03-capture-and-latency.mmd)

## 錄音保存、背景工作與中斷恢復

PCM 寫入不依賴 ASR 即時完成。音訊、metadata、同步確認分開處理，未獲可靠確認前保留本機恢復資料；背景講者工作以持久化 lease 與 generation 避免過期工作覆寫結果。

```mermaid
flowchart TB
  PCM["收音 PCM"] --> SINK["Buffered writer／PCM sink<br/>序列寫入 · 排空後完成"]
  SINK --> OPFS[("瀏覽器 OPFS<br/>錄音片段／manifest／checkpoint")]
  SINK --> REMOTE["可選遠端 PCM recording API<br/>chunk 冪等／完成確認"]
  OPFS --> STOP["停止錄音<br/>保留已寫入音訊 · 排空 ASR／翻譯"]
  REMOTE --> STOP
  STOP --> SNAP["SavedSession＋AudioVersion<br/>逐字稿／譯文／時間／講者／模型快照"]
  SNAP --> IDB[("IndexedDB session outbox<br/>尚未確認同步的本機快照")]
  IDB --> SYNC["Session sync coordinator<br/>版本 CAS · 衝突三方合併<br/>遠端 ACK 前保留本機資料"]
  SYNC --> CONFIG[("config store<br/>目前 local；可選 PostgreSQL")]
  STOP --> BLOB[("blob store<br/>目前 local；可選 MinIO")]
  CONFIG --> JOB["可恢復的講者分離 job<br/>claim／lease renew／generation fencing"]
  BLOB --> JOB
  JOB --> DIA["講者分離＋聲紋比對"]
  DIA --> CONFIG
  RELOAD["重新整理／中斷後登入"] --> RECOVER["恢復 manifest／outbox<br/>檢查帳號與音訊版本"]
  OPFS & IDB --> RECOVER
  RECOVER --> SYNC
  SYNC -- "音訊＋metadata 已確認後" --> CLEAN["對應資料安全清理<br/>失敗或未確認資料保留"]
```

[可縮放 SVG](diagrams/architecture/04-recording-and-recovery.svg) · [Mermaid 原始碼](diagrams/architecture/04-recording-and-recovery.mmd)

## 品質校正與三種結果比對

校正由前端 controller 編排 API 呼叫，與停止錄音後的持久化講者 job 是不同流程。勾選項目依字幕、講者、翻譯順序執行；進度與本次 baseline 存在 UI 記憶體，完成的結果版本再交給 session sync 保存。

```mermaid
flowchart TB
  HIST["紀錄更多操作"] -- "選中紀錄；只導頁" --> PAGE["品質校正頁面"]
  PAGE --> PICK["複選修正項目<br/>字幕／Diarization／翻譯"]
  PICK --> RUN["按品質校正<br/>快照舊結果 · 鎖定同筆紀錄編輯"]
  RUN --> A{"勾選字幕？"}
  A -- "是" --> ASR["依既有句子時間擷取 WAV<br/>ASR 重新辨識 · 清除已失效的舊譯文"]
  A -- "否" --> D{"勾選 Diarization？"}
  ASR --> D
  D -- "是" --> DIA["用選定模型重新分離講者<br/>時間重疊映射 · 保留手動講者標記"]
  D -- "否" --> T{"勾選翻譯？"}
  DIA --> T
  T -- "是" --> TRANS["翻譯目前字幕<br/>只有翻譯時不讀音訊／不跑 ASR"]
  T -- "否" --> COMMIT["全部選定步驟成功才提交<br/>新 AudioVersion 指向 parentId<br/>可沿用同一 audioKey"]
  TRANS --> COMMIT
  ASR & DIA & TRANS -. "HTTP／空結果／模型失敗" .-> FAIL["顯示失敗並解鎖<br/>不提交部分新版本 · 保留原紀錄"]
  COMMIT --> DIFF["校正前：直接父版本／本次快照<br/>校正後：目前版本"]
  DIFF --> TXT["字幕分頁：原文差異"]
  DIFF --> SPK["Diarization 分頁：時間段／講者"]
  DIFF --> TR["翻譯分頁：譯文差異"]
```

[可縮放 SVG](diagrams/architecture/05-quality-correction.svg) · [Mermaid 原始碼](diagrams/architecture/05-quality-correction.mmd)

## 摘要原文、翻譯與取消

只有按下產生摘要才會執行。已有原文摘要時使用翻譯模型；尚無原文時使用摘要模型直接生成目標語言。兩種欄位分開保存，取消／晚回應不得覆蓋先前成功結果。

```mermaid
flowchart TB
  HIST["紀錄更多操作 → 摘要<br/>預先選中紀錄"] --> SETUP["選紀錄＋模板＋分頁"]
  SETUP --> CLICK["按產生摘要<br/>只執行目前分頁動作"]
  CLICK --> TAB{"目前分頁？"}
  TAB -- "原文" --> SOURCE["逐字稿＋模板<br/>按瀏覽器／系統語言生成"]
  SOURCE --> PLAN["Summary workflow<br/>分塊 → 分批合併／壓縮 → 模板輸出"]
  PLAN --> SM["Summary API<br/>串流預覽＋取消"]
  SM --> ORIGINAL[("session.summary<br/>來源 signature／versionId")]
  TAB -- "翻譯＋目標語言" --> EXIST{"已有原文摘要？"}
  EXIST -- "是" --> TM["Translation API<br/>翻譯現有摘要／保留 Markdown"]
  EXIST -- "否" --> TARGET["Summary workflow<br/>直接以目標語言生成<br/>不額外生成原文副本"]
  TARGET --> SM2["Summary API<br/>串流請求／取消"]
  TM & SM2 --> TRANSLATED[("session.summaryTranslation<br/>summaryTranslationTargetLanguage")]
  ORIGINAL & TRANSLATED --> RESULT["各分頁顯示對應結果<br/>複製／TXT／Markdown／DOCX"]
  CANCEL["取消／切紀錄／離開／切帳號"] -. "AbortSignal＋generation／epoch" .-> SM & TM & SM2
  SM & TM & SM2 -. "失敗／晚回應" .-> KEEP["保留先前成功結果<br/>顯示錯誤／可重試"]
```

[可縮放 SVG](diagrams/architecture/06-summary.svg) · [Mermaid 原始碼](diagrams/architecture/06-summary.mmd)

## 模型連線設定、加密與重新部署

模型目錄、API key 加密內容、解密密鑰是三種不同資料。環境模型的覆蓋／選用規則與帳號設定是否仍存在，也是不同問題。手動 API 測試目前檢查連線、認證、模型清單或本機 runtime，不保證實際模型輸出品質。

```mermaid
flowchart TB
  ENV["部署環境設定<br/>Endpoint／Model／服務 API key"] --> DEFAULT["環境模型與公開設定<br/>由伺服器管理的卡片唯讀"]
  UI["模型管理／卡片設定<br/>使用者輸入新的 API key 僅暫存在記憶體"] --> SAVE["authenticated API<br/>模型目錄與憑證分開保存"]
  SAVE --> REG[("config store<br/>model-registry：ID／Endpoint／Model／requiresApiKey")]
  SAVE --> ENC["AES-256-GCM<br/>隨機 IV＋認證標記"]
  SECRET["穩定加密密鑰<br/>正式環境：S2T_AUTH_SECRET<br/>目前本機：/data/auth-secret"] --> ENC & DEC
  ENC --> CRED[("config store<br/>model-credential-ID：加密內容")]
  DEFAULT & REG --> RESOLVE["依環境／帳號規則解析模型<br/>不回傳已保存 API key 給 UI"]
  RESOLVE --> DEC["服務端解密憑證"]
  CRED --> DEC
  DEC --> CALL["Gateway 對模型服務發出請求"]
  TEST["卡片 API 測試<br/>使用已保存設定或明確的暫存草稿"] --> RESOLVE
  CALL --> HEALTH["連線／認證／模型清單檢查<br/>本機模型檢查 runtime／權重<br/>不等於實際推論品質測試"]
  REDEPLOY["重新部署 AP"] --> KEEP{"相同持久化資料<br/>且相同加密密鑰？"}
  KEEP -- "是" --> RESTORE["可重新讀取 Endpoint 與加密 key<br/>仍需上游服務／網路可用"]
  KEEP -- "否" --> ERROR["設定不存在或 API key 無法解密<br/>需還原資料／原密鑰或重存 key"]
  ENV -. "環境變更仍會影響預設／覆蓋規則" .-> RESTORE
```

[可縮放 SVG](diagrams/architecture/07-model-settings-and-redeploy.svg) · [Mermaid 原始碼](diagrams/architecture/07-model-settings-and-redeploy.mmd)

## 可選 K8s 分工與遠端 Storage

這是 repo 已提供的部署範例，不代表目前 8787 AP 已採此拓撲。範例為 API 2、Audio Service 2、Audio Worker 1；容量與 HPA 上限仍須依真實負載校準。Redis／Sentinel 是否啟用須依 scale 設定，不可畫成目前本機必備依賴。

```mermaid
flowchart TB
  WEB["Web／Electron 用戶端"] --> ENTRY["Ingress／外部 HTTPS<br/>部署時另行配置"]
  ENTRY --> API["Gateway API Pods<br/>role=api · 範例 replicas=2<br/>JWT／路由／限流／服務代理"]
  API --> MODEL["外部 ASR／Translation／Summary API"]
  API -- "內部 token＋HTTP" --> AUDIO["Audio Service Pods<br/>role=audio-service · 範例 replicas=2<br/>VAD／轉碼／embeddings／講者運算"]
  API --> PG[("PostgreSQL<br/>帳號／設定／紀錄／工作／CAS／lease")]
  API --> MINIO[("MinIO · 音訊／聲紋檔")]
  API --> MILVUS[("Milvus · 聲紋向量")]
  WORKER["Audio Worker Pods<br/>role=audio-worker · 範例 replicas=1"] -- "claim／renew／finish" --> PG
  WORKER --> MINIO
  WORKER --> LOCAL["各 Pod 獨立音訊 runtime<br/>Sherpa／Nemotron／FFmpeg"]
  AUDIO --> LOCAL
  AUDIO --> MILVUS
  WEIGHTS["唯讀模型 PVC · /models"] --> AUDIO & WORKER
  SHARED["相同 Kubernetes Secret<br/>S2T_AUTH_SECRET／Storage／模型 key<br/>S2T_AUDIO_SERVICE_TOKEN"] -. "所有相關 Pod" .-> API & AUDIO & WORKER
  API -. "共享限流／admission／lease<br/>依 scale 設定啟用" .-> REDIS["Redis＋Sentinel"]
  API & AUDIO & WORKER -. "/metrics" .-> PROM["Prometheus／Adapter／HPA<br/>RollingUpdate／readiness／drain／PDB"]
  PROM --> GRAF["Grafana"]
```

[可縮放 SVG](diagrams/architecture/08-optional-scale-deployment.svg) · [Mermaid 原始碼](diagrams/architecture/08-optional-scale-deployment.mmd)

## 監控、部門與 NT 使用行為

Grafana 是呈現與查詢層；Prometheus 抓取 Gateway 與 exporters 的量測。部門／NT 趨勢以 L2 計數，L1／L2／L3 漏斗依選定範圍統計。圖表存在不代表當前時間區間一定已有樣本。

```mermaid
flowchart LR
  subgraph EVENTS["量測來源"]
    PAINT["前端實際 paint<br/>t1～t7／E2E tail"]
    JOURNEY["L1：載入網站<br/>L2：按開始錄音<br/>L3：成功開啟有內容的紀錄／摘要"]
    REQ["Gateway 請求<br/>狀態碼／耗時／tokens／audio"]
    RUNTIME["程序／worker／背景工作"]
  end
  PAINT --> TELE["/api/telemetry/captions"]
  JOURNEY --> JT["使用者 journey telemetry<br/>NT／部門標籤與帳號隔離"]
  TELE & JT & REQ & RUNTIME --> MET["Gateway /metrics<br/>histogram／counter／gauge"]
  MET --> PROM["Prometheus scrape<br/>gateway-web＋基礎服務 exporters"]
  EXPORT["Storage exporters<br/>PostgreSQL／Redis／Sentinel<br/>MinIO／Milvus／etcd"] --> PROM
  PROM --> GRAF["Grafana 報表<br/>預設最近一週／刷新 30 秒"]
  GRAF --> KPI["E2E P90 小於 3 秒<br/>t1～t7 avg／API 成功率"]
  GRAF --> TREND["部門／NT 趨勢與篩選<br/>L2 人數／次數 · L1→L2→L3 漏斗"]
  GRAF --> ERR["HTTP 4xx／5xx<br/>每個 NT 一條線"]
  GRAF --> ASR["t1～t5 每分鐘平均<br/>Storage 只看 healthy"]
```

[可縮放 SVG](diagrams/architecture/09-observability.svg) · [Mermaid 原始碼](diagrams/architecture/09-observability.mmd)

## 持久化不變條件

| 資料 | 現行 local 位置／責任 | 重新部署注意事項 |
| --- | --- | --- |
| 帳號、模型目錄、加密 API key、session metadata、工作 | `/data/config.json`，以 config adapter 操作並隔離帳號 | 保留原 Volume；遠端模式則保持相同資料庫與 schema |
| 錄音與聲紋樣本 | `/data/blobs`，blob adapter | 保留原 Volume／MinIO bucket 與帳號 scope |
| 聲紋向量 | `/data/vectors.json`，vector adapter | 保留原 Volume／Milvus DB 與 collection |
| API key 解密密鑰 | 本機 `/data/auth-secret` 或固定 `S2T_AUTH_SECRET` | 相同加密內容必須搭配原密鑰；只保留資料庫而換了密鑰仍會無法解密。沒有自動 key rotation／重加密流程 |
| 瀏覽器未同步錄音 | OPFS／IndexedDB，依 origin 與帳號區分 | 換網域／port／瀏覽器或清除網站資料，不能假設仍可取得原本的本機恢復資料 |
| 模型 Endpoint 與網路 | 部署環境及帳號 model-registry | 持久化成功不保證新容器能連線；DNS、服務位置、port、憑證、環境覆蓋仍須一致 |

## 錯誤與相容性邊界

- Storage 設定完全缺席時選 local；一組遠端設定只填部分會報錯，不靜默切換另一個資料庫。
- 失敗紀錄仍可依已有的音訊或逐字稿進行摘要／校正；處理中的紀錄不得被相衝突的編輯覆寫。
- 校正的進度狀態不是跨瀏覽器重啟可恢復的 durable job；保存成功的 AudioVersion 才是持久化比對來源。
- 原文改動會使對應舊譯文失效；未勾選翻譯不代表可以把過期譯文當成新字幕的正確翻譯。
- API key 保存時會經使用者輸入的 renderer 記憶體提交；已保存的 key 不回傳至瀏覽器，不將 key 放入公開模型清單。
- 啟用環境模型時，重新載入仍會按現行規則選回環境預設；模型資料未遺失與使用者上次選用狀態被保留不能混為一談。

## 中立契約

`src/shared/contracts/` 是 application、models、settings、sessions、transcript、capture、response-speed 與 DesktopBridge 的單一型別來源；不依賴 renderer／server 實作。`src/shared/validation/` 提供 main、renderer、server 共用的 CJS runtime validator，Docker runtime 會包含該目錄。

## Renderer

| 位置 | 責任 |
| --- | --- |
| features/app | 路由與功能組裝。Controller 還有待抽離的 capture／sync／summary orchestration，不可再回填新領域服務。 |
| features/sessions | 三方合併、storage state、recovery domain 與 injected recovery handlers、remote repository。 |
| features/capture | VAD、resampling、AudioWorklet 與音訊輸出。 |
| features/models | ModelAdapter、noop/WebSocket/HTTP adapters、ASR text domain、卡片 API 測試。 |
| features/quality-comparison | 字幕／講者／譯文比對；直接父版本與暫存 baseline、差異列。 |
| features/transcript | WAV/import、caption grouping、correction、逐字稿文件與畫面。 |
| features/translation | 翻譯策略與 revision/cancel-aware queue。 |
| features/summary | 摘要 templates/plan、stream decoder、document export 與 SummaryWorkspace。 |
| features/settings | 環境設定與 glossary domain、settings/admin/template 畫面。 |
| features/speakers | 講者結果解析、聲紋 storage、講者標註畫面。 |
| features/captions | 字幕呈現、paint metric、浮動視窗。 |
| shared/http | authenticated transport；不反向依賴 auth feature。 |
| shared/events、shared/ui | 組合用 EventChannel 與無 domain 依賴的共用 UI。 |

`shared/types.ts`、`model-adapter.ts` 與 `src/shared/response-speed.ts` 是相容 exports，沒有原本的 domain／adapter 實作。功能測試直接 import 正式 service；不要擷取 controller 宣告字串作為長期測試介面。

## Server

| 位置 | 責任 |
| --- | --- |
| server/index.cjs | CLI 啟動、process signals 與 exit；匯入不啟動服務。 |
| server/bootstrap.cjs | 明確 startGateway() 組裝、readiness、可等待 stop；其餘 routes/services 仍待拆分。 |
| server/http/app.cjs、http/routes | 無 listen 副作用的 createHttpApp；recordings、sessions routes 已拆分。 |
| server/jobs/diarization.cjs | 注入依賴的單筆 durable job runner；排程由 bootstrap 擁有。 |
| server/auth | 登入與撤銷、bootstrap、user stores；sharing authorization 與展示用 Department 分離。 |
| server/storage | local、MinIO/PostgreSQL/Milvus adapters，CAS／update 與 job fencing。 |
| server/audio/wav.cjs | 不依賴模型的 WAV decoding/resampling，解除 Silero/Sherpa 循環。 |
| server/audio/clients | 明確 local/remote AudioOperations；不散播 worker pool 內部介面。 |
| server/http/internal-audio.cjs | private audio HTTP surface 與 import proxy。 |

每組 remote storage 環境變數必須完整；完全沒有設定時才使用該本機 adapter。已保存的模型憑證不回傳 renderer；使用者新增／更換 key 時，輸入值短暫經 renderer 送入經認證的保存 API，不將明文 key 寫入瀏覽器設定。Kubernetes 的 shared storage／lease fencing／drain 契約不可因搬檔改變。

## 檢查入口

`npm run check:architecture` 檢查執行期 SCC、shared → feature 與 src → server 的反向引用。`npm run check` 執行 typecheck、architecture gate、安全本機／HTTP tests，以及 Electron/Web build。模型、瀏覽器與外部 storage tests 明確分組，見 tests/README.md。

## 圖與實作來源

- 前端流程：`src/renderer/src/features/app/hooks/useAppController.ts`、`features/app/views/AppView.tsx`。
- 品質比對：`features/quality-comparison/domain/comparison.ts` 與對應 workspace。
- 摘要：`features/summary/services/summarize-transcript.ts`、`translate-summary.ts` 與 `SummaryWorkspace.tsx`。
- 認證與憑證：`server/auth/index.cjs`、`server/bootstrap.cjs`、`server/model-api-test.cjs`。
- 音訊與背景工作：`server/audio/client.cjs`、`server/jobs/diarization.cjs`、worker pool／Nemotron modules。
- 持久化：`server/storage/config.cjs`、`local.cjs`、`remote.cjs`；瀏覽器 recording／session sync adapters。
- 部署：`docker-compose.gateway.yml`、`deploy/k8s/workloads.yaml`、`deploy/k8s/autoscaling.yaml`。
- 監控：`server/metrics.cjs`、`server/usage-metrics.cjs`、`shared/services/caption-metrics.ts`、`deploy/monitoring/oncall.py`。
