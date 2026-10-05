# Redis Sentinel 切換、慢 API 與容量等待修正

日期：2026-10-06（Asia/Taipei）；分支：feature/k8s-scale-docker-compatible。

本次 100 人、2／4 個 Gateway 各完成 6,000 組 ASR → 翻譯請求，Redis primary 在流量中真正暫停，Sentinel 自動選主後恢復：共 12,000 組，零失敗、零丟棄、沒有客戶端或模型 API 重試。實際模擬服務收到 24,000 次模型呼叫，與成功數完全相符。

## 延遲與結果

每人每 1.5 秒一組、每階段送入流量 90 秒。ASR 為 600 ± 200 ms，每 100 次加入 12 秒回應；翻譯為 300 ± 100 ms，每 100 次加入 3 秒回應。API 完全模擬，資料儲存為隔離的真實容器。節點仍是同一個 Colima VM。

| 階段 | Gateway | 完成／排程 | 失敗 | Sentinel 選主 | 整組 P95／P99 |
|---|---:|---:|---:|---:|---:|
| 原實作重現 | 4 | 2,067／4,000 | 1,933 | 4 秒 | 3,615／6,648 ms* |
| 第一版：rediscovery、等待 | 4 | 6,000／6,000 | 0 | 4 秒 | 5,137／12,229 ms |
| 第一版交叉驗證 | 2 | 2,898／6,000 | 3,102 | 4 秒 | 10,598／13,261 ms* |
| 加入已完成租約清理 | 2 | 6,000／6,000 | 0 | 6 秒 | 5,250／12,223 ms |
| 租約清理，隨機容量競爭 | 4 | 5,989／6,000 | 11 | 5 秒 | 6,690／12,278 ms* |
| 最終 FIFO | 4 | 6,000／6,000 | **0** | 4 秒 | 4,036／12,216 ms |
| 最終 FIFO＋一般操作讀取 | 2 | 6,000／6,000 | **0** | 3 秒 | 5,173／12,208 ms |

* 延遲只統計成功請求；失敗比例不同，不可只比較百分位。波動為隨機分布，各次選主時間也不同，P95 改善是觀察結果，並非控制所有變因的因果估計。

模擬服務累計最高 ASR 併發 64，仍符合原本上限。不是靠增加模型容量或重送模型請求過關。

## 找到與修正的問題

1. Sentinel 4 秒選主，但命令只等待 3 秒、rediscovery 次數為零，過早回覆錯誤。開啟有界 rediscovery，Sentinel 命令整體最多 10 秒，Redis URL 模式維持 3 秒。
2. 非同步切換會讓已完成請求的容量租約重新出現。第一次失敗後曾觀察到 42 個 ASR／20 個翻譯殘留；另一輪出現 45／18 個。只等 lease 的 120 秒 TTL 會持續壓低有效容量。現在保留本 Pod 已完成 UUID 的 20 秒清理紀錄，每秒對目前 primary 重送刪除；不移除其他在途請求。最終 2 Pod 測後容量集合均為零。
3. 隨機輪詢容量會讓後到請求搶先、部分舊請求餓死或等滿十秒。改為每 Pod、每個模型依到達順序取得容量；只序列化取得容量，推論仍平行。等待佇列每 Pod 最多 1,000 筆，十秒預算包含排隊及命令等待。
4. Redis 命令在切換中可能重送。Lua 限流與容量取得使用同一 UUID 去重，並以真 Redis 驗證 20 次重複操作只計一次，其他超額請求仍被拒絕。
5. 協調命令斷線／逾時一律標為 503，避免部分容量取得錯誤被當成模型 502。

測試部署 readiness failureThreshold 從 1 改為 3，避免短切換立即讓所有 Service endpoint 消失；正式範例原本即使用預設 3。主實作也保留前一輪 preStop／SIGTERM 排空修正。

## 完全不可用與完整性

另外暫停全部三個 Redis：受限 ASR 請求約 10 秒後回 **503**，模擬模型呼叫增加 **0**，沒有繞過共享協調。解凍後等待 readiness 恢復，再檢查 100 個帳號的音訊 SHA256、完成工作、翻譯及聲紋。

第一次在解凍後立刻做檢查，7 次讀取仍因 Service 尚在恢復而 fetch failed；該結果保存在 integrity-during-recovery.json，不是資料毀損。最終檢查需等待 readiness；final-integrity.json 為穩定後結果。全部 Redis 同時不可用仍有服務中斷，不能宣稱此情境零中斷。

## 證據與重現

- [最終結果摘要](results/summary.json)、[全部 Redis 停止](results/total-redis-outage.json)、[恢復時間](results/total-outage-recovery.json)、[完整性](results/final-integrity.json)。
- [重複命令去重](results/redis-replay-check.json)、results/sentinel-smoke.txt、scale-smoke.txt、typecheck.txt。
- [最終部署快照](manifests/stack-final.json)；Secret、帳號與負載工具沿用前次隔離實驗，不含於這份快照。
- baseline、fixed、final、fifo 各階段原始數據都保留，未隱藏中間失敗。

既有測試叢集、load-client 暫存腳本及帳號仍保留時，先確認副本數與設定，再用新的名稱重跑：

```sh
sh experiment/k8s-sentinel-latency-2026-10-06/run-failover.sh rerun-failover
```

failover.sh 只暫停隔離 context／namespace 的 Redis primary；以穩定 DNS 找 Pod，EXIT trap 保證解凍。日誌含選主時間、資料探針及 Sentinel quorum。此結果不包含真實 GPU 容量、多節點故障或 Pod crash 與 Redis 切換同時發生；Redis 非同步複寫仍不提供配額 exactly-once 保證，可靠資料與任務擁有權仍以 PostgreSQL 為準。
