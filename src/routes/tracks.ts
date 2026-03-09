import { Router, Request, Response } from 'express';
import axios from 'axios';
import { z } from 'zod';
import { query, queryOne } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { cacheGet, cacheSet } from '../db/redis.js';
import type { Track } from '../types/index.js';

const router = Router();

const upsertTrackSchema = z.object({
  spotify_id: z.string().optional(),
  apple_music_id: z.string().optional(),
  title: z.string(),
  artist: z.string(),
  album: z.string().default(''),
  genre: z.string().default('Music'),
  release_year: z.number().int().optional(),
  artwork_url: z.string().url().optional(),
  preview_url: z.string().url().optional(),
  duration_ms: z.number().int().optional(),
});

// GET /tracks/search?q=...
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  const q = (req.query.q as string)?.trim();
  if (!q) { res.json([]); return; }

  const cacheKey = `search:tracks:${q.toLowerCase()}`;
  const cached = await cacheGet<Track[]>(cacheKey);
  if (cached) { res.json(cached); return; }

  const tracks = await query<Track>(
    `SELECT t.*,
       (SELECT COUNT(*) FROM reviews WHERE track_id = t.id)::INT AS review_count,
       (SELECT AVG(rating) FROM reviews WHERE track_id = t.id) AS avg_rating,
       (SELECT COUNT(*) FROM track_saves WHERE track_id = t.id)::INT AS saves_count
     FROM tracks t
     WHERE t.title ILIKE $1 OR t.artist ILIKE $1 OR t.album ILIKE $1
     ORDER BY t.popularity DESC
     LIMIT 25`,
    [`%${q}%`]
  );

  await cacheSet(cacheKey, tracks, 180);
  res.json(tracks);
});

// GET /tracks/feed — AI-powered personalized feed
router.get('/feed', requireAuth, async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 0;
  const limit = 20;
  const cacheKey = `feed:${req.user!.id}:${page}`;

  if (page === 0) {
    const cached = await cacheGet<Track[]>(cacheKey);
    if (cached) { res.json(cached); return; }
  }

  try {
    // Ask AI service for recommendations
    const aiRes = await axios.post(
      `${process.env.AI_SERVICE_URL}/recommend`,
      { user_id: req.user!.id, limit, offset: page * limit },
      { timeout: 3000 }
    );
    const recommendedIds: string[] = aiRes.data.track_ids ?? [];

    if (recommendedIds.length > 0) {
      const placeholders = recommendedIds.map((_, i) => `$${i + 2}`).join(', ');
      const tracks = await query<Track>(
        `SELECT t.*,
           (SELECT COUNT(*) FROM reviews WHERE track_id = t.id)::INT AS review_count,
           (SELECT AVG(rating) FROM reviews WHERE track_id = t.id)::FLOAT AS avg_rating,
           (SELECT COUNT(*) FROM track_saves WHERE track_id = t.id)::INT AS saves_count,
           EXISTS(SELECT 1 FROM track_saves WHERE user_id = $1 AND track_id = t.id) AS is_saved,
           EXISTS(SELECT 1 FROM track_likes WHERE user_id = $1 AND track_id = t.id) AS is_liked
         FROM tracks t
         WHERE t.id IN (${placeholders})`,
        [req.user!.id, ...recommendedIds]
      );

      // Sort by AI order
      const ordered = recommendedIds
        .map((id) => tracks.find((t) => t.id === id))
        .filter(Boolean) as Track[];

      if (page === 0) await cacheSet(cacheKey, ordered, 300);
      res.json(ordered);
      return;
    }
  } catch {
    // AI service unavailable — fall back to popularity
  }

  // Fallback: popular tracks user hasn't interacted with
  const tracks = await query<Track>(
    `SELECT t.*,
       (SELECT COUNT(*) FROM reviews WHERE track_id = t.id)::INT AS review_count,
       (SELECT AVG(rating) FROM reviews WHERE track_id = t.id)::FLOAT AS avg_rating,
       (SELECT COUNT(*) FROM track_saves WHERE track_id = t.id)::INT AS saves_count,
       EXISTS(SELECT 1 FROM track_saves WHERE user_id = $1 AND track_id = t.id) AS is_saved,
       EXISTS(SELECT 1 FROM track_likes WHERE user_id = $1 AND track_id = t.id) AS is_liked
     FROM tracks t
     WHERE NOT EXISTS (
       SELECT 1 FROM listening_history lh WHERE lh.user_id = $1 AND lh.track_id = t.id
     )
     ORDER BY t.popularity DESC, RANDOM()
     LIMIT $2 OFFSET $3`,
    [req.user!.id, limit, page * limit]
  );

  if (page === 0) await cacheSet(cacheKey, tracks, 180);
  res.json(tracks);
});

