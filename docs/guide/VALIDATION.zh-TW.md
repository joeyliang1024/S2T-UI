# S2T UI 驗收手冊

本手冊區分可自動驗證的建置結果、已驗證的 ASR API 路徑，以及必須由真人在目標裝置操作的功能。請不要把 API 回傳成功當成麥克風、權限或系統音訊已驗收。

## 已完成的基線驗證

| 項目 | 結果 | 證據／指令 |
| --- | --- | --- |
| TypeScript 型別 | 通過 | `npm run typecheck` |
| Production bundle | 通過 | `npm run build`（Electron）及 `npm run build:web`（Web） |
| Diff 格式 | 通過 | `git diff --check` |
| 本機儲存與帳號隔離 | 通過 | `npm run storage:smoke`（含原子 `update` 並發寫入與 stale-lock 回收） |
| Gateway PostgreSQL 啟動 | 通過 | `npm run storage:gateway:smoke`（暫存資料庫實啟 gateway，驗證 schema migration 與 auth bootstrap 無競態、第一個 API 要求不 crash） |
| Storage 提交寬限 | 通過 | `npm run storage:grace:smoke`（上傳後未提交的音檔不會被無關的 session 儲存刪除；過期後補償仍會清除） |
| 音訊重取樣 | 通過 | `npm run resample:smoke`（48k→16k、44.1k→16k、原率直通、分塊一致性與停止時尾段 flush） |
| 術語 JSON 解析 | 通過 | `npm run glossary:smoke`（物件／陣列、無效內容、重複與空資料） |
| 免 key ASR adapter | 通過 | `npm run model-adapter:smoke`（免 key 模型不查 key；需 key 模型會被阻擋） |
| 翻譯排程策略 | 通過 | `npm run translation-policy:smoke`（HTTP final 合併、逐句上限與失敗不自動重送） |
| 摘要分段規劃 | 通過 | `npm run summary-plan:smoke`（完整重組、分層批次與內容簽章） |
| 摘要模板規則 | 通過 | `npm run summary-templates:smoke`（即時選取、預設格式與至少保留一個模板） |
| 五語系字典完整性 | 通過 | `npm run i18n:smoke`（所有已登錄 key 均有繁中、簡中、英文、日文、德文） |
| Gateway 授權與聲紋同意 | 通過 | `npm run gateway:auth-smoke`（本機 loopback，拒絕未授權與未同意的共享聲紋請求） |
| Breeze HTTP ASR | 通過 | 本機中文 WAV → `/v1/audio/transcriptions` → 非空白文字 |
| Web 模型載入 | 通過 | `GET /api/config` 回傳 `Breeze-ASR-25`；Web 下拉選單已選取該模型 |
| Web BFF 轉錄 | 通過 | Web UI → 同源 BFF → ASR → 非空白文字 |

API key 僅存在忽略的 `.env`，不應寫入本文件、截圖、前端 bundle 或 Git。

## 啟動測試環境

```bash
# 建置並啟動 Web gateway；同時提供 UI 與 API
npm run build:web
npm run web:serve

# 需要 Electron 時另開終端；會先建置再 preview，沒有 renderer HMR
npm run dev
```

- Web：開啟 `http://127.0.0.1:8787/`，確認 ASR 模型是 `Breeze-ASR-25`。
- Electron：由 `npm run dev` 開啟的 S2T UI 視窗測試原生保存、safeStorage、浮動字幕與系統音訊。
- Production Web：以 `npm run build:web` 建置 `out/web`，再以 `npm run web:serve` 開啟 `http://127.0.0.1:8787/`。

## 近即時字幕驗收

### Web 與 Electron 共用步驟

1. 在「即時轉錄」確認音源正確，ASR 模型已選取 `Breeze-ASR-25`。
2. 按「開始收音」，允許麥克風權限。
3. 以一般音量連續說 30 秒繁體中文，包含短停頓、人名、數字與一段中英混說。
4. 觀察彩色音量條，確認說話時立即變動，靜音時回到接近 `-60 dBFS`。
5. 確認字幕以連續段落出現，而不是每個字換行；HTTP 模式的結果是 final 字幕，沒有原生 partial 字元。
6. 按「結束收音」，確認最後不足一段的尾音仍會送至 ASR，再到「記錄」保存工作階段。

