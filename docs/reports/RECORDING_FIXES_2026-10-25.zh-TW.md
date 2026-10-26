# 錄音與清理問題修正驗證 — 2026-10-25

繁體中文 | [English](../en/RECORDING_FIXES_2026-10-25.md)

[審查中的五項問題](RECORDING_REVIEW_2026-10-25.zh-TW.md) 已全部修正。部署於既有本機隔離 K8s：前端 `s2t-frontend:web-20261025-r1` 1/1 Ready，後端 `s2t-backend:web-20261025-r1` 2/2 Ready。

## 修正與回歸覆蓋

| 問題 | 修正 | 驗證 |
| --- | --- | --- |
| 寫入失敗後錯誤恢復收音 | writer 與 controller 都將永久失敗視為終止狀態 | 壓力後寫入失敗不發送 resume、維持暫停、drain 明確拒絕 |
| 未完成上傳無法清理 | cleanup API 驗證已保存的替代音檔、紀錄、key、token 與非處理中狀態 | 無替代音檔／錯誤 token／仍處理中／其他帳號均不能清理；fallback 成功後可以清理 |
| 衝突上傳留下孤立 blob | 寫入前持久化 pending intent；同錄音交易鎖序列化寫入、finish、清理 | 衝突不建立 blob；寫入後故障仍可追蹤；清理 exact prefix 包含 legacy orphan |
| 重載遺失清理進度 | 正常保存與恢復使用同一流程，remote → draft → OPFS，並排程重試 | 清理故障保留 OPFS；重載後完成遠端、本機清理；無須新編輯觸發 |
| Worker 無回應導致停止卡住 | 每筆 Worker request 有 30 秒期限；逾時終止 Worker 並拒絕等待者 | 靜默 Worker 逾時、late reply 無法改成成功、失敗後不可繼續寫入 |

後端先持久化 deleting fence，再刪物件，成功後保留不含音訊的小型 deleted fence。遲到的 PUT 不可重新建立已清理錄音。刪除途中失敗也可重試；正式音檔與其他錄音 namespace 不受影響。無有效保存證明時，舊 DELETE 仍拒絕未完成錄音。

## 測試結果

- `npm run check`：型別、架構、51 項單元測試與 Web build 通過。
- `S2T_TEST_EMBEDDED_PG=1 npm run test:backend`：38 passed、1 skipped。略過的是本機 FFmpeg 案例；實際容器轉碼已通過。
- `npm run test:e2e`：2/2 通過，自動使用根目錄 `.venv` 與本機 Chrome fallback。
- 真實 PostgreSQL 多副本：同 index 不同內容只能一方成功、不留孤立 blob、另一副本清理後無法由晚到 PUT 復活。
- 實際兩個後端 Pods：JWT、CAS、錄音接續／完成／讀取、登出撤銷通過。
- Grafana、兩個 backend scrape targets、看板查詢及瀏覽器／Prometheus 計時核對通過。

## 真實部署故障測試

透過 Nginx 操作 Python／MinIO，故意阻斷錄音上傳 65 秒並丟棄 3 次已持久化 ACK，期間收音與字幕持續。再強制遠端 finish 失敗，使前端走完整 WAV fallback；保存與背景處理成功後，故意讓清理請求失敗。

確認失敗時 OPFS 仍存在，之後重載頁面：遠端 recording 與暫存音檔回報 404，OPFS 錄音目錄已移除，正式 WAV 與清理前逐位元組一致。這項測試驗證了原本缺失的跨重載清理路徑。

重跑：

```sh
S2T_ALLOW_DEPLOYMENT_TESTS=true S2T_TEST_RECORDING_UPLOAD_STALL_MS=65000 S2T_TEST_RECORDING_CLEANUP_RELOAD=true npm run test:deployment
```

## 限制

這些結果不是 500 人容量驗證。外部 ASR／翻譯／摘要使用 mock；真實模型品質／容量、Safari／Firefox 實機、GPU 與跨節點故障仍需另測。本機磁碟、OPFS 配額或硬體失效仍可能造成保護性暫停與未提交音訊缺失，不能宣稱永不漏音。

[操作與設計說明](../guide/RECORDING_RELIABILITY.zh-TW.md)、證據摘要（本機歷史資料）、部署（本機歷史資料）、故障測試（本機歷史資料）、監控（本機歷史資料）。
