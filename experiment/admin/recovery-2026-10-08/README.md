# Admin and additive recovery, 2026-10-08

Two isolated Gateway Pods used a disposable `s2t_admin_recovery_test` PostgreSQL database and test-only MinIO/Milvus names. The live s2t database was not cleared. Model APIs were mocks. Setup starts two Pods against an empty database, exercising migration/bootstrap concurrency.

Full schema deletion was reproduced with verify-mode startup failure; a new recovery Job rebuilt schema and a missing bootstrap admin, then both Pods became Ready. The partial-table test independently removed only config records, observed 503 readiness on both Pods, ran the same recovery tool, and verified the existing admin ID/password survived with two Ready Pods.

API tests cover anonymous/user denial, ignored registration role escalation, privileged account creation without changing the admin session, per-account parameter persistence, invalid ranges, and temperature authorization. Browser checks verify the admin-only settings tab and no page errors.

The final feature was rolled into the original two Gateways and two workers. A 100-user, 6,000-chain mock regression passed without failures/drops; original 100-account recording/session integrity passed. Artificial latency stayed disabled. These results do not validate real-model quality or arbitrary multi-node outages.

Validation used a named disposable database and two test Pods; the table deletion was applied only inside the disposable database and recovery was always attempted. Do not point such a deletion at a live database. Test Pods, their service and the disposable database are removed after validation.

Fake-microphone scope validation: the admin's first ASR chunk was 1800 ms while the ordinary account retained 1500 ms, in simultaneous browser sessions. Only the dedicated test database/bucket received those fake recordings.
