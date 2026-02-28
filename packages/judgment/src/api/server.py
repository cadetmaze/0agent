"""
FastAPI server — Judgment Service API.

Exposes judgment retrieval to the TypeScript runtime.
All endpoints validate input with Pydantic and return typed responses.
Authentication: X-Service-Token header matching SERVICE_TOKEN env var.

Endpoints:
  GET  /health                        — service status and version
  POST /envelope/build                — build expert judgment for a TaskEnvelope
  POST /training/session              — ingest a training session transcript
  POST /training/correction           — receive approval-gate corrections as training signals
  GET  /training/version/diff         — diff two training versions for adoption review
  POST /memory/semantic/search        — semantic similarity search
  POST /memory/semantic/write         — write semantic memory
  GET  /training/status/{agent_id}    — training status for an agent
  POST /consolidation/run             — trigger nightly dream event
"""

import os
import hashlib
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from ..db.supabase import db
from ..memory.core import CoreMemory
from ..memory.semantic import SemanticMemory
from ..memory.consolidator import Consolidator
from ..training.session import TrainingSessionHandler
from ..retrieval.envelope_builder import EnvelopeBuilder


# ============================================================
# Pydantic Models — mirror TypeScript TaskEnvelope types exactly
# ============================================================


class JudgmentPattern(BaseModel):
    id: str
    name: str
    description: str
    response_guidance: str = Field(alias="responseGuidance", default="")
    domains: list[str] = []
    confidence: float = 0.0

    model_config = {"populate_by_name": True}


class Trigger(BaseModel):
    id: str
    description: str
    patterns: list[str] = []
    action: str = "escalate"  # escalate | pause | abort
    priority: int = 0


class Constraint(BaseModel):
    id: str
    description: str
    rule: str
    category: str = "operational"  # security | compliance | brand | operational | legal
    critical: bool = False


class ConfidenceRange(BaseModel):
    min: float
    max: float
    action: str = "act"  # act | slow_down | escalate
    description: str = ""


class ExpertJudgment(BaseModel):
    expert_id: str = Field(alias="expertId", default="")
    version: str = ""
    patterns: list[JudgmentPattern] = []
    escalation_triggers: list[Trigger] = Field(alias="escalationTriggers", default=[])
    hard_constraints: list[Constraint] = Field(alias="hardConstraints", default=[])
    confidence_map: list[ConfidenceRange] = Field(alias="confidenceMap", default=[])

    model_config = {"populate_by_name": True}


class Decision(BaseModel):
    id: str
    title: str
    description: str = ""
    status: str = "proposed"
    stakeholders: list[str] = []
    deadline: Optional[str] = None
    made_by: Optional[str] = Field(alias="madeBy", default=None)
    made_by_type: Optional[str] = Field(alias="madeByType", default=None)
    outcome: Optional[str] = None
    tags: list[str] = []

    model_config = {"populate_by_name": True}


class Person(BaseModel):
    id: str
    name: str
    role: str = ""
    relevance: str = ""
    contact_preference: Optional[str] = Field(alias="contactPreference", default=None)

    model_config = {"populate_by_name": True}


class EpisodicEvent(BaseModel):
    session_id: str = Field(alias="sessionId", default="")
    summary: str = ""
    outcome: str = ""
    timestamp: str = ""
    sentiment: float = 0.0
    relevance_score: float = Field(alias="relevanceScore", default=0.0)

    model_config = {"populate_by_name": True}


class ActiveContextSnapshot(BaseModel):
    priorities: list[str] = []
    open_questions: list[dict] = Field(alias="openQuestions", default=[])
    active_experiments: list[dict] = Field(alias="activeExperiments", default=[])

    model_config = {"populate_by_name": True}


class OrgContext(BaseModel):
    goal: str = ""
    active_decisions: list[Decision] = Field(alias="activeDecisions", default=[])
    key_people: list[Person] = Field(alias="keyPeople", default=[])
    budget_remaining: float = Field(alias="budgetRemaining", default=0.0)
    constraints: list[str] = []
    history: list[EpisodicEvent] = []
    active_context: Optional[ActiveContextSnapshot] = Field(alias="activeContext", default=None)
    optimization_mode: str = Field(alias="optimizationMode", default="balanced")

    model_config = {"populate_by_name": True}


# ============================================================
# Request / Response Models
# ============================================================


class HealthResponse(BaseModel):
    status: str
    version: str
    database_connected: bool


class EnvelopeBuildRequest(BaseModel):
    agent_id: str
    task_spec: str
    company_id: str


class EnvelopeBuildResponse(BaseModel):
    expert_judgment: ExpertJudgment
    org_context: OrgContext


class TrainingSessionRequest(BaseModel):
    agent_id: str
    expert_id: str
    transcript: str  # Plain text or base64-encoded audio
    is_audio: bool = False


class TrainingSessionResponse(BaseModel):
    success: bool
    training_version: str
    patterns_extracted: int
    constraints_extracted: int
    message: str


