# Web and Python architecture

[繁體中文](../reference/ARCHITECTURE.zh-TW.md) | English

The browser runs React. Vite serves development builds; production builds are static assets served by Nginx. Both proxy `/api` to Python, keeping browser requests on the frontend origin.

```mermaid
flowchart LR
  Browser[React browser] --> Front[Nginx: 1 Pod, port 5173]
  Front --> Back[Python: 2 Pods, port 8787]
  Back --> Audio[Persistent audio process pools]
  Back --> Jobs[Durable workers]
  Back --> PG[Shared PostgreSQL]
  Back --> S3[Shared MinIO]
  Back --> Redis[Shared Redis]
  Audio --> Models[Read-only model weights]
  Back --> Remote[External ASR, translation, summary]
```

Each backend Pod runs one Uvicorn process for asynchronous I/O, persistent subprocess pools for native audio work, and a durable background worker. The active deployment runs the `all` role on both Pods. Separate `api`, `audio-service`, and `audio-worker` roles are optional deployment alternatives.

Shared PostgreSQL, MinIO, Redis, and an identical authentication secret let requests move between backend Pods without sticky sessions. Immutable recording chunks, compare-and-swap settings, account fencing, job lease generations, and shared token revocation coordinate concurrent activity.

Frontend code belongs in `frontend/src/`, with contracts and validators in `frontend/shared/`. Backend code belongs in `backend/app/`; default prompts and templates belong in `backend/resources/`. Private runtime data belongs in `data/`, while model weights and native binaries belong in `models/`.

External services provide ASR, translation, and summaries. Local audio processing uses FFmpeg, Silero, Sherpa, and optionally Nemotron. API credentials stay on the backend. Metrics are exposed directly by each Python Pod at `/metrics`.

See [deployment](DEPLOYMENT.md) for operational steps and [validation](VALIDATION.md) for what has actually been tested.
