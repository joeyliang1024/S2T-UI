#!/bin/sh
for i in $(seq 1 100); do
 date -u '+%Y-%m-%dT%H:%M:%SZ'
 kubectl --context colima-s2t-stress top nodes
 kubectl --context colima-s2t-stress -n s2t-stress-20261005 top pods
 sleep 10
done
