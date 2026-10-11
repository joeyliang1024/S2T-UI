#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CTX=colima-s2t-stress
NS=s2t-stress-20261005
kubectl --context "$CTX" -n "$NS" cp "$ROOT/check-outage.cjs" load-client:/tmp/check-outage.cjs
pod_ip=$(kubectl --context "$CTX" -n "$NS" get pods -l app=gateway -o jsonpath='{.items[0].status.podIP}')
containers=$(docker --context "$CTX" ps --filter "name=k8s_redis_redis-" --format '{{.ID}}')
[ "$(printf '%s\n' "$containers" | wc -l | tr -d ' ')" = 3 ]
trap 'for c in $containers; do docker --context "$CTX" unpause "$c" >/dev/null 2>&1 || true; done' EXIT
for c in $containers; do docker --context "$CTX" pause "$c"; done
kubectl --context "$CTX" -n "$NS" exec load-client -- node /tmp/check-outage.cjs "$pod_ip" > "$ROOT/results/total-redis-outage.json"