### 記錄表

| 測試日 | 平台 | 首段延遲 | 平均延遲 | 漏字／重複 | 尾段保留 | WAV 保存 | 結論 |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
|  | Web / Electron |  |  |  | 是／否 | 是／否 |  |

## 音訊與 VAD 驗收

| 場景 | 預期結果 |
| --- | --- |
| 靜音 10 秒 | 音量條接近 -60 dBFS；不應持續產生空白 ASR 請求或字幕。 |
| 一般說話 | 音量條立即反映；目前約 1.0–2.4 秒分段送 ASR，連續結果可合併至約 12 秒字幕段；實測以當次設定與版本為準。 |
| 500 ms 內短停頓 | 不應過度切碎字幕。 |
| 500 ms 以上停頓 | VAD 可完成一段；後續語句應保留約 300 ms pre-roll。 |
| 鍵盤聲／背景噪音 | 不應單靠短雜訊不斷送出空白片段。 |
| 切換音源 | 音量條、WAV 與字幕都應跟隨新裝置；失敗時保留舊裝置或顯示錯誤。 |
| 48 kHz → 16 kHz ASR | 保存的 WAV 仍為 48 kHz；送至 ASR 的 `start.sampleRate` 為 16 kHz，字幕時間、清除字幕邊界與實際錄音時長一致。 |
| 44.1 kHz → 16 kHz ASR | 以不同裝置或測試音訊重複上列檢查；長時間收音不可在區塊交界出現累積時間漂移。 |
| Electron 即時講者預覽 | 開啟講者分離後，桌面版每次只送最近 45 秒的 PCM WAV；回傳講者時間需對應整段錄音的絕對時間，且不增加無界 PCM 記憶體。 |

## Electron 專屬驗收

| 項目 | 現況 | 驗收條件 |
| --- | --- | --- |
| PCM16 WAV 持續寫入 | 已實作 | 錄製、停止、保存後可播放 WAV；TXT/VTT/JSON 可下載。 |
| API key safeStorage | 已實作 | 在完整設定保存 key 後可收音；key 不顯示於設定檔。 |
| 浮動字幕 | 已實作 | 開啟後顯示最新字幕；關閉可回到主視窗。 |
| 系統音訊混入 | 已實作平台分流 | Windows 使用 Electron loopback；macOS 15+ 使用 system picker。若取消或無 audio track，麥克風 session 必須持續；實際 audio track 仍需逐平台驗收。 |
| 跨重啟 session | 已實作 | 在「記錄」按「開啟已保存工作階段」，選擇含 `session.json` 的資料夾後可播放或再次匯出 WAV。 |
| 強制關閉錄音復原 | 已實作 | 強制關閉後重開，復原 WAV 應出現在「記錄」；先播放確認，再保存或下載。 |

## Web 專屬驗收

| 項目 | 驗收條件 |
| --- | --- |
| 模型載入 | `Breeze-ASR-25` 自動出現在並選取於快速設定 ASR 下拉選單。 |
| 模型 key | 瀏覽器 DevTools、localStorage、Web bundle 與 `/api/config` 均不能看到 key。 |
| BFF 限制 | `/api/transcriptions` 僅接受受允許 origin、單次上傳最大 100 MB、每 IP 每分鐘最多 60 次。 |
| 保存 | Web 經登入保護的 gateway 保存工作階段與音檔，IndexedDB 作本機後備，另可下載；沒有 Electron 原生資料夾保存功能。 |
| 系統音訊 | 依瀏覽器的 tab/screen share 支援情況；不等同 Electron loopback。 |

## 批次 WAV 轉錄驗收

1. 在「匯入檔案」選擇超過 100 MB 的 PCM16 WAV。
2. 按「開始批次轉錄」，確認顯示 `第 N / M 段` 進度；每段為 45 秒，與下一段保留 1.5 秒重疊。
3. 完成後確認字幕時間軸連續、交界處沒有文字重複。
4. 重新測試並按「取消批次轉錄」；Web 應中止當前請求；Electron 的當前請求取消另行驗證，兩端都不得繼續送出下一段，已完成內容不得被覆蓋。
5. MP3、M4A、影片與其他非 PCM16 WAV 檔會先透過登入中的 Gateway 轉成 PCM16 WAV，再分段轉錄；輸入與轉換後 WAV 均以 2 GB 為上限。請測試無音軌、損壞檔案與取消轉換。

