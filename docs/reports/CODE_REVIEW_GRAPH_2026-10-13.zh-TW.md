# code-review-graph 審查補充與修改順序

> 歷史／研究文件：以下數據、路徑與命令僅代表記錄版本，不是現行操作入口。最新操作與驗收請以 [文件入口](../README.md)、[目前結果](VALIDATION_2026-10-26.zh-TW.md) 及 [重現指南](../guide/REPRODUCE.zh-TW.md) 為準。


本次實際使用 `code-review-graph 2.3.5`，在 `/tmp/s2t-code-review-graph-venv` 隔離安裝。原本全域 CLI 的 editable source `/Users/liangzhiquan/Desktop/code-review-graph` 已不存在，因此無法 import cli；未改動原安裝與 MCP 設定。

## 建圖結果與必要補充

- 原生 CLI：89 files；status 顯示 698 nodes、7,101 edges。
- 該版 `EXTENSION_TO_LANGUAGE` 沒有 `.cjs`，原生結果漏掉 server 和大部分 tests。本次在 Python 程序內加入 `.cjs = javascript`，使用 thread parser，並納入 src/server/tests/scripts/deploy 未追蹤程式檔案；沒有修改產品程式或工具套件。
- 補充後：229 files、1,868 nodes、19,203 edges；30 Class、1,604 Function、229 File、5 Test；16,876 CALLS、2,004 CONTAINS、296 IMPORTS_FROM、27 REFERENCES。建圖回傳的 2,290 nodes／21,216 edges 是插入前計數，報告採資料庫 status 的去重後值。
- 偵測 329 flows、18 communities；未安裝 igraph，工具採 file-based community fallback，因此 communities 不能當成實際 domain 邊界證據。
- 建圖 errors 為空代表解析程序沒有回報例外，不代表所有呼叫都解析正確。

## 函式層級的拆分候選

| 函式 | 位置 | 範圍行數 | 修改方向 |
| --- | --- | ---: | --- |
| useAppController | src/renderer/src/features/app/hooks/useAppController.ts:58 | 3426 | 抽 sessions/sync/recovery、summary、capture lifecycle；留下組裝 |
| handleHttpRequest | server/index.cjs:749 | 703 | 依領域拆 routes；auth、limits、error handling 成中介層 |
| AppView | src/renderer/src/features/app/views/AppView.tsx:30 | 614 | 按畫面 feature 拆分，定義小型 props |
| startCapture | useAppController.ts:1383 | 321 | 收音裝置、PCM writer、model session 以 ports 協調 |
| stopCapture | useAppController.ts:1737 | 217 | stop/finalize workflow 與 UI 狀態分離，保留背壓與失敗復原 |
| SettingsView | features/app/views/settings/SettingsView.tsx:82 | 210 | 移入 settings feature，模型設定與共用 UI 分開 |
| createAuth | server/auth/index.cjs:22 | 154 | bootstrap、token/revocation、HTTP handlers 分離 |
| retryFailedSession | useAppController.ts:2384 | 122 | 可直接 import 的 recovery service，注入 audio/model/storage |
| transcribeImportedFile | useAppController.ts:2259 | 109 | 匯入工作流程與 checkpoint service |

巢狀函式範圍可能重疊，不能加總作成本估算；大函式是拆分候選，仍需依職責決定切點。

## 與原始 review 的交叉驗證

`callers_of(mergeSessions)` 找到 controller、enqueueRemoteSessionSave、retryRemoteSessionSync 與兩個測試呼叫點。`callees_of(enqueueRemoteSessionSave)` 包含 save、load、mergeSessions 與 retry scheduling，支持把同步 coordinator 獨立抽離。前一份 review 重現的刪除復活／遠端編輯覆寫，應針對這條流程修復，而非僅換目錄。

`callers_of(retryFailedSession)` 找到 AppView；其 callees 同時牽涉 authFetch、WAV layout/chunk、ASR、翻譯、audio versions、saveSession 與 setSessions。這說明 recovery 同時協調領域流程、平台 I/O 與 React UI，適合優先抽 service。該函式的片段擷取測試本次實際失敗，graph 查不到它透過 new Function 執行的關係。

`callers_of(streamSummary)` 明確找到 gateway 與 summary-stream-smoke-test；但是 `tests_for(streamSummary)` 回空。其他被查函式的 tests_for 也回空。因此不能把空結果寫成「沒有測試」，只能表示工具未建立對應關係。

兩跳 impact 結果：session-merge 534 nodes／154 additional files；model-adapter 1,137／214；auth 810／198；sherpa 842／195。這些過於寬廣，且包含看似無關的 UI／工具檔。邊中存在 `map`、`get`、`set`、`create` 等未充分限定的呼叫名稱，且 BFS 會走多種關係，數值只能作搜索候選，不當成實際改動清單或測試覆蓋率。

前一份 AST 模組圖補充了這個工具的另一個盲點：Silero/Sherpa lazy-require 循環、shared → feature 與 src → server 的反向依賴。兩份圖回答不同問題；不以函式圖取代型別／模組分層檢查。

## 建議實作順序

1. **先建立可信測試入口並修缺陷**：recovery harness、session 三方合併與刪除意圖、voiceprint consent header、Department 授權來源、logout 持久化錯誤及正式 bootstrap 保護。細節與驗收見 `CODE_REVIEW_2026-10-13.zh-TW.md`。
2. **拆共用契約与純音訊工具**：TranscriptEvent／VadConfig／admin parameters 中立化；WAV helper 抽離 Silero/Sherpa 循環；auth transport 移到 shared 層。
3. **抽 session sync/recovery 與 summary**：使用明確 ports，讓測試直接 import 正式 service，停止 source slice/eval harness。
4. **拆 capture lifecycle、AppView 與模型 adapters**：每個變更驗證 start/pause/stop/cancel、帳號切換、晚到回覆、錄音壓力與復原；按領域搬目錄，不做整包改名。
5. **拆 server HTTP 與 bootstrap**：保留 CAS、lease fencing、補償佇列、drain/readiness 行為；最後補分層圖 baseline 與 CI gate。

## 重跑與產物

```sh
/tmp/s2t-code-review-graph-venv/bin/python scripts/analysis/code-review-graph.py
CRG_DATA_DIR=/tmp/s2t-code-review-graph-complete /tmp/s2t-code-review-graph-venv/bin/code-review-graph visualize --repo . --mode file
```

分析腳本需要安裝 code-review-graph 2.3.5；暫存環境不保證永久存在。`CODE_REVIEW_GRAPH_2026-10-13.json` 保留查詢摘要與結果，完整包含 impact edges 的資料在 `/tmp/s2t-code-review-graph-complete/analysis-full.json`；SQLite 在同目錄 graph.db。

`CODE_REVIEW_GRAPH_2026-10-13.html` 是工具生成的互動 file graph，載入 D3 CDN，需網路才能互動。本次僅確認工具成功生成 HTML，未做瀏覽器視覺驗證。分析沒有啟用 embedding、LLM wiki 或將 repo source 送至外部模型。

未跑完整 build、全部 browser tests、真實 storage/model/Kubernetes；工作目錄有原先未提交變更。圖與行號是本次快照，不代表固定 commit 的完整靜態或動態證明。
