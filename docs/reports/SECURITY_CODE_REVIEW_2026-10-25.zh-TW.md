# 安全、效能與 UI 審查 — 2026-10-25

> 歷史／研究文件：以下數據、路徑與命令僅代表記錄版本，不是現行操作入口。最新操作與驗收請以 [文件入口](../README.md)、[目前結果](VALIDATION_2026-10-26.zh-TW.md) 及 [重現指南](../guide/REPRODUCE.zh-TW.md) 為準。


繁體中文 | [English](../en/SECURITY_CODE_REVIEW_2026-10-25.md)

本輪為現況掃描與隔離重現，沒有升級產品依賴、修補程式或變更部署。
目前不能宣稱沒有 CVE，也不能宣稱通過 500 人端到端容量驗證。

## 依賴掃描

- npm：`npm audit --json`，包含開發依賴，回報 0 項已知漏洞。
- Python：以隔離 `pip-audit` 工具查詢 PyPI 漏洞資料，掃描 71 個固定版本、
  本機 `.venv` 的 77 個套件、實際後端容器的 64 個套件。三份均無略過套件。
- 合併去重後：5 個套件命中 15 項已知漏洞公告。PyPI 結果包含重複公告，
  原始 16／16／26 筆不能直接相加當成 CVE 數量。

| 套件 | 現有版本 | 去重公告 | 修復版本門檻 | 範圍 |
| --- | --- | --- | --- | --- |
| starlette | 0.49.3 | 5 | 1.3.1 | 後端執行依賴 |
| anyio | 4.12.1 | 2 | 4.14.2 | 後端執行依賴 |
| python-dotenv | 1.2.1 | 1 | 1.2.2 | 後端啟動／環境載入 |
| pytest | 8.4.2 | 1 | 9.0.3 | 本機／CI 測試，不在產品容器內 |
| pip | 25.0.1 | 6 | 26.2.0 | Python 容器基底映像隨附工具，未列於產品 lockfile |

以上是版本比對命中，**不是 15 項已證實可遠端利用的問題**。例如：

- Starlette 公告包含 Host/path 解析、Windows StaticFiles、HTTPEndpoint 及表單解析條件。
  目前主要安全 middleware 使用 `scope['path']`，API 也各自檢查帳號；本輪未證實認證繞過。
  Linux 部署不符合 Windows StaticFiles 那項的條件，產品路由也未使用 HTTPEndpoint。
- AnyIO 的程序池公告涉及 `anyio.to_process` 的 stderr；目前音訊使用
  `concurrent.futures.ProcessPoolExecutor`。TLS 公告涉及 IDN 與攔截連線等條件。
- python-dotenv 的公告涉及 `set_key()`／`unset_key()` 與符號連結覆寫；產品使用的是讀取環境。
- pip 公告主要涉及安裝／下載套件。CVE-2025-8869 的 fallback extraction 條件在
  Python 3.12 已有 PEP 706 的環境中不走該易受影響分支；仍建議更新容器工具鏈。

不能只單獨升 Starlette：已安裝 FastAPI 0.128.8 限制 `starlette<1.0.0`。
也不能只升 pytest：pytest-asyncio 1.2.0 限制 `pytest<9`。
需成組調整相容版本、重新產生帶雜湊的 lockfile、測試並重建容器後再重掃。

