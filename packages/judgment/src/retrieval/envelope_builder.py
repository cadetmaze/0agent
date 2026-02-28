"""
Envelope Builder — Builds the expert judgment portion of a TaskEnvelope.

Called by the TypeScript runtime via the /envelope/build API endpoint.
Assembles expert judgment, relevant memories, and org context.
"""

import json
from typing import Any, Optional

from ..memory.core import CoreMemory
from ..memory.semantic import SemanticMemory
from ..db.supabase import db


class EnvelopeBuilder:
    """Build the judgment portion of a TaskEnvelope."""

    async def build(
        self,
        agent_id: str,
        task_spec: str,
        company_id: str,
        core_memory: CoreMemory,
        semantic_memory: SemanticMemory,
    ) -> dict[str, Any]:
        """
        Build the expert judgment and org context for a TaskEnvelope.

        Steps:
        1. Load core memory for the agent
        2. Retrieve relevant episodic memories via semantic search
        3. Query org knowledge graph for the company
        4. Assemble and return the judgment + context objects

        Returns:
            dict matching the EnvelopeBuildResponse Pydantic model
        """
        # Step 1: Load core memory
        cm = await core_memory.load(agent_id)

        if cm is None:
            # Agent has not been trained — return empty judgment
            expert_judgment = {
                "expertId": "",
                "version": "untrained",
                "patterns": [],
                "escalationTriggers": [],
                "hardConstraints": [],
                "confidenceMap": [
                    {"min": 0.0, "max": 0.3, "action": "escalate", "description": "Low"},
                    {"min": 0.3, "max": 0.7, "action": "slow_down", "description": "Medium"},
                    {"min": 0.7, "max": 1.0, "action": "act", "description": "High"},
                ],
            }
        else:
            judgment_json = cm.get("judgment_json", {})
            patterns = judgment_json.get("patterns", [])

            expert_judgment = {
                "expertId": cm.get("expert_id", ""),
                "version": cm.get("training_version", ""),
                "patterns": patterns,
                "escalationTriggers": cm.get("escalation_triggers", []),
                "hardConstraints": cm.get("hard_constraints", []),
                "confidenceMap": cm.get("confidence_map", []),
            }

        # Step 2: Retrieve relevant episodic memories
        relevant_memories = await semantic_memory.search(
            agent_id=agent_id,
            query=task_spec,
            limit=5,
        )

        history = []
        for mem in relevant_memories:
            history.append(
                {
                    "sessionId": mem.get("metadata", {}).get("session_id", ""),
                    "summary": mem.get("content", "")[:200],
                    "outcome": "",
                    "timestamp": mem.get("metadata", {}).get("created_at", ""),
                    "sentiment": 0.0,
                    "relevanceScore": mem.get("similarity", 0.0),
                }
            )

        # Step 3: Query org knowledge graph
        org_context = await self._build_org_context(company_id)
        org_context["history"] = history

        return {
            "expert_judgment": expert_judgment,
            "org_context": org_context,
        }

    async def _build_org_context(self, company_id: str) -> dict[str, Any]:
        """Build org context from the knowledge graph."""
        try:
            rows = await db.fetch_all(
                """
                SELECT entity_type, entity_data
                FROM org_knowledge_graph
                WHERE company_id = $1
                """,
                company_id,
            )
        except Exception as e:
            print(f"[EnvelopeBuilder] Failed to query org graph: {e}")
            return self._empty_org_context()

        if not rows:
            return self._empty_org_context()

        decisions = []
        people = []
        goal = ""
        constraints: list[str] = []
        budget = 0.0

        for row in rows:
            entity_type = row["entity_type"]
            data = row["entity_data"]
            if isinstance(data, str):
                data = json.loads(data)

            if entity_type == "decision":
                decisions.append(
                    {
                        "id": data.get("id", ""),
                        "title": data.get("title", ""),
                        "description": data.get("description", ""),
                        "status": data.get("status", "proposed"),
                        "stakeholders": data.get("stakeholders", []),
                        "deadline": data.get("deadline"),
                    }
                )
            elif entity_type == "person":
                people.append(
                    {
                        "id": data.get("id", ""),
                        "name": data.get("name", "Unknown"),
                        "role": data.get("role", ""),
                        "relevance": data.get("relevance", ""),
                        "contactPreference": data.get("contactPreference"),
                    }
                )
            elif entity_type == "project":
                goal = data.get("goal", goal)
                constraints = data.get("constraints", constraints)
                budget = data.get("budgetRemaining", budget)

        return {
            "goal": goal,
            "activeDecisions": decisions,
            "keyPeople": people,
            "budgetRemaining": budget,
            "constraints": constraints,
            "history": [],
        }

    def _empty_org_context(self) -> dict[str, Any]:
        return {
            "goal": "",
            "activeDecisions": [],
            "keyPeople": [],
            "budgetRemaining": 0.0,
            "constraints": [],
            "history": [],
        }
