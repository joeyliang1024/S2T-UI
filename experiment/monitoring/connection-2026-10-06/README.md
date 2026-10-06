# Prometheus environment connection validation

`configure-connection.py` changes only Grafana datasource configuration and its environment binding. It does not change database users, MinIO authentication, NetworkPolicy or application replicas.

Changing `PROMETHEUS_URL` to the equivalent cluster DNS URL restarted Grafana and persisted that exact datasource URL. An actual `up` query through Grafana succeeded with 23 targets; see [result.json](result.json). The original service URL was restored afterward.

URL validation runs before cluster mutations. The exported variable takes precedence over dotenv; malformed ports, embedded credentials, fragments and whitespace are rejected.
