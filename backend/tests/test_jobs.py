from conftest import session_value


def test_durable_job_commits_preserving_translation_and_manual_labels(client, admin):
    rt = client.app.state.runtime
    value = session_value("job-audio")
    value.update(
        processingToken="token-one", processingState="running", processingStage="diarization"
    )
    value["segments"][0].update(translatedText="translated")
    manual = {
        **value["segments"][0],
        "id": "manual",
        "speaker": "manual-name",
        "speakerManuallyEdited": True,
    }
    value["segments"].append(manual)
    assert client.post("/api/data/audio/job-audio", content=b"mock-audio").status_code == 201
    assert (
        client.post("/api/data/sessions", json={"sessions": [value], "version": 0}).status_code
        == 200
    )
    result = client.post(
        "/api/data/diarization-jobs",
        json={"sessionId": value["id"], "audioKey": "job-audio", "processingToken": "token-one"},
    )
    job_id = result.json()["job"]["id"]
    calls = []

    async def diarize(filename, *args, **kwargs):
        calls.append(filename)
        return {"exclusive_diarization": [{"start": 0, "end": 1, "speaker": "speaker_0"}]}

    rt.models.diarize = diarize
    job = client.portal.call(rt.jobs.claim)
    client.portal.call(rt.jobs.execute, job)
    current = client.get("/api/data/sessions").json()
    assert current["version"] == 2
    segments = current["sessions"][0]["segments"]
    assert segments[0]["speaker"] == "speaker_0" and segments[0]["translatedText"] == "translated"
    assert segments[1]["speaker"] == "manual-name"
    assert (
        client.get("/api/data/diarization-jobs?id=" + job_id).json()["job"]["state"] == "completed"
    )
    assert len(calls) == 1


def test_job_waits_until_tail_is_saved(client, admin):
    value = session_value("job-audio")
    value.update(processingToken="token-one", processingState="running", processingStage="asr")
    client.post("/api/data/sessions", json={"sessions": [value], "version": 0})
    result = client.post(
        "/api/data/diarization-jobs",
        json={"sessionId": value["id"], "audioKey": "job-audio", "processingToken": "token-one"},
    )
    job_id = result.json()["job"]["id"]
    rt = client.app.state.runtime
    job = client.portal.call(rt.jobs.claim)
    client.portal.call(rt.jobs.execute, job)
    assert client.get("/api/data/diarization-jobs?id=" + job_id).json()["job"]["state"] == "queued"
    assert client.get("/api/data/sessions").json()["version"] == 1
