# 執行資料

本機預設 `S2T_DATA_DIR=./data`。此目錄存放帳號、設定、錄音、聲紋、工作狀態、
認證金鑰，以及使用者可修改的 `prompt/`、`template/`。
翻譯共用術語放在 `jargon/jargon_en.csv`，詳見 [CSV 術語說明](jargon/README.md)。

除了說明與術語格式範例，執行資料全部排除 Git；整個 data 目錄排除 Docker build context。備份時應保留完整目錄，
包括 `auth-secret`。不要將這個目錄設為 Nginx 的靜態網站根目錄。

內建預設檔位於 `backend/resources/`，首次啟動只會補上缺少的檔案。
此次整理已將本機原 `.s2t-data/` 搬至此處；沒有重新初始化帳號或錄音。
其他舊環境請先停止服務，再自行搬移原資料目錄並更新 `S2T_DATA_DIR`。

Compose 未設定 `S2T_DATA_DIR` 時掛載本機 `./data`；多 Pod 的共享帳號與錄音資料使用
PostgreSQL／MinIO／Redis。共用術語 CSV 另透過 ConfigMap 或共享 PVC 掛載。
