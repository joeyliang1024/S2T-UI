# 開發規範

## 責任與依賴

- 從 feature／domain 出發拆分；跨領域協調留給 services／app 組裝。
- renderer 不引用 `server/`；renderer shared 不反向引用 feature；中立契約不引用平台實作。
- `useAppController`／`AppView` 仍有待拆分責任，新增領域邏輯應放正式 feature 模組。
- `npm run check:architecture` 檢查 runtime cycle、shared 反向依賴及 unresolved import。跨 feature 存在引用不代表一律違規；仍需判斷責任與組裝位置。

## 抽象與 virtual class

TypeScript 優先用 type／interface、函式與依賴注入。只有已有多個實作、需要統一生命週期或共享不變條件時才引入 abstract class；不要為了可能的未來實作預先建立層級。Web／desktop 的 transport 差異透過 port 契約隔離。測試直接執行正式模組，不把 controller 原始碼截字串當長期 API。

## 契約與錯誤

- 外部 JSON、Storage 與模型回應使用 runtime guard；TypeScript cast 不等於驗證。
- 損壞資料應明確報錯並保留復原證據，不能降級成空資料後覆寫。
- 已設定的 blob／config／vector 故障不得靜默換成本機。完全未設定的 adapter 才可依現行規則選本機。
- 帳號隔離、CAS、revision、job fence 與刪除權限屬不變條件，拆檔不能改變語意。

## 非同步與資料保護

取消須傳到真正執行請求的 transport／worker；每階段開始前檢查取消。晚到結果發布前確認 request identity、帳號、來源版本／revision。使用者編輯與取消後保留的舊結果不能被晚到請求覆寫。`finally` 只能清理自己仍擁有的請求。

長音訊／模型運算離開 HTTP／UI event loop；使用有界 queue、timeout 與資源釋放。新增並行前量測 CPU、RAM、顯存與排隊，不能只增加 worker 數。

## 介面與設定

UI 支援繁中、簡中、英文、日文、德文；文案放既有 i18n 字典，日期／排序跟隨介面 locale。互動須支援鍵盤、焦點與窄畫面，狀態不能只靠顏色。錯誤訊息要有可執行的原因，敏感上游內容需遮蔽。

環境變數只保留部署者需要的決策，內部路徑與可推導值由程式／image 管理。新增參數同時更新 `.env.example`、設定檢查與文件；不要為單一功能攤開多個實作細節開關。

## 變更與 PR

先處理具體問題再做必要重構，避免混入無關格式化與功能。不得覆蓋既有未提交修改。PR 寫清「何種操作出錯、修改後如何運作、如何驗證、仍有何限制」，附相關文件與證據。未跑的項目明寫未驗證；mock 成功不等於模型品質或正式部署成功。

完成項目從 enhancement 移除，保留可追溯證據；未決規格與暫停的 Electron 工作不能擅自當成已完成。