class SemanticSearchRequest(BaseModel):
    agent_id: str
    query: str
    limit: int = 10


class SemanticSearchResult(BaseModel):
    id: str
    content: str
    metadata: dict = {}
    similarity: float = 0.0


class SemanticSearchResponse(BaseModel):
    results: list[SemanticSearchResult]


class SemanticWriteRequest(BaseModel):
    agent_id: str
    content: str
    metadata: dict = {}


class SemanticWriteResponse(BaseModel):
    id: str
    success: bool


class TrainingStatusResponse(BaseModel):
    trained: bool
    training_version: Optional[str] = None
    last_training_date: Optional[str] = None
    pattern_count: int = 0
    constraint_count: int = 0


class CorrectionRequest(BaseModel):
    """Receive a correction from the approval gate as a training signal."""
    agent_id: str
    task_id: str
    correction_content: str
    correction_type: str = "approval_gate"
    created_at: Optional[str] = None


class CorrectionResponse(BaseModel):
    success: bool
    message: str
    incorporated: bool = False


class ConsolidationRequest(BaseModel):
    """Trigger a nightly dream event for an agent."""
    agent_id: str


class ConsolidationResponse(BaseModel):
    agent_id: str
    episodes_reviewed: int
    patterns_found: int
    drift_detected: bool
    drift_score: float = 0.0
    memories_pruned: int
    morning_note: str = ""


class VersionDiffResponse(BaseModel):
    agent_id: str
    version_a: str
    version_b: str
    added_patterns: list[dict] = []
    removed_patterns: list[dict] = []
    changed_constraints: list[dict] = []
    summary: str = ""


# ============================================================
# Authentication
# ============================================================

SERVICE_TOKEN = os.getenv("SERVICE_TOKEN", "")


def verify_token(x_service_token: str = Header(...)):
    """Verify the X-Service-Token header."""
    if not SERVICE_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="SERVICE_TOKEN not configured on server",
        )
    if x_service_token != SERVICE_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid service token",
        )


# ============================================================
# FastAPI App
# ============================================================

app = FastAPI(
    title="Only Reason — Judgment Service",
    version="0.1.0",
    description="Expert training, memory encoding, and judgment retrieval for the Only Reason agent runtime.",
)

# Module instances — initialized on startup
core_memory = CoreMemory()
semantic_memory = SemanticMemory()
training_handler = TrainingSessionHandler()
envelope_builder = EnvelopeBuilder()
consolidator = Consolidator()


@app.on_event("startup")
async def startup():
    """Initialize database connection and modules on startup."""
    await db.connect()
    await semantic_memory.initialize()
    print("[JudgmentService] Started successfully")


@app.on_event("shutdown")
async def shutdown():
    """Clean up on shutdown."""
    await db.disconnect()
    print("[JudgmentService] Shut down")


# ============================================================
# Endpoints
# ============================================================


@app.get("/health", response_model=HealthResponse)
async def health():
    """Returns service status and version."""
    db_ok = await db.health_check()
    return HealthResponse(
        status="healthy" if db_ok else "degraded",
        version="0.1.0",
        database_connected=db_ok,
    )


@app.post("/envelope/build", response_model=EnvelopeBuildResponse)
async def build_envelope(
    request: EnvelopeBuildRequest,
    x_service_token: str = Header(...),
):
    """
    Build the expert judgment portion of a TaskEnvelope.

    Called by the TypeScript runtime at task processing time.
    Steps:
    1. Load core memory for agent_id
    2. Retrieve relevant episodic memories via semantic search
    3. Query org knowledge graph for company_id
    4. Assemble and return the judgment object
    """
    verify_token(x_service_token)

    result = await envelope_builder.build(
        agent_id=request.agent_id,
        task_spec=request.task_spec,
        company_id=request.company_id,
        core_memory=core_memory,
        semantic_memory=semantic_memory,
    )

    return result


@app.post("/training/session", response_model=TrainingSessionResponse)
async def training_session(
    request: TrainingSessionRequest,
    x_service_token: str = Header(...),
):
    """
    Ingest a training session transcript.

    Extracts judgment patterns from the transcript and writes
    them to core_memory. This is the training ingestion endpoint.
    """
    verify_token(x_service_token)

    result = await training_handler.process_session(
        agent_id=request.agent_id,
        expert_id=request.expert_id,
        transcript=request.transcript,
        is_audio=request.is_audio,
        core_memory=core_memory,
        semantic_memory=semantic_memory,
    )

    return result


@app.post("/memory/semantic/search", response_model=SemanticSearchResponse)
async def semantic_search(
    request: SemanticSearchRequest,
    x_service_token: str = Header(...),
):
    """
    Semantic similarity search using pgvector cosine similarity.
    """
    verify_token(x_service_token)

    results = await semantic_memory.search(
        agent_id=request.agent_id,
        query=request.query,
        limit=request.limit,
    )

    return SemanticSearchResponse(results=results)


