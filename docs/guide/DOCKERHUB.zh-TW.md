# 容器映像建置與發布

繁體中文 | [English](../en/DEPLOYMENT.md)

從 repository 根目錄建置，Dockerfile 集中於 `deploy/docker/`：

```sh
docker build -f deploy/docker/frontend.Dockerfile -t <registry>/s2t-frontend:<version> .
docker build -f deploy/docker/backend.Dockerfile --target audio -t <registry>/s2t-backend:<version> .
```

將佔位值替換為自己的 registry 與版本後再執行。完整後端使用 `audio` target；`api` target 不含完整本機音訊依賴。前端 final image 為 Nginx，後端為 Python 3.12，沒有 Node 業務 runtime。

使用既有 registry 登入方式，再分別 `docker push` 兩個映像。於 `deploy/k8s/.env` 設定對應的 `FRONTEND_IMAGE` 與 `BACKEND_IMAGE`，依 [K8s 指南](K8S_SCALE_DEPLOYMENT.zh-TW.md) 部署。多架構映像需各架構原生依賴驗證，不可將單一 ARM64 成功當成所有平台通過。

GPU 映像另見 `deploy/docker/audio-cuda.Dockerfile`。不要沿用已刪除的根目錄 Dockerfile，舊版 hardened／Wolfi 掃描結果也不適用於現行映像。`data/`、`models/` 與私有環境檔不放進應用映像，啟動時掛載或注入。
