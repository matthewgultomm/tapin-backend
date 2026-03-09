import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { cacheGet, cacheSet, cacheDel } from '../db/redis.js';
import type { Review } from '../types/index.js';

const router = Router();

const createReviewSchema = z.object({
  track_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  body: z.string().max(1000).default(''),
});

const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  body: z.string().max(1000).optional(),
});

// GET /reviews/track/:trackId
router.get('/track/:trackId', requireAuth, async (req: Request, res: Response) => {
  const cacheKey = `reviews:track:${req.params.trackId}`;
  const cached = await cacheGet<Review[]>(cacheKey);
  if (cached) { res.json(cached); return; }

  const reviews = await query<Review>(
    `SELECT
       r.*,
       u.username, u.display_name, u.avatar_url,
       (SELECT COUNT(*) FROM review_likes WHERE review_id = r.id)::INT AS likes_count,
       EXISTS(SELECT 1 FROM review_likes WHERE user_id = $2 AND review_id = r.id) AS is_liked
     FROM reviews r
     JOIN users u ON r.user_id = u.id
     WHERE r.track_id = $1
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [req.params.trackId, req.user!.id]
  );

  await cacheSet(cacheKey, reviews, 120);
  res.json(reviews);
});

// GET /reviews/user/:username
router.get('/user/:username', requireAuth, async (req: Request, res: Response) => {
  const user = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE username = $1',
    [req.params.username]
  );
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const reviews = await query<Review>(
    `SELECT
       r.*,
       t.title, t.artist, t.album, t.artwork_url, t.genre,
       (SELECT COUNT(*) FROM review_likes WHERE review_id = r.id)::INT AS likes_count,
       EXISTS(SELECT 1 FROM review_likes WHERE user_id = $2 AND review_id = r.id) AS is_liked
     FROM reviews r
     JOIN tracks t ON r.track_id = t.id
     WHERE r.user_id = $1
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [user.id, req.user!.id]
  );

  res.json(reviews);
});

// GET /reviews/feed — reviews from people you follow
router.get('/feed', requireAuth, async (req: Request, res: Response) => {
  const reviews = await query<Review>(
    `SELECT
       r.*,
       u.username, u.display_name, u.avatar_url,
       t.title, t.artist, t.artwork_url,
       (SELECT COUNT(*) FROM review_likes WHERE review_id = r.id)::INT AS likes_count,
       EXISTS(SELECT 1 FROM review_likes WHERE user_id = $1 AND review_id = r.id) AS is_liked
     FROM reviews r
     JOIN users u ON r.user_id = u.id
     JOIN tracks t ON r.track_id = t.id
     WHERE r.user_id IN (
       SELECT followee_id FROM follows WHERE follower_id = $1
     )
     ORDER BY r.created_at DESC
     LIMIT 40`,
    [req.user!.id]
  );
  res.json(reviews);
});

// POST /reviews
router.post('/', requireAuth, validate(createReviewSchema), async (req: Request, res: Response) => {
  const { track_id, rating, body } = req.body;

  const existing = await queryOne(
    'SELECT id FROM reviews WHERE user_id = $1 AND track_id = $2',
    [req.user!.id, track_id]
  );
  if (existing) {
    res.status(409).json({ error: 'You have already reviewed this track. Use PATCH to update.' });
    return;
  }

  const [review] = await query<Review>(
    `INSERT INTO reviews (user_id, track_id, rating, body)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [req.user!.id, track_id, rating, body]
  );

  // Feed event
  await query(
    `INSERT INTO feed_events (user_id, type, track_id, review_id) VALUES ($1, 'review', $2, $3)`,
    [req.user!.id, track_id, review.id]
  );

  // Notify followers
  await query(
    `INSERT INTO notifications (user_id, type, actor_id, entity_id, entity_type)
     SELECT follower_id, 'new_review', $1, $2, 'review'
     FROM follows WHERE followee_id = $1`,
    [req.user!.id, review.id]
  );

  await cacheDel(`reviews:track:${track_id}`);
  res.status(201).json(review);
});

// PATCH /reviews/:id
router.patch('/:id', requireAuth, validate(updateReviewSchema), async (req: Request, res: Response) => {
  const { rating, body } = req.body;

  const fields: string[] = ['is_edited = TRUE', 'updated_at = NOW()'];
  const values: unknown[] = [];
  let i = 1;

  if (rating !== undefined) { fields.push(`rating = $${i++}`); values.push(rating); }
  if (body !== undefined) { fields.push(`body = $${i++}`); values.push(body); }

  values.push(req.user!.id, req.params.id);
  const [review] = await query<Review>(
    `UPDATE reviews SET ${fields.join(', ')}
     WHERE user_id = $${i++} AND id = $${i}
     RETURNING *`,
    values
  );

  if (!review) { res.status(404).json({ error: 'Review not found' }); return; }

  await cacheDel(`reviews:track:${review.track_id}`);
  res.json(review);
});

// DELETE /reviews/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const [review] = await query<Review>(
    'DELETE FROM reviews WHERE id = $1 AND user_id = $2 RETURNING track_id',
    [req.params.id, req.user!.id]
  );
  if (!review) { res.status(404).json({ error: 'Review not found' }); return; }

  await cacheDel(`reviews:track:${review.track_id}`);
  res.json({ deleted: true });
});

// POST /reviews/:id/like
router.post('/:id/like', requireAuth, async (req: Request, res: Response) => {
  await query(
    `INSERT INTO review_likes (user_id, review_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [req.user!.id, req.params.id]
  );

  const review = await queryOne<{ user_id: string }>(
    'SELECT user_id FROM reviews WHERE id = $1',
    [req.params.id]
  );

  if (review && review.user_id !== req.user!.id) {
    await query(
      `INSERT INTO notifications (user_id, type, actor_id, entity_id, entity_type)
       VALUES ($1, 'review_like', $2, $3, 'review')`,
      [review.user_id, req.user!.id, req.params.id]
    );
  }

  res.json({ liked: true });
});

// DELETE /reviews/:id/like
router.delete('/:id/like', requireAuth, async (req: Request, res: Response) => {
  await query(
    'DELETE FROM review_likes WHERE user_id = $1 AND review_id = $2',
    [req.user!.id, req.params.id]
  );
  res.json({ liked: false });
});

export default router;
