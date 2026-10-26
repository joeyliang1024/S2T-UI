# 錄音保存與慢寫入處理

繁體中文 | [English](../en/RECORDING_RELIABILITY.md)

本版將本機錄音寫入與遠端上傳拆開。錄音上傳慢或暫時失敗，不再佔住本機 PCM writer 的佇列；字幕仍由獨立的音訊／模型流程處理。

## 寫入與恢復

```text
AudioWorklet → PCM 批次 → OPFS durable chunks
                              ↓
                      背景上傳（最多一個 1 MiB 範圍）
                              ↓
                    Python durable ACK → 前進上傳游標
```

支援的瀏覽器使用 dedicated Worker 的 `createSyncAccessHandle()` 寫入、flush、close，再提交分塊標記；不支援時使用原有非同步 OPFS 路徑。Worker 只處理檔案與音訊，不持有帳號憑證。

OPFS v2 每個 PCM 分塊都有 `.commit` 標記。恢復時只承認已提交分塊，不把異常關閉留下的未提交尾段當成完整錄音；仍可讀取原 v1 格式。commit 代表瀏覽器檔案 API 已成功完成，不是電源故障時的硬體持久性保證。

背景上傳直接讀取已提交的 OPFS 範圍，不在 RAM 累積整段待傳音訊。只收到符合預期的 durable ACK 才增加遠端 chunk index／sample 游標；回應遺失時重送相同範圍，由後端既有不可變分塊規則去重。暫時錯誤使用指數退避加 jitter，永久性 4xx 停止自動重試。帳號切換後不繼續傳送舊帳號音訊。

停止錄音時先取得本機音訊，再嘗試收尾遠端上傳（網路等待上限 30 秒）；遠端尚未完成時改走完整音檔保存流程，失敗則保留本機恢復來源及既有下載／重試動線。不把未完成的遠端錄音當成已保存。關閉頁面會停止背景程序，重載後透過本機恢復動線處理，不宣稱關閉瀏覽器後仍會自動補傳。

## 保存後清理

正常保存與重載恢復共用清理流程：後端核對替代音檔、紀錄 ID、音訊 key 與 processing token，確認不再處理中後，才終止原上傳並清除備份。先刪遠端備份，再刪 live draft，最後刪 OPFS；任一步失敗保留本機恢復資訊供下次重載重試。

分塊寫入前先持久化保留意圖，衝突請求不建立新物件；清理會掃描該錄音的精確 prefix，也清除舊版留下的孤立分塊。完成後只保留小型 deleted fence，拒絕遲到請求重新建立錄音；不保留音訊。

Worker 單筆寫入上限 30 秒。逾時會終止 Worker、回報失敗並保留已提交前綴，不在提交結果不明時直接重寫。永久寫入失敗不會因緩衝壓力解除而自動恢復收音。

## 仍存在的限制

本機磁碟持續慢、OPFS 配額耗盡或寫入失敗時，仍需保護性暫停，避免無限使用記憶體或靜默丟棄錄音。現有記憶體緩衝仍以約 60 秒／16 MiB 為上限；暫停期間可能缺音。Worker 改善 I/O 路徑，不能保證磁碟永不阻塞。

完全斷網時，外部 ASR／翻譯服務仍可能無法使用；此改動解除的是「錄音上傳拖停收音」的耦合，不會使遠端模型離線推論。不要清除可能含未保存錄音的網站資料。Safari／Firefox 的實機相容性、儲存極限與 500 人容量須另測。

## 重跑測試

```sh
npm run check
npm run test:e2e
S2T_ALLOW_DEPLOYMENT_TESTS=true S2T_TEST_RECORDING_UPLOAD_STALL_MS=65000 S2T_TEST_RECORDING_CLEANUP_RELOAD=true npm run test:deployment
```

前兩者涵蓋兩分鐘模擬上傳阻塞、ACK 遺失、帳號隔離、部分寫入／提交順序，以及真實 Chrome AudioWorklet＋OPFS Worker 與重載恢復。最後一項在 localhost 隔離 K8s 故意阻擋錄音上傳 65 秒，檢查持續收音、字幕、恢復及保存；會建立並清理專用帳號。

## 成熟做法與本次選擇

- [Chrome AudioWorklet 設計](https://developer.chrome.com/blog/audio-worklet-design-pattern)：即時音訊工作應與可能等待的處理分離。本次沿用既有 AudioWorklet，另拆儲存與上傳責任，沒有新增 SharedArrayBuffer 隔離標頭需求。
- [MDN OPFS sync access](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)：同步存取只能在 dedicated Worker 使用。本次採能力偵測與非同步 fallback，並增加明確提交標記。
- [tus 續傳協定](https://tus.io/protocols/resumable-upload)：以伺服器確認的 offset 協調續傳。本次沿用已支援跨 Pod 的 chunk/sample ACK，不另加第二套上傳協定；不是 tus 相容服務。
- [S3 multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)：失敗分塊可獨立重送。本次保留 Python 的認證／帳號隔離及 MinIO 儲存，不將物件儲存憑證交給瀏覽器，也沒有導入瀏覽器直傳 S3。

## 極限測試（2026-10-25）

真實 Chrome 在上傳連續阻塞 600 秒時仍完成 57,793,536 bytes 本地 PCM 寫入，未觸發暫停；恢復上傳後逐位元一致，並通過重新載入恢復與 ACK 清理。另以 96 kHz、30 倍即時速率，在約 19.94 秒寫入 115,200,000 bytes，等效 600 秒錄音；300 次寫入 P95 約 4.9 ms，未觸發暫停，內容完整且確認刪除。這些是隔離瀏覽器儲存測試，不能替代 500 人後端容量結果。

故障注入涵蓋 createWritable、write、close 卡死與配額不足，含 abort 永不回應及逾時後晚到結果。正式儲存期限 30 秒；測試 bundle 僅將期限加速為 40 ms。已提交前綴保持可恢復，後續寫入／finish 會拒絕，關閉不會無限等待。實體磁碟無法寫入時不能保證尚未提交的記憶體資料不遺失；系統會保護性暫停，而非宣稱能無限緩衝。

重跑：`S2T_OPFS_STALL_MS=600000 node tests/smoke/opfs-recording-browser-smoke-test.cjs`、`node tests/stress/opfs-throughput.cjs`、`node tests/smoke/opfs-storage-extremes-smoke-test.cjs`。只使用新的隔離瀏覽器環境，不清除既有網站錄音。

### 上傳批次與本機寫入

錄音仍每約 2 秒提交到瀏覽器 OPFS；網路上傳獨立累積，以最多 1 MiB 的範圍傳送，並以 15–30 秒的隨機期限錯開使用者的請求。結束錄音會立即送出剩餘資料。失敗重試使用完全相同的範圍，只有伺服器回覆持久化確認後才推進進度。此調整降低上傳請求數，不改變字幕辨識的發送時機。

## 最新記錄的儲存結果（2026-10-26）

上傳分批後另輪 600 秒斷網測試完整恢復 58,754,560 bytes、307 次 OPFS 提交，無收音壓力暫停。前文其他 byte 數代表各自素材／測試，不能混成同一輪。96kHz／30 倍即時測試回讀 115,200,000 bytes；皆不是 500 個實體瀏覽器。詳見 [目前結果](../reports/VALIDATION_2026-10-26.zh-TW.md) 與 [重現指南](REPRODUCE.zh-TW.md)。