公告來源：[Starlette](https://github.com/Kludex/starlette/security/advisories/GHSA-86qp-5c8j-p5mr)、
[AnyIO TLS](https://github.com/agronholm/anyio/security/advisories/GHSA-82r6-8w77-94w6)、
[AnyIO 程序池](https://github.com/agronholm/anyio/security/advisories/GHSA-5p39-cfhj-2xmp)、
[python-dotenv](https://github.com/theskumar/python-dotenv/security/advisories/GHSA-mf9w-mj56-hr94)、
[pytest](https://github.com/advisories/GHSA-6w46-j5rx-g56g)、
[pip URL 處理](https://github.com/advisories/GHSA-qwm4-qh6w-59xr)。
完整 CVE／GHSA 列表與三份掃描範圍見 去重摘要（本機歷史資料）。

這次是 npm／Python 套件公告掃描，不涵蓋 OS、Nginx、FFmpeg、原生模型執行檔的映像漏洞掃描，
也無法保證沒有未揭露漏洞。未對產品進行破壞式安全測試。

## 已重現的程式問題

### P1：清理期間可新增音訊引用，留下指向不存在 WAV 的紀錄

[recordings.py](../../backend/app/recordings.py):155、185 與
[data.py](../../backend/app/routes/data.py):127。

刪除第一階段檢查 sessions，但第二階段只持有 recording 鎖；另一 Pod 可以 CAS 保存
引用該音檔的新 session。已用兩個 app 與真實隔離 PostgreSQL 再次重現：保存回 200、
清理回 204，最後 session 仍存在，音訊卻回 404。這是先前已知、目前仍在的缺陷。
應讓新增引用與 deleting/deleted 狀態遵循同一交易協定。

### P1：錄音合併逾 10 秒會被 DB 閒置交易期限中斷

[recordings.py](../../backend/app/recordings.py):125、139 與
[storage.py](../../backend/app/storage.py):189。

完成錄音時，整段讀取 chunks／寫入音檔都在 PostgreSQL 交易內；期間沒有 SQL。
預設 `idle_in_transaction_session_timeout=10000`。模擬儲存耗時 10.5 秒後，
實測完成 API 於 10.52 秒回 503，manifest 仍是 `recording`，沒有進入 completed。
這輪新確認；chunks 尚在，可重試，並非證實音訊已遺失。

除了完成失敗，長時間儲存 I/O 還持有 DB／帳號協調連線，降低多使用者寫入能力。
應採短交易保留完成意圖、在交易外處理物件儲存，再用狀態／token 驗證提交結果，
同時封住與清理並行的競態。單純拉長 DB timeout 不能解決連線長期被占用。

重現程式（本機歷史資料）、
結果（本機歷史資料）。

### P2：非同步 OPFS fallback／metadata 沒有 I/O deadline

[opfs-pcm-recording.ts](../../frontend/src/features/capture/recording/adapters/opfs-pcm-recording.ts):38。

目前 30 秒期限只涵蓋 Worker request；fallback 的 createWritable/write/close 與 metadata
仍可一直 pending。已再次以正式 adapter 加入不回應的 writable 重現，append 與 finish
不會結束，也尚未進入遠端上傳收尾期限。應補一致的本地 I/O 終止處理，保留可恢復資料。

### P2：新分頁找不到已關閉分頁的待同步修改

[session-outbox.ts](../../frontend/src/features/sessions/services/session-outbox.ts):17、57。

outbox key 包含 sessionStorage 的分頁 owner，讀取只查自己的 key。已在真實 Chrome
再現：原分頁存待同步修改後關閉，新分頁同帳號讀不到；IndexedDB 原紀錄仍在，未被刪除。
應以帳號列出可接管的待同步資料，並確認原 owner 不活躍後再協調保存。

上述三項先前問題的原始重現來源與詳情見
[錄音追查報告](RECORDING_FOLLOWUP_2026-10-25.zh-TW.md)。本輪均重新執行確認。

### P2：修改管理頁部門後離開，不會保存

[SharingAuthorizationEditor.tsx](../../frontend/src/features/settings/views/SharingAuthorizationEditor.tsx):14、32。

文字欄位 onChange 只更新 React state，保存只接在共享核准 checkbox 上。
真實 Chrome＋產品 build 的隔離測試確認：輸入新部門、失焦、重整後內容回到原值，
期間保存請求數為 0。這輪新確認。應在既有單行排版內提供明確的保存動作或失焦保存，
讓部門修改不需要順便切換授權狀態。

UI 重現程式（本機歷史資料）。

## 其他效能觀察

- 8 張 PNG 均為 1536×1024，每張約 1.22–1.45 MB，合計 10.38 MB。
  多數標題圖只顯示 208px，手機更小。可以提供縮圖／WebP／多尺寸資產，保留原稿。
  瀏覽器依當前頁面載入使用到的背景圖，這不代表首頁必定一次下載全部 8 張。
- CSV 讀檔與解析已移至背景執行緒，但匹配仍逐列執行 `jargon in text`。
  正式 CSV 尚未提供，不能對其大小、匹配成本或 500 人翻譯容量作保證。
  這是容量待測項，並非本輪已量測證實的瓶頸。

## UI 驗證與 500 併發的實際範圍

已重跑產品 build 的導覽檢查：8 頁 × 深淺色 × 1440／768／390px，48 組版面通過，
圖稿載入、動畫與 reduced motion 也通過；這不涵蓋上述部門保存缺陷。
UI 檢查結果（本機歷史資料）。

本輪對**目前版本**重跑 500 請求、500 併發的單次 ASGI 轉錄微測試：

| 項目 | 本輪結果 |
| --- | --- |
| HTTP 200 | 500 / 500 |
| 耗時 | 1.052 秒 |
| 成功吞吐 | 475.48 req/s |
| P95 / P99 | 927.92 / 937.53 ms |
| 事件迴圈 lag P95 | 8.10 ms |
| 峰值 RSS | 107.0 MiB |

使用隔離 PostgreSQL、同一測試帳號、不同冪等鍵，模型是 30 ms mock。
只含 JWT／上傳／admission／冪等性，不含實際 TCP／Nginx／跨 Pod 網路、MinIO、
瀏覽器、持續錄音、翻譯 CSV、真實 ASR／LLM、長時間穩定性或多使用者帳號隔離容量。
因此 **不是「500 人完整壓測通過」**。與 10/23 舊微測試條件大致相同，但單次短測
與主機背景負載不同，不能用這兩個數字直接判定版本效能退步。
本輪原始結果（本機歷史資料）。

## 修正順序

先處理相容的安全依賴／容器工具鏈更新，以及兩項 P1 錄音交易問題；再修 OPFS、
outbox 與管理頁保存。完成後才做含真實模型、兩個後端 Pod、共享儲存與長時間錄音的
500 帳號分階段壓測。這輪的重現測試「通過」表示缺陷已暴露，不代表缺陷已修好。
