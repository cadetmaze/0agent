"""
Semantic Memory — pgvector read/write and similarity search.

Generates embeddings using sentence-transformers and stores them
in the semantic_memory table with pgvector for cosine similarity search.
"""

import json
import uuid
from typing import Optional

import numpy as np
from ..db.supabase import db


class SemanticMemory:
    """Semantic memory operations using pgvector."""

    def __init__(self, model_name: str = "all-MiniLM-L6-v2"):
        self._model_name = model_name
        self._model = None  # Lazy load

    async def initialize(self) -> None:
        """Initialize the embedding model. Called on server startup."""
        try:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self._model_name)
            print(f"[SemanticMemory] Loaded embedding model: {self._model_name}")
        except ImportError:
            print(
                "[SemanticMemory] sentence-transformers not installed. "
                "Embeddings will use random vectors (development only)."
            )
        except Exception as e:
            print(f"[SemanticMemory] Failed to load model: {e}. Using random vectors.")

    def _embed(self, text: str) -> list[float]:
        """Generate an embedding vector for the given text."""
        if self._model is not None:
            embedding = self._model.encode(text, normalize_embeddings=True)
            # Pad or truncate to 1536 dimensions to match schema
            vec = embedding.tolist()
            if len(vec) < 1536:
                vec.extend([0.0] * (1536 - len(vec)))
            elif len(vec) > 1536:
                vec = vec[:1536]
            return vec
        else:
            # Fallback: random vector for development
            rng = np.random.default_rng()
            vec = rng.standard_normal(1536).tolist()
            norm = float(np.linalg.norm(vec))
            return [v / norm for v in vec]

    async def search(
        self,
        agent_id: str,
        query: str,
        owner: Optional[str] = None,
        limit: int = 10,
    ) -> list[dict]:
        """
        Perform cosine similarity search against semantic memory.
        Returns the top-k most similar memories.
        """
        query_embedding = self._embed(query)
        embedding_str = "[" + ",".join(str(v) for v in query_embedding) + "]"

        sql = """
            SELECT id, content, metadata,
                   1 - (embedding <=> $1::vector) AS similarity
            FROM semantic_memory
            WHERE agent_id = $2
        """
        params = [embedding_str, agent_id]

        if owner:
            sql += " AND owner = $3"
            params.append(owner)

        limit_pos = len(params) + 1
        sql += f"""
            ORDER BY embedding <=> $1::vector
            LIMIT ${limit_pos}
        """
        params.append(limit)

        rows = await db.fetch_all(sql, *params)

        results = []
        for row in rows:
            meta = row["metadata"]
            if isinstance(meta, str):
                meta = json.loads(meta)

            results.append(
                {
                    "id": str(row["id"]),
                    "content": row["content"],
                    "metadata": meta,
                    "similarity": float(row["similarity"]),
                }
            )

        return results

    async def write(
        self,
        agent_id: str,
        content: str,
        metadata: Optional[dict] = None,
        owner: str = "company",
    ) -> str:
        """
        Write a semantic memory entry.
        Generates an embedding and stores in pgvector.
        Returns the memory ID.
        """
        memory_id = str(uuid.uuid4())
        embedding = self._embed(content)
        embedding_str = "[" + ",".join(str(v) for v in embedding) + "]"

        await db.execute(
            """
            INSERT INTO semantic_memory (id, agent_id, content, embedding, metadata, owner)
            VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6)
            """,
            memory_id,
            agent_id,
            content,
            embedding_str,
            json.dumps(metadata or {}),
            owner,
        )

        print(f"[SemanticMemory] Wrote memory {memory_id} for agent {agent_id}")
        return memory_id
