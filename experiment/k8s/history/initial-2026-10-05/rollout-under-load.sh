#!/bin/sh
set -eu
sleep 10
date -u '+rollout-start %Y-%m-%dT%H:%M:%SZ'
kubectl --context colima-s2t-stress -n s2t-stress-20261005 rollout restart deployment/gateway
kubectl --context colima-s2t-stress -n s2t-stress-20261005 rollout status deployment/gateway --timeout=45s
date -u '+rollout-end %Y-%m-%dT%H:%M:%SZ'
