# 摘要與網頁量測修正（2026-10-08）

- 模板 helper 回傳正確的 `summaryTemplates` 欄位；名稱驗證在 React updater 外執行，空名稱不使畫面崩潰。Web 模板保存序列化以避免同視窗舊 CAS version。
- 摘要操作保留在摘要頁；失敗紀錄可摘要已有文字，缺少 transcript 快取時以 final segments 重建。摘要失敗顯示原因、保留原摘要且可重試；重載時不保留失效的「正在產生摘要」標記。
- 歷史紀錄直接提供原有完整錄音品質校正作為重新辨識入口；無音訊時停用。辨識錯誤仍使用原有進度與錯誤提示。
- 導航、隱藏分頁、不可見字幕不補報延遲；API 回應的 roundtrip 不等待頁面重新開啟。

`browser-results.json` 是最後建置版本的真實 Chrome UI 測試：全部 API 都攔截為記憶體 fixtures，沒有使用者資料或真實模型呼叫。驗證模板保存與重載、空名稱、錯誤紀錄、摘要失敗後重試、已完成紀錄及中斷摘要恢復，page errors 為 0。

`caption-navigation-metrics-smoke-test.cjs` 驗證導航、分頁隱藏、不可見字幕及翻譯重新掛載不會補報舊時間。`summary-templates`、`summary-plan`、`chunk-latency`、`caption-metric-transport` 測試及 TypeScript/build 通過。

雙 Gateway + 雙 audio-worker 更新後，100 人／90 秒／6000 組請求透過 ingress 使用無注入延遲的假模型：6000 成功、0 失敗、0 丟棄，Gateway/worker/ingress 始終至少 2 Ready。詳見 `load-results.json` 和 `pod-results.json`。此輪為更新完成後回歸，未宣稱是更新同時壓測。

8787 為使用者的 Docker 網頁入口，已更新並重啟；8790 保留為 K8s 測試站。Prometheus `gateway-web` 透過 Lima host 介面抓取 8787，驗證 up=1。Dashboard 預設此來源，避免與 mock 資料混合。8787 的公開環境摘要模型 configured=false：若帳號亦無自訂摘要模型，仍需配置模型才能呼叫摘要，不以假 API 或其他模型替代。

量測修正後沒有在 8787 注入假字幕數據或呼叫付費模型。實際字幕延遲需使用者在 8787 說話後產生有效樣本；沒有新樣本時 No data 是正確行為。
