# Repository code review 與修改計劃

審查日期：2026-10-13。範圍為目前工作目錄，包含原有未提交變更；不是只審查 HEAD 或某個 PR。審查期間工作目錄仍有其他變更，因此行號與測試結果代表檢查當時狀態。本次只新增此報告，未修改產品程式。

## 判斷

主要技術債是狀態、平台與資料同步責任集中，而不只是目錄命名。既有 storage adapter、worker pool、translation queue、錄音背壓、CAS、補償佇列與測試已有基礎，適合逐步抽離，不建議全面重寫或立即切成 monorepo。

## 具體 findings

### F1 — P1：衝突合併會復活刪除紀錄，也會覆蓋別的視窗編輯

- 位置：`src/renderer/src/features/app/hooks/useAppController.ts` 的 `enqueueRemoteSessionSave`、`retryRemoteSessionSync`；`services/session-merge.ts:12`。
- CAS 409 後呼叫 `mergeSessions(localSnapshot, remote.sessions)`，它將兩份清單取聯集，同 ID 以本機整筆資料優先。沒有 baseline、dirty fields 或刪除 tombstone。
- 情境一：A 刪除 r1，B 先保存另一筆紀錄；A 重試時遠端 r1 被 fallback 加回。情境二：B 改 r1 標題，A 用舊 r1 修改另一筆紀錄；A 重試會把 B 的標題覆寫。
- 直接執行正式 merge 函式重現：`mergeSessions([], [r1])` 回傳 r1；本機舊標題與遠端新標題合併後仍為舊標題。這是合併函式重現，未執行完整多視窗 E2E。
- 建議：短期以 committed baseline 做三方合併，保留明確刪除集合，對同筆衝突顯示可處理結果；長期改 per-session revision 與更新／刪除 API。CAS 是並發偵測，仍需獨立設計衝突解決。
- 驗收：兩視窗交錯新增、刪除、改標題、改 segments、背景講者完成，以及回應遺失重送，均不能復活刪除或靜默遺失編輯。

### F2 — P1：共享聲紋正常同意後仍被拒絕

- 位置：`server/index.cjs:1193`；對照 `src/renderer/src/features/speakers/services/voiceprint-storage.ts`。
- 前端送 `x-s2t-voiceprint-consent: true`，後端卻查詢含逗號的整串 header 名稱 `x-s2t-voiceprint-consent, x-s2t-idempotency-key, x-s2t-start-sample, x-s2t-sample-rate`。
- department／organization 正常註冊會在 inference 前回 400；private 不受此條件影響。現有 gateway auth 測試只驗證未同意的負向案例，未涵蓋已同意成功路徑。
- 建議：修正 header key，把 scope／consent 驗證放到音訊 body 讀取之前，加入共享成功與拒絕案例。

### F3 — P1：Department 的授權依據可由公開註冊自行宣告

- 位置：`server/auth/index.cjs` 的 `register`；`server/auth/user-store.cjs` 的 `userInput`；`server/storage/remote.cjs:316`。
- 公開 register 接受使用者提供的 Department，沒有可信目錄或 admin 核准；department 聲紋可見性直接比較該欄位與 owner.department。
- 在使用 department 共享的部署，使用者能自行填入目標部門取得比對資格。此風險在 F2 修復後更容易走到；目前不代表已完成跨部門實際取用。
- 建議：把展示用 Department 與授權群組分離，授權群組由 admin 或可信身分來源設定；未核准帳號不能參與部門／組織共享。補跨部門、未核准與核准後授權測試。

### F4 — P2：logout 吞掉 storage 失敗並回成功

- 位置：`server/auth/index.cjs` 的 `revoke` 與 `/api/auth/logout`。
- 驗 token 與保存 revocation 包在同一個 catch，包含 `storage.config.update` 失敗也被視為無效 token。之後 logout 回 204，原本的有效 bearer token 仍可能被接受。
- 建議：只忽略 token 無效／到期；有效 token 的持久化錯誤必須回可重試失敗並記錄。驗收用故障注入，確認不能把未持久化的撤銷宣告成功。

