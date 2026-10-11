# 大型歷史紀錄同步與壓縮傳輸

日期：2026-10-06（Asia/Taipei）；分支：feature/k8s-scale-docker-compatible。

## 重現問題

建立 40 筆模擬會議紀錄、9,600 個片段，完整 snapshot 為 **9,807,526 bytes**。原 API 只允許 5 MiB，超過後直接 destroy request；實際結果為 fetch failed，而非可讀的大小限制回覆。瀏覽器因此將它當成暫時連線故障重試，歷史資料越多越無法同步。

另以 JSON null 重現 503：無效 envelope 的程式例外被誤當資料庫不可用。現在回覆 400，不觸發暫時錯誤重試。

## 修正

- 紀錄 API 接受最多 32 MiB 的 plain JSON，或傳輸最多 8 MiB、解壓最多 32 MiB 的 gzip。大小限制回 413；JSON／gzip 無效回 400；未知編碼回 415。先完成錯誤回覆再關閉未讀完的請求，保留資料。
- 瀏覽器對較大 snapshot 使用原生 CompressionStream；無支援、壓縮反而更大或超過 gzip 傳輸上限時傳 plain JSON。舊 gateway 的 400／415 可退回同一版本的 plain JSON；409 不做盲目重送。
- 每 Pod 最多兩個完整紀錄寫入；等待最多 32 筆、十秒，包含讀取、解壓、JSON parsing 及資料庫保存。忙碌為 503 + Retry-After，並使用 socket backpressure 限制等待中的 body。
- PostgreSQL CAS 保留 row lock 與原有 first-write 唯一勝者，只讀取版本 scalar，避免為版本檢查再次傳回／解析完整大逐字稿。未更動記錄衝突與任務 lease fencing 規則。
- CORS 接受 content-encoding。

這份重複文字較多的 fixture，gzip 傳輸約 **230 KB（原大小的 2.35%）**；比例不能直接代表所有真實逐字稿。實際 Chrome 編輯大型帳號的一筆標題，送出兩次 gzip 約 233 KB、皆 200，讀回確認保存，單次端到端約 826 ms，零 pageerror。無模型 API 重試。

## 驗證範圍與結果

| 情境 | 同時寫入的測試客戶端 | 結果 |
|---|---:|---|
| 100 個帳號逐批加入／讀回／還原 9.8 MB snapshot | 4 | 100／100 通過，保存 P95 448 ms、讀回 P95 315 ms |
| 100 個帳號同時寫入 9.8 MB snapshot | **100** | 100／100 通過，突發保存約 6.35 秒完成 |
| 同時大型保存＋100 人有延遲的 ASR／翻譯 | **100** | 大型保存 100／100；模型 4,000／4,000 組成功、零丟棄 |

混合流量：每人每 1.5 秒一組，ASR 600 ± 200 ms、翻譯 300 ± 100 ms，每 100 次插入 12 秒／3 秒慢回應。模型整組 P95 1,211 ms、P99 12,223 ms。負載程式沒有重試；此階段未另外擷取 mock 前後計數差值，因此不以此數據宣稱已量測實際 upstream 次數。

每個大型 snapshot 透過 API 讀回做深度內容比對，再還原原本的帳號紀錄。混合測試後，原有 100 份音訊 SHA256、翻譯、完成工作與聲紋完整性全部通過。腳本帳號與 backup 只存 load-client /tmp，未推送認證 token。

實際 Docker Node runtime 亦驗證：plain 超限及 gzip 解壓超限皆 413，損壞 gzip／null 皆 400、未知編碼 415，而且帳號資料前後完全不變。另通過真 PostgreSQL／MinIO／Redis 的多 adapter 整合測試，涵蓋 CAS 首寫競態、工作 generation fencing、row-lock 等待逾期、共享配額、chunk ACK、組裝、讀取與清理。TypeScript、HTTP lifecycle smoke、client compression smoke 及 payload smoke 通過。

## 證據、重現與限制

- [摘要](results/summary.json)、[原始失敗](results/baseline.json)、[100 人突發](results/burst.json)、[混合流量](results/mixed-models.json)。
- [真實瀏覽器編輯](results/browser.json)、[錯誤回覆／資料不變](results/errors.json)、整合測試 (intermediate artifact removed)。
- probe.cjs 使用額外模擬帳號；concurrent.cjs／burst.cjs 使用既有 100 帳號並還原原紀錄。測試資料是模擬逐字稿，模型服務也完全模擬，未呼叫真實模型 API。

```sh
kubectl --context colima-s2t-stress -n s2t-stress-20261005 exec load-client -- node /tmp/large-history-burst.cjs
node experiment/k8s/history/large-history-2026-10-06/browser.cjs
```

重跑需要既有隔離測試叢集、load-client 中的帳號及腳本；browser.cjs 需要 Chrome、bundled Playwright、8790 port-forward，以及 probe 帳號。瀏覽器會修改該模擬帳號的一筆標題；原 100 個測試帳號已還原。請勿把 script 當作正式帳號資料搬移工具。

目前 4 個 Gateway、1 個 audio-worker 使用 s2t-stress:20261006-large-history4，模型延遲恢復 ASR 400 ms／翻譯 180 ms。原服務 localhost:8787 及其儲存資料未修改。

此輪驗證單節點、多 Pod、這個大小及到達模式；超過 32 MiB 仍會收到明確 413，並非無限資料量支援。大 snapshot 的 GET 仍傳送完整清單，更多資料與大量同時讀取的效能仍待後續測試。
