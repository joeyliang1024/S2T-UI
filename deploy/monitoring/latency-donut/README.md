# S2T latency donut

Local static Grafana panel, no remote dependencies or network requests. Grafana supplies query results and React. The test deployment allows only the unsigned plugin ID `s2t-latencydonut-panel` and mounts these source files read-only.

Query A contains six overall stage shares for the selected range. Query B contains one first-word histogram percentile in seconds for the same range. P50/P95/P99 panels share the same outer ring; it is not a percentile-specific stage decomposition. Center values render with two decimals and `s`. Missing or non-finite measurements show a dash, not zero seconds.

After changes, run `python3 deploy/monitoring/generate.py`, update the plugin/dashboard ConfigMaps, and restart Grafana when installing the plugin or changing its module. Refresh the browser after dashboard provisioning changes.
