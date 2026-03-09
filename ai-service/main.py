"""
TapIn AI Recommendation Service
FastAPI microservice — collaborative filtering + content-based hybrid
"""

from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
import numpy as np
import psycopg2
import psycopg2.extras
import os
import json
import math
from typing import Optional
from datetime import datetime, timedelta
from collections import defaultdict
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tapin-ai")

app = FastAPI(title="TapIn AI Service", version="1.0.0")

DB_URL = os.getenv("DATABASE_URL", "postgresql://tapin_user:password@localhost:5432/tapin_db")


def get_db():
    return psycopg2.connect(DB_URL, cursor_factory=psycopg2.extras.RealDictCursor)


# ─── Models ──────────────────────────────────────────────────────────────────

class RecommendRequest(BaseModel):
    user_id: str
    limit: int = 20
    offset: int = 0


class RebuildVectorRequest(BaseModel):
    user_id: str


class RecommendResponse(BaseModel):
    track_ids: list[str]
    strategy: str


# ─── Core Recommendation Logic ────────────────────────────────────────────────

def get_user_listening_profile(conn, user_id: str) -> dict:
    """Build a listening profile for a user from their history."""
    with conn.cursor() as cur:
        # Get listening history with audio features
        cur.execute("""
            SELECT
                t.id AS track_id,
                t.genre,
                t.energy,
                t.valence,
                t.danceability,
                t.tempo,
                t.acousticness,
                t.artist,
                COUNT(*) AS play_count,
                MAX(lh.played_at) AS last_played
            FROM listening_history lh
            JOIN tracks t ON lh.track_id = t.id
            WHERE lh.user_id = %s
              AND lh.played_at > NOW() - INTERVAL '90 days'
              AND t.energy IS NOT NULL
            GROUP BY t.id, t.genre, t.energy, t.valence, t.danceability, t.tempo, t.acousticness, t.artist
        """, (user_id,))
        history = cur.fetchall()

        # Get liked and saved tracks (stronger signal)
        cur.execute("""
            SELECT track_id FROM track_likes WHERE user_id = %s
            UNION
            SELECT track_id FROM track_saves WHERE user_id = %s
        """, (user_id, user_id))
        engaged_ids = {r["track_id"] for r in cur.fetchall()}

        # Get rated tracks
        cur.execute("""
            SELECT track_id, rating FROM reviews WHERE user_id = %s
        """, (user_id,))
        ratings = {r["track_id"]: r["rating"] for r in cur.fetchall()}

    return {
        "history": [dict(r) for r in history],
        "engaged_ids": engaged_ids,
        "ratings": ratings,
    }


def build_user_taste_vector(profile: dict) -> Optional[np.ndarray]:
    """
    Build a weighted audio feature vector from listening history.
    Weights: saves/likes = 3x, 5-star rating = 3x, 4-star = 2x, repeat plays > 3 = 2x
    """
    if not profile["history"]:
        return None

    feature_keys = ["energy", "valence", "danceability", "acousticness"]
    weighted_sum = np.zeros(len(feature_keys))
    total_weight = 0.0

    for track in profile["history"]:
        # Base weight = normalized play count
        weight = math.log1p(track["play_count"])

        # Boost for engagement
        if track["track_id"] in profile["engaged_ids"]:
            weight *= 3.0

        # Boost for rating
        rating = profile["ratings"].get(track["track_id"])
        if rating == 5:
            weight *= 3.0
        elif rating == 4:
            weight *= 2.0
        elif rating and rating <= 2:
            weight *= 0.2  # penalize disliked tracks

        # Recency boost — last 7 days get 1.5x
        if track.get("last_played"):
            days_ago = (datetime.now() - track["last_played"]).days
            if days_ago <= 7:
                weight *= 1.5

        features = np.array([
            track.get(k) or 0.5 for k in feature_keys
        ])
        weighted_sum += features * weight
        total_weight += weight

    if total_weight == 0:
        return None

    return weighted_sum / total_weight


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def content_based_recommendations(conn, user_id: str, user_vector: np.ndarray,
                                   excluded_ids: set, limit: int, offset: int) -> list[str]:
    """Score all tracks by cosine similarity to user taste vector."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, energy, valence, danceability, acousticness, popularity, genre
            FROM tracks
            WHERE energy IS NOT NULL
              AND id NOT IN %s
            ORDER BY popularity DESC
            LIMIT 2000
        """, (tuple(excluded_ids) if excluded_ids else ('00000000-0000-0000-0000-000000000000',),))
        candidates = cur.fetchall()

    feature_keys = ["energy", "valence", "danceability", "acousticness"]
    scored = []

    for track in candidates:
        vec = np.array([track.get(k) or 0.5 for k in feature_keys])
        sim = cosine_similarity(user_vector, vec)
        # Mix similarity with popularity (80/20)
        pop_score = (track["popularity"] or 0) / 100.0
        final_score = 0.8 * sim + 0.2 * pop_score
        scored.append((track["id"], final_score))

    scored.sort(key=lambda x: x[1], reverse=True)
    return [tid for tid, _ in scored[offset : offset + limit]]


def social_collaborative_filter(conn, user_id: str, excluded_ids: set, limit: int) -> list[str]:
    """Recommend tracks popular among similar users (who follow the same people)."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT lh.track_id, COUNT(*) AS score
            FROM listening_history lh
            WHERE lh.user_id IN (
                -- Users who follow at least 2 of the same people
                SELECT f2.follower_id
                FROM follows f1
                JOIN follows f2 ON f1.followee_id = f2.followee_id
                WHERE f1.follower_id = %s AND f2.follower_id <> %s
                GROUP BY f2.follower_id
                HAVING COUNT(*) >= 2
            )
            AND lh.track_id NOT IN %s
            AND lh.played_at > NOW() - INTERVAL '14 days'
            GROUP BY lh.track_id
            ORDER BY score DESC
            LIMIT %s
        """, (user_id, user_id,
              tuple(excluded_ids) if excluded_ids else ('00000000-0000-0000-0000-000000000000',),
              limit))
        return [r["track_id"] for r in cur.fetchall()]