// GET /tracks/friends-feed — what friends are listening to
router.get('/friends-feed', requireAuth, async (req: Request, res: Response) => {
  const tracks = await query(
    `SELECT DISTINCT ON (t.id)
       t.*,
       u.username AS friend_username,
       u.display_name AS friend_display_name,
       lh.played_at AS friend_played_at
     FROM listening_history lh
     JOIN tracks t ON lh.track_id = t.id
     JOIN users u ON lh.user_id = u.id
     WHERE lh.user_id IN (
       SELECT followee_id FROM follows WHERE follower_id = $1
     )
     AND lh.played_at > NOW() - INTERVAL '7 days'
     ORDER BY t.id, lh.played_at DESC
     LIMIT 30`,
    [req.user!.id]
  );
  res.json(tracks);
});

// GET /tracks/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const cacheKey = `track:${req.params.id}`;
  const cached = await cacheGet<Track>(cacheKey);
  if (cached) { res.json(cached); return; }

  const track = await queryOne<Track>(
    `SELECT t.*,
       (SELECT COUNT(*) FROM reviews WHERE track_id = t.id)::INT AS review_count,
       (SELECT AVG(rating) FROM reviews WHERE track_id = t.id)::FLOAT AS avg_rating,
       (SELECT COUNT(*) FROM track_saves WHERE track_id = t.id)::INT AS saves_count,
       (SELECT COUNT(*) FROM track_likes WHERE track_id = t.id)::INT AS likes_count,
       EXISTS(SELECT 1 FROM track_saves WHERE user_id = $2 AND track_id = t.id) AS is_saved,
       EXISTS(SELECT 1 FROM track_likes WHERE user_id = $2 AND track_id = t.id) AS is_liked
     FROM tracks t WHERE t.id = $1`,
    [req.params.id, req.user!.id]
  );

  if (!track) { res.status(404).json({ error: 'Track not found' }); return; }
  await cacheSet(cacheKey, track, 300);
  res.json(track);
});

// POST /tracks — upsert track from client (when user interacts with an Apple Music track)
router.post('/', requireAuth, validate(upsertTrackSchema), async (req: Request, res: Response) => {
  const t = req.body;

  const conflictClause = t.spotify_id
    ? 'ON CONFLICT (spotify_id) DO UPDATE SET popularity = GREATEST(tracks.popularity, EXCLUDED.popularity), updated_at = NOW()'
    : t.apple_music_id
    ? 'ON CONFLICT (apple_music_id) DO UPDATE SET popularity = GREATEST(tracks.popularity, EXCLUDED.popularity), updated_at = NOW()'
    : 'ON CONFLICT DO NOTHING';

  const [track] = await query<Track>(
    `INSERT INTO tracks (spotify_id, apple_music_id, title, artist, album, genre, release_year, artwork_url, preview_url, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ${conflictClause}
     RETURNING *`,
    [t.spotify_id ?? null, t.apple_music_id ?? null, t.title, t.artist, t.album, t.genre, t.release_year ?? null, t.artwork_url ?? null, t.preview_url ?? null, t.duration_ms ?? null]
  );

  res.status(201).json(track);
});

// POST /tracks/:id/save
router.post('/:id/save', requireAuth, async (req: Request, res: Response) => {
  await query(
    `INSERT INTO track_saves (user_id, track_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [req.user!.id, req.params.id]
  );
  await query(
    `INSERT INTO feed_events (user_id, type, track_id) VALUES ($1, 'save', $2)`,
    [req.user!.id, req.params.id]
  );
  res.json({ saved: true });
});

// DELETE /tracks/:id/save
router.delete('/:id/save', requireAuth, async (req: Request, res: Response) => {
  await query(
    'DELETE FROM track_saves WHERE user_id = $1 AND track_id = $2',
    [req.user!.id, req.params.id]
  );
  res.json({ saved: false });
});

// POST /tracks/:id/like
router.post('/:id/like', requireAuth, async (req: Request, res: Response) => {
  await query(
    `INSERT INTO track_likes (user_id, track_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [req.user!.id, req.params.id]
  );
  await query(
    `INSERT INTO feed_events (user_id, type, track_id) VALUES ($1, 'like', $2)`,
    [req.user!.id, req.params.id]
  );
  res.json({ liked: true });
});

// DELETE /tracks/:id/like
router.delete('/:id/like', requireAuth, async (req: Request, res: Response) => {
  await query(
    'DELETE FROM track_likes WHERE user_id = $1 AND track_id = $2',
    [req.user!.id, req.params.id]
  );
  res.json({ liked: false });
});

// POST /tracks/:id/play — log in-app playback
router.post('/:id/play', requireAuth, async (req: Request, res: Response) => {
  const { duration_ms } = req.body;
  await query(
    `INSERT INTO listening_history (user_id, track_id, played_at, duration_ms, source)
     VALUES ($1, $2, NOW(), $3, 'in_app')`,
    [req.user!.id, req.params.id, duration_ms ?? null]
  );
  res.json({ logged: true });
});

export default router;
