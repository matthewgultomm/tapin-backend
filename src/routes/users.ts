import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { cacheGet, cacheSet, cacheDel } from '../db/redis.js';
import type { UserPublic } from '../types/index.js';

const router = Router();

const updateProfileSchema = z.object({
  display_name: z.string().min(1).max(60).optional(),
  bio: z.string().max(200).optional(),
  hometown: z.string().max(100).optional(),
  is_private: z.boolean().optional(),
});

// GET /users/search?q=query
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  const q = (req.query.q as string)?.trim();
  if (!q || q.length < 2) {
    res.json([]);
    return;
  }

  const users = await query<UserPublic>(
    `SELECT
       u.id, u.username, u.display_name, u.bio, u.hometown, u.avatar_url, u.is_private,
       (SELECT COUNT(*) FROM follows WHERE followee_id = u.id)::INT AS followers_count,
       (SELECT COUNT(*) FROM follows WHERE follower_id = u.id)::INT AS following_count,
       EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = u.id) AS is_following
     FROM users u
     WHERE u.id <> $2
       AND (
         u.username ILIKE $1
         OR u.display_name ILIKE $1
         OR similarity(u.username, $3) > 0.2
       )
     ORDER BY similarity(u.username, $3) DESC, u.username
     LIMIT 20`,
    [`%${q}%`, req.user!.id, q]
  );

  res.json(users);
});

// GET /users/:username
router.get('/:username', requireAuth, async (req: Request, res: Response) => {
  const { username } = req.params;
  const cacheKey = `user:${username}`;
  const cached = await cacheGet<UserPublic>(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  const user = await queryOne<UserPublic>(
    `SELECT
       u.id, u.username, u.display_name, u.bio, u.hometown, u.avatar_url, u.is_private,
       (SELECT COUNT(*) FROM follows WHERE followee_id = u.id)::INT AS followers_count,
       (SELECT COUNT(*) FROM follows WHERE follower_id = u.id)::INT AS following_count,
       (SELECT COUNT(*) FROM follows f1
        JOIN follows f2 ON f1.followee_id = f2.follower_id
        WHERE f1.follower_id = u.id AND f2.followee_id = u.id)::INT AS friends_count,
       EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = u.id) AS is_following,
       (SELECT top_genres FROM user_taste_vectors WHERE user_id = u.id) AS top_genres
     FROM users u
     WHERE u.username = $1`,
    [username.toLowerCase(), req.user!.id]
  );

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  await cacheSet(cacheKey, user, 120);
  res.json(user);
});

// PATCH /users/me
router.patch('/me', requireAuth, validate(updateProfileSchema), async (req: Request, res: Response) => {
  const updates = req.body;
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      fields.push(`${key} = $${i++}`);
      values.push(val);
    }
  }

  if (fields.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  values.push(req.user!.id);
  const [user] = await query(
    `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $${i}
     RETURNING id, username, display_name, bio, hometown, avatar_url, is_private`,
    values
  );

  await cacheDel(`user:${req.user!.username}`);
  res.json(user);
});

