> 後續驗證：本報告的滾動更新 58 組失敗已修正，詳見[多 Pod 與 API 延遲測試](../rollout-2026-10-05/README.zh-TW.md)。以下保留原始歷史結果。

# 本機 Kubernetes：100 人模擬壓測

日期：2026-10-05，Asia/Taipei。基底 commit 見 `results/base-commit.txt`；分支 `feature/k8s-scale-docker-compatible`。本次修正尚未 commit／push。

**結論：在指定模擬延遲與請求頻率下，系統可承受 100 人正常字幕流量；超量、Redis 切換與部署更新仍會短暫失敗，不能宣稱零中斷或真實模型也有相同容量。**

## 已部署、可使用

- Web： http://127.0.0.1:8790 。測試管理帳號 `admin`，密碼 `stress-admin-test-only`。僅供這個隔離環境使用。
- Colima profile `s2t-stress`：6 CPU、10 GiB RAM、40 GiB disk，ARM64／VZ。
- Docker 與 Kubernetes context：`colima-s2t-stress`；K3s `v1.35.0+k3s1`，一個節點。
- Namespace：`s2t-stress-20261005`。
- Gateway 2 副本、audio-worker 1 副本，使用真實應用程式與真實驗證、儲存、持久化工作佇列、Redis 限流。
- PostgreSQL 16、MinIO、Milvus 2.5.3＋etcd 3.5.18，全部容器化部署在 Kubernetes，使用獨立 PVC。
- Redis 7.4 Alpine：1 primary＋2 replicas、3 個 Sentinel，quorum 2；每個節點都有 PVC，Redis 使用 AOF。
- 原本的 Docker 服務與資料保留；8787 的原服務沒有改接到測試資料庫。這次部署的 Web 本身已連到 Kubernetes storage。
- 目前服務持續運行；port-forward 綁定一個 Pod，未來重新部署後若失效，重新執行文末指令。

