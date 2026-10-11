# 穩定紀錄儲存標籤（2026-10-11）

原因：每次保存逐字稿／處理進度，都把整批紀錄標成 pending；每次中間保存成功又全部標成 both。因此 Local + remote 和 pending 反覆切換。

修正：比對每筆紀錄與最後遠端確認的快照，只標記有變更的紀錄。佇列仍有更新時不顯示中間成功狀態；處理中的紀錄固定 pending，處理結束且最後快照成功保存後顯示 both。摘要、手動或自動標題、品質校正期間也保持 pending；失敗待同步的紀錄不會假裝成功。

驗證：production 儲存佇列測試覆蓋連續兩次更新、中間確認、處理中的保存、最後確認、同步失敗與未修改紀錄。真實 React 瀏覽器 + 隔離模擬 API，以 MutationObserver 確認處理中的儲存標籤始終為 Local, pending sync。TypeScript、build、session recovery regression 通過。未呼叫真實模型。

部署：8787；兩個 Gateway Pod 更新 `s2t-stress:20261011-stable-status`，另保留兩個 audio-worker 與 ingress。前端狀態修正，未重新執行 100 人壓測。
