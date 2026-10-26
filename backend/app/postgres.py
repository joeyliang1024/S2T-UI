"""Bound every libpq wire wait, including COMMIT and dead TCP connections."""

import asyncio

import anyio
from psycopg import AsyncConnection, OperationalError


class BoundedConnection(AsyncConnection):
    wire_timeout = 6.0

    async def wait(self, generator, interval=0.1):
        task = asyncio.create_task(super().wait(generator, interval=interval))
        try:
            completed, _ = await asyncio.wait({task}, timeout=self.wire_timeout)
            if not completed:
                # Closing libpq first avoids an extra network cancellation wait
                # against the same blackholed host. The pool discards this socket.
                await self.close()
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise OperationalError("PostgreSQL query deadline exceeded")
            return task.result()
        except BaseException:
            if not task.done():
                with anyio.CancelScope(shield=True):
                    await self.close()
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            raise
