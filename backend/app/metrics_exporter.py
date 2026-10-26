"""One supervised metrics serializer per server, outside API workers' GIL."""

import logging
import os
from pathlib import Path
import subprocess
import sys
import threading
import time


class MetricsExporter:
    def __init__(self, directory):
        self.path = Path(directory) / "snapshot.prom"
        self.stopped = threading.Event()
        self._child = None
        self.thread = threading.Thread(target=self._supervise, daemon=True)

    def start(self):
        os.environ["S2T_METRICS_SNAPSHOT"] = str(self.path)
        self.thread.start()

    def _supervise(self):
        while not self.stopped.is_set():
            try:
                child = subprocess.Popen([sys.executable, "-m", "app.metrics_exporter"])
            except OSError:
                logging.getLogger(__name__).exception("Cannot start metrics exporter")
                self.stopped.wait(1)
                continue
            self._child = child
            try:
                while child.poll() is None and not self.stopped.wait(0.2):
                    pass
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
            if not self.stopped.is_set():
                logging.getLogger(__name__).warning("Metrics exporter exited; restarting")
                self.stopped.wait(1)

    def close(self):
        self.stopped.set()
        self.thread.join(timeout=10)


def read_snapshot(path, maximum_age=45):
    # Open once so replacement cannot mix the timestamp and a different payload.
    with Path(path).open("rb") as handle:
        if time.time() - os.fstat(handle.fileno()).st_mtime > maximum_age:
            raise TimeoutError("Metrics snapshot is stale")
        return handle.read()


def main():
    from prometheus_client import CollectorRegistry
    from .metrics import export_metrics

    destination = Path(os.environ["S2T_METRICS_SNAPSHOT"])
    temporary = destination.with_suffix(".tmp")
    while True:
        started = time.monotonic()
        try:
            temporary.write_bytes(export_metrics(CollectorRegistry()))
            temporary.replace(destination)
        except Exception:
            logging.getLogger(__name__).exception("Metrics snapshot generation failed")
        # Bound both GIL contention and CPU spent merging per-account series.
        # Scrapers share this snapshot; its maximum expected age is 15 seconds.
        time.sleep(max(1, 15 - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
