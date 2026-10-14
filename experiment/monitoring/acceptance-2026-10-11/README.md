# 2026-10-11 監控驗收

實際 8787 Web gateway 已套用字幕跨切頁／隱藏分頁的計時修正與使用量指標，readiness 及前端 bundle hash 已核對。使用者需重新整理原 Web 頁面以載入新 renderer。

Grafana 使用 `gateway-acceptance` 的独立驗收資料：三個 NT（驗收使用者甲、乙、丙）、兩個部門（驗收研發部、驗收營運部），持續产生不同 ASR／翻譯／摘要用量、4xx 與未回報 token 的情境。實際 request 走隔離 gateway 的 HTTP 路徑，所有模型為同容器 mock；字幕延遲示範資料為合成樣本，不代表真實模型速度。未在真實 8787 帳號或資料中灌入示範流量。

驗證透過 Grafana datasource 實際查詢 Prometheus，確認來源可用、三個 NT、兩個部門、token／音訊量非零及各部門 request 加總等於各 NT request 加總；再以 Chrome 確認中文表格與圖表。

測試通過：跨切頁／隱藏分頁回歸、真實 Chrome + 隔離 gateway 呈現、chunk 起點、六階段時間守恆、遙測背壓、NT／部門標籤與用量、雙帳號 gateway request／token／音訊與快取重播、登入／登出／cookie 相容性、TypeScript 檢查及 Web production build。原版 caption 計時程式對新增回歸情境會失敗。

登入 smoke test 原先會載入專案 dotenv；此次改為暫存工作目錄、最小環境及明確模型路徑，並為請求增加 timeout。驗證過程也修正 request 身分快取曾使 session handler 提早返回的問題；最終登入測試已通過。

重新建立示範來源：`python3 deploy/monitoring/install-acceptance.py`。若重啟 Grafana，需要重新啟動 `kubectl --context colima-s2t-stress -n s2t-stress-20261005 port-forward svc/grafana 13000:3000`。清除示範 workload 可刪除 `monitoring-acceptance` deployment/service 與 `monitoring-acceptance-code` ConfigMap；历史示範 series 會依 Prometheus 保存期自動到期。
