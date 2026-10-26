import resource
from app.__main__ import configure_file_limit


def test_descriptor_budget_raises_soft_limit_without_lowering_hard(monkeypatch):
    monkeypatch.setenv('S2T_NOFILE', '8192')
    monkeypatch.setattr(resource, 'getrlimit', lambda _: (1024, 524288))
    calls = []
    monkeypatch.setattr(resource, 'setrlimit', lambda kind, value: calls.append(value))
    configure_file_limit()
    assert calls == [(8192, 524288)]


def test_descriptor_budget_preserves_higher_existing_limit(monkeypatch):
    monkeypatch.setenv('S2T_NOFILE', '8192')
    monkeypatch.setattr(resource, 'getrlimit', lambda _: (65536, 524288))
    monkeypatch.setattr(resource, 'setrlimit', lambda *_: (_ for _ in ()).throw(AssertionError('must not lower limit')))
    configure_file_limit()


def test_descriptor_budget_respects_hard_limit(monkeypatch, caplog):
    monkeypatch.setenv('S2T_NOFILE', '8192')
    monkeypatch.setattr(resource, 'getrlimit', lambda _: (1024, 4096))
    calls = []
    monkeypatch.setattr(resource, 'setrlimit', lambda kind, value: calls.append(value))
    configure_file_limit()
    assert calls == [(4096, 4096)]
    assert 'below requested' in caplog.text
