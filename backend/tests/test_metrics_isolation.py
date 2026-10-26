import threading
import os
import time
from concurrent.futures import ThreadPoolExecutor


def test_slow_metrics_serialization_does_not_block_liveness(client, monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def render(_):
        entered.set()
        assert release.wait(3)
        return b'# slow test metrics\n'

    monkeypatch.setattr('app.metrics.export_metrics', render)
    with ThreadPoolExecutor(2) as executor:
        scrape = executor.submit(client.get, '/metrics')
        try:
            assert entered.wait(2)
            live = executor.submit(client.get, '/livez')
            assert live.result(timeout=1).status_code == 200
        finally:
            release.set()
        assert scrape.result(timeout=2).status_code == 200


def test_metrics_snapshot_is_atomic_and_stale_snapshots_fail_closed(client, monkeypatch, tmp_path):
    snapshot = tmp_path / 'snapshot.prom'
    monkeypatch.setenv('S2T_METRICS_SNAPSHOT', str(snapshot))
    def unexpected_render(_):
        raise AssertionError('API worker must not serialize metrics')
    monkeypatch.setattr('app.metrics.export_metrics', unexpected_render)
    assert client.get('/metrics').status_code == 503
    snapshot.write_bytes(b'# snapshot\nmetric 7\n')
    response = client.get('/metrics')
    assert response.status_code == 200
    assert response.content == b'# snapshot\nmetric 7\n'
    os.utime(snapshot, (time.time() - 60, time.time() - 60))
    assert client.get('/metrics').status_code == 503
    assert client.get('/livez').status_code == 200


def test_supervised_exporter_merges_worker_counters_and_stops(monkeypatch, tmp_path):
    import subprocess
    import sys
    from app.metrics_exporter import MetricsExporter, read_snapshot

    monkeypatch.setenv('PROMETHEUS_MULTIPROC_DIR', str(tmp_path))
    # Import after setting the environment in a separate interpreter, as in Uvicorn.
    subprocess.run([sys.executable, '-c', "from prometheus_client import Counter; Counter('isolated_export_test','test').inc(3)"], check=True)
    exporter = MetricsExporter(tmp_path)
    monkeypatch.setenv('S2T_METRICS_SNAPSHOT', str(exporter.path))
    exporter.start()
    try:
        deadline = time.monotonic() + 10
        while not exporter.path.exists() and time.monotonic() < deadline:
            time.sleep(.05)
        assert b'isolated_export_test_total 3.0' in read_snapshot(exporter.path)
        previous = exporter._child
        previous.kill()
        exporter.path.unlink()
        deadline = time.monotonic() + 10
        while not exporter.path.exists() and time.monotonic() < deadline:
            time.sleep(.05)
        assert exporter._child.pid != previous.pid
        assert b'isolated_export_test_total 3.0' in read_snapshot(exporter.path)
    finally:
        exporter.close()
    assert not exporter.thread.is_alive()


def test_shared_backlog_uses_latest_worker_measurement_not_stale_maximum(client, monkeypatch, tmp_path):
    import subprocess
    import sys
    from app.metrics import export_metrics

    monkeypatch.setenv('PROMETHEUS_MULTIPROC_DIR', str(tmp_path))
    children = []
    try:
        for value in (5, 0):
            mode = client.app.state.runtime.backlog._multiprocess_mode
            code = f"from prometheus_client import Gauge; import time; Gauge('s2t_diarization_pending_jobs','test',multiprocess_mode={mode!r}).set({value}); print('ready',flush=True); time.sleep(30)"
            child = subprocess.Popen([sys.executable,'-c',code],stdout=subprocess.PIPE,text=True)
            children.append(child)
            assert child.stdout.readline().strip() == 'ready'
        text = export_metrics(client.app.state.runtime.registry).decode()
        assert 's2t_diarization_pending_jobs 0.0' in text
        assert 's2t_diarization_pending_jobs 5.0' not in text
    finally:
        for child in children:
            child.terminate()
            child.wait(timeout=5)
            child.stdout.close()
