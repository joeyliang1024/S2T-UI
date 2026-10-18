# Current two-Pod verification, 2026-10-07

Gateway, audio-worker and ingress each have two replicas. Readiness and restarts were inspected; no current Warning events were found. A 100-user, 90-second fixed-arrival test sent 6,000 ASR + translation chains through the two-Pod nginx ingress while Gateway rolled. No client or ingress retries mask failures.

All 6,000 chains succeeded without dropped arrivals. Every observed sample retained at least two Ready Pods per required deployment. Rollout progress is present in the Pod/deployment timeline. The original 100 accounts passed recording/session integrity verification after the rollout.

Model APIs were mock services. Artificial latency stayed disabled as requested for the interactive site; previous injected-latency experiments are separate historical evidence. This run does not establish real-model translation quality, arbitrary storage outage tolerance, or multi-node availability. Storage remains real and isolated on one physical node.
