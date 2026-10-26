"""Run once as a Kubernetes Job before API rollout; no Node tooling needed."""

import asyncio

from dotenv import load_dotenv

from .core import Settings
from .storage import Storage


async def main():
    load_dotenv(override=False)
    settings = Settings()
    settings.env["S2T_STORAGE_MIGRATIONS"] = "apply"
    storage = Storage(settings)
    try:
        await storage.open()
    finally:
        await storage.close()


if __name__ == "__main__":
    asyncio.run(main())
