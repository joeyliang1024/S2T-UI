import struct

import httpx
import pytest

from app.audio import Audio
from app.core import Settings
from app.main import create_app


@pytest.mark.asyncio
async def test_large_diarization_options_use_body_not_headers(environment, tmp_path):
    token = "test-internal-audio-token"
    audio_app = create_app(
        {**environment, "S2T_PROCESS_ROLE": "audio-service", "S2T_AUDIO_SERVICE_TOKEN": token}
    )
    async with audio_app.router.lifespan_context(audio_app):

        async def invoke(operation, filename=None, options=None):
            assert operation == "speaker-embeddings"
            assert filename.read_bytes() == b"audio-body"
            return {"turns": len(options["turns"])}

        audio_app.state.runtime.audio.invoke = invoke
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(audio_app), base_url="http://audio"
        ) as client:
            remote = Audio(
                Settings(
                    {
                        **environment,
                        "S2T_AUDIO_SERVICE_URL": "http://audio",
                        "S2T_AUDIO_SERVICE_TOKEN": token,
                    }
                ),
                client,
            )
            source = tmp_path / "input"
            source.write_bytes(b"audio-body")
            turns = [
                {"speaker": "speaker_0", "start": index, "end": index + 1} for index in range(5000)
            ]
            result = await remote.invoke("speaker-embeddings", source, {"turns": turns})
            assert result == {"turns": 5000}
            assert (await client.post("/internal/audio/health")).status_code == 401
            response = await client.post(
                "/internal/audio/vad",
                content=b"S2TA" + struct.pack(">I", 3 * 1024**2),
                headers={"authorization": "Bearer " + token, "x-s2t-audio-protocol": "1"},
            )
            assert response.status_code == 413
