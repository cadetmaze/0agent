"""
Judgment Extractor — Extracts judgment patterns from training transcripts.

Analyzes training session transcripts to identify:
- Domain-specific patterns the expert recognizes
- Hard constraints (things the agent must never do)
- Escalation triggers (when to stop and call a human)
- Confidence ranges (when to act vs slow down vs escalate)
"""

import hashlib
import re
from typing import Any


class JudgmentExtractor:
    """Extract structured judgment from training transcripts."""

    async def extract(self, transcript: str) -> dict[str, Any]:
        """
        Extract judgment patterns, constraints, triggers, and confidence map
        from a training transcript.

        In production, this should use an LLM to analyze the transcript
        and extract structured judgment. The LLM prompt should be designed
        to identify:
        1. Domain patterns (how the expert recognizes situations)
        2. Decision heuristics (how the expert makes decisions)
        3. Red lines (things that are never acceptable)
        4. Escalation signals (when to involve a human)
        5. Confidence calibration (when the expert is sure vs unsure)

        TODO: Replace with LLM-based extraction using Claude or GPT-4.
        Current implementation uses keyword-based heuristics as a scaffold.
        """
        patterns = self._extract_patterns(transcript)
        constraints = self._extract_constraints(transcript)
        triggers = self._extract_triggers(transcript)
        confidence_map = self._extract_confidence_map(transcript)

        return {
            "patterns": patterns,
            "constraints": constraints,
            "triggers": triggers,
            "confidence_map": confidence_map,
            "raw_transcript_hash": hashlib.sha256(
                transcript.encode()
            ).hexdigest()[:16],
        }

    def _extract_patterns(self, transcript: str) -> list[dict]:
        """
        Extract domain-specific patterns from the transcript.

        TODO: Replace with LLM-based extraction.
        """
        patterns = []

        # Simple heuristic: look for sentences with pattern indicators
        pattern_indicators = [
            r"when\s+(?:I|we)\s+see",
            r"the\s+pattern\s+(?:is|here\s+is)",
            r"(?:I|we)\s+always\s+(?:look\s+for|check)",
            r"the\s+key\s+(?:thing|indicator|signal)\s+is",
            r"(?:I|we)\s+(?:typically|usually|always)\s+(?:do|handle|approach)",
        ]

        sentences = re.split(r"[.!?]+", transcript)
        for i, sentence in enumerate(sentences):
            sentence = sentence.strip()
            if not sentence:
                continue

            for indicator in pattern_indicators:
                if re.search(indicator, sentence, re.IGNORECASE):
                    pattern_id = hashlib.md5(sentence.encode()).hexdigest()[:8]
                    patterns.append(
                        {
                            "id": f"pat_{pattern_id}",
                            "name": f"Pattern from training (line {i + 1})",
                            "description": sentence[:200],
                            "responseGuidance": "",  # TODO: extract from context
                            "domains": [],
                            "confidence": 0.5,
                        }
                    )
                    break

        return patterns

    def _extract_constraints(self, transcript: str) -> list[dict]:
        """
        Extract hard constraints (things the agent must never do).

        TODO: Replace with LLM-based extraction.
        """
        constraints = []

        constraint_indicators = [
            r"never\s+(?:do|say|send|share|disclose|reveal)",
            r"(?:don't|do\s+not)\s+ever",
            r"absolutely\s+(?:not|never|forbidden)",
            r"(?:this|that)\s+is\s+(?:off\s+limits|forbidden|prohibited)",
            r"under\s+no\s+circumstances",
            r"(?:must|should)\s+never",
        ]

        sentences = re.split(r"[.!?]+", transcript)
        for i, sentence in enumerate(sentences):
            sentence = sentence.strip()
            if not sentence:
                continue

            for indicator in constraint_indicators:
                if re.search(indicator, sentence, re.IGNORECASE):
                    constraint_id = hashlib.md5(sentence.encode()).hexdigest()[:8]
                    constraints.append(
                        {
                            "id": f"con_{constraint_id}",
                            "description": sentence[:200],
                            "rule": sentence[:200],
                            "category": "operational",
                            "critical": "never" in sentence.lower(),
                        }
                    )
                    break

        return constraints

    def _extract_triggers(self, transcript: str) -> list[dict]:
        """
        Extract escalation triggers.

        TODO: Replace with LLM-based extraction.
        """
        triggers = []

        trigger_indicators = [
            r"(?:call|contact|escalate\s+to)\s+(?:me|the\s+team|management)",
            r"(?:if|when)\s+you(?:'re)?\s+(?:unsure|not\s+sure|uncertain)",
            r"(?:stop|pause)\s+and\s+(?:ask|check|verify)",
            r"this\s+needs\s+(?:human|manual)\s+(?:review|approval)",
            r"(?:flag|alert)\s+(?:me|us|the\s+team)",
        ]

        sentences = re.split(r"[.!?]+", transcript)
        for i, sentence in enumerate(sentences):
            sentence = sentence.strip()
            if not sentence:
                continue

            for indicator in trigger_indicators:
                if re.search(indicator, sentence, re.IGNORECASE):
                    trigger_id = hashlib.md5(sentence.encode()).hexdigest()[:8]
                    triggers.append(
                        {
                            "id": f"trg_{trigger_id}",
                            "description": sentence[:200],
                            "patterns": [sentence[:100].lower()],
                            "action": "escalate",
                            "priority": 5,
                        }
                    )
                    break

        return triggers

    def _extract_confidence_map(self, transcript: str) -> list[dict]:
        """
        Extract confidence calibration.

        TODO: Replace with LLM-based extraction from expert's
        descriptions of when they feel confident vs uncertain.
        """
        # Default confidence map — should be refined through training
        return [
            {
                "min": 0.0,
                "max": 0.3,
                "action": "escalate",
                "description": "Low confidence — escalate to human",
            },
            {
                "min": 0.3,
                "max": 0.6,
                "action": "slow_down",
                "description": "Medium confidence — proceed with extra verification",
            },
            {
                "min": 0.6,
                "max": 1.0,
                "action": "act",
                "description": "High confidence — act autonomously",
            },
        ]
