#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAME=$1
CTX=colima-s2t-stress
NS=s2t-stress-20261005
kubectl --context "$CTX" -n "$NS" exec load-client -- node -e 'fetch("http://mock-models:9090/stats").then(r=>r.text()).then(console.log)' > "$ROOT/results/$NAME-mock-before.json"
kubectl --context "$CTX" -n "$NS" get pods -l app=gateway -o json > "$ROOT/results/$NAME-pods-before.json"
kubectl --context "$CTX" -n "$NS" exec load-client -- node /tmp/load-test.cjs load "$NAME" 100 90 1500 > "$ROOT/results/$NAME.json" &
phase_pid=$!
trap 'kill "$phase_pid" 2>/dev/null || true' EXIT
sh "$ROOT/failover.sh" > "$ROOT/results/$NAME-failover.log" 2>&1
wait "$phase_pid"
trap - EXIT
kubectl --context "$CTX" -n "$NS" exec load-client -- node -e 'fetch("http://mock-models:9090/stats").then(r=>r.text()).then(console.log)' > "$ROOT/results/$NAME-mock-after.json"
kubectl --context "$CTX" -n "$NS" get pods -l app=gateway -o json > "$ROOT/results/$NAME-pods-after.json"
kubectl --context "$CTX" -n "$NS" logs -l app=gateway --prefix --since=3m --tail=300 > "$ROOT/logs/$NAME-gateway.log"
