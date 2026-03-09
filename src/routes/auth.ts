import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../db/index.js';
import { generateTokens, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import type { User } from '../types/index.js';

const router = Router();

const signUpSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(30)
    .regex(/^[a-z0-9._]+$/, 'Username can only contain lowercase letters, numbers, dots, and underscores'),
  display_name: z.string().min(1).max(60),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  bio: z.string().max(200).default(''),
  hometown: z.string().max(100).default(''),
});

const signInSchema = z.object({
  username: z.string(),
  password: z.string().optional(),
});

const refreshSchema = z.object({
  refresh_token: z.string(),
});

// POST /auth/signup
router.post('/signup', validate(signUpSchema), async (req: Request, res: Response) => {
  const { username, display_name, email, password, bio, hometown } = req.body;

  const existing = await queryOne<User>('SELECT id FROM users WHERE username = $1', [username]);
  if (existing) {
    res.status(409).json({ error: 'Username already taken' });
    return;
  }

  if (email) {
    const emailExists = await queryOne<User>('SELECT id FROM users WHERE email = $1', [email]);
    if (emailExists) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
  }

  const password_hash = password ? await bcrypt.hash(password, 12) : null;

  const [user] = await query<User>(
    `INSERT INTO users (username, display_name, email, password_hash, bio, hometown)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, username, display_name, email, bio, hometown, avatar_url, is_private, created_at`,
    [username, display_name, email ?? null, password_hash, bio, hometown]
  );

  const { accessToken, refreshToken } = generateTokens(user.id, user.username);

  // Store refresh token
  await query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [user.id, refreshToken]
  );

  res.status(201).json({ user, access_token: accessToken, refresh_token: refreshToken });
});

// POST /auth/signin
router.post('/signin', validate(signInSchema), async (req: Request, res: Response) => {
  const { username, password } = req.body;

  const user = await queryOne<User & { password_hash?: string }>(
    'SELECT * FROM users WHERE username = $1',
    [username.toLowerCase().trim()]
  );

  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // Password check (optional — app currently uses username-only auth)
  if (user.password_hash && password) {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
  }

  const { accessToken, refreshToken } = generateTokens(user.id, user.username);

  await query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [user.id, refreshToken]
  );

  const { password_hash: _, ...safeUser } = user;
  res.json({ user: safeUser, access_token: accessToken, refresh_token: refreshToken });
});

// POST /auth/refresh
router.post('/refresh', validate(refreshSchema), async (req: Request, res: Response) => {
  const { refresh_token } = req.body;

  const stored = await queryOne<{ user_id: string; expires_at: string }>(
    `SELECT user_id, expires_at FROM refresh_tokens
     WHERE token = $1 AND expires_at > NOW()`,
    [refresh_token]
  );

  if (!stored) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
    return;
  }

  const user = await queryOne<User>('SELECT * FROM users WHERE id = $1', [stored.user_id]);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  // Rotate refresh token
  await query('DELETE FROM refresh_tokens WHERE token = $1', [refresh_token]);
  const { accessToken, refreshToken: newRefresh } = generateTokens(user.id, user.username);
  await query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [user.id, newRefresh]
  );

  res.json({ access_token: accessToken, refresh_token: newRefresh });
});

// POST /auth/signout
router.post('/signout', requireAuth, async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    await query('DELETE FROM refresh_tokens WHERE token = $1', [refresh_token]);
  }
  res.json({ success: true });
});

// GET /auth/me
router.get('/me', requireAuth, (req: Request, res: Response) => {
  const { password_hash: _, ...safeUser } = req.user as User & { password_hash?: string };
  res.json(safeUser);
});

export default router;
