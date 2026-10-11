# Docker 相容與 K8s 多副本部署

## 兩種模式

同一個 Dockerfile.web 映像。未設定 S2T_KUBERNETES_MODE=true 時，預設角色仍為 all，保留本地 Storage／本地密鑰、本容器 worker threads、FFmpeg；不連 Redis、不要求獨立 worker、不自動偵測 K8s 切換模式。現有 docker-compose.gateway.yml 啟動與資料 volume 不變。單一 Deployment 可同樣使用此模式，但只能一個副本。

多副本必須明確設 S2T_KUBERNETES_MODE=true，所有角色使用同一組共享 MinIO／PostgreSQL／Milvus 及 S2T_AUTH_SECRET；共享限流使用 REDIS_URL 或 Sentinel 設定。Redis 中断時受限操作回覆 503，不回退本地。Redis 重啟／非同步 failover 可能重置短期限流及容量租約；可靠資料與任務擁有權始終以 PostgreSQL 為準，不宣稱 Redis 配額 exactly-once。

## 角色與必要設定

- all：Docker 預設，完整功能與本地 CPU 處理。
- api：公開 Gateway；K8s 必須指定 S2T_AUDIO_SERVICE_URL、S2T_AUDIO_SERVICE_TOKEN，CPU 工作轉送內部服務。
- audio-service：只接受內部 token 認證的音訊處理，公開 API 不可用。token 必須與 api 相同；只公開 ClusterIP，不掛公開 Ingress。
- audio-worker：只提供 probes／metrics；從 PostgreSQL 取得完整分離工作。

Redis 設定已改名，不讀取舊 S2T_REDIS_* 或 PASSWORD 拼法。主要使用 `REDIS_SENTINEL_NODES`、`REDIS_SERVICE_NAME`、`REDIS_SENTINEL_USERNAME`、`REDIS_PASSWARD` 與 `REDIS_SENTINEL_PASSWARD`；未指定 port 的節點預設 26379，資料節點帳號預設 default。

Redis 可二選一：`REDIS_URL`（redis:// 或 rediss://），或原生 Sentinel。不可同時設定；部分 Sentinel 設定也會拒絕啟動 readiness。所有 Pod 使用相同設定。

```dotenv
REDIS_URL=
REDIS_SENTINEL_NODES=redis-0.redis-headless:26379,redis-1.redis-headless:26379,redis-2.redis-headless:26379
REDIS_SERVICE_NAME=mymaster
REDIS_SENTINEL_USERNAME=default
REDIS_SENTINEL_PASSWARD=replace-sentinel-password
REDIS_USERNAME=default
REDIS_PASSWARD=replace-redis-password
REDIS_DATABASE=0
REDIS_SENTINEL_TLS=false
REDIS_TLS=false
```

NODES 為逗號分隔 host 或 host:port（port 預設 26379），IPv6 使用 [address]:port；可設定三個 Sentinel 種子，client 發現其他節點並追蹤 primary 切換。master name 必須符合 `sentinel monitor`，不是 Pod／Service 名稱。Sentinel 與 Redis 密碼分開；只有密碼認證時 username 留空會使用 default。TLS 兩側獨立啟用，使用系統信任 CA，未提供自訂 CA 環境變數。密鑰、URL 與 provider credentials 使用 Secret，禁止放在公開 frontend。

限流讀寫皆送 primary，不讀 replica。Sentinel 命令整體最多等待十秒，容許短暫 primary 切換；單一 Redis URL 仍為三秒。Rediscovery 重送共用同一 UUID，Lua 限流與容量取得皆去重，模型呼叫不重試。已完成租約保留二十秒清理紀錄，每秒對目前 primary 重送刪除，避免非同步切換復活已完成的容量租約；只清理本 Pod 已完成的 UUID，不移除其他在途租約。容量等待佇列每 Pod 最多 1,000 筆，Sentinel 模式最多等待十秒取得容量，每 Pod 的每個模型依到達順序取得容量，避免切換後的積壓瞬間失敗及後來請求插隊；超過等待預算仍回 503；服務恢復後 readiness 與請求恢復。Sentinel 公告的 Redis／其他 Sentinel 位址必須可被應用 Pod 解析與連線；只讓三個初始位址可連並不足夠。本實作不改 Sentinel quorum、伺服器間 auth-pass/auth-user 或 TLS 部署。Kubernetes 自行部署 Redis／Sentinel 時，所有公告位址應使用 StatefulSet 的固定 DNS 名稱，並啟用 Sentinel resolve-hostnames／announce-hostnames；只啟用 resolve-hostnames 仍可能把舊 Pod IP 寫入持久化配置，重建後失聯。

