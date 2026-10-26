"""Per-process runtime metrics, sampled using the event loop's monotonic clock."""

import asyncio
import os
from pathlib import Path
from collections import deque

from prometheus_client import Gauge, ProcessCollector, CollectorRegistry, generate_latest

def export_metrics(registry):
    directory = os.environ.get("PROMETHEUS_MULTIPROC_DIR")
    if not directory:
        return generate_latest(registry)
    from prometheus_client import multiprocess
    pids = {int(file.stem.rsplit("_", 1)[1]) for file in Path(directory).glob("*.db")}
    alive = []
    for pid in pids:
        try:
            os.kill(pid, 0)
            if Path("/proc").is_dir():
                stat = Path(f"/proc/{pid}/stat").read_text()
                if stat.rsplit(")", 1)[1].split()[0] == "Z":
                    raise ProcessLookupError()
            alive.append(pid)
        except (ProcessLookupError, FileNotFoundError):
            multiprocess.mark_process_dead(pid, path=directory)
    class WorkerProcesses:
        def collect(self):
            families = {}
            for pid in alive:
                for metric in ProcessCollector(namespace="s2t", pid=lambda pid=pid: pid, registry=None).collect():
                    samples = [sample._replace(labels={**sample.labels, "pid": str(pid)}) for sample in metric.samples]
                    if metric.name in families:
                        families[metric.name].samples.extend(samples)
                    else:
                        metric.samples = samples
                        families[metric.name] = metric
            yield from families.values()
    merged = CollectorRegistry()
    multiprocess.MultiProcessCollector(merged, path=directory)
    merged.register(WorkerProcesses())
    return generate_latest(merged)



def configure_metrics(registry):
    ProcessCollector(namespace="s2t", registry=registry)
    lag = Gauge(
        "s2t_event_loop_p99_seconds",
        "P99 scheduler lag over the last 60 seconds",
        registry=registry,
        multiprocess_mode="livemax",
    )

    async def sample():
        loop = asyncio.get_running_loop()
        samples = deque(maxlen=600)
        while True:
            deadline = loop.time() + 0.1
            await asyncio.sleep(0.1)
            samples.append(max(0, loop.time() - deadline))
            values = sorted(samples)
            lag.set(values[min(len(values) - 1, int(len(values) * 0.99))])

    return sample
