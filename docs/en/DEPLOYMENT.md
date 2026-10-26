# Development, Docker, and Kubernetes

[繁體中文](../guide/DEPLOYMENT.zh-TW.md) | English

## Local development

Follow the [quick start](../../README.en.md) to install dependencies and create separate frontend/backend environment files. Then run:

```sh
npm run dev
```

The frontend defaults to 5173 and Python defaults to 8787. Both ports load from their component environment files. `npm run build` writes frontend assets to `out/web`; `npm run preview` previews the build. Production hosting uses Nginx.

## Docker images

Build from the repository root. Replace the registry and version placeholders before running these commands:

```sh
docker build -f deploy/docker/frontend.Dockerfile -t <registry>/s2t-frontend:<version> .
docker build -f deploy/docker/backend.Dockerfile --target audio -t <registry>/s2t-backend:<version> .
```

The frontend final image runs Nginx. The Python backend `audio` target includes native audio dependencies and FFmpeg. The smaller `api` target is for optional split-role deployments and does not provide the full local audio runtime. See [models](MODELS.md) for the optional CUDA image.

Push both images using your registry's existing authentication. Configure immutable tags in Kubernetes, and verify each target architecture independently. Local ARM64 verification does not establish compatibility on every architecture.

## Docker Compose

```sh
npm run docker:up
npm run docker:down
```

`deploy/compose/compose.yaml` starts Nginx and the complete Python backend together. It reads separate frontend/backend environment files. Registry settings belong in `deploy/compose/.env`.

Mount `data/` read/write with permissions for container UID 10001; mount `models/` read-only. Private environment files, recordings, and weights stay outside application images. Optional overlays are `deploy/compose/storage.yaml` and `deploy/compose/gpu.yaml`.

The wrapper sets the repository as the project directory. Manual Compose commands must do the same:

```sh
docker compose --project-directory . -f deploy/compose/compose.yaml config
```

Do not share rendered configuration containing secrets.

## Kubernetes: one frontend and two backends

1. Prepare shared PostgreSQL, MinIO, Redis, and an identical authentication secret. Put connection settings in private `backend/.env.k8s`.
2. Configure `deploy/k8s/.env` using its example: namespace, context, `FRONTEND_IMAGE`, `BACKEND_IMAGE`, and `K8S_DNS_RESOLVER`.
3. Push images to an accessible registry, or load them into every eligible local node. Provide the `s2t-models` PVC. An explicit `K8S_MODEL_HOST_PATH` is available for a local single-node cluster.
4. Run deployment and local forwarding:

```sh
npm run k8s:up
npm run k8s:forward
```

The deployment script renders configuration and secrets, runs a migration Job, waits for completion, and then rolls out one frontend and two complete Python backends. The active base is `deploy/k8s/web.json`. Separate-role and HPA resources under `deploy/k8s/examples/` are optional examples and are not active.

Frontend and backend container/Service ports come from their component environment variables. Nginx uses the backend's fully qualified Service DNS name. Set `K8S_DNS_RESOLVER` to the real cluster DNS IP. Streaming buffering is disabled; POST requests are not automatically replayed.

`/livez` reports process liveness; `/readyz` checks required storage dependencies. Shutdown includes draining. Use `ingress.example.yaml` as a starting point for a separately configured ingress controller, domain, and TLS.

`npm run k8s:down` removes application workloads and Services while preserving storage, secrets, and monitoring. Port forwarding reconnects after Pod replacement; production access requires an ingress or equivalent routing.

## Backup and recovery

Back up PostgreSQL, recording objects, vector storage when used, private settings, and the original authentication secret. Local mode requires the complete `data/` directory. Preserve account IDs when restoring associated objects.

Migration recreates schema, not deleted user data. The independent Python migration entry point is `python -m backend.app.migrate`; inject the intended storage and authentication environment before invoking it. Kubernetes normally handles this through the deployment Job. Revalidate readiness, login, recording playback, and both replicas after recovery.

Browser storage may contain unsaved recordings. Do not clear site data as a workaround for slow recording writes.
