# Nemotron 小數 timeout 修正（2026-10-04）

18:56:44 即時 29.9706875 秒與 18:56:57 最終 42.1013125 秒推論皆出現 ERR_OUT_OF_RANGE，exitStatus／signal 均 null。根因：execFileSync 的 timeout 必須是非負整數，但 base + 每秒预算 × 音訊秒數產生小數，Node 在原生程序啟動前就拒絕參數。對應 timeout 是 69988.275 與 74840.525 ms。原一般錯誤訊息錯誤引導為 runtime／權重版本問題。

server/nemotron-diarization.cjs 將 timeout 改為 Math.max(1, Math.floor(budget) - 2000)，保留原预算與提前兩秒退出規則。未變更環境設定、權重、模型或依賴。

新增 tests/smoke/nemotron-timeout-smoke-test.cjs，執行正式 wrapper、攔截 runtime 並交由真正 Node child_process 驗證選項，涵蓋兩個失敗長度、60 整秒、極短片段和小數環境設定。全部通過。此測試不宣稱驗證模型輸出。

Docker 已重建；使用該次失敗的保存錄音在容器內經正式 worker pool 實際重測：

| 秒數 | turns | 講者群數 | 耗時 |
| --- | --- | --- | --- |
| 29.9706875 | 14 | 2 | 2.821 秒 |
| 42.1013125 | 18 | 2 | 3.298 秒 |

兩者均成功。此次屬故障修復驗證，未對該錄音人工核對講者真值或 DER。

既有 failed 紀錄未自動改寫或重排程，可於記錄重新執行「自動識別講者」。新收音及新的最終背景推論使用修正。

全專案 TypeScript 檢查當次遇到其他同步編輯中的 i18n/status-messages-a.ts 語法錯誤，未因此修改該檔；本次 JS 語法、timeout 回歸、Docker build 與真實推論均通過。