## 尚不可簽核的項目

- Realtime WebSocket partial 字幕：等待自建 gateway 協定、認證與重連語義。
- 翻譯可靠性：ASR 獨立驗收可不設定翻譯 endpoint；翻譯仍須另做真實服務驗收，翻譯錯誤不得阻擋原文字幕。
- 60 分鐘穩定性、睡眠喚醒、低磁碟。
- 自動說話者分離、批次大檔、MP3/M4A、打包簽署與 Windows 實機。

剩餘工作與唯一優先順序請見 [Enhancement.md](../Enhancement.md)；本文件只維護驗收操作與證據，模型傳輸協定見 [MODEL_ADAPTER.md](../reference/MODEL_ADAPTER.md)。

2026-10-11 補驗：`session-recovery-smoke-test.cjs`、`session-recovery-handlers-smoke-test.cjs` 與 `summary-ui-recovery-smoke-test.cjs` 驗證失敗步驟單獨重試、部分成功結果保留、WAV 備份補救、刷新圖示與文字提示，以及設定頁模板新增／編輯／重載。瀏覽器與 handler 測試全用假 API，不代表真實模型品質評估。

## 已移出待辦的功能

2026-10-16 對照程式與現有回歸測試，從 Enhancement 移除已實作的開發工作及重複現況敘述。下表只列實作／測試入口，不代表本次文件整理重跑所有測試，也不取代真人、打包版、外部服務及長時間驗收。

| 已有功能 | 實作／回歸入口 |
| --- | --- |
| 中立契約與平台 ports | `src/shared/contracts/`；`asr-transport-smoke-test.cjs`、`text-transport-smoke-test.cjs`、`summary-transports-smoke-test.cjs`。剩餘 controller／IPC 拆分仍列 O01。 |
| Durable outbox、CAS 衝突選擇與 ACK cleanup | `features/sessions/services/sync-coordinator.ts`、`SessionSyncConflicts.tsx`；`session-sync-coordinator-smoke-test.cjs`、`session-outbox-browser-smoke-test.cjs`、`session-conflict-browser-smoke-test.cjs`。特殊復原仍列 O03。 |
| PCM sink、OPFS 多份復原與帳號隔離 | `features/capture/recording/`、`src/main/recording/`；`pcm-sink-smoke-test.cjs`、`recording-recovery-browser-smoke-test.cjs`、`native-recording-recovery-smoke-test.cjs`。Electron UI／長測仍列 V07／V09。 |
| NT 唯一、正式登入限制、可信共享與 admin 刪帳號 | `server/auth/`、storage account fence；`auth-policy-smoke-test.cjs`、`sharing-authorization-http-smoke-test.cjs`、`account-deletion-http-smoke-test.cjs`、`admin-accounts-browser-smoke-test.cjs`。 |
| 8787 同源 Web 與文件／環境範例整理 | `config/vite.web.config.ts`、`server/bootstrap.cjs`、兩份 env example；`gateway-single-origin-smoke-test.cjs`、`gateway-env-smoke-test.cjs`。持續維護不再列獨立 O10 開發項。 |
| 摘要 workflow、模板與明確觸發翻譯 | `features/summary/services/`、`SummaryWorkspace.tsx`；`summary-workspace-smoke-test.cjs`、`summary-translation-smoke-test.cjs`、`summary-ui-recovery-smoke-test.cjs`。 |
| 非 WAV／影片 server 轉碼、取消與清理 | `server/import-audio.cjs`、`features/transcript/import-formats.ts`；`import-audio-smoke-test.cjs`。輸入／輸出上限 2 GB；durable job 與完整壓測仍列 F03／V09。 |
| M4A、DOCX／XLSX 等輸出 | `features/capture/services/audio-export.ts`、`features/summary/services/document.ts`、`features/transcript/services/documents.ts`；`transcript-export-smoke-test.cjs`、`transcript-download-smoke-test.cjs`。真人檔案一致性仍列 V04／V06。 |
| 重講時間槽與音檔版本 | `useAppController.ts` 的重講／版本流程與 `speaker-flow-smoke-test.cjs`；既有固定時間槽已有實作，是否改成平移後續時間軸仍屬 Q04 規格問題。 |
| 五格速度、翻譯排程與觀測基礎 | `response-speed-smoke-test.cjs`、`translation-policy-smoke-test.cjs`、caption metrics 系列；真實語言品質與硬體量測仍列 U01–U03／O09。 |

