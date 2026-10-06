# 多 Pod、API 延遲與滾動更新修正驗證

日期：2026-10-05；分支：feature/k8s-scale-docker-compatible。

先前滾動更新的 58 組失敗已修正。本次修正前以 4 個 Gateway 重現 63 / 4,000 組失敗；修正後，2／4 個 Gateway 在 5 次完整滾動更新中完成 21,000 組請求，零失敗、零丟棄。客戶端沒有重試。

## 測試方式與結果

100 個帳號，每人每 1.5 秒送出一組 ASR → 翻譯請求，固定到達速率約 66.7 組／秒。每組使用不同的冪等鍵；比對模擬服務計數，實際收到 21,000 次 ASR 與 21,000 次翻譯，排除快取回放。模型 API 完全模擬；PostgreSQL、MinIO、Milvus、Redis／Sentinel 使用隔離的真實容器與 PVC。命名空間限制對外連線，未呼叫真實模型 API。

| 情境 | Gateway | API 模擬延遲 | 滾動次數 | 成功／排程 | 失敗 | 整組 P95／P99 |
|---|---:|---|---:|---:|---:|---:|
| 修正前 | 4 | ASR 400 ms；翻譯 180 ms | 1 | 3,937／4,000 | 63 | 646／808 ms |
| 修正後固定延遲 | 4 | ASR 400 ms；翻譯 180 ms | 1 | 5,000／5,000 | 0 | 623／799 ms |
| 修正後波動與慢回應 | 4 | ASR 600 ± 200 ms；翻譯 300 ± 100 ms；各每 100 次插入 12 秒／3 秒回應 | 2 | 8,000／8,000 | 0 | 1,151／12,228 ms |
| 修正後較慢 API | 2 | ASR 750 ± 150 ms；翻譯 500 ± 100 ms；每 300 次 ASR 插入 12 秒、每 200 次翻譯插入 3 秒 | 2 | 8,000／8,000 | 0 | 1,452／1,513 ms |

最長整組回應約 15 秒。4 Pod 波動情境確實執行 80 次 12 秒 ASR 與 80 次 3 秒翻譯；2 Pod 情境執行 27／40 次。日誌另確認 5 次長 ASR 在 SIGTERM 之後仍成功完成，沒有被關機截斷。100 個帳號的既有音訊 SHA256、工作完成狀態、翻譯與聲紋資料最終完整性檢查全部通過。

2 Pod 測試的開始快照含縮容中的舊 Pod，因此原始 pods-before 共 4 筆；Deployment 已縮至 2 個副本並完成 rollout，後續兩次更新與最終快照均以 2 個副本驗證。Pod 時序保留供核對。

## 根因與修正

原流程一收到 SIGTERM 就拒絕新模型請求並關閉 listener；Kubernetes 路由撤除與既有 keep-alive 連線仍有時間差，因此出現 503 與網路錯誤。單純增加副本仍會重現：修正前 4 Pod 有 45 次 HTTP 503、18 次網路失敗。

新增 SIGUSR2 的預備關機階段，由 Gateway／audio-service 的 preStop 觸發：立即撤除 readiness、停止領取背景工作、對回應加上 Connection: close，但仍接住路由傳播期間到達的請求。等待 10 秒後才進入 SIGTERM 排空，讓在途請求完成。正式部署維持 60 秒 terminationGracePeriod，應用排空預算 45 秒；本次隔離測試應用排空為 15 秒，涵蓋 12 秒慢回應。生命周期 smoke test 驗證兩個訊號、readiness、連線關閉與請求完成。

設計依據：[Kubernetes endpoint termination](https://kubernetes.io/docs/tutorials/services/pods-and-endpoint-termination-flow/)、[container lifecycle hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)。

同時修正實驗環境的兩個實際問題：

- 4 個 Gateway 加 maxSurge=1 時 CPU requests 不足，更新卡在 Pending。調整 Redis request 至 100m、Sentinel 至 25m，保留 surge 排程空間，未新增 CPU limit。
- Redis／Sentinel 重建後，持久化的舊 Pod IP 讓 replica 指向不存在的 primary。改用 StatefulSet 固定 DNS，Sentinel 啟用 resolve-hostnames 與 announce-hostnames，並維護自身固定 DNS 公告。修正準備期間曾發生隔離 Redis 中斷；復原後再重建全套 Redis／Sentinel，確認一主兩從、replication link up、探針資料保留，再開始上述有效壓測。依據：[Redis Sentinel hostname 設定](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)。

早期更新因 Pending 未完成的試跑另存 invalid-baseline-4pods-pending，未計入有效結果。

## 證據與重現

- [結果摘要](results/summary.json)、[長請求排空證據](results/long-request-drain-proof.json)、[100 帳號完整性](results/final-integrity.json)。
- results/ 含每階段狀態碼、延遲、mock 計數前後差異、Pod 時序與 rollout 日誌；logs/ 含實際 Gateway 關機日誌。
- [部署快照](manifests/stack-final.json)、程式修正 (intermediate artifact removed)、[延遲設定](profiles/jitter-tail.json)。
- HTTP lifecycle smoke、scale smoke、TypeScript typecheck 與 Kustomize 產物驗證通過。

既有測試叢集與 load-client 保留時，可在專案根目錄執行（每次更換 phase 名稱，避免覆寫證據）：

```sh
sh experiment/k8s/history/rollout-2026-10-05/run-phase.sh rerun-4pods 4 120 jitter-tail 2
sh experiment/k8s/history/rollout-2026-10-05/run-phase.sh rerun-2pods 2 120 slow 2
```

完整建立流程與隔離 Secret 位於前次實驗目錄；stack-final.json 不含 Secret，也不包含 load-client 暫存帳號與腳本，不能單獨還原全部測試。延遲波動為隨機分布，重跑百分位會略有差異。

目前隔離叢集恢復為 4 個 Gateway、1 個 audio-worker，模型延遲恢復 ASR 400／翻譯 180 ms；測試網頁：http://localhost:8790。原本 localhost:8787 與原 Docker 儲存資料未修改。

此結果驗證單一實體節點、100 人及本次延遲範圍的 Gateway 滾動更新；不代表真實 GPU 推論容量、多節點故障、任意長度的 API 延遲或 Redis failover 均零中斷。前次 Redis failover 的失敗量仍是歷史測量，本次不以 Gateway 測試取代其重新驗證。
