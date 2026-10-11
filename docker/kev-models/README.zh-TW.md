# Kev 0.8B 模型檔案包

Docker Hub：`joeyliang1024/s2t-kev-models:0.8b-v1.0`。

只有模型檔案，沒有作業系統、Python、套件或 HTTP 服務。權重與 CPU 架構無關，供其他部署環境取出使用。

## 取出檔案

```sh
docker pull joeyliang1024/s2t-kev-models:0.8b-v1.0
docker create --name kev-weights joeyliang1024/s2t-kev-models:0.8b-v1.0 /unused
mkdir -p ./kev-models
docker cp kev-weights:/models/. ./kev-models/
docker rm kev-weights
```

映像僅作檔案載體，使用 `docker create`／`docker cp` 取出，不需啟動容器。若 Docker 提示映像架構不同，這不影響檔案取出。

## 搬到無網路環境

在可連線的機器拉取映像後，匯出：

```sh
docker save -o kev-0.8b-models.tar joeyliang1024/s2t-kev-models:0.8b-v1.0
```

將 tar 帶到目標機器，再執行：

```sh
docker load -i kev-0.8b-models.tar
```

之後依上面的 `docker create`／`docker cp` 取出檔案即可，不需連線下載模型。

## 內容

- Kev 0.8B v1.0 的 LoRA adapter、`head.pt`、tokenizer 與模型卡。
- checkpoint 指定版本的 Qwen3.5-0.8B-Base 基底權重、tokenizer、設定與 Apache-2.0 授權。
- `MODEL_PROVENANCE.json`、`KEV_LICENSE`、`UPSTREAM_REVISION` 和 `SHA256SUMS`。

保留 Hugging Face cache 結構，snapshot 裡是實際檔案，不依賴映像外的 symlink。

若目標環境已安裝相容 Kev 執行環境，可設定：

```sh
export HF_HOME="$(pwd)/kev-models/huggingface"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
python -m kev.serve --run jaredpalmer/kev-0.8b@v1.0 --host 0.0.0.0 --port 8009
```

這段指令需自行提供 Python、PyTorch 與相容的 Kev；權重包不包含它們。原始碼版本為 `fe64b1274ea7f80d4095866df90666abb03e9cf6`。

校驗檔案（Linux）：

```sh
cd kev-models
sha256sum -c SHA256SUMS
```

## 重建

準備只包含模型的 build context，將 `models` 目錄及此 Dockerfile 放入其中：

```sh
docker build -t joeyliang1024/s2t-kev-models:0.8b-v1.0 /path/to/context
```

不使用專案根目錄作為 context，以免包含設定、錄音或金鑰。