省略 renderer 根目錄的入口以 `src/renderer/src/` 為根，測試 basename 位於 `tests/smoke/`。歷史完整需求由 Git 保留，不必放在日常待辦。

## 尚待逐頁核對的細節

這些條件從舊 Enhancement 保留至驗收手冊；不是已完成紀錄，也不要求恢復舊版布局。

- 模板管理：清單固定高度可捲動、選項固定高度、下方刪除按鈕同寬；右側預覽對齊清單與刪除按鈕，說明獨立，不重複顯示灰色「已保存模板」。跨視窗模板／術語衝突另需操作驗收。
- 模型對話框：註冊按鈕置中，用途與其他欄位同寬；只從既有模型卡編輯時顯示刪除，切用途不誤出現；低視窗可捲動。
- 字幕／側欄：即時控制不佔其他頁內容，收合後可由圖示開功能，展開／收合與高度捲動正常；搜尋、小／大字與段數位置需依現行布局核對。左右位置仍依 Enhancement Q06 決定。
- 歷史：選單有圖示、可關閉、鍵盤／焦點正常，小視窗不裁切；載入另一筆前保護未保存內容。名稱／建立時間／時長需核對升降冪及同值穩定性；前 40 筆以外可由全部紀錄找到。匯出含目前範圍、講者、翻譯、gap、CSV BOM／特殊字元與剪貼簿失敗情境。

## 暫移出開發待辦的驗收項目

2026-10-17 依使用者要求，將測試、量測與待驗收工作移出 Enhancement，集中於本手冊。這是整理追蹤位置，不代表以下情境已通過。原 ID 保留供既有文件引用。

### O04 登入、NT 與憑證可靠性 — 待驗收

- [ ] 驗證逾期／撤銷登入的提示與重新登入動線；正式環境禁止預設 admin 已實作，不再列開發待辦。
- [ ] 完成 Electron 登出、A/B 換帳號與重開驗收，涵蓋設定、key、模板、字幕、音訊及復原來源；含打包版見 V07。
- [ ] 實機確認逐模型憑證綁定與 DOM／儲存／匯出／日誌的秘密隔離；已有 gateway 加密保存、safeStorage 與 account epoch 不重做。

### O06 重講、接續與版本一致性 — 待驗收

- [ ] 驗證接續保存失敗、重試不重複追加、多聲道重講長度、解碼錯誤後 AudioContext 釋放。
- [ ] 驗證載入／編輯保護提示，以及搜尋、複製、匯出與摘要來源過期狀態一致；固定時間槽、音檔版本及文字快照已有實作。

### O09 降噪、取樣率研究與觀測 — 待驗收

- [ ] 相同素材比較 48k→16k、44.1k→16k、原率與降噪開關，記錄 CER／WER、聲紋誤配／漏配、聽感、樣本數與時間戳。
- [ ] 比較聲紋／ASR 重取樣品質，依實測決定預設；獨立降噪模型仍屬 Q08。
- [ ] 在既有 metrics、受控 fixture 與虛擬長錄音測試上，補目標硬體的 heap／RSS／queue／CPU／磁碟與端到端延遲量測；具體長測與門檻見 V09、Q09。

### U01 語者分離系統 — 待驗收

- [ ] 校正真實多人、短句、長停頓、噪音／重疊、模型版本／維度及聲紋誤配；核對前後端註冊樣本品質門檻一致，跨字幕／窗口一致性與人工修改保護見 V01。
- [ ] 完成雙平台即時預覽、歷史最終分離、重開、VTT／JSON 一致性及失敗不干擾 ASR／保存的驗收。
- [ ] 可信共享、帳號刪除與向量 metadata 已有實作／回歸；真實外部服務與完整授權情境仍按 V01／V08 驗收。選定 embedding 模型的剩餘接線追蹤 F01。

### U02 斷句速度 — 待驗收