Redis 使用遠端拉取的 [官方 Redis Docker image](https://hub.docker.com/_/redis)，digest 見 `results/images.txt`。Sentinel 配置依 [Redis 官方 Sentinel 文件](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)，使用可寫配置檔、獨立 Sentinel／Redis 密碼與三個 Sentinel。

## 測試條件

100 個真正註冊的獨立帳號／JWT，不是同一個帳號重複 100 次。負載產生器在 Kubernetes 內，走 Gateway Service；跨 Pod 檢查則直接呼叫兩個 Gateway Pod。

每人每 1.5 秒送 1.5 秒、16 kHz、mono、PCM16 WAV；ASR 成功後再送翻譯。採固定到達率並錯開帳號起始時間，正常約 66.7 組／秒，約 133.3 個模型 HTTP 請求／秒。紀錄漏送、排程延遲、失敗、成功請求的 P50／P95／P99，避免只報快速拒絕造成的低延遲。

ASR 模擬延遲 400 ms、翻譯 180 ms、講者分離 750 ms。模型只呼叫 namespace 內 `mock-models:9090`；mock 沒有上游轉送功能。namespace egress NetworkPolicy 只允許同 namespace 與 cluster DNS。對外 TCP 連線檢查被阻擋，見 `results/egress-tcp-check.json`；沒有呼叫真實模型 API。

ASR／翻譯共享併發上限各 64，Redis Sentinel 協調兩個 Gateway；每帳號每分鐘配額各 180；本輪 storage compensation grace 設為 150 ms，PostgreSQL 每個應用程式 pool 上限 8，完整參數在產生器與 private env。測試客戶端不自動重試，以保留故障當下的原始結果。這是 HTTP 端到端測試，未包含瀏覽器渲染、麥克風、VAD 或真實模型推論成本。

## 結果

P95 是**成功完成辨識＋翻譯整組**的延遲；不把失敗算成成功。

| 情境 | 排程組數 | 完成組數 | 失敗組數 | 成功組 P95 |
|---|---:|---:|---:|---:|
| 10 人基準，30 秒 | 200 | 200 | 0 | 667 ms |
| 100 人正常，180 秒 | 12,000 | 12,000 | 0 | 610 ms |
| 100 人超量，15 秒 | 7,500 | 832 | 6,668 | 1,683 ms |
| 超量後恢復，100 人 60 秒 | 4,000 | 4,000 | 0 | 616 ms |
| Redis 真正凍結／切換，100 人 60 秒 | 4,000 | 3,613 | 387 | 618 ms |
| Gateway 滾動更新，100 人 60 秒 | 4,000 | 3,942 | 58 | 620 ms |

正常流量 P99 627 ms、最慢 760 ms，沒有產生器漏送；最大排程延遲 33 ms。背景工作及錄音測試也在基準／正常流量期間執行。

超量情境每人每 200 ms 送一次，合計 500 組／秒，ASR 延遲增為 1,200 ms。6,668 次拒絕全部為 ASR 503 容量保護；沒有 OOM，產生器沒有漏送，最大排程延遲 300 ms。Mock 觀測 ASR 併發峰值恰為 64，證明兩個 Gateway 共用同一上限，並非各自 64。恢復正常頻率後全部成功。

Redis 故障使用 Docker cgroup pause，真正凍結 current primary（當時 redis-2），而非只刪 Pod 再立刻啟動。2026-10-05T14:55:31Z 注入故障，4 秒內 primary 從 10.42.0.23 切到 10.42.0.20。新 primary 讀到事前已 WAIT 2 確認的測試探針。387 組 ASR 503，沒有翻譯 503／網路錯誤；從負載開始第 22 秒後沒有新增失敗，約故障後 7 秒內恢復穩定。成功組 P99 升到 4,701 ms、最慢 6,810 ms。Redis 非同步複製仍不能據此宣稱任意故障都不會丟失最新寫入。

Gateway 兩個 Pod 滾動更新約 12 秒完成；58 組失敗包含 33 個 HTTP 503 與 25 個網路錯誤，訊息包含「服務正在排空，請重試」。原始客戶端未重試，因此不能解讀為實際 UI 一定丟失 58 句，也不能宣稱更新無感。

## 儲存與資料驗證

- 100／100 帳號：3 個 PCM chunks、同 chunk 重送、完成錄音、promote、保存 session、讀回 WAV 與 PCM 位元組比對全部通過。這個階段限制 20 個帳號同時進行。
- 100／100 舊版本 session 保存被正確拒絕為 409；跨帳號讀音檔被拒絕為 403／404。
- 100／100 持久化講者分離工作完成，講者寫回 session，原翻譯保留，全部一次 attempt。單 worker 一次一個工作，2 秒 polling：平均完成等待 97.91 秒、最慢 195.09 秒，**100 人同時結束時會排隊**。
- 100／100 帳號：真實 Milvus 聲紋寫入、metadata 與私有範圍搜尋通過；embedding 為模擬向量。這個階段限制 10 個帳號同時進行，沒有測辨識準確率。
- 故障與更新後，再驗證 100／100 音檔 SHA-256、session 完成狀態、翻譯及聲紋 metadata，全部完整。
- 跨 Gateway 同一 ASR idempotency key 重送，只觸發一次 mock ASR；改 payload 正確得到 409。
- 真實 PostgreSQL＋MinIO＋Redis integration：工作 lease／generation fencing、跨副本配額、登入限流、併發上限、持久化去重、chunk ACK／stream 組裝／清除均通過。另各執行 20 次首次設定與術語 CAS 雙寫競態，恰有一位勝出。

原始結果見 `results/storage.json`、`jobs.json`、`voiceprints.json`、`final-integrity.json`、`scale-integration-final.txt`、`remote-storage-smoke.txt`。

## 找到並處理的問題

1. **首次寫入的 PostgreSQL CAS 競態已修正**：`SELECT ... FOR UPDATE` 鎖不到尚不存在的 row。兩個 Pod 同時首次寫一般設定或術語時，第二個 INSERT 會 unique violation，錯誤回 503。改成明確的 `ON CONFLICT ... DO NOTHING`，由 affected row count 判斷輸家；API 現在回 409。兩個修改在 `server/storage/remote.cjs`，回歸驗證加入 `tests/integration/scale-safety-integration.cjs`。修正前／後的跨 Pod 回應及 patch 都已存檔，final image 為 `s2t-stress:20261005-fixed2`。
2. **隔離 VM 的校時會阻止 Sentinel 切換**：Lima SyncTime 每約 10 秒向後 step 約 105–136 ms，與 Sentinel `+tilt` 時間吻合。Redis 官方說明時間倒退會進入 TILT 並暫停切換。只在壓測 VM 的 lima-guestagent systemd drop-in 移除 `CAP_SYS_TIME`，保留 systemd-timesyncd；guestagent 仍可處理其他功能。重測 Sentinel tilt=0，兩次真實容器凍結均完成升級。原始 VM／Sentinel logs 保留；此調整未套到原本 Colima default VM。
3. **切換與更新不是零中斷**：應用程式會在協調器不可用時拒絕，避免無限排隊；但前端恢復仍需進一步驗證。現有 storage fetch 是短時間三次重試，翻譯 queue 也有有限重試，不能把它們直接視為可跨越約 7 秒故障窗口。建議下一輪測瀏覽器端重送、保留同一 idempotency key、退避與 jitter，以及滾動更新的 endpoint 傳播／排空時序。
4. **背景工作等待時間偏長**：單 worker 的 2 秒 polling 在 mock 只要 750 ms 時限制了吞吐量；可增 worker 副本並再次測 queue latency／database pool。真實模型處理速度必須另測。

這輪沒有觀察到測試期間 OOM、非預期 Pod restart 或持久化資料損壞。節點 10 秒取樣峰值約 4.258 CPU、2,107 MiB；這包含 K3s、其他服務及修正映像建置，不能當作純字幕服務的資源需求。

## 不能由本次測試推論的事情

- 真實 ASR／翻譯／講者分離的延遲、GPU 容量、品質、供應商配額。
- 長時間、長錄音、500 MB 上傳、網路慢速客戶端或瀏覽器記憶體穩定性。
- 多實體節點 HA：三個 Redis／Sentinel 都在同一台 VM；PostgreSQL、MinIO、Milvus、etcd 目前單副本，整台 VM 掛掉仍全部不可用。
- Sentinel probe 保留不是一般性 RPO=0 保證。

## 重跑與維運

所有檔案位於本目錄，`manifests/stack.json` 為最後部署；`private/` 保存測試 secrets，已設 600 並 gitignore。不要套用真實模型 key。映像未上傳外部 registry。

```sh
kubectl --context colima-s2t-stress -n s2t-stress-20261005 get pods
kubectl --context colima-s2t-stress -n s2t-stress-20261005 port-forward svc/gateway 8790:8787
kubectl --context colima-s2t-stress -n s2t-stress-20261005 exec load-client -- node /tmp/load-test.cjs load rerun-100 100 180 1500
```

產生器會重用既存 private credentials。若建立全新環境：build／load `s2t-stress:20261005` 和 `s2t-stress:20261005-fixed2` 及 storage images，先 apply `manifests/storage.json`、`private/secret.json`，跑 `manifests/migration.json` 等待 complete，再 apply `manifests/stack.json`、`manifests/client.json`。namespace 與實驗資料為固定名稱；錄音初始化測試不是可重複覆寫的測試，重跑時應使用新帳號或新的隔離 namespace。

停止這個 VM、保留資料：`colima stop s2t-stress`。不要刪 namespace／PVC／profile，除非確定不再需要實驗資料。

校時 drop-in 路徑為 `/etc/systemd/system/lima-guestagent.service.d/s2t-stress-clock.conf`（VM 內）。若要恢復原行為，只移除此檔並 daemon-reload／restart lima-guestagent；Sentinel 可能再次 TILT。隔離環境持續運行時保留本次修正。

## 實驗有效性與保留紀錄

- `sentinel-noop-signal-*`：早期由 namespace 內對 PID 1 發 STOP，實際沒有凍結主節點，**不算 failover 測試**。
- `sentinel-cached-replay-*`：確實升級副本，但初次重跑沿用了 idempotency keys，主要命中既有結果，**不算完整模型負載測試**。產生器已加入每次 run 的 timestamp，正式 `sentinel-failover-100.json` 為重測的新 keys。
- `remote-storage-smoke-sandbox-blocked.txt`：初次本機測試因 sandbox EPERM 沒有連上服務；其後完全改在隔離 Kubernetes 內執行。
- `remote-storage-smoke-before-cas-fix.txt`：真實跨 process 競態失敗的證據，修正後 `remote-storage-smoke.txt` 通過。
- fault 後舊容量 lease 尚未過期時，使用不同上限的獨立 integration 曾被 503 拒絕；待測試 key 自然過期後 final integration 通過。容量租約為 120 秒，故障後短期可用容量需要另行監測。

`results/summary.json` 有彙整，完整時序見每階段 JSON；`logs/` 保存 build、Gateway 及 Sentinel 記錄。
