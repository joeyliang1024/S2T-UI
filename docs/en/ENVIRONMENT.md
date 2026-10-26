# Environment configuration

[繁體中文](../guide/ENVIRONMENT.zh-TW.md) | English

Keep configuration with its component. Preserve existing environment files and credentials. Process environment variables override values loaded from files.

| File | Responsibility |
| --- | --- |
| `frontend/.env` | `FRONTEND_PORT=5173`, `S2T_DEV_API_URL=http://127.0.0.1:8787` |
| `backend/.env` | `BACKEND_PORT=8787`, model endpoints, credentials, storage, authentication |
| `backend/.env.k8s` | Kubernetes shared storage and authentication settings |
| `deploy/compose/.env` | npm/PyPI build registries |
| `deploy/k8s/.env` | Namespace, context, immutable image tags, cluster DNS |
| `deploy/monitoring/.env` | Prometheus and metrics connection settings |

Create files from their corresponding `.env.example` where available. The backend explicitly loads `backend/.env`; Vite uses the frontend environment directory. Never place backend API keys in frontend files or `VITE_*` variables. If you change `BACKEND_PORT`, update `S2T_DEV_API_URL` as well.

## Data, models, and authentication

With commands run from the repository root, `S2T_DATA_DIR=./data` and `S2T_MODEL_DIR=./models` select the local directories. Built-in resources are supplied from `backend/resources/` without replacing existing user files.

ASR, translation, and summary services each use their `S2T_*_ENDPOINT`, `S2T_*_MODEL`, and `S2T_*_API_KEY` variables. `backend/.env.example` lists the exact names and the optional ASR profile JSON configuration. Local diarization can use `sherpa-onnx-speaker-diarization` or `nemotron-3-diarization` without a remote endpoint or API key.

Production deployments need a stable random `S2T_AUTH_SECRET`, a bootstrap administrator username, and a password of at least 12 characters. All backend Pods must share the secret. Changing it affects tokens and encrypted model credentials; preserve it with backups.

## Shared storage

Configure each PostgreSQL, MinIO, or Milvus group completely, or leave the entire group empty when using local storage. A configured remote service failure must not silently switch writes to local storage. Two backend Pods require shared PostgreSQL, MinIO, and Redis; Milvus is optional.

Redis accepts `REDIS_URL`, or Sentinel nodes with a master service name. Existing compatibility variables are spelled `REDIS_PASSWARD` and `REDIS_SENTINEL_PASSWARD`; follow the example file exactly. Sentinel and data-node authentication are separate.

## Performance settings

| Variable | Purpose |
| --- | --- |
| `S2T_HTTP_MAX_CONCURRENCY` | HTTP admission concurrency; example 1024 |
| `S2T_HTTP_MAX_WAITING` | Admission waiting limit; example 512 |
| `S2T_POSTGRES_POOL_MAX` | Query pool size; example 16, Kubernetes default 8 per worker |
| `S2T_POSTGRES_FENCE_SESSIONS` | Shared fence sessions; example 4, Kubernetes default 4 per worker |
| `S2T_AUDIO_LIGHT_WORKERS` | Persistent light audio subprocesses; example 1 |
| `S2T_AUDIO_HEAVY_WORKERS` | Persistent heavy audio subprocesses; example 1 |
| `S2T_SHUTDOWN_GRACE_SECONDS` | Shutdown drain time; example 660 seconds |
| `S2T_PROCESS_ROLE` | Empty means `all`; optional `api`, `audio-service`, `audio-worker` |
| `S2T_STORAGE_MIGRATIONS` | `verify` after the Kubernetes migration Job completes |
| `S2T_FFMPEG_PATH` | Optional explicit FFmpeg binary path |
| `S2T_WEB_ORIGINS` | Allowed browser origins, comma-separated |

Connection budgets include query pools, shared and exclusive fencing, migrations, and exporters. Budgets are per worker; account for every replica and worker plus one reserved health connection per worker. More admission concurrency does not establish more model throughput. Measure CPU, memory, queueing, storage, and end-to-end latency before raising limits.

See [deployment](DEPLOYMENT.md) and [validation](VALIDATION.md).

## Python processes and connection budgets

`S2T_WEB_WORKERS` selects Uvicorn processes per Pod: development defaults to 1, Kubernetes to 2, with 2 backend Pods. SQL, model HTTP and native audio pools are per process. Multiply their budgets by replicas and worker count. Kubernetes defaults to 8 main SQL connections, at most 5 account-fence connections and one reserved health connection per process: 2 × 2 × 14 = 56 application connections, leaving capacity for monitoring and maintenance.

`S2T_NOFILE` defaults to 8192. Startup raises the soft descriptor limit within the host hard limit, logging a warning if that target is unavailable. Multiprocess Prometheus uses a fresh private temporary directory per service start. Counters and latency histograms merge across workers; active requests sum, shared backlog takes the maximum, and worker CPU/RSS has a `pid` label. Never share this metrics directory between Pods.

`S2T_HTTP_ACTIVE_PER_WORKER` defaults to 64. It bounds active API work before authentication and SQL access, with a maximum ten-second wait and `S2T_HTTP_MAX_WAITING` queued callers per worker. Background HTTP work has a separate four-active-request budget; health probes bypass these queues. This differs from Uvicorn's connection limit. See `deploy/k8s/examples/backend-capacity.env.example` for the test profile and connection budgets including rolling surge Pods.

Known-length ASR chunks up to 256 KiB use bounded memory when normalization is not requested. This avoids temporary files, rereads and thread-pool hops. Actual body size remains bounded. Larger, unknown-length and normalization requests retain file streaming. This transient request optimization does not replace durable OPFS/MinIO recording storage.
