import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.glossary import CsvGlossary, NO_MATCH, matched_glossary
from app.main import create_app


def test_matching_is_case_sensitive_ordered_and_includes_substrings():
    rows = (("GPU", "graphics"), ("PU", "unit"), ("cpu", "processor"))
    assert matched_glossary("GPU and GPU", rows) == "GPU->graphics\nPU->unit"
    assert matched_glossary("gpu", rows) == NO_MATCH


@pytest.mark.asyncio
async def test_csv_bom_quotes_cache_atomic_reload_and_removal(tmp_path, monkeypatch):
    path = tmp_path / "jargon_en.csv"
    path.write_text(
        '\ufeffjargon,az_jargon_listen,notes\n"a,b","c,d",extra\n,skip,extra\n', encoding="utf-8"
    )
    loader = CsvGlossary(path)
    first = await loader.load_glossary()
    assert first == (("a,b", "c,d"),)
    original = Path.open
    reads = []

    def counted(self, *args, **kwargs):
        reads.append(self)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", counted)
    assert await loader.load_glossary() is first
    assert not reads  # Stat every request, but do not reparse unchanged CSV.
    replacement = tmp_path / "new.csv"
    replacement.write_text("jargon,az_jargon_listen\na,b\n", encoding="utf-8")
    replacement.replace(path)
    assert await loader.load_glossary() == (("a", "b"),)
    path.unlink()
    assert await loader.load_glossary() == ()


@pytest.mark.parametrize(
    "source,target,format", [("zh-TW", "en", "text"), ("en-US", "de", "markdown")]
)
def test_translation_uses_current_csv_and_preserves_account_glossary(
    environment, source, target, format
):
    calls = []
    path = Path(environment["S2T_DATA_DIR"]) / "jargon/jargon_en.csv"
    path.parent.mkdir()
    path.write_text("jargon,az_jargon_listen\nGPU,graphics unit\nCPU,processor\n", encoding="utf-8")
    environment.update(
        S2T_TRANSLATION_ENDPOINT="http://model/v1",
        S2T_TRANSLATION_MODEL="mock",
        S2T_TRANSLATION_API_KEY="secret",
    )

    def upstream(request):
        calls.append(json.loads(request.content)["messages"][0]["content"])
        return httpx.Response(200, json={"choices": [{"message": {"content": "translated"}}]})

    with TestClient(create_app(environment, httpx.MockTransport(upstream))) as client:
        client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        body = dict(
            text="GPU is ready; literal {glossary}",
            sourceLanguage=source,
            targetLanguage=target,
            format=format,
            glossary="account->custom",
        )
        assert client.post("/api/translations", json=body).status_code == 200
        assert "GPU->graphics unit" in calls[-1]
        assert "CPU->processor" not in calls[-1]
        assert "account->custom" in calls[-1]
        assert "literal {glossary}" in calls[-1]  # Never rewrite inserted source text.
        path.write_text("jargon,az_jargon_listen\nGPU,new translation\n", encoding="utf-8")
        assert client.post("/api/translations", json=body).status_code == 200
        assert "GPU->new translation" in calls[-1]
        assert "GPU->graphics unit" not in calls[-1]
        body["text"] = "no matching terms"
        assert client.post("/api/translations", json=body).status_code == 200
        assert NO_MATCH in calls[-1]
        # Old persisted templates still receive terms without being overwritten.
        prompt_file = path.parent.parent / "prompt/prompts.json"
        prompts = json.loads(prompt_file.read_text())
        key = "gatewayTranslationZh" if source.startswith("zh") else "gatewayTranslationEn"
        prompts[key] = "Legacy {{terms}} {{text}}"
        prompt_file.write_text(json.dumps(prompts), encoding="utf-8")
        body["text"] = "GPU"
        assert client.post("/api/translations", json=body).status_code == 200
        assert "GPU->new translation" in calls[-1]
        # Both placeholder syntaxes work, with a single nonrecursive rendering pass.
        prompts[key] = "Custom {glossary} / {{glossary}} / {{text}}"
        prompt_file.write_text(json.dumps(prompts), encoding="utf-8")
        assert client.post("/api/translations", json=body).status_code == 200
        assert calls[-1] == "Custom GPU->new translation / GPU->new translation / GPU"


def test_explicit_csv_path_missing_file_and_invalid_header(environment, tmp_path):
    path = tmp_path / "mounted/jargon_en.csv"
    environment.update(
        S2T_JARGON_FILE=str(path),
        S2T_TRANSLATION_ENDPOINT="http://model/v1",
        S2T_TRANSLATION_MODEL="mock",
        S2T_TRANSLATION_API_KEY="secret",
    )
    calls = []

    def upstream(request):
        calls.append(json.loads(request.content)["messages"][0]["content"])
        return httpx.Response(200, json={"choices": [{"message": {"content": "translated"}}]})

    with TestClient(create_app(environment, httpx.MockTransport(upstream))) as client:
        client.post("/api/auth/login", json={"username": "admin", "password": "admin"})
        assert client.post("/api/translations", json={"text": "GPU"}).status_code == 200
        assert NO_MATCH in calls[-1]
        path.parent.mkdir()
        path.write_text("jargon,wrong_column\nGPU,graphics\n", encoding="utf-8")
        assert client.post("/api/translations", json={"text": "GPU"}).status_code == 503
        assert len(calls) == 1
        path.write_text("jargon,az_jargon_listen\nGPU,graphics\n", encoding="utf-8")
        assert client.post("/api/translations", json={"text": "GPU"}).status_code == 200
        assert "GPU->graphics" in calls[-1]
