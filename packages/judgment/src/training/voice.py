"""
Voice Transcription — Whisper transcription stub.

In production, uses OpenAI Whisper (local or API) to transcribe
audio recordings of training sessions.
"""

import base64
import tempfile
import os


class VoiceTranscriber:
    """Transcribe audio to text using Whisper."""

    def __init__(self, model_name: str = "base"):
        self._model_name = model_name
        self._model = None  # Lazy load

    def _load_model(self):
        """Load the Whisper model on first use."""
        if self._model is not None:
            return

        try:
            import whisper

            self._model = whisper.load_model(self._model_name)
            print(f"[VoiceTranscriber] Loaded Whisper model: {self._model_name}")
        except ImportError:
            print(
                "[VoiceTranscriber] openai-whisper not installed. "
                "Audio transcription will return a stub."
            )
        except Exception as e:
            print(f"[VoiceTranscriber] Failed to load Whisper: {e}")

    async def transcribe(self, audio_base64: str) -> str:
        """
        Transcribe base64-encoded audio to text.

        Args:
            audio_base64: Base64-encoded audio file content

        Returns:
            Transcribed text

        TODO: CTO should review:
        - API vs local model decision (cost vs latency vs privacy)
        - Audio format handling (wav, mp3, m4a, webm)
        - Chunking for long recordings (>30 min)
        - Language detection and multi-language support
        """
        self._load_model()

        if self._model is None:
            # Stub: return placeholder text when Whisper is not available
            print("[VoiceTranscriber] Whisper not available, returning stub transcript")
            return (
                "[STUB TRANSCRIPT] Audio transcription is not available. "
                "Install openai-whisper to enable voice training sessions. "
                f"Received {len(audio_base64)} characters of base64 audio."
            )

        # Decode base64 audio to a temp file
        try:
            audio_bytes = base64.b64decode(audio_base64)
        except Exception as e:
            raise ValueError(f"Invalid base64 audio: {e}")

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            result = self._model.transcribe(tmp_path)
            return result.get("text", "")
        finally:
            os.unlink(tmp_path)

    async def transcribe_file(self, file_path: str) -> str:
        """
        Transcribe an audio file directly.

        Args:
            file_path: Path to the audio file

        Returns:
            Transcribed text
        """
        self._load_model()

        if self._model is None:
            return "[STUB] Whisper not available"

        result = self._model.transcribe(file_path)
        return result.get("text", "")
