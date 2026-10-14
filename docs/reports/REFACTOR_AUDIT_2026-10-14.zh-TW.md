# 整合修改計劃：目前驗收盤點

完整目標維持 REFACTOR_PLAN_2026-10-13.zh-TW.md，本盤點不將目標縮成已完成的部分。所有變更在 codex/technical-debt-refactor worktree，原 checkout 保持原狀；尚未 stage、commit 或 push。

## 已有直接證據

- Consent header 與可信共享授權：獨立 authorization record、admin 管理 API/UI；HTTP 正向註冊／比對、未核准、跨部門與撤銷測試通過。本機 adapter 驗证通過；PostgreSQL 新查詢仍需隔離服務驗證。
- Revocation storage 失敗向上回報；invalid/expired token 與 storage errors 分離。故障注入／並行撤銷測試通過；frontend 在暫時錯誤時保留憑證供重試。
- Development default admin 明確 opt-in，production 禁止 fallback、首次 credential guard、已有 admin 保留，auth-policy 測試通過。
- 中立 contracts/validation、main/preload/renderer DesktopBridge、WAV helpers、authenticated HTTP transport 與 i18n 類型已分離；架構 gate 沒有 runtime SCC 或反向 shared/feature/server 引用。
- ModelAdapter 三個實作分模組，EventChannel 使用 composition；沒有新增大型 abstract base。三方 session merge、metadata ACK race、OPFS read/ack/file-backed recovery 已有回歸測試。
- Recovery handlers 已直接 export/import injected service；測試不再擷取 controller 字串。30 個模組移入各 feature，更新 imports 與 fixtures。
- 安全 suite manifest、直接 esbuild/Playwright 依賴、Node22 CI、可配置瀏覽器與 ffmpeg checksum 準備已建立。Git models ignore 已限定根目錄，避免漏掉新程式檔。
- Docker Web 使用独立 build:web；Web out/web 與 Electron out/renderer 不互相覆蓋。登入後 shell、docx/xlsx 改 lazy import。Web 初始 JS 從相同配置的 1407.47 kB 降為 426.46 kB（未 gzip）；登入後 app/文件 SDK 另按需載入，尚未作完整使用者效能基準。

## 驗證來源

- 本機安全套件及 HTTP gate：先前 53/53 與 9/9 通過；分類修正後無模型的 Node22 乾淨副本 unit 為 52/52。
- 乾淨副本 npm ci --ignore-scripts、Node22 v22.23.3；發現需準備 ffmpeg runtime 後，HTTP 9/9、Electron/Web builds 通過。
- 瀏覽器端（真實 Chrome＋loopback fixtures）：summary/recovery 與 caption paint metrics 2/2 通過，包含 lazy shell 後重跑。
- Native model suite 先前 7/8，失敗原因為私人 fixture 路徑；改為受控 fixture 後 audio-residency 單項通過，確認第二 heavy job transferredBytes=0。其餘 7 項先前通過，尚未將新整個 suite 再跑成同一次 all-green 證據。
- 最新 Typecheck、Electron/Web builds、DOCX/XLSX/text exports、diff check 通過。後續每次 source 改動必須按影響重新驗證。
- 實際 code-review-graph 改後：265 files、1949 nodes、19669 edges；已保留改前與改後 JSON。工具 test/impact 推論限制仍適用。

## 尚未完成，不能宣告整體目標 achieved

