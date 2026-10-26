# 錄音與暫存清理審查 — 2026-10-25

> 歷史／研究文件：以下數據、路徑與命令僅代表記錄版本，不是現行操作入口。最新操作與驗收請以 [文件入口](../README.md)、[目前結果](VALIDATION_2026-10-26.zh-TW.md) 及 [重現指南](../guide/REPRODUCE.zh-TW.md) 為準。


狀態：五項均已修正。以下保留修正前的審查與重現條件，舊重現腳本的斷言不代表目前行為。最新驗證見 [fix report](RECORDING_FIXES_2026-10-25.zh-TW.md).

繁體中文 | [English](../en/RECORDING_REVIEW_2026-10-25.md)

範圍為目前工作區的收音、PCM 緩衝、OPFS、遠端錄音分塊及保存後清理。本輪只做審查與重現，未修改產品程式、資料或部署；不代表已完成整個系統的安全／容量審計。

## P1：寫入失敗後錯誤自動恢復，後續音訊被忽略

來源：`frontend/src/features/capture/recording/buffered-writer.ts:79`、`useAppController.ts:1563`。

觸發：本機寫入先停滯，待寫入佇列達上限觸發 pressure，接著該寫入失敗。catch 設定永久 failure、清空 pending 並通知暫停；finally 沒檢查 failure，仍通知 `onPressure(false)`。Controller 因此恢復 recorder、將狀態改回 recording，但後續 `push()` 在 failure 判斷直接返回，造成 UI 錄音中而 PCM 不再保存。

最小重現得到事件順序 `pressure:true → failure:paused → pressure:false`，之後 push 不再呼叫寫入。

修正方向：失敗必須是終止狀態，不可被 pressure 解除覆蓋；加入同時發生壓力與寫入失敗的回歸測試，保留已提交前綴並明確要求恢復／重開錄音。

## P2：完整音檔 fallback 成功後，未完成的遠端分塊無法清理

來源：`backend/app/recordings.py:154`、`useAppController.ts:1751`、`useAppController.ts:1762`。

觸發：chunk 上傳收尾逾時／失敗，改走完整 WAV 保存並成功。原 recording manifest 可能仍為 recording 或 finishing。前端清理呼叫 DELETE，但後端只接受 completed/deleting，持續返回 409。清理回呼又先刪除 OPFS，關頁後可能連恢復線索也不再存在。

以記憶體 storage 呼叫實際 `Recordings.remove()` 已重現 recording 狀態被拒絕且沒有刪除任何 chunk。這不能靠一般 retry 解決。

修正方向：新增有明確終止狀態、帳號與替代音檔保存驗證的 abandon/cleanup 流程；不要直接放寬刪除正在錄音的資料。

## P2：衝突上傳會留下正常清理找不到的 blob

來源：`backend/app/recordings.py:50`。

append 先把 `chunks/<id>/<index>-<digest>` 寫入物件儲存，才在 manifest 更新時判斷相同 index 內容衝突或錄音狀態。衝突返回 409，但新 blob 沒有補償刪除、也沒登記在 manifest。正常 remove 只遍歷 manifest，清不到該 blob。

最小重現：上傳 index 0 的兩份不同內容，第二份被拒絕；儲存有兩個 blob、manifest 只有一個；再執行完成錄音的 remove，仍留下第二個 blob。

修正方向：追蹤／補償未被 manifest 接受的 blob，並以併發安全方式確認沒有其他成功請求引用，不能盲目刪除共享 digest key。

## P2：重載恢復流程缺少遠端暫存清理

來源：`useAppController.ts:852`、`recover-recordings.ts:29`。

正常保存後的清理回呼包含 remote discard，但重載後重建的 acknowledge 只刪 live draft 與 OPFS，不刪遠端 recording manifest、chunks 或組裝出的暫存 WAV。即使恢復資料最後已成功保存，遠端暫存仍可能殘留。這項以呼叫路徑確認，沒有進行故障注入實機測試。

修正方向：將跨來源的清理進度持久化，正常保存與重載恢復使用同一個可重試流程；所有清理步驟完成前保留必要識別資訊。

## P2：OPFS Worker 無回應時停止錄音可能一直卡住

來源：`opfs-write-client.ts:35`、`pcm-sinks.ts:34`。

只有 Worker 啟動有 3 秒 timeout，每筆 write request 沒有 deadline。如果 Worker 沒有回覆、也沒觸發 error，PCM writer 的 drain 與 local.finish 一直等待；遠端的 30 秒收尾保護在它們之後才開始，無法解除這個等待。

以靜默 fake Worker 已重現 write 保持 pending 且未設定 I/O timer，只有外部 close 才 reject。

修正方向：增加寫入 liveness/deadline、失敗終止及保留已提交資料的處理；逾時後不可在無法確認的提交上直接重寫或當成成功。

## 檢查與限制

`npm run check`：型別、架構、50 項單元測試與 Web build 均通過。另以最小重現確認上述四個可執行案例；現有測試尚未涵蓋這些組合。重載清理一項為來源追蹤確認。

500 人容量、真實外部模型效能、Safari／Firefox 實機仍非已驗證項目。本輪沒有宣稱它們通過，也沒有檢查線上叢集健康。

建議先處理 P1，再處理不完整上傳與持久化清理，之後補 Worker 停滯處理。

重現結果摘要（本機歷史資料）、緩衝錯誤重現（本機歷史資料）、Worker 停滯重現（本機歷史資料）。兩個 Node 腳本從 repository 根目錄執行，不會寫入使用者錄音或呼叫外部服務。
