# S2T UI

[繁體中文](README.md) | English

Real-time speech transcription, translation, recording, and summaries for the web. React frontend, Python backend, and Nginx for production frontend hosting.

## Development

Use Node.js 22+ and Python 3.12. Run commands from the repository root:

```sh
python3.12 -m venv .venv
.venv/bin/pip install --require-hashes -r backend/requirements-audio.lock
.venv/bin/pip install -r backend/requirements-integration.txt
npm ci --ignore-scripts
cp frontend/.env.example frontend/.env
cp backend/.env.example backend/.env
npm run dev
```

Create environment files only when they do not exist; preserve existing credentials. On Windows, use `.venv\Scripts\python.exe -m pip` instead of `.venv/bin/pip`. Install FFmpeg or set `S2T_FFMPEG_PATH`.

Configure `S2T_BOOTSTRAP_ADMIN_USERNAME` and `S2T_BOOTSTRAP_ADMIN_PASSWORD` in `backend/.env` before the first start. The password must contain at least 12 characters. Development environments may explicitly enable `S2T_ALLOW_DEFAULT_ADMIN=true`.

- Frontend: [localhost:5173](http://127.0.0.1:5173), using `FRONTEND_PORT` from `frontend/.env`.
- Backend: [localhost:8787](http://127.0.0.1:8787), using `BACKEND_PORT` from `backend/.env`.
- `npm run dev` starts both processes; Ctrl+C stops both. A process failure stops the other process.
- `npm run dev:frontend` and `npm run dev:backend` start each side separately.
- Vite proxies `/api` to `S2T_DEV_API_URL`. Update that URL when changing the backend port. Never put backend credentials in frontend environment files.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `frontend/src/` | React UI and browser audio capture |
| `frontend/shared/` | Frontend contracts and validators |
| `backend/app/` | Python API, audio processing, storage, jobs, metrics |
| `backend/resources/` | Built-in prompts and summary templates |
| `backend/tests/` | Python tests |
| `data/` | Private local settings, accounts, recordings, secrets |
| `models/` | Model weights and native runtimes |
| `deploy/docker/` | Dockerfiles |
| `deploy/compose/` | Compose application and optional overlays |
| `deploy/k8s/` | One frontend Pod and two backend Pods |
| `deploy/monitoring/` | Prometheus and Grafana configuration |

Runtime data, model weights, and private environment files are excluded from Git and application images. Node is used for frontend tooling and tests; the application backend runs Python.

## Containers and Kubernetes

```sh
npm run docker:up
npm run docker:down
```

Compose starts both services and loads their ports from separate environment files. Build registry settings belong in `deploy/compose/.env`.

For Kubernetes, prepare shared PostgreSQL, MinIO, Redis, and authentication settings in `backend/.env.k8s`. Set the namespace, context, images, and cluster DNS in `deploy/k8s/.env`, then run:

```sh
npm run k8s:up
npm run k8s:forward
```

Images must already be available to the cluster. Deployment runs the migration Job before rolling out one Nginx frontend and two complete Python backends. See [deployment](docs/en/DEPLOYMENT.md).

## Validation

```sh
npm run check
npm run test:backend
npm run test:e2e
npm run test:dev
```

Playwright automatically falls back to local Chrome, Edge, or Chromium when its bundled browser is unavailable. You can set `S2T_BROWSER_EXECUTABLE` explicitly. Deployment tests use disposable test accounts and must run in an isolated environment.

See the [English documentation](docs/en/README.md), [validation guide](docs/en/VALIDATION.md), and [latest measured results and capacity limits](docs/en/VALIDATION_2026-10-26.md). External model integration has been tested with mocks; this does not establish real-model accuracy or production capacity.

[Recording reliability and slow uploads](docs/en/RECORDING_RELIABILITY.md).

## License

[PolyForm Noncommercial](LICENSE).

Sign-in and user management use NT as the single visible identifier; see [NT login](docs/en/NT_LOGIN.md).
