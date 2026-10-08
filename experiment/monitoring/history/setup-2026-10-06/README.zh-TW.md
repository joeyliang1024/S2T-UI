# Prometheus + Grafana 單張總覽

隔離測試：colima-s2t-stress / s2t-stress-20261005。Grafana http://127.0.0.1:13000/d/s2t-overview 。字幕 UI http://127.0.0.1:8790 。同一張總覽包含首字、各階段、HTTP、模型、儲存、Redis / Sentinel 與 Kubernetes 資源。

## 定義與範圍

首字延遲是 Web VAD 偵測到語音開头後，回推 minSpeech 音訊樣本時間，到該語音第一段非空原文在主字幕 UI 可見呈現的時間。不是 API 回應時間，也不含 Prometheus scrape / Grafana refresh。雙 requestAnimationFrame 在 DOM commit 後估計呈現時間，並檢查頁面可見與字幕在視窗／捲動區域內。此方法估計語音開頭和 paint；不能宣稱量到精確人類音素、麥克風硬體延遲、音訊到 JS 前的延遲或螢幕實體 scanout。模型回整段文字時，整段第一次顯示即首字顯示。只對本次 Web HTTP ASR 收音路徑啟用，Electron、本機 streaming 和浮動字幕視窗未納入。

Web 使用同一 performance.now 單調時鐘，server 使用自己的單調時鐘，沒有跨機器牆鐘相減。階段包括 vad_onset（回推開頭到確認）、chunk_wait（確認到分段）、browser_queue、browser_preprocess（含前處理／Silero 如啟用）、asr_roundtrip_with_retries、response_to_paint。翻譯另有 schedule_wait、roundtrip、response_to_paint、speech_to_translation_paint。Gateway 提供 upload_read、容量等待、ASR 模型、翻譯模型。模型階段包括 SDK 編碼及網路往返，不是模型內部 GPU 推論計時。Gateway 分解和 Web roundtrip 重疊，不能加總它們；各階段 p95 也不能直接相加作為端到端 p95。

只報告實際可見且非空的字幕；speech_detected / asr_empty / asr_failed / audio_gap / telemetry_dropped 另外顯示，避免只看成功延遲忽略遺失。瀏覽器 500ms 批次最多 128 個測量，服務端登入、每帳號每分鐘 240 次、16KiB 及有限 stage/event allowlist。測量沒有文字、音訊、使用者／逐句 ID。未知或無效指標拒絕整批。沒有新增 durable 儲存寫入。

## 服務監控

Prometheus 5s 抓取，3 天／1GiB retention，2GiB PVC；Grafana 5s 更新，2GiB PVC，dashboard 和 datasource 以 ConfigMap provisioning。PostgreSQL 監控角色只有 pg_monitor、最多 3 connections、3 秒 SQL timeout。MinIO 的 metrics 在本隔離 ClusterIP 服務設 public；沒有對外公開 MinIO 埠。Grafana 本測試允許 Viewer 免登入；管理密碼是隨機 Secret，備份位於 ignored private/，不能把這份測試設定直接当公開網路生產部署。

原生 exporters：PostgreSQL、每個 Redis／Sentinel；MinIO／Milvus／etcd 原生 metrics；mock API 明確標示模擬，無真實 API forwarding；kube-state-metrics 限本 namespace，kubelet / cAdvisor 走 API server 認證 proxy。此 Docker runtime cAdvisor 只在 Pod cgroup 上提供 pod labels，資源查詢用該層避免 parent/container 雙重計數。kubelet 沒有 CFS metrics，補唯讀 /sys/fs/cgroup 掛載的 collector，只讀取容器 cpu.stat，輸出 Pod UID 累計節流，join 本 namespace 的 kube_pod_info；不需要 privileged、hostPID 或主機網路。