### F5 — P2：正式環境可默默建立 admin/admin

- 位置：`server/auth/index.cjs` 的 `ensureBootstrapAdmin`；`.env.example:87`。
- 缺少 bootstrap 設定即建立預設 admin/admin；README 有人工提醒，但程式沒有正式部署保護。Kubernetes 只要求 auth secret，沒有同等 bootstrap 密碼限制。
- 建議：開發模式明確啟用預設帳號；正式環境首次 bootstrap 缺少明確憑證則 readiness 失敗。已有 admin 時不應因 bootstrap 變數缺失而中斷服務。

### F6 — P2：recovery 測試已因片段擷取失敗

- 位置：`tests/smoke/session-recovery-handlers-smoke-test.cjs:4`、`:19`。
- 測試以字串定位 controller 中兩段宣告，抽出片段後用 `new Function` 與大量手工 mock 執行。本次失敗：`ReferenceError: liveCorrectionRunnerRef is not defined`。
- 這個結果證明測試 harness 跟不上 controller 依賴，不能直接推論正式 recovery 功能故障。其他 source assertion 也容易阻礙安全搬檔或函式改名。
- 建議：先抽出可直接 import 的 recovery service，對 injected ports 測行為；再用少量掛載／瀏覽器測試驗證 hook 與 service 接線。避免用增補更多片段 mock 作為長期解法。

## 結構與目錄技術債

1. **前端 controller 過度集中。** 檢查時約 3,483 行，約 124 個 useState／useRef／useEffect 呼叫；收音、ASR、翻譯、匯入、摘要、聲紋、歷史、同步與復原共享大量 refs。`AppController = ReturnType<typeof useAppController>` 把整個實作暴露給 views。`AppView.tsx` 約 643 行，內含模型設定轉換邏輯。既有 App.tsx 薄化沒有同步建立功能責任邊界。
2. **server index 同時是 bootstrap、router 與 domain service。** 約 1,546 行，包含 credentials crypto、模型解析、voiceprint 配對、補償清理、背景 job、metrics 與 HTTP。啟動依賴 process.env／cwd 並直接 listen，使孤立測試與多角色設定難以分開。
3. **平台差異散落 controller。** 多處 `window.s2t` 分支與 Web／Electron model、audio、storage 實作，應透過少數 ports 統一，而不是只把 if 分支移至另一個大檔。
4. **型別檢查不涵蓋 server。** tsconfig include 僅 src 與 config，CJS server 沒有 checkJs。frontend 與 main 直接 import `server/admin-parameters.cjs`，中立契約放在 server 層；HTTP response 多以 type assertion 接受，缺少完整 runtime 驗證。先補關鍵 DTO／JSDoc／schema，無須一次遷移全部 TS。
5. **測試入口與可攜性不足。** package.json 有許多個別 smoke 指令，但没有統一安全 test／CI 入口，也未發現 `.github` workflow。部分 browser tests hardcode `/Users/liangzhiquan/.../playwright`、Chrome.app，`audio-residency-smoke-test.cjs` 甚至 hardcode repo 路徑。Playwright／esbuild 測試依賴沒有完整作為直接依賴宣告。tests/README 已提示遠端清資料與停止容器測試，應將這類測試做成明確 opt-in，不可自動全跑。
6. **實驗與資產管理有既有分類，但規模掩蓋正式入口。** experiment 約五百個 tracked files；本機大小 experiment 約 59 MB、dependencies 約 110 MB、music 約 169 MB，大小包含本機未追蹤內容，非 Git 體積。Git 有追蹤 ffmpeg binaries 與 MP3。scripts／deploy／experiment 中的操作脚本需標示正式工具、可重跑實驗與歷史證據的區別。保留 dependencies 離線需求與 checksum，不直接刪除資產或重寫 Git history。

## 建議目標結構

