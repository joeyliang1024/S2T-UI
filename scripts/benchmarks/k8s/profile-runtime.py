"""Opt-in sitecustomize for isolated diagnostics; SIGUSR1 profiles 20 seconds."""
import cProfile
import json
import os
from pathlib import Path
import signal

profile = None


def finish(_signal, _frame):
    global profile
    if profile is None:
        return
    profile.disable()
    profile.create_stats()
    rows = sorted(({'function': f'{key[0]}:{key[1]} {key[2]}', 'primitiveCalls': value[0], 'calls': value[1], 'exclusiveSeconds': value[2], 'cumulativeSeconds': value[3]} for key, value in profile.stats.items()), key=lambda row: row['exclusiveSeconds'], reverse=True)
    Path(f'/tmp/s2t-profile-{os.getpid()}.json').write_text(json.dumps(rows[:80], indent=2))
    profile = None


def start(_signal, _frame):
    global profile
    if profile is None:
        profile = cProfile.Profile()
        profile.enable()
        signal.signal(signal.SIGALRM, finish)
        signal.setitimer(signal.ITIMER_REAL, 20)


signal.signal(signal.SIGUSR1, start)