Prometheus／kube-state-metrics 的網路政策只增加本 K3s API 位址／埠；原有 no-real-model-api egress 保留。K3s 動態埠由 install-test.py 讀 EndpointSlice；生成 stack.json 的固定值是此實驗實例，搬遷請用安裝器重新解析。安裝時先等待 MinIO ready 再啟動新版 Gateway，避免同時重啟儲存造成新 Pod 初始化失敗。此 VM 只有一個 node，未證明跨 node 高可用。

## 目前實驗

100 人、90 秒、ASR 400±150ms，每20次1200ms長尾；翻譯180±80ms，每25次800ms長尾：6000 組、12000 次模型請求、0 失敗、0 排程丟棄，peak pending 106。八個 Chrome 頁面在相同模型負載下以假麥克風週期聲音實際錄音：32 個語音開頭成功 paint，p50 1.6132s、p95 2.4094s、p99 3.1545s。這是模擬模型／聲音的延遲測試，未量測真實模型正確率。原始結果為 results/load-100.json、browser.json、browser-summary.json。

Grafana 的分位數是 Prometheus histogram / rate 的 5 分鐘估計；與原始樣本 order-statistic 分位數不完全相同。首批指標有零基線，避免第一次 scrape 漏掉 first observation。累計樣本依目前 Pods 生命週期重置；不以兩個跨 Pod counter 的滾動比率宣稱成功率。

Redis 主要變數直接改為 REDIS_SENTINEL_NODES、REDIS_SERVICE_NAME、REDIS_SENTINEL_USERNAME、REDIS_PASSWARD、REDIS_SENTINEL_PASSWARD；沒有舊名稱或 PASSWORD 別名。Sentinel 省略 port 時用 26379，帳號預設 default。額外 URL／TLS／database 可選設定也改為無 S2T_ 前綴。第三方 Redis server / exporter 的原生設定名稱照其產品規格，這次改名的是 S2T 應用程式設定。

## 重現

python3 deploy/monitoring/generate.py 生成 stack / dashboard。建置 Dockerfile.web 的最新 s2t-stress:20261006-stage-share-v2 映像後（含後續階段占比增補），python3 deploy/monitoring/install-test.py 安裝監控，python3 deploy/monitoring/rename-app-redis.py 將既有隔離應用設定及映像原子切換到新名稱。監控 Secret 不納入版本控制。kubectl port-forward svc/grafana 13000:3000、svc/gateway 8790:8787 都要指定本測試 context / namespace。瀏覽器檔案使用本機 Chrome 與 Codex bundled Playwright；probe.cjs 在 load-client 執行逐一核對所有 PromQL 與 targets。

參考：[Prometheus Kubernetes SD](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)、[Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)、[Redis exporter Sentinel](https://github.com/oliver006/redis_exporter)。

改名初次 rollout 發現設定透過 envFrom Secret 注入，僅改 container env 不足，新 Pod 未 Ready，舊 Pod 繼續服務。已修正 rename-app-redis.py 同時遷移 envFrom Secret / ConfigMap，再將映像與 env 原子更新；舊鍵從 Secret 移除。load-before-secret-migration.json 只證明舊副本持續服務，不當成新名稱驗證。

最終驗證：新 Secret／新映像四個 Gateway 全數 Ready，滾動期間 100 人再執行 6000 組／12000 請求，0 失敗、0 丟棄，peak pending 60（results/load-redis-secret-fixed.json）。Pod 內原生 Sentinel 探針確認舊 S2T_REDIS_* 變數完全不存在、default 使用者、省略 port→26379、6 次容量執行成功（redis-live.json）。最終八個 Chrome 再量 32 個首字樣本：p50 1.5275s、p95 2.3172s、p99 2.3798s；此輪後半段沒有背景 100 人負載，不與初輪視為完全相同負載條件。22 個 targets 全部 up，所有 dashboard 面板 PromQL 有資料、無查詢錯誤；原始 100 帳號音訊 SHA256／紀錄／聲紋完整性全通過。Chrome dashboard 無頁面錯誤，截圖 results/dashboard.png。