@app.post("/memory/semantic/write", response_model=SemanticWriteResponse)
async def semantic_write(
    request: SemanticWriteRequest,
    x_service_token: str = Header(...),
):
    """
    Write a semantic memory entry. Generates embedding and stores in pgvector.
    """
    verify_token(x_service_token)

    memory_id = await semantic_memory.write(
        agent_id=request.agent_id,
        content=request.content,
        metadata=request.metadata,
    )

    return SemanticWriteResponse(id=memory_id, success=True)


@app.get("/training/status/{agent_id}", response_model=TrainingStatusResponse)
async def training_status(
    agent_id: str,
    x_service_token: str = Header(...),
):
    """
    Returns whether an agent has completed training, training version hash,
    and last training date.
    """
    verify_token(x_service_token)

    cm = await core_memory.load(agent_id)

    if cm is None:
        return TrainingStatusResponse(trained=False)

    return TrainingStatusResponse(
        trained=True,
        training_version=cm.get("training_version", ""),
        last_training_date=cm.get("created_at", ""),
        pattern_count=len(cm.get("judgment_json", {}).get("patterns", [])),
        constraint_count=len(cm.get("hard_constraints", [])),
    )


# ============================================================
# Training Correction — Approval gate feedback as training signal
# ============================================================


@app.post("/training/correction", response_model=CorrectionResponse)
async def training_correction(
    request: CorrectionRequest,
    x_service_token: str = Header(...),
):
    """
    Receive a correction from the approval gate.

    Every time a human reviewer corrects an agent's decision,
    this endpoint records it as a training signal that can be
    incorporated into the next training version.
    """
    verify_token(x_service_token)

    # Store correction as semantic memory for retrieval during next training
    correction_metadata = {
        "type": "correction",
        "correction_type": request.correction_type,
        "task_id": request.task_id,
        "created_at": request.created_at or datetime.utcnow().isoformat(),
    }

    await semantic_memory.write(
        agent_id=request.agent_id,
        content=f"CORRECTION: {request.correction_content}",
        metadata=correction_metadata,
    )

    print(
        f"[JudgmentService] Correction recorded for agent {request.agent_id}, "
        f"task {request.task_id}"
    )

    return CorrectionResponse(
        success=True,
        message="Correction recorded as training signal",
        incorporated=False,  # Will be incorporated in next training version
    )


# ============================================================
# Consolidation — Nightly dream event
# ============================================================


@app.post("/consolidation/run", response_model=ConsolidationResponse)
async def run_consolidation(
    request: ConsolidationRequest,
    x_service_token: str = Header(...),
):
    """
    Trigger the nightly consolidation (dream event) for an agent.

    This:
    1. Reviews the day's episodic memories
    2. Identifies patterns and themes
    3. Detects behavioral drift
    4. Generates a morning note summarizing insights
    5. Prunes low-relevance memories
    """
    verify_token(x_service_token)

    # Run consolidation
    consolidation_result = await consolidator.run_consolidation(request.agent_id)

    # Run drift detection
    drift_result = await consolidator.detect_drift(request.agent_id)

    # Generate morning note
    morning_note = await consolidator.generate_morning_note(
        request.agent_id,
        consolidation_result,
        drift_result,
    )

    return ConsolidationResponse(
        agent_id=request.agent_id,
        episodes_reviewed=consolidation_result.get("episodes_reviewed", 0),
        patterns_found=consolidation_result.get("patterns_found", 0),
        drift_detected=drift_result.get("drift_detected", False),
        drift_score=drift_result.get("drift_score", 0.0),
        memories_pruned=consolidation_result.get("memories_pruned", 0),
        morning_note=morning_note,
    )


# ============================================================
# Training Version Diff — for adoption review
# ============================================================


@app.get("/training/version/diff", response_model=VersionDiffResponse)
async def training_version_diff(
    agent_id: str,
    version_a: str = "current",
    version_b: str = "latest",
    x_service_token: str = Header(...),
):
    """
    Diff two training versions so the company can decide when to adopt.

    Companies receive a diff showing what changed in the judgment layer
    (new patterns, removed patterns, changed constraints) and choose
    when to adopt the new version.
    """
    verify_token(x_service_token)

    # Load both versions from core_memory
    cm = await core_memory.load(agent_id)
    if cm is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No training data found for agent {agent_id}",
        )

    # TODO: Implement actual version diffing.
    # This requires versioned storage of core_memory snapshots.
    # For now, return a stub diff.

    current_version = cm.get("training_version", "")
    current_patterns = cm.get("judgment_json", {}).get("patterns", [])
    current_constraints = cm.get("hard_constraints", [])

    return VersionDiffResponse(
        agent_id=agent_id,
        version_a=version_a if version_a != "current" else current_version,
        version_b=version_b if version_b != "latest" else current_version,
        added_patterns=[],
        removed_patterns=[],
        changed_constraints=[],
        summary=(
            f"Agent {agent_id} at version {current_version}: "
            f"{len(current_patterns)} patterns, {len(current_constraints)} constraints. "
            "Version diffing will be available when versioned core_memory storage is implemented."
        ),
    )
