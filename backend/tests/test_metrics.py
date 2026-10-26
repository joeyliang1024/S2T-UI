from prometheus_client.parser import text_string_to_metric_families


def test_caption_seconds_and_counts_are_preserved(client, admin):
    samples = [
        {"stage": "e2e_asr", "seconds": 1.25},
        {"stage": "e2e_translation_tail", "seconds": 2.5},
        {"stage": "phase_t3", "seconds": 0.8},
    ]
    assert client.post("/api/telemetry/captions", json={"samples": samples}).status_code == 200
    text = client.get("/metrics").text
    values = {
        (s.name, tuple(sorted(s.labels.items()))): s.value
        for family in text_string_to_metric_families(text)
        for s in family.samples
    }
    for stage, seconds in [("e2e_asr", 1.25), ("e2e_translation_tail", 2.5)]:
        labels = tuple(sorted({"stage": stage, "phase": "e2e"}.items()))
        assert values[("s2t_caption_stage_duration_seconds_count", labels)] == 1
        assert values[("s2t_caption_stage_duration_seconds_sum", labels)] == seconds
    labels = tuple(sorted({"stage": "phase_t3", "phase": "t3"}.items()))
    assert values[("s2t_caption_phase_duration_seconds_sum", labels)] == 0.8
    assert 's2t_gateway_request_duration_seconds_count{route="other"}' in text
    assert 's2t_gateway_request_errors_total{route="other"} 0.0' in text