- [ ] 補英文、日文、中英混說與鍵盤噪音資料，記錄句尾→final、首段 P50／P95、漏字／碎片化及請求數；現有中文五檔實驗不代表全語種完成。
- [ ] 雙平台驗證收音中調整速度的生效時機與 App／server VAD 不重複裁切；已有五格滑桿、持久化、UI 生效提示與尾音 flush 不重做。

### U03 翻譯模式 — 待驗收

- [ ] 用相同真實音訊比較即時／整句／手動／節流的負載、延遲、完整度與錯意；手動模式不得自動送請求。
- [ ] 覆蓋無標點長句、日文、混說、自動方向、停止尾句、5xx／429、取消、重開、人工編輯及晚到結果；失敗不得影響原文與 WAV。
- [ ] 雙平台核對選定模型的實際 prompt；自動方向與嚴格整句的剩餘規格見 Q02。

### 驗收範圍索引

下列是驗證範圍，不是新增功能或另一組優先順序。詳細操作與既有證據在 本手冊，量測素材在 [experiment](../../experiment/README.md)。每次驗收記錄版本、平台、模型、素材、設定與結果；自動化／mock 成功不代替真人、打包版或外部服務品質。

| ID | 尚需完成的驗收範圍 |
| --- | --- |
| V01 | 已知＋至少兩名未知講者；跨窗口／長停頓／重疊、人工保護、版本不相容、共享與刪除權限。 |
| V02 | 兩平台真實收音、參數變更、靜音／短停頓／長句、尾音、慢模型與 gap。 |
| V03 | 翻譯模式的真實品質、請求數、方向、取消／重試與 revision 邊界。 |
| V04 | 大量歷史的排序／搜尋／分頁，以及目前版本的複製、講者、時間軸與匯出檔一致性。 |
| V05 | 保存→重開→選版→接續／重講；失敗、取消與回復舊版不破壞其他版本。 |
| V06 | 長摘要／重生／手動翻譯、模板／術語跨視窗衝突、真實 prompt 與匯出一致性。 |
| V07 | Electron 開發／打包版分開驗證：身分切換、原生復原、safeStorage、權限與乾淨裝置安裝。 |
| V08 | 真實外部 HTTPS 與三類 adapter、並行／離線／配額／權限、遷移／備份，以及帳號級刪除與故障重試。 |
| V09 | 60 分鐘真人、2 小時雙平台、4 小時／10,000 段、2 GB；睡眠／拔除／斷網／低磁碟／強制關閉與資源界限。 |
| V10 | 模型選擇／免 key、語言能力、取樣率／offset、大檔續跑／取消；WebSocket 先取得 Q03 契約。 |
| V11 | 真實內建／USB／系統音訊、混音與換源、拒絕／拔除、雙音量表與降噪效果。 |
| V12 | 全頁五語系×主題×窄／低視窗，含路由、鍵盤／焦點、模板／模型對話框、側欄／選單與浮動字幕。 |

### 開發待辦的程式核對補記（2026-10-17）

- 歷史頁已有 10／20／50／100 筆分頁、前後頁操作；live 側欄顯示最近 40 筆並提供全部紀錄入口。因此移除重複的歷史 UI 分頁待辦。實作為 `useAppController.ts` 的 `historyPageCount`／`pagedSessions` 與 `AppView.tsx` 的 `history-pagination`／`live-sidebar-history`。資料層分頁及大量字幕搜尋的虛擬化仍未完成。
- 摘要的 `summaryChunks`／`summaryBatches` 已以 24,000 字元分組，`summarizeTranscript` 有分層合併及有界壓縮；核對當時剩餘依選定模型的 context window 預算及 UI 取消；UI 取消已由下述 Web 批次補上，context window 預算仍待開發。
- Electron 錄音 manifest 已有 active／finished 狀態；剩餘是與字幕游標、暫停／換源／gap 事件整合的同批復原。
- CI 已執行型別、架構、測試及 Electron／Web build；尚無安裝包產出與發布流程，因此 F04 改為明確要求 packaging／release CI。

上述核對階段只整理文件；後續 Web 實作與驗證另記如下。

- 補核對：`SummaryWorkspace.tsx` 與 controller 仍以「正在產生摘要…」作為摘要狀態 sentinel，此缺口已由下述 Web 批次補上；一般 capture enum 與既有五語系字典不再列待開發。

### Web 優先實作（2026-10-17）

Electron 專屬開發與打包暫停，保留於 Enhancement 第四節；Web 仍由 gateway `8787` 同源提供。

