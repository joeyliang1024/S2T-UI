import time

import httpx
import pytest
from fastapi import HTTPException

from app.audio import Audio
from app.core import Settings


def slow_operation(operation, filename, root, options):
    time.sleep(0.1)
    return {"ok": True}


@pytest.mark.asyncio
async def test_hung_native_pool_is_replaced(environment, monkeypatch):
    import app.audio as module

    monkeypatch.setattr(module, "run", slow_operation)
    settings = Settings({**environment, "S2T_AUDIO_LIGHT_JOB_TIMEOUT_MS": "1"})
    async with httpx.AsyncClient() as client:
        audio = Audio(settings, client)
        try:
            with pytest.raises(HTTPException) as error:
                await audio.invoke("health")
            assert error.value.status_code == 503
            assert "light" not in audio.pools
            settings.env["S2T_AUDIO_LIGHT_JOB_TIMEOUT_MS"] = "5000"
            assert await audio.invoke("health") == {"ok": True}
        finally:
            await audio.close()
