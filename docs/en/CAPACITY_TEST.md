# Backend capacity testing

[繁體中文](../guide/CAPACITY_TEST.zh-TW.md) | English

Functional correctness, model quality and capacity are separate acceptance items. Record image/commit, replicas, workers, CPU/RAM, shared database limits, inference configuration, sample rate, speech ratio and request cadence.

The recorded 500-user/600-second capacity run passed at a three-second cadence with separate 500ms ASR and translation mocks. Two-second cadence failed. Synchronized browser translation P90 was 3.023s and failed the strict under-three-second target. These results are neither 500 physical browsers nor real-model compute capacity. Subsequent UI-only releases have not rerun this capacity benchmark.

[Reproduction](REPRODUCE.md) gives prerequisites, distinct test JWTs, explicit context/namespace, 3000ms cadence, runner start/collect/cleanup and recording integrity checks. The tool defaults to 2000ms, so specify cadence deliberately. Keep tokens private and delete only identities created for the run. Test recording assembly/readback/deletion after production, and report errors before retries, drops and generator timing honestly.

[Measured results](VALIDATION_2026-10-26.md) and [observability](OBSERVABILITY.md) explain limits. Raising HTTP limits or adding Pods does not prove more throughput.
