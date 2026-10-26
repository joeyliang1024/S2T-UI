"""Opt-in benchmark sitecustomize: SIGUSR2 snapshots await stacks, never arguments."""
import asyncio
import collections
import json
import os
import signal
import time


def snapshot():
    counts = collections.Counter()
    for task in asyncio.all_tasks():
        current, chain, seen = task.get_coro(), [], set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            code = getattr(current, 'cr_code', getattr(current, 'gi_code', None))
            if code:
                chain.append(os.path.basename(code.co_filename) + ':' + code.co_name)
            current = getattr(current, 'cr_await', getattr(current, 'gi_yieldfrom', None))
        counts[' > '.join(chain)] += 1
    with open('/tmp/s2t-tasks-' + str(os.getpid()) + '.json', 'w') as output:
        json.dump({'pid': os.getpid(), 'time': time.time(), 'stacks': counts.most_common(40)}, output)


def trigger(*_):
    try:
        asyncio.get_running_loop().call_soon(snapshot)
    except RuntimeError:
        pass


signal.signal(signal.SIGUSR2, trigger)
