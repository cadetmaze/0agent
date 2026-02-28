"""
Supabase/Postgres client for the Python judgment service.

Uses asyncpg for direct Postgres/pgvector access.
All database operations go through this module.
"""

import os
import asyncpg
from typing import Optional


class Database:
    """Async Postgres database client using asyncpg."""

    def __init__(self, database_url: Optional[str] = None):
        self.database_url = database_url or os.getenv("DATABASE_URL", "")
        self._pool: Optional[asyncpg.Pool] = None

    async def connect(self) -> None:
        """Create a connection pool."""
        if not self.database_url:
            raise ValueError(
                "DATABASE_URL is not set. Provide it via constructor or environment variable."
            )

        self._pool = await asyncpg.create_pool(
            self.database_url,
            min_size=2,
            max_size=10,
            command_timeout=30,
        )
        print("[Database] Connection pool created")

    async def disconnect(self) -> None:
        """Close the connection pool."""
        if self._pool:
            await self._pool.close()
            self._pool = None
            print("[Database] Connection pool closed")

    @property
    def pool(self) -> asyncpg.Pool:
        """Get the connection pool. Raises if not connected."""
        if self._pool is None:
            raise RuntimeError(
                "[Database] Not connected. Call connect() first."
            )
        return self._pool

    async def fetch_one(self, query: str, *args) -> Optional[asyncpg.Record]:
        """Fetch a single row."""
        async with self.pool.acquire() as conn:
            return await conn.fetchrow(query, *args)

    async def fetch_all(self, query: str, *args) -> list[asyncpg.Record]:
        """Fetch all matching rows."""
        async with self.pool.acquire() as conn:
            return await conn.fetch(query, *args)

    async def execute(self, query: str, *args) -> str:
        """Execute a query (INSERT, UPDATE, DELETE)."""
        async with self.pool.acquire() as conn:
            return await conn.execute(query, *args)

    async def health_check(self) -> bool:
        """Verify the database connection is healthy."""
        try:
            row = await self.fetch_one("SELECT 1 AS ok")
            return row is not None and row["ok"] == 1
        except Exception as e:
            print(f"[Database] Health check failed: {e}")
            return False


# Singleton instance — import and use across the service
db = Database()