// POST /users/:username/follow
router.post('/:username/follow', requireAuth, async (req: Request, res: Response) => {
  const target = await queryOne<{ id: string; is_private: boolean }>(
    'SELECT id, is_private FROM users WHERE username = $1',
    [req.params.username]
  );

  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (target.id === req.user!.id) {
    res.status(400).json({ error: 'Cannot follow yourself' });
    return;
  }

  await query(
    `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [req.user!.id, target.id]
  );

  // Notify
  await query(
    `INSERT INTO notifications (user_id, type, actor_id, entity_type)
     VALUES ($1, 'follow', $2, 'user') ON CONFLICT DO NOTHING`,
    [target.id, req.user!.id]
  );

  await cacheDel(`user:${req.params.username}`);
  res.json({ following: true });
});

// DELETE /users/:username/follow
router.delete('/:username/follow', requireAuth, async (req: Request, res: Response) => {
  const target = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE username = $1',
    [req.params.username]
  );

  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  await query(
    'DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2',
    [req.user!.id, target.id]
  );

  await cacheDel(`user:${req.params.username}`);
  res.json({ following: false });
});

// GET /users/:username/followers
router.get('/:username/followers', requireAuth, async (req: Request, res: Response) => {
  const target = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE username = $1',
    [req.params.username]
  );
  if (!target) { res.status(404).json({ error: 'User not found' }); return; }

  const followers = await query<UserPublic>(
    `SELECT u.id, u.username, u.display_name, u.avatar_url,
       EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = u.id) AS is_following
     FROM follows f
     JOIN users u ON f.follower_id = u.id
     WHERE f.followee_id = $1
     ORDER BY f.created_at DESC
     LIMIT 50`,
    [target.id, req.user!.id]
  );
  res.json(followers);
});

// GET /users/:username/following
router.get('/:username/following', requireAuth, async (req: Request, res: Response) => {
  const target = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE username = $1',
    [req.params.username]
  );
  if (!target) { res.status(404).json({ error: 'User not found' }); return; }

  const following = await query<UserPublic>(
    `SELECT u.id, u.username, u.display_name, u.avatar_url,
       EXISTS(SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = u.id) AS is_following
     FROM follows f
     JOIN users u ON f.followee_id = u.id
     WHERE f.follower_id = $1
     ORDER BY f.created_at DESC
     LIMIT 50`,
    [target.id, req.user!.id]
  );
  res.json(following);
});

// POST /users/friend-request/:username
router.post('/friend-request/:username', requireAuth, async (req: Request, res: Response) => {
  const target = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE username = $1',
    [req.params.username]
  );
  if (!target) { res.status(404).json({ error: 'User not found' }); return; }
  if (target.id === req.user!.id) { res.status(400).json({ error: 'Cannot friend yourself' }); return; }

  await query(
    `INSERT INTO friend_requests (sender_id, receiver_id)
     VALUES ($1, $2)
     ON CONFLICT (sender_id, receiver_id) DO NOTHING`,
    [req.user!.id, target.id]
  );

  await query(
    `INSERT INTO notifications (user_id, type, actor_id, entity_type)
     VALUES ($1, 'friend_request', $2, 'user')`,
    [target.id, req.user!.id]
  );

  res.json({ sent: true });
});

// PATCH /users/friend-request/:requestId
router.patch('/friend-request/:requestId', requireAuth, async (req: Request, res: Response) => {
  const { action } = req.body; // 'accept' | 'decline'
  if (!['accept', 'decline'].includes(action)) {
    res.status(400).json({ error: 'action must be accept or decline' });
    return;
  }

  const status = action === 'accept' ? 'accepted' : 'declined';
  const [request] = await query<{ sender_id: string }>(
    `UPDATE friend_requests SET status = $1, updated_at = NOW()
     WHERE id = $2 AND receiver_id = $3
     RETURNING sender_id`,
    [status, req.params.requestId, req.user!.id]
  );

  if (!request) { res.status(404).json({ error: 'Request not found' }); return; }

  if (action === 'accept') {
    // Mutual follow = friends
    await query(
      `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
      [req.user!.id, request.sender_id]
    );
    await query(
      `INSERT INTO notifications (user_id, type, actor_id, entity_type)
       VALUES ($1, 'friend_request_accepted', $2, 'user')`,
      [request.sender_id, req.user!.id]
    );
  }

  res.json({ status });
});

// GET /users/me/friend-requests
router.get('/me/friend-requests', requireAuth, async (req: Request, res: Response) => {
  const inbound = await query(
    `SELECT fr.id, fr.created_at, u.id AS sender_id, u.username, u.display_name, u.avatar_url
     FROM friend_requests fr
     JOIN users u ON fr.sender_id = u.id
     WHERE fr.receiver_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [req.user!.id]
  );

  const outbound = await query(
    `SELECT fr.id, fr.created_at, u.id AS receiver_id, u.username, u.display_name, u.avatar_url
     FROM friend_requests fr
     JOIN users u ON fr.receiver_id = u.id
     WHERE fr.sender_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [req.user!.id]
  );

  res.json({ inbound, outbound });
});

export default router;
