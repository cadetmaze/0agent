"""
Core Memory — Read/write expert identity to the core_memory table.

Core memory stores the expert's judgment patterns, hard constraints,
escalation triggers, and confidence map. It is the expert's identity.

IMPORTANT: Only the training service writes to this table.
Agent runtime processes must treat it as read-only.
"""

import json
import hashlib
from datetime import datetime, timezone
from typing import Optional

from ..db.supabase import db


class CoreMemory:
    """Read/write operations for the core_memory table."""

    async def load(self, agent_id: str) -> Optional[dict]:
        """
        Load the latest core memory for an agent.
        Returns None if no core memory exists.
        """
        row = await db.fetch_one(
            """
            SELECT id, agent_id, expert_id, training_version,
                   judgment_json, hard_constraints, escalation_triggers,
                   confidence_map, created_at, locked_at
            FROM core_memory
            WHERE agent_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            """,
            agent_id,
        )

        if row is None:
            return None

        return {
            "id": str(row["id"]),
            "agent_id": str(row["agent_id"]),
            "expert_id": str(row["expert_id"]),
            "training_version": row["training_version"],
            "judgment_json": json.loads(row["judgment_json"])
            if isinstance(row["judgment_json"], str)
            else row["judgment_json"],
            "hard_constraints": json.loads(row["hard_constraints"])
            if isinstance(row["hard_constraints"], str)
            else row["hard_constraints"],
            "escalation_triggers": json.loads(row["escalation_triggers"])
            if isinstance(row["escalation_triggers"], str)
            else row["escalation_triggers"],
            "confidence_map": json.loads(row["confidence_map"])
            if isinstance(row["confidence_map"], str)
            else row["confidence_map"],
            "created_at": row["created_at"].isoformat()
            if row["created_at"]
            else None,
            "locked_at": row["locked_at"].isoformat()
            if row["locked_at"]
            else None,
        }

    async def write(
        self,
        agent_id: str,
        expert_id: str,
        judgment_json: dict,
        hard_constraints: list,
        escalation_triggers: list,
        confidence_map: list,
    ) -> str:
        """
        Write a new core memory record.
        Generates a training version hash from the content.
        Returns the training version hash.
        """
        # Generate training version hash
        content = json.dumps(
            {
                "judgment": judgment_json,
                "constraints": hard_constraints,
                "triggers": escalation_triggers,
                "confidence": confidence_map,
            },
            sort_keys=True,
        )
        version_hash = hashlib.sha256(content.encode()).hexdigest()[:16]

        now = datetime.now(timezone.utc)

        await db.execute(
            """
            INSERT INTO core_memory (
                agent_id, expert_id, training_version,
                judgment_json, hard_constraints, escalation_triggers,
                confidence_map, created_at, locked_at
            ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
            """,
            agent_id,
            expert_id,
            version_hash,
            json.dumps(judgment_json),
            json.dumps(hard_constraints),
            json.dumps(escalation_triggers),
            json.dumps(confidence_map),
            now,
            now,  # locked immediately
        )

        print(
            f"[CoreMemory] Wrote core memory for agent {agent_id}, "
            f"version: {version_hash}"
        )
        return version_hash

    async def get_version(self, agent_id: str) -> Optional[str]:
        """Get the current training version hash for an agent."""
        row = await db.fetch_one(
            """
            SELECT training_version FROM core_memory
            WHERE agent_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            """,
            agent_id,
        )
        return row["training_version"] if row else None
