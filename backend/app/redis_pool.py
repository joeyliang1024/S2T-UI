"""Bounded Redis checkout without serializing socket readiness across callers."""
from redis.asyncio import BlockingConnectionPool
from redis.asyncio.sentinel import SentinelConnectionPool


class BlockingSentinelConnectionPool(SentinelConnectionPool, BlockingConnectionPool):
    """Retain Sentinel discovery/failover with bounded, parallel connection checks."""