1. Durable session outbox 與同筆 conflict resolution UI 已實作；owned OPFS 多份 recovery manifest、跨重載啟動復原與 metadata ACK 閘門已有真實 React/browser 證據。仍需完整 app 的衝突選擇／重載／新一輪遠端變更 E2E、初始化失敗後重開 outbox 與 sync/cleanup coordinator。遠端 live-draft endpoint 仍是一份 legacy pointer，跨裝置／僅遠端 source 的多份 metadata 仍需收尾。
2. ASR、TextCompletionPort、SummaryStreamPort 已有注入式 Web/Electron 實作，平台判斷留在 composition factory；PcmSink 已整合 typed artifacts 與各平台完成／中止；完整 capture lifecycle／Electron UI E2E 仍未完成。
3. AppController 仍約 3400 行，AppView/SettingsView 仍有整包 controller/refs/setters；需抽 feature hooks/view contracts、summary generation/title 狀態所有權、capture workflow 與 history view model；摘要分段合併及摘要翻譯 workflow 已抽成 services。
4. Server 已拆 CLI/bootstrap、無副作用 HTTP factory、recordings/sessions routes 與 durable diarization runner；其餘 routes/services、job scheduler 與 main IPC 仍需按領域拆分。bootstrap 仍偏大，不能把搬檔當作整體完成。
5. Storage/HTTP payload runtime contracts、來源/媒體 manifest、CSS 模組責任與所有文件連結收尾。
6. 針對最新全量 snapshot 的 Node22 clean check＋browser/Electron recording/import/cancel/account-switch E2E、隔離 PostgreSQL/MinIO/Milvus/Redis 与 drain/fencing 驗證，以及全量 completion audit。

本輪屬於有實際程式、測試與依賴圖變更的 progress；沒有完成全部要求，goal 保持 active。下一批優先完成 sync/outbox/conflict UI 與 cleanup manifest，再處理其餘組裝層。

## 使用者修正合併後的進度

- 依初始 baseline 做三方合併；保留使用者的翻譯逾時、Markdown 格式、API key 傳遞、摘要／管理介面與處理階段修正。搬移過的程式在新 feature 路徑整合；DesktopBridge 保持單一契約，沒有恢復重複宣告。原 checkout 未修改。
- 新增 IndexedDB session outbox：account/tab 隔離、接受時 clone、序列寫入、僅 matching ACK 清除、close 等待已接受寫入；損壞資料讀取或 ACK 失敗時保留資料。controller 已接入 hydrate/checkpoint，Settings 有逐筆 local/remote 衝突選擇；完整 app 衝突 E2E 仍未完成。
- authenticated transport 保留標準 Headers，gateway URL 等待期間與重試前檢查憑證，阻止舊帳號 payload 被新帳號重送；另加專項測試。同步重載回應也檢查 owner 是否仍 active。
- 最新驗證：TypeScript、架構 gate、unit 53/53、HTTP 9/9、Electron/Web 建置通過；真實 Chrome 的 outbox reload、stale ACK、account/tab 隔離、close drain、corrupt retention 通過。完整瀏覽器 e2e 3/3 通過（summary/recovery、caption paint metrics、outbox）；尚未包含完整 app 衝突解決 E2E。
- 實際 code-review-graph 重新建立：269 files；postprocess 後 stats 為 1981 nodes / 19979 edges。build 的原始計數與 postprocess 不同，引用 stats 為準。報告 CODE_REVIEW_GRAPH_CURRENT.json；工具沒有 igraph，community 採 file fallback，不能據此宣稱所有耦合已解決。

整體計劃仍未完成，尤其 coordinator、平台 ports、controller/server 組裝層與外部服務整合驗證，goal 保持 active。

## Server 組裝邊界拆分

- server/index.cjs 保留 CLI、signals 與 exit；require index/bootstrap 不載入 storage/model workers、不監聽 socket、不安裝 process listeners。startGateway() 明確啟動，回傳 server、prepareForShutdown、stop；stop 為冪等 Promise，不結束宿主，清理排程、connections、worker pool、shared limits 與 storage。
- server/http/app.cjs 的 createHttpApp(deps) 僅建立 server，由 bootstrap 決定 listen；保留 request ID、log context、request accounting、quiescing 與 draining admission，並將同步 handler throw 納入統一 503 handling。
- recordings 與 sessions 路由獨立注入依賴；promote 的 protected upload、CAS 與 cleanup intent 順序保留。HTTP 回歸曾抓到 promote 漏注入依賴，已修復並重跑。
- server/jobs/diarization.cjs 直接 export injected runner；caption-background 測試直接呼叫正式模組，移除 server source slicing。job 的 lease renewal/fencing、部分紀錄同步與失敗處理保持原有行為。
- 新增 import/factory 合約測試及隔離子程序 lifecycle 測試：ready → quiescing/not-ready → await stop → 自然離開，確認 stop 不執行 process.exit。
- 驗證：unit 54/54、HTTP 10/10 通過；最終架構 gate 134 modules、沒有 runtime cycles／反向依賴；完整 browser e2e 3/3 通過。code-review-graph postprocess stats：276 files、2008 nodes、20103 edges，已更新 CURRENT JSON。此批未修改 renderer 程式，既有 build 結果不當作新 server 行為的證明。
- 尚未完成：其他 routes/services/scheduler、controller workflows、平台 ports、recovery manifest 與外部服務合約驗證；goal 保持 active。

