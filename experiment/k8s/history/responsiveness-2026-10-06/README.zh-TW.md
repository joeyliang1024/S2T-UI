# 一般操作回應與長篇紀錄瀏覽效能

日期：2026-10-06（Asia/Taipei）；分支：feature/k8s-scale-docker-compatible。

## 找到的體感瓶頸與修正

瀏覽器中載入 2,400 個片段（一小時）、480 個合併字幕群組的模擬紀錄。原本原生 details 雖然收合，React 仍建立所有片段、講者輸入、編輯按鈕及重錄控制，共 30,240 個 DOM 節點；開啟紀錄時出現 108 ms 主執行緒 long task。

新增共用 CaptionMemberDetails 元件，收合時只建立 summary，展開後才建立該群組的編輯內容。套用在紀錄及即時字幕；目前正在編輯的群組保留內容，避免重繪卸載輸入框。群組文字、翻譯、編輯內容和時間資料都保留。

| 本機 Chrome 單次量測 | 修改前 | 修改後，同一份測試 fixture | 修正 fixture 後複驗 |
|---|---:|---:|---:|
| 紀錄 DOM 節點 | 30,240 | 3,840 | 3,840 |
| 收合時片段編輯列 | 2,400 | 0 | 0 |
| 開啟紀錄、等待畫面更新 | 219 ms | 112 ms | 103 ms |
| 最長 long task | 108 ms | 51 ms | 無 ≥50 ms long task |
| 展開第一群組 | 67 ms | 68 ms | 66 ms |

DOM 減少約 87%。這是本機單次實測，開啟時間含 Playwright 點擊及兩次 requestAnimationFrame，不是所有裝置的效能保證。原始 browser-bench 第一版未提供 settings save version，會出現測試 stub 的設定儲存警示；前後第一組使用相同 stub。後來修正 harness 的設定 API 契約，fixed-clean 複驗沒有該警示。fixture 沒有寫入真實帳號資料。

瀏覽器實際驗證：展開第一群組能看到 5 個原始片段、進入編輯並改字、結束編輯、再次收合移除編輯 DOM、搜尋找到修改後內容；零 pageerror。API 除隔離 Gateway /api/config 外均攔截為模擬回應，對外請求被阻擋，未呼叫真實模型。

- [修改前數據](results/baseline-browser.json)、[修改後數據](results/fixed-browser.json)、[完整互動複驗](results/fixed-clean-browser.json)。
- 修改後畫面 (intermediate artifact removed)。
- [瀏覽器測試腳本](browser-bench.cjs)：使用本機 Chrome 和 Codex bundled Playwright，可在測試網頁 8790 就緒時重跑。

## 一般操作不被慢模型拖住

100 人的 ASR → 翻譯流量，加入 ASR 600 ± 200 ms、翻譯 300 ± 100 ms，及每 100 次的 12 秒／3 秒慢回應。同時量測一般操作：

| API／資源 | Sentinel 切換時 P95 | 最新版本滾動更新時 P95 |
|---|---:|---:|
| 紀錄讀取 | 4 ms | 4 ms |
| 登入狀態讀取 | 4 ms | 4 ms |
| 設定讀取 | 2 ms | 2 ms |
| 首頁 HTML | 6 ms | 7 ms |
| 既有音訊下載 | 17 ms | 11 ms |

Sentinel 情境 3,790 次一般操作全數成功；最新版本滾動更新 3,275 次也全數成功，包含 100 份音訊的 SHA256 驗證。這部分是 API／HTML 回應時間，不能直接當成瀏覽器按鈕完成時間；紀錄使用前次實驗的小型資料集，長篇 DOM 測試則另用瀏覽器 fixture。

最新映像 s2t-stress:20261006-ui-responsive 在 2 個 Gateway 的完整滾動更新中完成 **5,000／5,000 組模型請求，零失敗、零丟棄**。mock 實際收到各 5,000 次 ASR／翻譯，無快取回放或模型重試。整組 P95 1,143 ms、P99 12,211 ms。最終 100 帳號資料完整性全部通過。

## 重現與部署狀態

```sh
node experiment/k8s/history/responsiveness-2026-10-06/browser-bench.cjs rerun-browser 2400
sh experiment/k8s/history/responsiveness-2026-10-06/run-rolling.sh rerun-rolling 2 75 jitter-tail 1
```

首次命令需要本機 Chrome、腳本中的 bundled Playwright 路徑及 8790 port-forward；第二個需要既有隔離叢集、load-client 暫存工具與帳號。結果名稱請每次更換。API 一般操作腳本為 ui-load.cjs，需複製進 load-client 執行。

目前隔離測試 K8s 恢復 4 個 Gateway、1 個 audio-worker；模型延遲回到 ASR 400 ms／翻譯 180 ms，波動及尾端慢回應已關閉。測試網頁 http://localhost:8790，原服務與儲存資料未修改。TypeScript 檢查及 Docker 正式 Web 建置通過。完整 rollout 日誌、模型計數、Pod 快照與完整性結果保留於 results/。

接下來持續檢查較大實際儲存資料集、重連和更高負載的回應時間；本輪尚未驗證多節點故障或真實 GPU／模型吞吐量。
