#!/bin/sh
set -eu
NS=s2t-stress-20261005
CTX=colima-s2t-stress
for i in 0 1 2; do
 kubectl --context "$CTX" -n "$NS" exec redis-$i -- sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning CONFIG SET replica-announce-ip "$HOSTNAME.redis.s2t-stress-20261005.svc.cluster.local"'
done
kubectl --context "$CTX" -n "$NS" exec redis-1 -- sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning REPLICAOF NO ONE'
for i in 0 2; do
 kubectl --context "$CTX" -n "$NS" exec redis-$i -- sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning REPLICAOF redis-1.redis.s2t-stress-20261005.svc.cluster.local 6379'
done
for i in 0 1 2; do
 kubectl --context "$CTX" -n "$NS" exec sentinel-$i -- sh -c '
 redis-cli -p 26379 -a "$SENTINEL_PASSWORD" --no-auth-warning SENTINEL CONFIG SET announce-hostnames yes
 redis-cli -p 26379 -a "$SENTINEL_PASSWORD" --no-auth-warning SENTINEL CONFIG SET announce-ip "$HOSTNAME.sentinel.s2t-stress-20261005.svc.cluster.local"
 redis-cli -p 26379 -a "$SENTINEL_PASSWORD" --no-auth-warning SENTINEL REMOVE s2t-stress-master
 redis-cli -p 26379 -a "$SENTINEL_PASSWORD" --no-auth-warning SENTINEL MONITOR s2t-stress-master redis-1.redis.s2t-stress-20261005.svc.cluster.local 6379 2
 redis-cli -p 26379 -a "$SENTINEL_PASSWORD" --no-auth-warning SENTINEL SET s2t-stress-master auth-pass "$REDIS_PASSWORD" down-after-milliseconds 2000 failover-timeout 15000 parallel-syncs 1
 '
done