## ASR transport port 與帳號 epoch

- OpenAiChunkedModelAdapter 的 constructor 明確接受 AsrTransport；不再匯入 authenticated HTTP、不判斷 window.s2t、不處理 Web wire headers/回應 decode/timeout。保留 PCM queue、rolling context、VAD、retry/backpressure 與 diagnostics 所有權。
- createOpenAiChunkedModelAdapter 在組裝邊界選 Web 或 Electron transport；production controller 與現有 fixtures/tests 明確使用 factory，class export 留供 instanceof 與注入測試。沒有加入 abstract base class。
- Web transport 固定 profile、account epoch、language/prompt/idempotency request；保留 Server-Timing 與 timeout 跨 body read 的生命週期。AbortError 不再作 transient retry，也不混成 TimeoutError。Electron 維持 keyless profile 與可信 main 金鑰檢查，固定 bridge/profile 並攔截舊帳號的請求／結果。
- transport 契約明確 cancellation：Web=request；Electron=result，因現有 ASR IPC 沒有 cancellation request ID，不宣稱可停止 main 的 inference。
- shared authenticated-client 加 requestEpoch；auth save/session/logout/401 更新 authenticated user identity。即使 Web cookie-only 沒有 renderer token，明確帳號切換仍使舊 transport/retry 失效。跨 tab cookie 變更的主動通知仍不在本批證據內。
- 新增直接注入 transport 測試，包含 AbortError 單次、不重試、profile binding、keyless IPC、token 與 cookie-only epoch、舊結果拒絕與 signal abort。timeout 測試改直接驗正式 Web transport，虛擬 clock 確認 cleanup 沒有殘留 timers；100 路背壓與三個 10-minute virtual capture scenarios 已通過。
- 驗證：unit 55/55；TypeScript、Electron/Web builds、架構 gate 138 modules（沒有 runtime cycles／反向依賴）與完整 browser e2e 3/3 通過。最後增加 pre-aborted/late-aborted 防護後，專項 ASR transport 與 TypeScript/Web build 另通過，受影響 browser ASR／Electron build 重跑通過。最終 code-review-graph stats：281 files、2026 nodes、20233 edges，詳見 CURRENT JSON；尚未完成的 text/summary ports、sync coordinator、recovery manifest、UI/workflow/server 其餘拆分與外部合約驗證仍維持原計劃。

## TextCompletionPort／SummaryStreamPort 與摘要 workflows

