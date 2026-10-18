# 目錄與檔案放置規範

以領域責任放檔案，先找既有位置。不要為了拆大檔只新增 `helpers`／`utils`／`misc`，也不要把領域邏輯再加回大型 controller。

## 程式與工具

| 位置 | 放什麼 | 不放什麼 |
| --- | --- | --- |
| `src/renderer/src/features/<feature>/domain/` | 純規則、排序、狀態推導、計畫計算 | React hooks、HTTP、檔案讀寫 |
| `features/<feature>/services/` | 使用案例、協調與可注入依賴的流程 | 全 app 巨型 controller |
| `features/<feature>/views/` | 該功能的 React 畫面與互動 | 金鑰、native runtime、資料庫存取 |
| `features/<feature>/ports.ts`、`transports/` | 外部能力契約及 Web／desktop 實作 | 把所有平台細節塞進 UI |
| `features/<feature>/hooks/` | 該功能的 React lifecycle／組裝，按需要新增 | 與 UI 無關的純計算 |
| `features/app/` | 導覽、跨功能組裝與 shell | 新領域服務的最終存放處 |
| `src/renderer/src/shared/` | 無 feature 反向依賴的共用 UI、HTTP、events | 某個 feature 專用業務邏輯 |
| `src/shared/contracts/` | main／renderer／server 中立契約與型別 | 引用 renderer／server 實作 |
| `src/shared/validation/` | 共用 runtime guards；必要時 `.cjs` + `.d.cts` | 只靠 TypeScript cast 假裝輸入有效 |
| `server/http/routes/` | 路由與邊界驗證 | 模型、Storage 的所有實作 |
| `server/auth/`、`storage/`、`jobs/`、`audio/` | 各領域服務、adapter、工作與音訊流程 | 無責任歸屬的新根目錄大檔 |
| `server/bootstrap.cjs` | 組裝、readiness、資源生命週期 | 新增無關 route／業務流程的長期位置 |
| `src/main/`、`src/preload/` | Electron native 邊界 | 新 Web 專屬功能；目前專屬開發暫停 |
| `tests/smoke/` | 可重跑功能／回歸測試 | 真實帳號、API key、未授權外部呼叫 |
| `tests/integration/`、`stress/`、`fixtures/` | 整合／壓力測試及必要小 fixture | 大型模型與下載語料 |
| `scripts/analysis/`、`testing/`、`evaluation/`、`benchmarks/`、`storage/` | 對應維護工具；文件工具用 `scripts/docs/` | 產品 runtime 的唯一實作、散落根目錄的臨時腳本 |
| `config/`、`deploy/`、`docker/` | build 設定、部署 manifest、映像支援檔 | 真實部署 Secret |

現有 feature 名稱含 app、auth、capture、models、sessions、transcript、translation、summary、settings、speakers、captions；新增前先確認是否屬於其中一個。更細責任見 [架構 reference](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/reference/ARCHITECTURE.zh-TW.md)。

## 文件與資料

| 位置 | 用途 |
| --- | --- |
| `README.md` | 專案入口、最短啟動方式、主要連結 |
| `CONTRIBUTING.md` | 開發規範入口，不複製所有 Wiki 內容 |
| `docs/README.md` | 文件分類索引 |
| `docs/guide/` | 現行操作、部署、維運與驗收步驟 |
| `docs/reference/` | API、資料格式、架構與不變條件 |
| `docs/research/` | 未定方案、比較、推論與待驗證問題 |
| `docs/reports/` | 有日期／版本／範圍的審查、實作與結果摘要 |
| `docs/Enhancement.md` | 唯一剩餘開發與待決規格清單 |
| `docs/wiki/` | Wiki 受版本控制的 Markdown 來源、側欄與頁尾 |
| `docs/templates/` | 新文件範本；不是產品操作入口 |
| `experiment/<主題>/<案例-日期>/README.md` | 方法、設定、量測摘要、限制與重現入口 |
| `models/`、`.s2t-data/`、本機暫存 | 本機權重、資料與 runtime；不提交大型 artifact 或帳號資料 |

實驗入口目前要求以 Markdown 摘要為主；原始音訊、日誌、JSON／CSV、截圖不任意提交。既有小型測試 fixture 可保留，但新增資料需說明必要性、授權、大小與去識別。`.gitignore` 不是唯一審查依據。

新檔案例：摘要取消協調放 `features/summary/services/`；純歷史排序放 `features/sessions/domain/`；操作教學放 `docs/guide/`；尚未跑過的 GPU 方案放 research，不能寫成已驗收報告。
