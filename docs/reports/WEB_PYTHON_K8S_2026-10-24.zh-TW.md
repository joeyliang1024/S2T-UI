# Web／Python／K8s 驗證紀錄

繁體中文 | [English](../en/VALIDATION-REPORT-2026-10-24.md)

日期：2026-10-24（Asia/Taipei）。本機叢集 `colima-s2t-stress`，namespace `s2t-stress-20261005`。

## 最終配置

- 前端 `s2t-frontend:web-20261024-r5`：1 Pod，Nginx，5173。
- 後端 `s2t-backend:web-20261024-r5`：2 Pods，Python API、音訊程序池與 durable worker，8787。
- PostgreSQL／MinIO／Redis Sentinel 共用；模型唯讀掛載。
- Grafana 3000、Prometheus 9090；兩個後端均為獨立且健康的 scrape target。
- 本機 port-forward 仍在執行；重新啟動可用 `node scripts/forward.cjs --monitoring`。

Node Gateway、Electron 主程序／preload／IPC adapter、相應套件、舊建置產物及直接依賴它們的工具已移除。
合用的前端契約／驗證器保留在 `frontend/shared`；原錄音緩衝修正與壓力測試內容未變動。
Dockerfiles／Compose 位於 `deploy/docker`、`deploy/compose`；後端與前端各自讀取 env port。
本機 `.venv` 已安裝完整 Python 3.12 依賴，`npm run dev` 的兩端啟動、代理及共同退出已實測。

## 實際功能

真實 Chrome（Playwright 自動 fallback）經 Nginx 操作實際 Python Pods：

- 登入／HttpOnly Cookie／重新整理／歷史、模型、設定、摘要、匯入與聲紋導覽。
- 帳號建立、角色更新、設定 CAS 衝突、術語與範本。
- 亂序錄音分塊、持久化 ACK、WAV 組裝、promotion 與清理，實際使用 MinIO。
- ASR、冪等重播、翻譯、摘要 SSE→NDJSON 串流。
- FFmpeg 轉碼、Silero、Sherpa 講者分離、聲紋 embedding／向量保存／識別與刪除。
- 模擬麥克風輸入真實 WAV，瀏覽器錄音、字幕、翻譯、停止與持久化歷史。
- 保存的逐字稿、翻譯與 WAV 可讀，背景工作狀態為 `completed`。
- 直接連接不同 Pods：JWT 跨 Pod 驗證、CAS、錄音接續／完成／讀取、共享登出撤銷。
- Linux ARM64 Nemotron CPU 實際推論，詳見原始 JSON。

隔離帳號與其資料在測試後刪除。原有使用者資料及 PVC 未刪除。

## 量測核對

| 量測 | 樣本數 | 原始樣本範圍 | 瀏覽器秒數總和 |
| --- | --- | --- | --- |
| e2e_asr | 6 | 0.561–0.847 秒 | 4.036333332 秒 |
| e2e_translation_tail | 5 | 1.143–1.511 秒 | 6.586833333 秒 |

Prometheus 的 sum／count 與瀏覽器收到成功 ACK 的樣本逐項一致（浮點容許誤差 1e-8），
沒有額外乘除 1000、重複計數或跨主機 wall-clock 相減。
ASR 為最後語音字到原文繪出；翻譯為最後語音字到譯文繪出。
主機與 Prometheus 時鐘相差約 0.030 秒。
P90 是 histogram 分桶估算，不能當成原始樣本精確排序。

這次 ASR／翻譯／摘要服務是固定約 500ms 的隔離 mock，用來驗證串接與計時；
Silero／Sherpa／FFmpeg／Nemotron／embedding 是本機真實處理。
數據不代表外部模型準確率、正式容量或 500 人服務保證。

## Grafana 修正

- 預設字幕來源改為 Python `job=s2t`，不用舊 `gateway-web`。
- Redis／Sentinel 從失效的 StatefulSet 固定位址改為動態發現目前 Pods。
- 音訊長度改為正確面板名稱，不當成最老等待時間。
- 效能看板改為 Python 實際提供的 HTTP、主程序 CPU／RSS、event loop、儲存及背景工作指標。
- 新使用者的漏斗計數器初始化零基準，降低首次 scrape 沒有計數基線的問題。
- 退役的 synthetic preview 已移除；保留真正看板、資料來源與 Grafana／Prometheus PVC。
- 主看板、效能看板的 PromQL 均無錯誤，實際頁面可呈現。
- 未使用的 etcd／Milvus 或沒有事件的區間可無資料；不填造 0 秒延遲。

## 回歸與範圍

`npm run check`：型別、架構、48 項前端測試及 Web build 通過。
`S2T_TEST_EMBEDDED_PG=1 npm run test:backend`：32 passed、1 skipped。
skip 為本機未安裝 FFmpeg；實際容器的 FFmpeg 已通過轉碼測試。
獨立瀏覽器測試、開發啟動指令測試、部署功能、跨 Pod 及監控測試均通過。

舊本機真實 ASR／翻譯端點的無憑證探測均無法連線；自動審核也拒絕向未驗證目的地傳送 API key。
因此外部真實模型的帶憑證推論尚未驗證，需要可用端點及明確允許使用對應憑證。
GPU、跨節點故障及正式長時間容量未在這次本機單節點驗證中宣稱通過。

部署期間既有 28GB MinIO 壓測資料造成 VM 40GB 資料碟 DiskPressure。
已保留資料並將資料碟擴為 64GB，儲存、監控與排程已恢復。

## 原始證據

部署（本機歷史資料）、
功能與瀏覽器樣本（本機歷史資料）、
監控與數值核對（本機歷史資料）、
真實 Nemotron（本機歷史資料）、
外部無憑證可達性（本機歷史資料）。
