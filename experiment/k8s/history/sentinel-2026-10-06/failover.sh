#!/bin/sh
set -eu
CTX=colima-s2t-stress
NS=s2t-stress-20261005
master() { kubectl --context "$CTX" -n "$NS" exec sentinel-0 -- sh -c 'redis-cli -p 26379 -a "$SENTINEL_PASSWORD" --no-auth-warning --raw SENTINEL get-master-addr-by-name s2t-stress-master' | head -n 1; }
old=$(master)
pod=$(kubectl --context "$CTX" -n "$NS" get pods -l app=redis -o json | python3 -c 'import json,sys;ip=sys.argv[1];print(next(p["metadata"]["name"] for p in json.load(sys.stdin)["items"] if p["status"]["podIP"]==ip or ip.split(".")[0]==p["metadata"]["name"]))' "$old")
kubectl --context "$CTX" -n "$NS" exec "$pod" -- sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning SET stress:durable-probe present; redis-cli -a "$REDIS_PASSWORD" --no-auth-warning WAIT 2 3000'
sleep 10
date -u '+fault-start %Y-%m-%dT%H:%M:%SZ'
start=$(date +%s)
echo "stopping master $pod $old"
container=$(docker --context colima-s2t-stress ps --filter "name=k8s_redis_${pod}_${NS}_" --format '{{.ID}}')
[ -n "$container" ]
docker --context colima-s2t-stress pause "$container"
trap 'docker --context colima-s2t-stress unpause "$container" >/dev/null 2>&1 || true' EXIT
promoted=false
for i in $(seq 1 30); do
 new=$(master)
 if [ "$new" != "$old" ]; then
  elapsed=$(($(date +%s)-start))
  promoted=true
  echo "promoted $new elapsedSeconds=$elapsed"
  kubectl --context "$CTX" -n "$NS" exec sentinel-0 -- sh -c 'redis-cli -h "$1" -a "$REDIS_PASSWORD" --no-auth-warning GET stress:durable-probe' sh "$new"
  break
 fi
 sleep 1
done
# Resume the real cgroup freeze; the promoted replica remains primary.
docker --context colima-s2t-stress unpause "$container" || true
sleep 5
kubectl --context "$CTX" -n "$NS" exec sentinel-0 -- sh -c 'redis-cli -p 26379 -a "$SENTINEL_PASSWORD" --no-auth-warning SENTINEL CKQUORUM s2t-stress-master'
date -u '+fault-end %Y-%m-%dT%H:%M:%SZ'
[ "$promoted" = true ]
