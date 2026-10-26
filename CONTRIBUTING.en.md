# Contributing

[繁體中文](CONTRIBUTING.md) | English

Follow the [English quick start](README.en.md) to install Node.js 22+, Python 3.12, locked Python audio dependencies, npm dependencies, and FFmpeg. Run commands from the repository root.

Frontend changes belong in `frontend/src/` and `frontend/shared/`. Python application changes belong in `backend/app/`, with tests in `backend/tests/`. Keep built-in prompts/templates in `backend/resources/`, runtime data in `data/`, and weights/native binaries in `models/`.

Use `npm run dev` to start both services. Keep ports and configuration in separate environment files; never expose backend secrets in frontend configuration. Maintain `.env.example` alongside configuration changes without adding real credentials.

Run checks appropriate to the change:

```sh
npm run check
npm run test:backend
npm run test:e2e
npm run test:dev
```

Deployment and monitoring tests require an isolated localhost environment and explicit `S2T_ALLOW_DEPLOYMENT_TESTS=true`. See [validation](docs/en/VALIDATION.md).

Keep network I/O asynchronous, use persistent audio processes for CPU/native work, and store cross-Pod state in shared storage. Test failure recovery and account boundaries when changing storage or background jobs.

Update Traditional Chinese and English documentation together for changes to setup, commands, environment variables, deployment, or validation scope. Dated evidence must state the tested environment and distinguish mocked integration from real model quality and capacity.

The Kubernetes base defaults to two Uvicorn workers per Pod, each budgeting 8 query + 4 shared-fence + 1 exclusive-fence + 1 health connection (56 across two Pods). Include rolling surge and maintenance. The measured capacity profile differs; see [environment](docs/en/ENVIRONMENT.md). Curated results and reproduction instructions are versioned; raw experiment/evidence directories are local-only.
