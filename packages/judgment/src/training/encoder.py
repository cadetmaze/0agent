"""
Judgment Encoder — Writes extracted judgment to Core Memory.

Takes the output of the JudgmentExtractor and writes it to the
core_memory table. Handles merging with existing judgments
from previous training sessions.
"""

from typing import Any

from ..memory.core import CoreMemory


class JudgmentEncoder:
    """Encode extracted judgment patterns into Core Memory."""

    async def encode(
        self,
        agent_id: str,
        expert_id: str,
        extraction: dict[str, Any],
        core_memory: CoreMemory,
    ) -> str:
        """
        Write extracted judgment to Core Memory.

        Merges new patterns with any existing ones from previous
        training sessions rather than replacing them entirely.

        Args:
            agent_id: The agent being trained
            expert_id: The expert providing the training
            extraction: Output from JudgmentExtractor.extract()
            core_memory: Core memory module

        Returns:
            Training version hash
        """
        # Load existing core memory (if any)
        existing = await core_memory.load(agent_id)

        if existing is not None:
            # Merge with existing judgment
            merged_patterns = self._merge_patterns(
                existing.get("judgment_json", {}).get("patterns", []),
                extraction["patterns"],
            )
            merged_constraints = self._merge_constraints(
                existing.get("hard_constraints", []),
                extraction["constraints"],
            )
            merged_triggers = self._merge_triggers(
                existing.get("escalation_triggers", []),
                extraction["triggers"],
            )
            # Confidence map: prefer the latest training session
            confidence_map = extraction.get(
                "confidence_map",
                existing.get("confidence_map", []),
            )
        else:
            merged_patterns = extraction["patterns"]
            merged_constraints = extraction["constraints"]
            merged_triggers = extraction["triggers"]
            confidence_map = extraction.get("confidence_map", [])

        # Build the judgment JSON
        judgment_json = {
            "patterns": merged_patterns,
            "source_transcript_hash": extraction.get("raw_transcript_hash", ""),
        }

        # Write to core memory
        version_hash = await core_memory.write(
            agent_id=agent_id,
            expert_id=expert_id,
            judgment_json=judgment_json,
            hard_constraints=merged_constraints,
            escalation_triggers=merged_triggers,
            confidence_map=confidence_map,
        )

        print(
            f"[JudgmentEncoder] Encoded judgment for agent {agent_id}: "
            f"{len(merged_patterns)} patterns, "
            f"{len(merged_constraints)} constraints, "
            f"{len(merged_triggers)} triggers"
        )

        return version_hash

    def _merge_patterns(
        self, existing: list[dict], new: list[dict]
    ) -> list[dict]:
        """Merge new patterns with existing, avoiding duplicates by ID."""
        existing_ids = {p.get("id") for p in existing}
        merged = list(existing)
        for pattern in new:
            if pattern.get("id") not in existing_ids:
                merged.append(pattern)
        return merged

    def _merge_constraints(
        self, existing: list[dict], new: list[dict]
    ) -> list[dict]:
        """Merge new constraints with existing, avoiding duplicates by ID."""
        existing_ids = {c.get("id") for c in existing}
        merged = list(existing)
        for constraint in new:
            if constraint.get("id") not in existing_ids:
                merged.append(constraint)
        return merged

    def _merge_triggers(
        self, existing: list[dict], new: list[dict]
    ) -> list[dict]:
        """Merge new triggers with existing, avoiding duplicates by ID."""
        existing_ids = {t.get("id") for t in existing}
        merged = list(existing)
        for trigger in new:
            if trigger.get("id") not in existing_ids:
                merged.append(trigger)
        return merged
