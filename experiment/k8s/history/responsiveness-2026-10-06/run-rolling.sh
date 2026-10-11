#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAME=$1
PODS=$2
SECONDS_TO_RUN=$3
PROFILE=$4
ROLLS=${5:-1}
CTX=colima-s2t-stress
NS=s2t-stress-20261005
kubectl --context "$CTX" -n "$NS" scale deployment/gateway --replicas="$PODS"
kubectl --context "$CTX" -n "$NS" rollout status deployment/gateway --timeout=120s
profile_json=$(cat "$ROOT/profiles/$PROFILE.json")
kubectl --context "$CTX" -n "$NS" exec load-client -- node -e 'fetch("http://mock-models:9090/control",{method:"POST",body:process.argv[1]}).then(r=>r.text()).then(console.log)' "$profile_json" > "$ROOT/results/$NAME-control.json"
kubectl --context "$CTX" -n "$NS" exec load-client -- node -e 'fetch("http://mock-models:9090/stats").then(r=>r.text()).then(console.log)' > "$ROOT/results/$NAME-mock-before.json"
kubectl --context "$CTX" -n "$NS" get pods -l app=gateway -o json > "$ROOT/results/$NAME-pods-before.json"
kubectl --context "$CTX" -n "$NS" exec load-client -- node /tmp/load-test.cjs load "$NAME" 100 "$SECONDS_TO_RUN" 1500 > "$ROOT/results/$NAME.json" &
phase_load_pid=$!
monitor_pid=''
log_pid=''
kubectl --context "$CTX" -n "$NS" logs -l app=gateway --prefix --follow --since=1s --max-log-requests=12 > "$ROOT/logs/$NAME-initial-pods.log" 2>&1 &
log_pid=$!
trap 'kill "$phase_load_pid" ${monitor_pid:-} ${log_pid:-} 2>/dev/null || true' EXIT
(
 while true; do
  date -u '+%Y-%m-%dT%H:%M:%SZ'
  kubectl --context "$CTX" -n "$NS" get pods -l app=gateway -o wide
  sleep 2
 done
) > "$ROOT/results/$NAME-pod-timeline.log" &
monitor_pid=$!
sleep 10
for roll in $(seq 1 "$ROLLS"); do
 date -u '+rollout-start %Y-%m-%dT%H:%M:%SZ'
 kubectl --context "$CTX" -n "$NS" rollout restart deployment/gateway
 kubectl --context "$CTX" -n "$NS" rollout status deployment/gateway --timeout=120s
 date -u '+rollout-end %Y-%m-%dT%H:%M:%SZ'
 [ "$roll" -eq "$ROLLS" ] || sleep 5
done
wait "$phase_load_pid"
kill "$monitor_pid" "$log_pid" 2>/dev/null || true
trap - EXIT
kubectl --context "$CTX" -n "$NS" exec load-client -- node -e 'fetch("http://mock-models:9090/stats").then(r=>r.text()).then(console.log)' > "$ROOT/results/$NAME-mock-after.json"
kubectl --context "$CTX" -n "$NS" get pods -l app=gateway -o json > "$ROOT/results/$NAME-pods-after.json"
kubectl --context "$CTX" -n "$NS" top pods > "$ROOT/results/$NAME-resources.txt"