- 新增 summary/ports.ts 與 Web/Electron implementations；controller 的 completeSummary 只轉呼叫 memoized port。Web deadline 涵蓋 NDJSON body 消費，包含 account epoch 檢查與串流 partial 發布 fencing；外部取消維持 AbortError，逾時與 provider abort 訊息仍顯示可重試的 timeout。
- Electron summary/text 以 request ID 呼叫可信 main，取消／deadline 對應 cancelCompleteText；取消使用 Promise.race，避免 main 未即時回覆時卡住呼叫端，並清理 timer/listener。金鑰是否必要、profile、endpoint 與溫度維持契約。
- TextCompletionPort 處理字幕 plain text 與摘要 Markdown；保留 glossary、temperature、gateway managed profile 選擇、Server-Timing 與每次操作的 idempotency key；預設字幕 15s、Markdown 90s，可接受 recovery 注入較長 deadline。
- controller 不再直接呼叫 completeText、/api/translations、/api/summaries 或 readSummaryStream。摘要分段／分層合併與有界壓縮移到 summarize-transcript service；摘要翻譯 generation、empty result、stale response 處理移到 translate-summary service。
- 原 summary translation 測試改直接呼叫 production service + ports；summary transport 測試也不再 source-slice controller。其餘 manual translation trigger 等測試仍有 source-slice，未宣稱整個測試技術債已清除。
- 直接合約測試包含 JSON/NDJSON、deadline 跨 stream read、external cancel、account-fenced partials/results、IPC cancel ID、keyless profile、glossary/temperature/format、分段完整合併與無法收斂的壓縮終止。
- 驗證：TypeScript、架構 gate 149 modules（無 runtime cycles／反向依賴）、unit 57/57、Electron/Web builds 通過；完整 browser e2e 3/3 通過。其後發現 stream done 仍等待 EOF，已改為 done 即停止消費並取消 reader；保持 body 開啟的直接測試通過，最新 TypeScript 與雙平台 builds 通過，摘要 browser 重跑通過（無 page errors）；code-review-graph 最終 stats：294 files、2079 nodes、20481 edges，CURRENT JSON 已更新。controller 目前 3391 行，仍非薄組裝；goal 保持 active。

## OPFS 實際提交語意與錄音基礎設施位置

- 真實 Chrome probe：未 close 的 FileSystemWritableFileStream 已 await write，但 getFile().size 仍為 0；close 後才為 4。先前持續開啟單一 WAV writer 的設計無法以 append ACK 證明中途復原，先前簡化 mock 未模擬 close-commit 語意，本批修正。
- OPFS 改成每批 PCM 獨立 chunk file 並 close 提交，先保存版本／sample rate metadata；只有提交後才增加 chunk index。讀取以有序連續 chunks 組成 file-backed WAV Blob，不將整份 PCM 讀成 ArrayBuffer，也不每批重寫整段錄音。
- append 在接受時複製 bytes，防止排隊期間外部修改；finish 冪等且不刪來源；未 close 留下的最後空 placeholder 可忽略，保留已提交 prefix；中間缺段、奇數 PCM、metadata mismatch、WAV 大小溢出會回報而不清除來源。create 拒絕覆寫同 ID 的現存 recovery。
- 舊 single-WAV source 保持可讀；acknowledgeRecovery 冪等清除指定 ID 的新舊格式，其他 recordings 不受影響。這是 source durability 修正，不等同完成帳號級多份 recovery manifest 或完整 cleanup coordinator。
- OPFS/remote adapters 與 BufferedPcmWriter/limits 已移到 features/capture/recording；shared/audio 留通用 PCM／WAV 工具，沒有建立 shared → feature compatibility reexport。controller、fixtures 與測試更新新位置。
- 單元 mock 改成僅 close 才提交，驗證 failed-close prefix、pre-finish recovery、參數／metadata、legacy WAV、immutable append 與 finish/ACK 冪等；真實 Chrome 重新載入且未呼叫 finish 時，兩份錄音皆可復原，讀取可重試且 ACK 不刪另一份 source。
- 最終驗證：unit 57/57、browser e2e 4/4、TypeScript、架構 gate 150 modules（無 runtime cycles／反向依賴）、Electron/Web builds、diff check 通過。code-review-graph stats：296 files、2096 nodes、20591 edges，CURRENT JSON 已更新。PcmSink、capture lifecycle、owner manifest 與多份 recovery UI 仍待完成，goal 保持 active。

## PcmSink 與原生錄音資源釋放

