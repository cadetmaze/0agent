"""
Training Session Handler — Coordinates the training pipeline.

Processes a training session transcript (text or audio):
1. If audio, transcribe to text via Whisper
2. Extract judgment patterns from transcript
3. Encode extracted judgments into Core Memory
4. Store the transcript as semantic memory
"""

import hashlib
from datetime import datetime, timezone

from .voice import VoiceTranscriber
from .extractor import JudgmentExtractor
from .encoder import JudgmentEncoder
from ..memory.core import CoreMemory
from ..memory.semantic import SemanticMemory


class TrainingSessionHandler:
    """Orchestrates the full training session pipeline."""

    def __init__(self):
        self.transcriber = VoiceTranscriber()
        self.extractor = JudgmentExtractor()
        self.encoder = JudgmentEncoder()

    async def process_session(
        self,
        agent_id: str,
        expert_id: str,
        transcript: str,
        is_audio: bool,
        core_memory: CoreMemory,
        semantic_memory: SemanticMemory,
    ) -> dict:
        """
        Process a complete training session.

        Args:
            agent_id: The agent being trained
            expert_id: The expert providing the training
            transcript: Text transcript or base64-encoded audio
            is_audio: Whether the input is audio (needs transcription)
            core_memory: Core memory module for writing judgment
            semantic_memory: Semantic memory for storing the transcript

        Returns:
            dict with training results
        """
        print(
            f"[TrainingSession] Processing session for agent {agent_id} "
            f"by expert {expert_id}"
        )

        # Step 1: Transcribe if audio
        text = transcript
        if is_audio:
            print("[TrainingSession] Transcribing audio input...")
            text = await self.transcriber.transcribe(transcript)
            print(f"[TrainingSession] Transcribed {len(text)} characters")

        # Step 2: Extract judgment patterns
        print("[TrainingSession] Extracting judgment patterns...")
        extraction = await self.extractor.extract(text)
        print(
            f"[TrainingSession] Extracted {len(extraction['patterns'])} patterns, "
            f"{len(extraction['constraints'])} constraints"
        )

        # Step 3: Encode into Core Memory
        print("[TrainingSession] Encoding judgment into Core Memory...")
        version_hash = await self.encoder.encode(
            agent_id=agent_id,
            expert_id=expert_id,
            extraction=extraction,
            core_memory=core_memory,
        )

        # Step 4: Store transcript as semantic memory
        print("[TrainingSession] Storing transcript as semantic memory...")
        await semantic_memory.write(
            agent_id=agent_id,
            content=text,
            metadata={
                "type": "training_transcript",
                "expert_id": expert_id,
                "session_date": datetime.now(timezone.utc).isoformat(),
                "training_version": version_hash,
            },
            owner="expert",
        )

        return {
            "success": True,
            "training_version": version_hash,
            "patterns_extracted": len(extraction["patterns"]),
            "constraints_extracted": len(extraction["constraints"]),
            "message": (
                f"Training session processed. Extracted {len(extraction['patterns'])} "
                f"patterns and {len(extraction['constraints'])} constraints. "
                f"Version: {version_hash}"
            ),
        }
