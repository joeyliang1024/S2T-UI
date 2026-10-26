# Prometheus／Grafana

設定來源為 `generate.py` 與產出的監控資源／看板。Python `/metrics` 應逐 Pod 抓取；目前主字幕看板 selector 為 `job="s2t"`。

連線環境設定放本目錄 `.env`，不與前後端共用私有檔案。`PROMETHEUS_URL` 須從 Grafana 可達。

已有隔離 K8s 監控部署時，從專案根目錄執行：

```sh
node scripts/forward.cjs --monitoring
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:monitoring
```

Grafana 本機 port 3000，Prometheus 9090。詳見 [監控指南](../../docs/guide/OBSERVABILITY.zh-TW.md) 與 [實測報告](../../docs/reports/WEB_PYTHON_K8S_2026-10-24.zh-TW.md)。