- capture/recording/ports.ts 提供 PcmSink 與 local/opfs/remote artifacts；sink-lifecycle 以 closure composition 持有 immutable accepted bytes、serial append、finish/abort 狀態，不新增 abstract base。
- controller 的 audio frames 經 BufferedPcmWriter → sink；stop 只接收 typed artifact，不再直接 appendPcm/finishPcmRecording 或手動依序呼叫 raw OPFS/remote finish。Browser sink 保留 write-stage 壓力狀態，本機完成後才完成遠端；遠端失敗仍保留 local prefix。
- abort 代表停止接受、排空已接受 I/O 並保留 recovery evidence；cleanup/discard 不混入 abort。startup 已建立 sink 後的失敗與 unmount 都走 release；尚未建立 sink 的空來源保留原明確清理路徑。
- remote PCM adapter 每次跨請求檢查固定 account epoch，涵蓋大於 1MiB 的多 chunk append、finish/promote/delete 與 recovery，避免舊錄音下一個請求換用新帳號。
- main/recording/finalize-recording.ts 是可直接測試的原生 service；等待 accepted writes、完成 WAV header、關閉 descriptor，失敗保留來源及 manifest。main 的 logout／視窗 destroyed／不同使用者 authenticate 釋放該 sender 擁有的錄音，不關閉同帳號另一視窗的錄音。IPC 身分驗證仍由 trusted main 保持。
- 真實 tmp WAV 測試驗證 header/payload、write failure 與 metadata failure 的 source retention／descriptor closure；releaseRecordings 先同步移除 admission，再 allSettled，每一個同步或非同步錯誤都不跳過其他錄音。
- sink 合約測試覆蓋 serial order、copy at acceptance、drain-before-finish、finish/abort 冪等、失敗 evidence、本機先提交與多請求 owner fence。browser OPFS fixture 進一步改用 production sink，驗證 remote failure/abort 的 local recovery；完整 browser e2e 4/4 通過；code-review-graph stats：302 files、2137 nodes、20841 edges，CURRENT JSON 已更新。
- 最新 TypeScript、架構 gate 154 modules（無 runtime cycles／反向依賴）、unit 59/59、Electron/Web builds、diff check 通過。這不等同已驗證完整 Electron UI record/import/cancel/account-switch；多份 owner recovery manifest、同步 coordinator、剩餘 controller/main/server 拆分與外部服務仍未完成，goal 保持 active。

## 多份 owned recovery manifest、活躍分頁與 checkpoint cadence

- 每份 OPFS source 各自保存 ownerId、draft/segments、sample rate、capture offset 與最終 session/audio key/processing token；create 在任何 PCM append 前 close 提交初始 manifest，更新使用獨立序列，不讓 metadata 寫入失敗吞掉 PCM failure。
- RecordingRecoveryStore 綁定 account epoch，inspect 分別回傳有效 entries 與 issues；損壞 source 保留並回報，其他來源繼續恢復。read 不清除，ack 只刪該 owner 的已確認 source。原始 legacy single-WAV／remote draft pointer 仍相容。
- recoverRecordings service 逐份上傳、確認音訊後產生 history records，只有既有 cleanup gate 收到 metadata ACK 才呼叫 acknowledge；legacy draft 與 manifest 同 ID 去重。continuation 的 source 只含 tail，恢復時對齊 segments/time，保留原紀錄。
- 最終 target 需精確 processing token + audio key + 已保存音訊，不能讓續錄前舊 metadata 或 ASR/translation/saving 階段確認新 source。provisional continuation 明確 audioUnavailable=true，直到新音訊保存完成。
- Web Locks 在支援時標示仍活躍的 source，直到完成提交清除或 abort/release；其他分頁 inspect 與 legacy pointer 不恢復活躍錄音。reload 自動釋放鎖。真實 Chrome 測試證明活躍 source 不列入恢復，重載後可恢復。
- 原 300ms debounce effect 包含每 250ms 更新的 elapsed，可能持續取消保存；改為 startRecordingCheckpoints 固定 1s 讀取最新 refs。每個 checkpoint lifecycle 的 local/remote 各自最多一筆 inflight，遠端卡住不阻止 local；下一次取最新值，不累積舊 snapshot。停止／epoch 切換在 microtask 真正開始寫入前再次 fencing。
- 新真實 React/browser 測試 seed 多份 owner/foreign/corrupt/已提交 source，驗證兩筆獨立復原、舊 target 去重、ACK 前所有 source 仍在、ACK 後精確清理、foreign/corrupt 保留與 reload 無重複。
- 驗證：TypeScript、架構 gate 158 modules（無 runtime cycles／反向依賴）、full unit 61/61、Electron/Web builds、diff check 通過；最後 owner guard 專項也通過。完整 browser e2e 5/5 通過；code-review-graph stats：309 files、2206 nodes、21257 edges，CURRENT JSON 已更新。controller 目前 3396 行，仍未達薄組裝；sync coordinator、完整平台 UI lifecycle、main/server 剩餘拆分與外部服務合約等維持原計劃，goal 保持 active。

