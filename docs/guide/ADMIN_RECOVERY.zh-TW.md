# Admin 與 Storage 恢復

Admin 以資料庫的 `role=admin` 判定，不以帳號名稱或 Department 判定。設定頁的「帳號／Admin 參數」只有 admin 可見，後端也檢查角色。Admin 可以列出／新增／刪除帳號；新增帳號不會取代目前登入。公開註冊一律產生一般帳號，不能指定 admin。

## 刪除帳號與資料

在「帳號／Admin 參數」選擇目標帳號的「刪除帳號」，輸入帳號名稱後確認。不能刪除目前登入的帳號，也不能刪除最後一個可用 admin。後端入口為 `DELETE /api/admin/users/:id`，只接受 admin。

刪除會先停用帳號，讓舊 token 與新登入失效，拒絕新寫入並等待進行中的請求／背景工作排空，再刪除該帳號全部 blob（含錄音與分塊）、vector（含未完成註冊的補償資料）、config、glossary、聲紋 metadata 與背景工作，最後移除帳號。其他帳號與共享儲存服務保持不變。已刪除的 bootstrap admin 不會在重啟時自動重建；系統只保留防止重建用的雜湊標記。

若任一儲存服務失敗或寫入尚未排空，API 不會回報成功；帳號保持停用、清理意圖保留。在帳號列表選「重試清理」即可繼續；重試可重複執行。清理在 gateway 執行，不代表清除使用者另行匯出的檔案、外部備份或關閉中瀏覽器的本機資料。

PostgreSQL schema 已升級為 `002-account-deletion`，新增 `deletion_state` 欄位。使用 `S2T_STORAGE_MIGRATIONS=verify` 的部署，需先執行既有 migration Job，再更新 gateway／worker。帳號請求的 shared/exclusive 圍欄使用獨立連線池；兩個池各受 `S2T_POSTGRES_MAX_CONNECTIONS` 限制，資料庫容量應預留合計上限。

## 自己的字幕參數

Admin 的客製參數只存在於自己的設定，其他帳號繼續使用既有預設。可調整 VAD 語音確認、停頓、前卷、噪音偏移、chunk 最短／最長時間，以及翻譯排程間隔、節流間隔、整句等待、並行數與 temperature。啟用後，客製 VAD 值優先於回應速度滑桿。修改作用於後續 chunk／請求，不會改變其他帳號。

Web 隨帳號儲存，桌面版按「儲存設定」保留。停用客製化後恢復既有預設。VAD 數值適用於應用端分段的 HTTP ASR；服務端 VAD／WebSocket 模型須另有服務支援。所有值有範圍與組合檢查；一般帳號直接呼叫設定或翻譯 API 也無法修改進階值。

## 清空 PostgreSQL 後

既有 schema migration Job 成功不代表新資料庫仍有資料表。先確認連線設定與資料庫存在，再用新的恢復 Job 執行 additive migration：

```sh
python3 scripts/storage/recover-k8s.py \
  --context colima-s2t-stress \
  --namespace s2t-stress-20261005
```

工具使用目前 Gateway 的 image 與環境設定建立新 Job。它重建缺失 schema，依 `S2T_BOOTSTRAP_ADMIN_USERNAME`／`S2T_BOOTSTRAP_ADMIN_PASSWORD` 建立缺少的 admin；既有 admin 的 ID／密碼保持不變。Job 成功後才重新啟動 Gateway 和 worker，清除程序中已失敗的初始化 Promise。Job 不會刪除表或重置既有帳號，完成後由 TTL 清理。

非 Kubernetes 環境，在提供相同 PostgreSQL 與 bootstrap admin 環境變數後執行：

```sh
node scripts/storage/recover-storage.cjs
```

然後重啟 Gateway 與 worker。若 bootstrap 名稱已屬於一般帳號，工具會拒絕自動升權，請改用新的 bootstrap 名稱。若整個 PostgreSQL database 已被刪除，須先由資料庫管理者重建該 database 或還原備份；本工具不需要也不會取得管理其他 database 的權限。

**重建 schema 無法還原被刪除的帳號、紀錄或設定。** 需要舊資料時先還原 PostgreSQL 備份，保留原帳號 ID，才能與 MinIO／Milvus 物件對應。工具不會把舊孤立物件自動分配給新帳號。

Readiness 現在持續檢查核心 PostgreSQL 表，避免程序啟動後資料表消失仍回報健康。登入頁會保留 Storage／服務失效的診斷，不再當作單純未登入而吞掉錯誤。

若登入撤銷紀錄也遭刪除，重建表不會還原撤銷狀態；還原備份，或輪替所有 Pod 共用的 `S2T_AUTH_SECRET` 並重新登入，以使舊 token 失效。