S2T_AUDIO_WARMUP 可設 silero、nemotron、diarization 的逗號列表。silero 載入模型；nemotron 驗證 runtime／權重；diarization 實際推論一秒靜音以預熱。失敗使 readiness 不通過。Docker 預設空白。Nemotron CLI 每次工作仍會載入權重，預熱不是持續模型駐留承諾。ASR／翻譯模型服務自行配置完成推論暖機才 Ready。

模型 PVC s2t-models 必須能被多節點唯讀掛載，或替換成各節點模型副本／initContainer。不假設單一 ReadWriteOnce PVC 能支援跨節點擴容。需要符合 CPU 架構的 runtime。

## 任務、重送及音訊 ACK

同 processingToken 的分離任務重送沿用現有工作；新的 processingToken 才要求重新處理。舊客戶端不帶 token 時保留既有重新處理語意。租約五分鐘、每 30 秒續租；續租失敗不提交結果，逾期由其他 worker 接手。提交在同一交易驗證 owner／generation／租約／session 版本並更新結果與任務狀態。本地 adapter 使用同一檔案鎖與原子寫入。

ASR／翻譯支援 x-s2t-idempotency-key。後端依帳號、路由、key 與內容指紋協調，成功結果保留十分鐘；同 key 不同內容回 409、同 key 執行中回 409，舊請求無 key 維持原行為。回放前仍檢查權限與限流。模型呼叫可在 crash 後再執行，不能保證外部模型只被呼叫一次。客戶端新一次操作使用新 key；同一次重試必須保留原 key。

分段音訊：

- PUT /api/data/recordings/:id/chunks/:index，body 為單聲道 PCM16，headers x-s2t-start-sample、x-s2t-sample-rate；單 chunk ≤1 MiB。
- GET /api/data/recordings/:id，查詢連續持久化 chunk／sample 進度。
- POST /api/data/recordings/:id/finish，JSON totalChunks／totalSamples；完整核對後串流組裝 WAV 到既有 audio/:id。
- POST /api/data/recordings/:id/promote，JSON audioKey；以串流將已完成備份轉存為正式音訊，不再從瀏覽器上傳整份 WAV。
- DELETE /api/data/recordings/:id，只清理已完成的分段備份；應在正式紀錄音訊保存成功後使用。

同序號同內容重送回覆既有 ACK，不同內容／範圍重疊回 409；只有物件與 metadata 寫入成功才 durable ACK。所有路由以登入帳號隔離。完成 API 可重試。總 PCM 上限約 2 GiB，單錄音最多 100000 chunks；未完成的 ACK 音訊不自動過期。

分散式 Web 收音沿用 OPFS 與 BufferedPcmWriter，每約一秒提交原始 PCM，有界待處理緩衝及故障暫停；停止等待尾段與 finish，再保存工作階段／排分離任務。單機不增加此網路保存路徑。重整先使用 OPFS 恢復，OPFS 不可用時可從後端已 ACK 的連續音訊恢復。瀏覽器崩潰前尚未 ACK 且無 OPFS 的尾段無法恢復。此版本不提供另一裝置自動發現錄音 ID 的 UI。

新收音完成後直接後端轉存，續錄合併仍使用串流上傳；音訊保存／下載均不在 API 完整緩衝。長音檔上傳以兩分鐘租約、每 15 秒續期保護，完成後才開始 commit grace；Storage audit 保留 recording manifest 所引用的備份。成功正式保存後清理完成的遠端分段備份；保存失败保留備份。衝突上傳可能留下未引用的 immutable 物件，需在物件儲存維護中對照 recording manifest 清理，不可直接用短 TTL 刪除 ACK 音訊。

## 部署流程

deploy/k8s 為可調整的範例，不是 100 人容量保證。先替換 kustomization 的 registry／immutable tag，建立 s2t-secrets，包含現有 Storage／模型設定、S2T_AUTH_SECRET、Redis URL 或 Sentinel 設定、S2T_AUDIO_SERVICE_TOKEN；建立模型 PVC。Ingress／TLS 沿用組織現有方案，仅指向 s2t-gateway。

```sh
kubectl kustomize deploy/k8s
kubectl apply -k deploy/k8s
kubectl wait --for=condition=complete job/s2t-schema-migration --timeout=300s
kubectl rollout status deployment/s2t-gateway
```

Deployment 使用 S2T_STORAGE_MIGRATIONS=verify，migration Job 成功前不 Ready。Docker 預設 auto，保留啟動 migration。升级時以版本化 Job 名稱執行 migration 或重建已完成的 Job，再更新工作負載；Job 不會因更新映像自動重跑。只使用新增／相容 migration，新舊應用可同時運作。