## Session sync coordinator 與多線後續修正

- 新增 account-scoped createSessionSyncCoordinator，集中 baseline/local/pending/version、CAS rebase、outbox checkpoint、retry/backoff、逐筆衝突與錄音 cleanup registry；controller 保留 React 狀態映射及組裝。採 closure composition 與 typed dependencies，未增加沒有替換需求的 abstract class。
- 每次 remote save 前先保存 checkpoint；同筆衝突必須明確選擇，選擇期間新的 local edit 不被舊選擇覆蓋，未觀察過的新 remote revision 會再要求選擇。舊帳號 close 後的 ACK 不更新 UI 或清理來源。
- Cleanup 要求精確 audio key、可用音訊、非 running 及 processing token；await 期間更換的 cleanup task 不會被舊 task 移除。Cleanup 失敗獨立重試，不依賴下一次使用者編輯。
- 初始化 outbox 暫時失敗可以重開；若重開才發現舊 disk checkpoint 且已有新的 memory edits，兩份保留並暫停，尚未提供合併這兩份來源的完整 UI。不得將此保護性暫停描述為所有復原情境自動完成。
- 直接 production coordinator 測試及原 session-storage-state 測試通過；本批 TypeScript、架構 gate（159 modules）、unit 62/62、Electron/Web builds 通過。實際 App 衝突 UI browser 測試正在補齊，未以 service 測試代替。
- 使用者已明確授權 subagents；分別劃定 native recovery、server translation routes、新增 conflict browser test 的所有權，主代理整合同步服務、測試清單與文件。各線尚待整合驗證；整體計劃仍未完成。

## 原生模型與隔離外部儲存證據

- 本輪完整 models suite 同一次 8/8 通過，補齊先前只有 7/8 加單項重跑的證據。測試使用受控 fixture，涵蓋音訊 residency、VAD、worker、匯入格式及取消清理、聲紋與 speaker embeddings。
- 真實 Chrome 摘要／復原 UI 專項在 coordinator 整合後通過，pageErrors 為空；完整 conflict UI 專項另由 subagent 補齊。
- 建立名稱 s2t-review-20261014 的專用暫存 PostgreSQL 16／Redis 7／MinIO 容器，loopback 使用 26439／26379／29000；未操作既有容器或資料。tests/integration/scale-safety-integration.cjs 通過真實 CAS、並行 claim/commit、lease replacement/lock-wait expiry、跨節點 quotas/login/capacity、idempotency 與 Redis outage、MinIO 跨 adapter chunk ACK/streaming assembly/cleanup。
- 新增 tests/integration/sharing-authorization-postgres.cjs，直接驗證正式 PostgreSQL visibility query：偽造 profile department 無權限、雙方 approval、department／organization 範圍、雙方撤銷、owner access 與 embedding version 隔離；通過。此測試需明確提供隔離 PostgreSQL 環境，不加入預設無外部服務 suite。
- 此批未啟動／驗證 Milvus，沒有將 PG／Redis／MinIO 證據擴張為所有外部系統完成；Node22 最新 snapshot、完整 Electron UI 與其餘原計劃仍待完成。
