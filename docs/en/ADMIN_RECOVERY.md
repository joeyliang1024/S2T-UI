# Administrator and data recovery

[繁體中文](../guide/ADMIN_RECOVERY.zh-TW.md) | English

Administrator authority comes from the account role, not NT spelling or Department. Use NT and password to sign in. Account management rejects deletion of the current user or last usable administrator; failed cleanup retains a disabled identity and retry intent.

Configure `S2T_BOOTSTRAP_ADMIN_USERNAME`, `S2T_BOOTSTRAP_ADMIN_PASSWORD` (at least 12 characters) and stable `S2T_AUTH_SECRET` before initialization. The legacy environment variable name still supplies the administrator's NT. Bootstrap is not a password-reset or deleted-user recovery mechanism.

`npm run k8s:up` runs schema migration before rollout. An independent root-directory invocation is `python -m backend.app.migrate` with the intended storage/auth environment already injected. Schema creation does not restore deleted data. Restore PostgreSQL and associated object/vector storage with original user IDs and the original auth secret; do not assign orphaned objects to new identities.

After recovery, verify readiness, admin login, WAV playback and both replicas. Calculate connection budgets per worker and include rolling replicas. See [deployment](DEPLOYMENT.md), [environment](ENVIRONMENT.md) and [NT login](NT_LOGIN.md).