Prometheus 收集 /metrics，使用 prometheus-adapter.values.yaml 對應 Custom Metrics API；必須將 namespace、pod、service 標籤加入 scrape 設定。共享 backlog 用 max 聚合，不能把每個 Gateway 的同一份 backlog 加總。未安裝 adapter 時自訂指標 HPA 不完整，先保持手動副本並完成監控配置。Metrics Server 提供 CPU 指標。

Gateway HPA 使用 CPU／進行中請求，音訊服務使用 CPU，背景 worker 使用待處理音訊秒數；另對最老任務等待秒數告警。歷史缺少 duration 的工作估計 60 秒。門檻、Pod 數與 requests／memory limits 都是起始值，依容量驗收調整。ASR 與翻譯服務分別配置推論排隊指標擴容；vLLM 可用 num_requests_waiting。

S2T_ASR_MAX_INFLIGHT、S2T_TRANSLATION_MAX_INFLIGHT 在多副本預設各 64；單機預設不增加全域上限。它們依用途保護共用模型容量，可能使不同 provider 共用較保守上限。不是 64 使用者限制，須依實測模型吞吐調整。

Gateway 至少兩副本，更新 maxUnavailable=0／maxSurge=1，節點分散、PDB 保留一個。Gateway／audio-service 的 preStop 先以 SIGUSR2 切掉 readiness，繼續服務 endpoint 傳播期間的請求，並以 Connection: close 將 keep-alive 客戶端移到其他 Pod；等待 10 秒後 Kubernetes 才送 SIGTERM。SIGTERM 排空 HTTP／背景任務，應用 45 秒、Pod 60 秒，包含 preStop 的 10 秒。長任務強制終止後由租約接手。PDB 不保障非自願故障，也不代替更新策略。節點須容納新副本及更新 surge。

連線預算為各角色 (最大副本 + surge) × 每 Pod pool max，加 migration、監控及其他客戶端。S2T_POSTGRES_MAX_CONNECTIONS 已實際傳入 pool；範例每 Pod 為 4。避免將本機 Compose 的 max_connections=24 直接當作正式容量。

## 可重現驗證

```sh
npm run scale:smoke
node tests/smoke/gateway-scale-http-smoke-test.cjs
node tests/smoke/gateway-load-model-smoke-test.cjs
S2T_TEST_POSTGRES_PASSWORD=... S2T_TEST_REDIS_URL=redis://... npm run scale:integration
npm run gateway:auth-smoke
npm run storage:smoke
npm run caption:gateway:smoke
npm run build
npm run typecheck
```

integration 僅對專用測試 PostgreSQL／Redis 執行，會建立 schema 與短期測試資料。測試驗證跨連線 claim／commit、等待鎖期間租約逾期、跨副本配額／登入計數／併發、重送與 Redis 客戶端中斷。可另提供 S2T_TEST_MINIO_ENDPOINT／S2T_TEST_MINIO_ACCESS_KEY／S2T_TEST_MINIO_SECRET_KEY 驗證真正 MinIO 串流組裝與清理。HTTP 測試使用兩個程序和共享本地 adapter，不冒充真正多 Pod／網路／Redis failover 驗收。

正式驗收依 CAPACITY_TEST.zh-TW.md，另做 scale up/down、rolling、kill Pod、Redis failover、Storage 故障及 100 個獨立帳號。必須保存映像、模型、硬體、HPA、測試資料與結果。沒有正式 K8s／模型量測，就不能宣稱已達 100 人 P95 ≤2.5 秒。

## 設計依據

- Kubernetes HPA：https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/
- Pod termination：https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- PostgreSQL queue locking：https://www.postgresql.org/docs/current/sql-select.html
- Redis rate limiter：https://redis.io/docs/latest/develop/use-cases/rate-limiter/
- Retry/idempotency：https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
- Load model：https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/

## 大型歷史紀錄同步

紀錄 POST 接受 plain JSON（最多 32 MiB），或 Content-Encoding: gzip（傳輸最多 8 MiB、解壓最多 32 MiB）。較大的瀏覽器 snapshot 使用 CompressionStream；壓縮無益或超過傳輸上限時改送 plain JSON。舊 gateway 的 400／415 可回退同一版本的 plain payload；409 仍交由現有 CAS rebase，不重複覆寫。CORS 允許 content-encoding。

每個 Pod 最多同時處理兩個完整紀錄寫入，等待佇列最多 32 筆、最長十秒；範圍包含讀取、解壓縮、JSON parsing 及資料庫保存。超量為 413、無效 JSON／gzip 為 400、不支援編碼為 415、忙碌為 503 + Retry-After；不再直接斷開過大的同步請求。PostgreSQL CAS 只讀取版本 scalar，保留 FOR UPDATE 及 first-write 唯一勝者，避免再次傳輸解析整份逐字稿。
