# 0930：即時字幕效能、辨識品質與 K8s 多副本可靠性計畫

## 目標與驗收

100 人同時收音、ASR 與翻譯。從開始說話到首筆字幕及對應翻譯顯示，端到端 P95 ≤ 2.5 秒，包含收音、切段、排隊、網路、推論及顯示；允許暫定結果後續修訂。另量測持續更新延遲，不排除錯誤、逾時或無結果請求。效能承諾只適用實測環境，故障降級另報告。

## 功能實作

### Milvus REST

- 使用獨立 Docker Milvus 2.5.3 測試，不使用 SDK；保護既有服務與 volumes。
- 驗證建立、has、describe、load、upsert、query、search、delete、重啟讀取。
- 修正 schema 維度解析、REST 錯誤、load 就緒、初始化快取與跨副本建立競爭。
- 驗證維度不符、權限過濾、一致性及不可用；移除測試中 SDK 殘留。

### CPU 隔離與字幕

- sherpa diarization、embedding、Silero、CPU 音訊處理移至持久 worker_threads。
- 同一映像提供 API／音訊 worker 角色，獨立 Deployment 擴容。
- 有限併發、佇列、緩衝；取消、逾時、崩潰重啟與錯誤可觀測。
- 短片段／增量 ASR 與翻譯；實測外部模型能力，不等待整句結束。
- 即時字幕優先於聲紋、品質校正及 final diarization；減少 renderer 複製和儲存更新，不丟音訊掩蓋延遲。

### 停止後完整 diarization

- 追蹤音訊範圍、處理進度與版本；停止 flush 音訊及 ASR。
- 先保存原紀錄，再建立可靠背景全段任務；長音檔有限重疊窗口。
- 可查詢／重試／跨重整及 Pod 接續；版本防護，保留手動命名，不建立衝突副本。
- 關閉分離不排程；身份失敗保留匿名語者。

### 聲紋品質

- 修正同為男性時 NT 錯配：候選按不同身份彙整，不把同身份樣本當第二名。
- 多段乾淨語音共識、最低分數、身份差距；不足信心拒識。
- 排除短、靜音、削波、重疊片段；匿名追蹤與 NT 判斷分離。
- 授權標註音訊量測錯配／拒識率，無資料不宣稱改善幅度。

### 音訊前處理

- dynaudnorm、Kaiser resample、Silero VAD 獨立設定，預設關閉，下一次錄音生效。
- Web gateway 處理；worker 管理 FFmpeg，Silero 在 worker 推論。
- 模型固定版本下載及 checksum；缺依賴明確不可用，不偷偷替換。
- 驗證延遲、時間戳、flush；保留原始錄音及未正規化聲紋分支。

### 模型健康與 NVIDIA

- 綠／黃／紅／灰及原因，區分可用、降級、失敗、未知。
- 註冊後檢查，設定頁可見每 60 秒與手動刷新；後端快取合併探測。
- 區分服務可達與模型可推論，不以模型列表成功冒充健康。
- Nemotron-3-Diarization 獨立 NeMo REST 部署、健康介面及 adapter，ASR／LLM 保留 vLLM。
- 正規化時間與 speaker turns，保留 overlap；不取代 NT embedding，不混用向量模型。
- adapter 契約測試與 GPU 真實推論分開報告。

## K8s 一致性

- PostgreSQL 為錄音、版本、任務、租約、去重、補償可靠來源。
- Redis Sentinel 加速快取／通知／限流；失效以 PostgreSQL 協調及輪詢。工作取得／提交始終經 PostgreSQL 驗證，避免雙重擁有權。
- 全 Pod 共用穩定登入及加密密鑰；K8s 缺設定拒絕啟動。
- 限制資料庫總連線，migration 互斥且相容滾動部署。
- 可恢復音訊串流：錄音 ID、序號、sample offset、durable ack、停止 flush。
- 紀錄獨立版本及冪等寫入，舊資料保留 ID 遷移；任務狀態／重試及 fencing token。
- provider／health、設定、Electron IPC／preload、Web 型別同步。
- 所有讀寫、重連、任務、向量查詢後端驗證身份範圍。
- Web 共享 PostgreSQL／物件儲存／Milvus，不以 Pod 或 Browser Storage 保存可靠資料；Electron 本地優先。
- 遠端暫時故障不偷偷切本地。音訊 immutable key，確認物件後提交 metadata；刪除／向量以可靠補償，不假設跨服務交易。
- 重送／亂序不建立第二筆錄音；真實編輯衝突提示，不靜默覆寫。
- 不依赖 sticky session；另一 Pod 從可靠進度恢復，只有可靠保存後 ack。
- 瀏覽器只保留有限未確認記憶體緩衝，超限提示／暫停。
- shutdown 排空，強制終止租約接手；提供 probes、grace period、PDB、HPA。

## 測試與交付

1. 效能基線及階段指標。
2. Docker Milvus 與 storage 一致性。
3. worker、停止補全、聲紋修正。
4. 健康、前處理、NVIDIA。
5. 多副本與故障注入。
6. 目標 K8s 容量壓測、調整重測。
7. 型別、smoke、整合、Web build、文件。

覆蓋停止 <15 秒／tick 後／執行中／暫停／長錄音／關閉；worker crash、刷新、斷線、kill Pod、滾動及擴縮容；多 Pod 並發寫、重複亂序、手動編輯競爭；Redis failover／全斷、各 storage outage／恢復；100 帳號與同帳號多視窗；前處理正確性、flush、時間戳、CPU／記憶體。確認無跨帳號混用、重複錄音、已確認資料遺失及舊結果覆寫。

容量以 1／10／25／50／100 路逐階測試，100 路穩態至少 30 分鐘，另測突發及故障；實際音訊節奏與來源時間戳。交付 API／音訊 worker／ASR／翻譯最低及建議 Pod 數、每 Pod requests／limits、GPU、HPA、預熱及餘裕；P50／95／99、錯誤／逾時、吞吐、queue、throttling、記憶體；正常／擴縮／fallback 分別結果及 storage 瓶頸；可重現指令、工作負載、映像及模型版本。

## 前提與待取得依賴

ASR／翻譯可 K8s 擴容，Redis Sentinel 可用。當前 Pod CPU 0.2～0.4、Memory 2 GB 可調整，requests／limits 待核實。CPU worker 起始一個密集工作，依實測調整。前處理預設關，停止先保存後背景分離。

正式驗收需脫敏 Deployment／Service／Ingress／HPA、CPU／GPU／模型配置及授權測試環境；身份品質需授權標註音訊，NVIDIA 需 GPU。Docker 不替代正式容量，無環境不虛構 Pod 數及保證。
