# Kubernetes：前端 1 Pod、後端 2 Pods

繁體中文 | [English](../en/DEPLOYMENT.md)

目前 active base 為 `deploy/k8s/web.json`；`render.cjs` 載入分開的環境設定。後端兩個 Pod 都執行完整 Python API、音訊程序池與 durable worker。

## 部署前

1. 準備共享 PostgreSQL、MinIO、Redis，兩個後端使用相同認證密鑰。設定填入不提交的 `backend/.env.k8s`。
2. 依 `deploy/k8s/.env.example` 設定 namespace、context、`FRONTEND_IMAGE`、`BACKEND_IMAGE`、`K8S_DNS_RESOLVER`。使用明確且可取得的 immutable image tag。
3. 前端映像使用 `deploy/docker/frontend.Dockerfile`，完整後端使用 `deploy/docker/backend.Dockerfile` 的 `audio` target。映像須先推至 registry，或載入所有可能排程的節點。
4. 準備 `s2t-models` PVC；單節點本機叢集可明確設定 `K8S_MODEL_HOST_PATH`。多節點不應依賴單一節點的 hostPath。

```sh
npm run k8s:up
npm run k8s:forward
```

入口先套用環境設定並執行 schema migration Job，成功後才更新 workloads 並等待 rollout。前端與後端 Service／container port 分別取自 `frontend/.env` 的 `FRONTEND_PORT` 與後端的 `BACKEND_PORT`，預設 5173／8787。

Nginx 代理使用 namespace 完整 Service DNS；`K8S_DNS_RESOLVER` 必須是實際 cluster DNS IP。SSE 停用 buffer，POST 不自動重送。正式外部入口另依 `ingress.example.yaml` 配置 ingress controller、DNS 與 TLS。

## 一致性與健康

兩個後端共用 PostgreSQL／MinIO／Redis，以 immutable 音訊 chunks、CAS、撤銷紀錄、工作 lease generation 與 account fencing 協調，不要求 sticky session。

`/livez` 檢查程序存活；`/readyz` 檢查必要儲存依賴。部署含關閉排空與 preStop，應避免強制結束正在寫入的音訊工作。每 Pod query pool 預設 8、shared fence 2、exclusive fence 1，兩 Pod 至少預留 22 條，再加 migration／exporter。

```sh
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:deployment
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:replicas
node scripts/forward.cjs --monitoring
S2T_ALLOW_DEPLOYMENT_TESTS=true npm run test:monitoring
```

整合測試用於 localhost 隔離環境，會建立及清理專用測試帳號。最新實測與限制見 [2026-10-24 報告](../reports/WEB_PYTHON_K8S_2026-10-24.zh-TW.md)。

`npm run k8s:down` 刪除應用 workloads／Services，保留儲存、Secret 與監控。`deploy/k8s/examples/` 的角色分層與 HPA 是另案範例，不在本次固定 1＋2 部署中啟用。