- 遠端 sessions／live draft／import checkpoint GET 回應新增深層 runtime guard；破損格式明確報錯，避免被當成空資料再覆寫。保留舊紀錄 optional 欄位及缺少 draft／checkpoint 的相容性。對應 `remote-session-response-smoke-test.cjs`。
- 歷史搜尋／排序／分頁已抽至 `features/sessions/domain/history.ts`，controller 使用 memoization，避免錄音計時與音量更新重做整份搜尋／排序。標題排序跟隨介面語言；資料層分頁仍待開發。對應 `session-history-smoke-test.cjs`。
- 摘要改用 `summaryState`，舊中文字串僅在載入遷移時識別。新增取消操作、request identity／來源版本保護與逐階段 AbortSignal；取消／失敗恢復原摘要與翻譯，重開時顯示中斷提示。摘要翻譯維持按鈕明確觸發。對應 `summary-cancellation-smoke-test.cjs`、`summary-cancellation-browser-smoke-test.cjs` 與 `summary-ui-recovery-smoke-test.cjs`。

本批驗證：`npm test` 69／69、`npm run test:http` 12／12、型別檢查、架構檢查及 `npm run build:web` 均通過。7 個瀏覽器案例均已通過（其餘 5 項由 e2e suite 執行；摘要恢復與新增取消案例於最終 bundle 分別重跑）。測試使用本機 mock／隔離資料，沒有呼叫真實模型服務；不代表真實模型品質或部署環境已驗收。

### 模型健康異常原因（2026-10-17）

Web 模型卡片平常只顯示燈號與狀態；點擊燈號才以對話框顯示健康檢查原因；刷新失敗後不繼續沿用舊的 healthy 狀態。OpenAI 相容服務以 `/models` 檢查可達性與模型名稱，回報認證／權限、端點不存在、限流／配額、上游故障、DNS／連線／TLS 與逾時原因；上游訊息遮蔽已知金鑰與 Bearer token。這不是推論品質或推論端點的完整測試。本機 Silero／sherpa 維持模型檔與 runtime／worker 檢查；localhost 的 OpenAI 服務不再只因位址而誤判成 sherpa。

驗證：`model-health-smoke-test.cjs`、i18n、typecheck、architecture、Web build 通過；隔離 Chrome fixture 確認桌面與手機寬度均可點擊燈號查看 HTTP 401 原因。未呼叫真實模型服務。

模型燈號補核對：單一模型解密／讀取失敗以該模型 unhealthy 回報，不使整批 API 失敗；更新憑證會失效快取，前端僅接受最新一次檢查結果。`/models` 的 404／405 改為 degraded，WebSocket 無 HTTP 檢查契約則 unknown；名稱或 localhost 位址不再決定本機 runtime。registry 還原等待遠端 app settings，避免延遲設定覆蓋已讀取的自訂模型。`model-health-restart-http-smoke-test.cjs` 已驗證五種 purpose＋金鑰在同 storage／secret 下重啟仍 healthy，並驗證 secret 更換的明確錯誤、其他模型不受牽連及重新存 key 後恢復。

`model-health-browser-smoke-test.cjs` 已通過：桌面／手機燈號點擊顯示原因、關閉／鍵盤操作、不誤開模型編輯、自訂模型等待延遲設定載入、重新整理後模型卡片仍存在。

### H100／H200 單一模式開關（2026-10-17）

對外只保留 `S2T_INFERENCE_BACKEND=cpu|cuda`。CUDA 配置固定為 Nemotron CUDA、sherpa／聲紋與 Silero CPU；GPU 裝置交給部署平台，runtime 路徑由 image 決定。已移除先前尚未發布的個別 provider、GPU index、runtime 路徑變數及不再使用的 ONNX CUDA 預檢程式。詳見 [GPU 指南](GPU.zh-TW.md)。

收斂後 unit 72／72、型別、架構、Nemotron command／timeout、model-path、Silero／sherpa worker 專項通過；GPU overlay 已確認只有一個模式開關且沒有額外對外 port。沒有 H100／H200 實際推論或 GPU image 建置結果，本機只有 YAML parser，沒有完整 Compose plugin。硬體驗收腳本為 `scripts/benchmarks/gpu-diarization.cjs`。
