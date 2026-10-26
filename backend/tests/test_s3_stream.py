import pytest

from app.core import Settings
from app.storage import Storage


@pytest.mark.asyncio
async def test_s3_stream_keeps_wrapper_when_enter_returns_client_response(tmp_path):
    class Body:
        closed = False

        async def __aenter__(self):
            return object()  # aiohttp.ClientResponse has no iter_chunks method

        async def __aexit__(self, *args):
            self.closed = True

        async def iter_chunks(self, chunk_size):
            assert chunk_size == 256 * 1024
            yield b"first"
            yield b"second"

    body = Body()

    class S3:
        async def get_object(self, **kwargs):
            return {"Body": body}

    settings = Settings({"S2T_DATA_DIR": str(tmp_path)})
    settings.s3 = {"BUCKET": "isolated-test"}
    storage = Storage(settings)
    storage.s3 = S3()
    assert await storage.get_blob("test-user", "audio/test") == b"firstsecond"
    assert body.closed
