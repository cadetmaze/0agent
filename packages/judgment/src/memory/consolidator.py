"""
Consolidator — Nightly dream event.

In production, this runs as a scheduled job that:
1. Reviews the day's episodic memories
2. Identifies patterns and themes
3. Consolidates related memories
4. Detects behavioral drift against core memory
5. Prunes low-relevance memories
6. Generates a morning note for the company
"""

from datetime import datetime, timezone, timedelta
from ..db.supabase import db


class Consolidator:
    """Nightly memory consolidation (dream event)."""

    async def run_consolidation(self, agent_id: str) -> dict:
        """
        Run the nightly consolidation process for an agent.

        TODO: Implement the full consolidation pipeline:
        1. Fetch all episodic memories from the last 24 hours
        2. Cluster them by topic using semantic similarity
        3. Generate summary embeddings for each cluster
        4. Check for judgment drift against core memory
        5. Write consolidated memories
        6. Archive or prune low-relevance old memories

        Returns a summary of what was consolidated.
        """
        print(f"[Consolidator] Running consolidation for agent {agent_id}")

        # Fetch recent episodic memories
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)

        rows = await db.fetch_all(
            """
            SELECT id, session_id, summary, outcome, sentiment, created_at
            FROM episodic_memory
            WHERE agent_id = $1 AND created_at >= $2
            ORDER BY created_at DESC
            """,
            agent_id,
            yesterday,
        )

        episode_count = len(rows)

        if episode_count == 0:
            print(f"[Consolidator] No recent episodes for agent {agent_id}")
            return {
                "agent_id": agent_id,
                "episodes_reviewed": 0,
                "patterns_found": 0,
                "drift_detected": False,
                "memories_pruned": 0,
                "episodes": [],
            }

        # Extract episode data for morning note generation
        episodes = [
            {
                "summary": row.get("summary", ""),
                "outcome": row.get("outcome", ""),
                "sentiment": row.get("sentiment", 0.0),
            }
            for row in rows
        ]

        # TODO: Implement actual consolidation logic:
        # - Semantic clustering of episodes
        # - Pattern extraction across clusters
        # - Drift detection against core memory
        # - Memory pruning based on relevance decay

        print(
            f"[Consolidator] Reviewed {episode_count} episodes for agent {agent_id}"
        )

        return {
            "agent_id": agent_id,
            "episodes_reviewed": episode_count,
            "patterns_found": 0,  # TODO: implement
            "drift_detected": False,  # TODO: implement drift detection
            "memories_pruned": 0,  # TODO: implement pruning
            "episodes": episodes,
        }

    async def detect_drift(self, agent_id: str) -> dict:
        """
        Detect if the agent's behavior has drifted from its trained judgment.

        Compares recent behavior against the trained baseline:
        - Escalation frequency vs baseline
        - Confidence distribution vs trained distribution
        - Task outcome patterns vs expected outcomes

        Returns drift metrics.
        """
        # Fetch recent telemetry to compare against baseline
        one_week_ago = datetime.now(timezone.utc) - timedelta(days=7)

        escalation_rows = await db.fetch_all(
            """
            SELECT COUNT(*) as count
            FROM telemetry_events
            WHERE agent_id = $1
              AND event_type = 'escalation'
              AND created_at >= $2
            """,
            agent_id,
            one_week_ago,
        )

        task_rows = await db.fetch_all(
            """
            SELECT COUNT(*) as count
            FROM telemetry_events
            WHERE agent_id = $1
              AND event_type = 'task_completed'
              AND created_at >= $2
            """,
            agent_id,
            one_week_ago,
        )

        escalation_count = (
            escalation_rows[0].get("count", 0) if escalation_rows else 0
        )
        task_count = task_rows[0].get("count", 0) if task_rows else 0

        # Calculate escalation rate
        escalation_rate = (
            escalation_count / task_count if task_count > 0 else 0.0
        )

        # TODO: Compare against trained baseline escalation rate
        # For now, flag drift if escalation rate exceeds 30%
        drift_threshold = 0.30
        drift_detected = escalation_rate > drift_threshold
        drift_score = min(1.0, escalation_rate / drift_threshold) if drift_threshold > 0 else 0.0

        return {
            "agent_id": agent_id,
            "drift_score": round(drift_score, 3),
            "drift_detected": drift_detected,
            "escalation_rate": round(escalation_rate, 3),
            "escalation_count": escalation_count,
            "task_count": task_count,
            "details": (
                f"Escalation rate: {escalation_rate:.1%} "
                f"({'DRIFT DETECTED' if drift_detected else 'within normal range'})"
            ),
        }

    async def generate_morning_note(
        self,
        agent_id: str,
        consolidation_result: dict,
        drift_result: dict,
    ) -> str:
        """
        Generate a one-paragraph morning note summarizing the nightly
        consolidation results.

        This note is presented to the company each morning — a quick
        synthesis of what the agent processed, any drift detected,
        and what's on the agenda today.
        """
        episodes_reviewed = consolidation_result.get("episodes_reviewed", 0)
        patterns_found = consolidation_result.get("patterns_found", 0)
        drift_detected = drift_result.get("drift_detected", False)
        drift_score = drift_result.get("drift_score", 0.0)
        escalation_rate = drift_result.get("escalation_rate", 0.0)
        episodes = consolidation_result.get("episodes", [])

        if episodes_reviewed == 0:
            return (
                f"Good morning. Agent {agent_id} had a quiet day yesterday — "
                "no tasks were processed. Ready for today's assignments."
            )

        # Summarize episode themes
        positive = sum(1 for ep in episodes if ep.get("sentiment", 0) > 0.5)
        negative = sum(1 for ep in episodes if ep.get("sentiment", 0) < -0.2)
        neutral = episodes_reviewed - positive - negative

        # Build the morning note
        parts = [
            f"Good morning. Yesterday I processed {episodes_reviewed} sessions",
        ]

        if positive > 0 or negative > 0:
            sentiment_parts = []
            if positive > 0:
                sentiment_parts.append(f"{positive} positive")
            if negative > 0:
                sentiment_parts.append(f"{negative} challenging")
            if neutral > 0:
                sentiment_parts.append(f"{neutral} routine")
            parts.append(f" ({', '.join(sentiment_parts)})")

        parts.append(".")

        if patterns_found > 0:
            parts.append(
                f" I identified {patterns_found} recurring patterns worth noting."
            )

        if drift_detected:
            parts.append(
                f" ⚠️ Behavioral drift detected (score: {drift_score:.2f}, "
                f"escalation rate: {escalation_rate:.1%}). "
                "I recommend reviewing my recent decisions."
            )
        else:
            parts.append(" All systems operating within trained parameters.")

        return "".join(parts)

