import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv


def configure_file_limit():
    """Budget descriptors for inbound sockets, model pools and durable storage."""
    try:
        import resource
    except ImportError:  # Windows manages descriptor limits separately.
        return
    requested = int(os.environ.get("S2T_NOFILE", "8192"))
    if not 256 <= requested <= 1048576:
        raise ValueError("S2T_NOFILE must be between 256 and 1048576")
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft == resource.RLIM_INFINITY or soft >= requested:
        return
    target = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
    resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
    if target < requested:
        import logging
        logging.getLogger(__name__).warning("File descriptor hard limit %s is below requested %s", hard, requested)


def main():
    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
    configure_file_limit()
    workers = int(os.environ.get("S2T_WEB_WORKERS", "1"))
    if not 1 <= workers <= 16:
        raise ValueError("S2T_WEB_WORKERS must be between 1 and 16")
    import tempfile
    from .metrics_exporter import MetricsExporter
    metrics_directory = tempfile.TemporaryDirectory(prefix="s2t-metrics-")
    os.environ["PROMETHEUS_MULTIPROC_DIR"] = metrics_directory.name
    exporter = MetricsExporter(metrics_directory.name)
    exporter.start()
    try:
        uvicorn.run(
            "app.main:app_factory",
            factory=True,
            host=os.environ.get("S2T_BIND_HOST", "0.0.0.0"),
            port=int(os.environ.get("BACKEND_PORT", "8787")),
            workers=workers,
            proxy_headers=False,
            timeout_graceful_shutdown=int(os.environ.get("S2T_SHUTDOWN_GRACE_SECONDS", "90")),
            limit_concurrency=int(os.environ.get("S2T_HTTP_MAX_CONCURRENCY", "1024")),
            timeout_keep_alive=15,
        )
    finally:
        exporter.close()
        if metrics_directory:
            metrics_directory.cleanup()


if __name__ == "__main__":
    main()