```text
src/
  main/{ipc,services,storage}/
  preload/
  shared/{contracts,validation}/
  renderer/src/
    app/                    # 路由、provider、薄層組裝
    features/
      auth/
      capture/
      models/
      live-transcript/
      sessions/             # history、同步、recovery
      translation/
      summary/
      speakers/
      settings/
    shared/{ui,services,i18n}/
server/
  bootstrap.cjs
  http/{app,routes,middleware}/
  services/{sessions,models,voiceprints,summary}/
  jobs/
  audio/
  auth/
  storage/
tests/{unit,integration,e2e,stress,fixtures,helpers}/
scripts/{audio,evaluation,benchmarks,storage}/
deploy/{k8s,docker,monitoring,test}/
experiment/                 # 可重現實驗與索引
```

這是方向而非立即搬檔清單。根目錄可保留 Dockerfile 與 compose 作為穩定入口；storage adapters 保留現有模組邊界；測試依實際行為分類，不能只將 smoke 改名 unit。

## 分階段修改計劃

| 階段 | 修改範圍 | 驗收與依賴 |
| --- | --- | --- |
| 0：建立可信驗證 | 修 F6；宣告直接測試依賴；去除個人路徑；建立安全 `test`、`test:integration`、`test:e2e` 與 CI，危險測試另列 opt-in | 乾淨 checkout 可 npm ci、typecheck、build、跑本機測試；不需要私人服務或停止既有容器 |
| 1：先修資料與授權缺陷 | F1 三方合併／刪除意圖；F2 header；F3 可信群組；F4 撤銷錯誤；F5 bootstrap 保護。各自小 PR | 上述交錯更新與授權測試；如需 schema 遷移，驗證舊資料相容與回復流程 |
| 2：抽出 session 領域 | sessions repository、sync coordinator、recovery service，注入 audio／model／storage ports | controller 不再實作 CAS loop 與 recovery 演算法；Web／Electron 故障復原結果一致 |
| 3：拆前端功能 | 依序 summary、settings/models、speakers、capture/live transcript；定義小型 view props 與 typed events；共同 UI 才放 shared/ui | 每次抽離保留既有 UI 行為；掛載測試覆蓋取消、unmount、舊請求回覆及帳號切換；保留錄音壓力基準 |
| 4：拆 gateway | createHttpApp(dependencies) 與 bootstrap 分離；抽 domain services、routes、中介層、jobs；main IPC 按領域拆 handlers | import 模組不會自動 listen；保留 readiness、drain、lease fencing、CAS、compensation 與限流測試 |
| 5：契約與資產治理 | 中立 contracts；關鍵 runtime schemas／checkJs；整理 docs 索引、experiment manifests、大型資產下載／checksum 策略 | frontend/main/server 契約有共同來源；所有搬動更新 Docker COPY、npm scripts、docs links 與實驗復現入口 |

不先設定硬性檔案行數目標；每階段以單一責任、可直接測試與明確依賴驗收。不要讓目錄搬動、API／schema 變更與行為修復混在同一個大型 PR。

## 驗證紀錄與限制

- `npm run typecheck`：通過；不包含 CJS server。
- `session-recovery-smoke-test.cjs`：通過。
- `translation-policy-smoke-test.cjs`：通過。
- `session-payload-smoke-test.cjs`：通過。
- `summary-stream-smoke-test.cjs`：通過。
- `session-recovery-handlers-smoke-test.cjs`：失敗，缺少 liveCorrectionRunnerRef。
- 後兩個 HTTP tests 初次受 sandbox loopback listen 限制；獲准 sandbox 外重跑後通過。
- F1 用目前正式 merge 函式直接重現；F2／F3／F4／F5 是路徑與條件靜態追蹤，尚未全面做 HTTP 故障注入或真實遠端驗證。
- 未執行真實 MinIO／Postgres／Milvus、Kubernetes、模型推論、會停止容器或清資料的測試，也未執行完整 build／所有 browser tests。本次不是完整安全稽核或效能證明。