def genre_weighted_popular(conn, user_id: str, top_genres: list[str],
                            excluded_ids: set, limit: int) -> list[str]:
    """Popular tracks in user's top genres they haven't heard."""
    if not top_genres:
        return []

    with conn.cursor() as cur:
        placeholders = ','.join(['%s'] * len(top_genres))
        excluded = tuple(excluded_ids) if excluded_ids else ('00000000-0000-0000-0000-000000000000',)
        cur.execute(f"""
            SELECT id FROM tracks
            WHERE genre = ANY(ARRAY[{placeholders}])
              AND id NOT IN %s
            ORDER BY popularity DESC
            LIMIT %s
        """, (*top_genres, excluded, limit))
        return [r["id"] for r in cur.fetchall()]


# ─── API Endpoints ────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "tapin-ai"}


@app.post("/recommend", response_model=RecommendResponse)
def recommend(req: RecommendRequest):
    """
    Hybrid recommendation pipeline:
    1. Content-based (audio feature similarity) — 60%
    2. Social collaborative filtering — 25%
    3. Genre-weighted popular — 15%
    """
    conn = get_db()
    try:
        profile = get_user_listening_profile(conn, req.user_id)

        # Tracks to exclude (already heard recently)
        excluded_ids = {r["track_id"] for r in profile["history"]}
        excluded_ids |= profile["engaged_ids"]

        # Get stored taste vector / top genres
        with conn.cursor() as cur:
            cur.execute(
                "SELECT vector, top_genres FROM user_taste_vectors WHERE user_id = %s",
                (req.user_id,)
            )
            row = cur.fetchone()

        top_genres = row["top_genres"] if row and row["top_genres"] else []

        user_vector = None
        if row and row["vector"]:
            user_vector = np.array(row["vector"])
        else:
            user_vector = build_user_taste_vector(profile)

        strategy = "hybrid"
        track_ids: list[str] = []

        content_limit = int(req.limit * 0.60)
        social_limit = int(req.limit * 0.25)
        genre_limit = req.limit - content_limit - social_limit

        if user_vector is not None:
            content_ids = content_based_recommendations(
                conn, req.user_id, user_vector, excluded_ids, content_limit, req.offset
            )
            track_ids.extend(content_ids)
        else:
            strategy = "popular"

        social_ids = social_collaborative_filter(conn, req.user_id, excluded_ids | set(track_ids), social_limit)
        track_ids.extend(social_ids)

        genre_ids = genre_weighted_popular(conn, req.user_id, top_genres, excluded_ids | set(track_ids), genre_limit)
        track_ids.extend(genre_ids)

        # If we don't have enough, fill with popular
        if len(track_ids) < req.limit:
            with conn.cursor() as cur:
                already = tuple(excluded_ids | set(track_ids)) or ('00000000-0000-0000-0000-000000000000',)
                cur.execute("""
                    SELECT id FROM tracks
                    WHERE id NOT IN %s
                    ORDER BY popularity DESC
                    LIMIT %s
                """, (already, req.limit - len(track_ids)))
                track_ids.extend([r["id"] for r in cur.fetchall()])
                strategy = "hybrid+popular"

        return RecommendResponse(track_ids=track_ids[:req.limit], strategy=strategy)

    except Exception as e:
        logger.exception("Recommendation error")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@app.post("/internal/rebuild-vector")
def rebuild_vector(req: RebuildVectorRequest, background_tasks: BackgroundTasks):
    """Rebuild and persist user taste vector — called after Spotify sync."""
    background_tasks.add_task(_rebuild_vector_task, req.user_id)
    return {"queued": True}


def _rebuild_vector_task(user_id: str):
    conn = get_db()
    try:
        profile = get_user_listening_profile(conn, user_id)
        vector = build_user_taste_vector(profile)

        if vector is not None:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO user_taste_vectors (user_id, vector, updated_at)
                    VALUES (%s, %s, NOW())
                    ON CONFLICT (user_id) DO UPDATE
                    SET vector = EXCLUDED.vector, updated_at = NOW()
                """, (user_id, vector.tolist()))
            conn.commit()
            logger.info(f"Rebuilt vector for user {user_id}")
    except Exception:
        logger.exception(f"Failed to rebuild vector for user {user_id}")
    finally:
        conn.close()


@app.get("/internal/similar-users/{user_id}")
def similar_users(user_id: str, limit: int = 10):
    """Find users with similar taste vectors — for friend suggestions."""
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT vector FROM user_taste_vectors WHERE user_id = %s",
                (user_id,)
            )
            row = cur.fetchone()

        if not row or not row["vector"]:
            return {"user_ids": []}

        user_vec = np.array(row["vector"])

        with conn.cursor() as cur:
            cur.execute("""
                SELECT user_id, vector FROM user_taste_vectors
                WHERE user_id <> %s AND vector IS NOT NULL
                LIMIT 500
            """, (user_id,))
            others = cur.fetchall()

        scored = []
        for other in others:
            vec = np.array(other["vector"])
            sim = cosine_similarity(user_vec, vec)
            scored.append((other["user_id"], sim))

        scored.sort(key=lambda x: x[1], reverse=True)
        return {"user_ids": [uid for uid, _ in scored[:limit]]}

    finally:
        conn.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
