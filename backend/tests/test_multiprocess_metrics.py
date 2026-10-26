import os
import subprocess
import sys

from app.metrics import export_metrics
from prometheus_client import CollectorRegistry


def test_all_workers_are_scraped_and_dead_gauges_do_not_stick(tmp_path, monkeypatch):
    env = {**os.environ, 'PROMETHEUS_MULTIPROC_DIR': str(tmp_path)}
    code = '''import sys,time
from prometheus_client import Counter,Gauge
Counter('probe_requests_total','requests').inc(int(sys.argv[1]))
Gauge('probe_inflight','active',multiprocess_mode='livesum').set(int(sys.argv[2]))
Gauge('probe_backlog','shared backlog',multiprocess_mode='livemax').set(4)
print('ready',flush=True)
time.sleep(60)
'''
    workers = [subprocess.Popen([sys.executable, '-c', code, str(n), str(i)], env=env, stdout=subprocess.PIPE, text=True) for n, i in [(3, 1), (5, 2)]]
    try:
        for worker in workers:
            assert worker.stdout.readline().strip() == 'ready'
        monkeypatch.setenv('PROMETHEUS_MULTIPROC_DIR', str(tmp_path))
        text = export_metrics(CollectorRegistry()).decode()
        assert 'probe_requests_total 8.0' in text
        assert 'probe_inflight 3.0' in text
        assert 'probe_backlog 4.0' in text
        if sys.platform.startswith('linux'):
            for worker in workers:
                assert f'pid="{worker.pid}"' in text
        workers[0].terminate()
        workers[0].wait(timeout=5)
        text = export_metrics(CollectorRegistry()).decode()
        assert 'probe_requests_total 8.0' in text
        assert 'probe_inflight 2.0' in text
        assert f'pid="{workers[0].pid}"' not in text
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.terminate()
            worker.wait(timeout=5)
