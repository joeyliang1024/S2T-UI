# 錄音與清理追查 — 2026-10-25

繁體中文 | [English](../en/RECORDING_FOLLOWUP_2026-10-25.md)

上一輪五項修正已完成；本輪繼續檢查相鄰邊界，確認下列三項尚未解決。第一項是清理改動尚未封住的跨交易競態。本輪只有檢查與隔離重現，沒有修改產品程式或部署。

## P1：清理期間仍可提交引用該音檔的新紀錄

位置：`backend/app/recordings.py:185` 與 `backend/app/routes/data.py:127`。

清理第一階段持有 sessions 與 recording 鎖並檢查引用；第二階段只持有 recording 鎖。sessions CAS 不檢查新增引用是否指向 deleting/deleted 的 recording。因此第二個 Pod 可在刪除期間成功提交新引用，之後第一個 Pod 仍刪除 WAV。

真實暫存 PostgreSQL、兩個 TestClient 實例已重現：先建立並完成錄音，暫停第一個 app 的實際刪檔呼叫；第二個 app 成功 CAS 提交引用該音檔的紀錄；釋放刪檔後，DELETE 回 204、紀錄仍存在、WAV GET 回 404。這是特定並行 API 操作的可重現缺陷，不代表一般單人錄音必然遇到。

修正需讓新增／恢復音訊引用與刪除狀態使用一致的交易規則，拒絕指向 deleting/deleted 的新引用；只在清理起點查一次不夠。

## P2：非同步 OPFS 寫入與 metadata 寫入仍沒有 deadline

位置：`frontend/src/features/capture/recording/adapters/opfs-pcm-recording.ts:38`。

Worker 的 30 秒期限只涵蓋 Worker request。相容 fallback 及 recovery metadata 仍直接等待 createWritable/write/close；卡住時 append/finish 或停止前的 saveRecoveryDraft/setRecoveryTarget 不會結束，也尚未進入遠端收尾期限。

以正式 OpfsPcmRecording 與故意無回應的非同步 writable 重現，append 與 finish 都保持 pending。需為所有本機 I/O 路徑加入一致的期限與終止處理，保留提交資訊且不可盲目重寫結果不明的檔案。

## P2：關閉分頁後的待同步修改無法由新分頁發現

位置：`frontend/src/features/sessions/services/session-outbox.ts:17`、`:57`。

outbox key 使用 userId＋sessionStorage 中的 tab owner；新分頁會產生新 owner，read 僅查自己 key，沒有掃描同帳號已關閉分頁的資料。舊資料留在 IndexedDB，但沒有被恢復，也無法由新 key 的 acknowledge 清除。

真實 Chrome 隔離 context 重現：原分頁保存未同步 snapshot 後關閉；同 origin、同帳號新分頁 read 為空，直接檢查 IndexedDB 仍有一筆原修改。原分頁重新整理與開全新分頁是不同情況；本問題針對後者。

需以帳號列出可接管的 outbox、確認舊 owner 不活躍後取得協調權，再透過既有 rebase／CAS 保存。未收到保存 ACK 前不可自動刪除原修改。

## 重現與驗證範圍

摘要（本機歷史資料）、PostgreSQL 競態（本機歷史資料）、OPFS fallback（本機歷史資料）、Chrome outbox（本機歷史資料）。

腳本從 repository 根目錄執行；PostgreSQL 腳本需 `S2T_TEST_EMBEDDED_PG=1`、`PYTHONPATH=backend:backend/tests` 與根目錄 `.venv`，其資料庫和帳號均為隔離測試資料。這些是刻意重現現存缺陷的斷言，不是聲稱修復通過的回歸測試。

本輪沒有重跑完整功能或容量測試。500 人、真實外部模型效能與 Safari／Firefox 實機仍未驗證。
