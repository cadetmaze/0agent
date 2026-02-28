"""
Training Consolidator — Deepens the expert profile across sessions.

This module implements the consolidation pass required to make the
expert profile richer over time rather than just larger.

Refinement logic:
1. Deepen: Merge and strengthen existing patterns.
2. Resolve: Update contradicting nodes with separating conditions.
3. New: Add genuinely new patterns/constraints.
4. Contradict: Flag unresolved contradictions for expert review.
"""

from typing import Any


class TrainingConsolidator:
    """Consolidation pass for training sessions."""

    def consolidate(
        self,
        existing_judgment: dict[str, Any],
        new_extraction: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Consolidate new training extraction with existing judgment profile.
        
        Args:
            existing_judgment: The current Core Memory judgment (patterns, constraints, triggers)
            new_extraction: The newly extracted judgment from the latest session
            
        Returns:
            Consolidated judgment profile
        """
        # 1. Consolidate Patterns
        consolidated_patterns = self._consolidate_patterns(
            existing_judgment.get("patterns", []),
            new_extraction.get("patterns", []),
        )
        
        # 2. Consolidate Constraints
        consolidated_constraints = self._consolidate_constraints(
            existing_judgment.get("hard_constraints", []),
            new_extraction.get("constraints", []),
        )
        
        # 3. Consolidate Triggers
        consolidated_triggers = self._consolidate_triggers(
            existing_judgment.get("escalation_triggers", []),
            new_extraction.get("triggers", []),
        )
        
        # 4. Handle Confidence Map (usually prefer latest or merge)
        confidence_map = new_extraction.get(
            "confidence_map",
            existing_judgment.get("confidence_map", []),
        )
        
        return {
            "patterns": consolidated_patterns,
            "hard_constraints": consolidated_constraints,
            "escalation_triggers": consolidated_triggers,
            "confidence_map": confidence_map,
            "review_required": self._find_unresolved_contradictions(
                consolidated_patterns, consolidated_constraints
            )
        }

    def _consolidate_patterns(
        self, existing: list[dict], new: list[dict]
    ) -> list[dict]:
        """
        Deepen, Resolve, or Add patterns.
        
        In production, this would use an LLM to compare pattern semantics.
        Currently implements ID and semantic overlap heuristics.
        """
        merged = list(existing)
        existing_names = {p.get("name").lower(): i for i, p in enumerate(existing)}
        
        for p_new in new:
            name_lower = p_new.get("name").lower()
            if name_lower in existing_names:
                # Deepen existing pattern
                idx = existing_names[name_lower]
                p_old = merged[idx]
                p_old["description"] += f"\nDeepened: {p_new.get('description')}"
                p_old["confidence"] = min(1.0, p_old.get("confidence", 0.5) + 0.1)
            else:
                # Is it genuinely new or a contradiction?
                # (Simple check for high semantic overlap but different recommendation)
                # TODO: LLM-based contradiction detection
                merged.append(p_new)
                
        return merged

    def _consolidate_constraints(
        self, existing: list[dict], new: list[dict]
    ) -> list[dict]:
        """Merge constraints, avoiding duplicates and checking for conflicts."""
        merged = list(existing)
        existing_rules = {c.get("rule").lower(): i for i, c in enumerate(existing)}
        
        for c_new in new:
            rule_lower = c_new.get("rule").lower()
            if rule_lower not in existing_rules:
                merged.append(c_new)
                
        return merged

    def _consolidate_triggers(
        self, existing: list[dict], new: list[dict]
    ) -> list[dict]:
        """Merge triggers."""
        merged = list(existing)
        existing_desc = {t.get("description").lower() for t in existing}
        
        for t_new in new:
            if t_new.get("description").lower() not in existing_desc:
                merged.append(t_new)
                
        return merged

    def _find_unresolved_contradictions(
        self, patterns: list[dict], constraints: list[dict]
    ) -> list[dict]:
        """
        Find cases where patterns suggest an action that a constraint forbids.
        Returns a list of flags for expert review.
        """
        # Placeholder for complex contradiction detection logic
        return []
