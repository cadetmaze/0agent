"""
Judgment Encoder — Writes extracted judgment to Core Memory.

Takes the output of the JudgmentExtractor and writes it to the
core_memory table. Handles merging with existing judgments
from previous training sessions.
"""

from typing import Any

from .consolidator import TrainingConsolidator
from ..memory.core import CoreMemory


class JudgmentEncoder:
    """Encode extracted judgment patterns into Core Memory."""

    def __init__(self):
        self.consolidator = TrainingConsolidator()

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
            # Consolidate with existing judgment profile
            consolidated = self.consolidator.consolidate(
                existing_judgment={
                    "patterns": existing.get("judgment_json", {}).get("patterns", []),
                    "hard_constraints": existing.get("hard_constraints", []),
                    "escalation_triggers": existing.get("escalation_triggers", []),
                    "confidence_map": existing.get("confidence_map", []),
                },
                new_extraction=extraction,
            )
            merged_patterns = consolidated["patterns"]
            merged_constraints = consolidated["hard_constraints"]
            merged_triggers = consolidated["escalation_triggers"]
            confidence_map = consolidated["confidence_map"]
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

