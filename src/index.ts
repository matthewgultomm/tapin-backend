import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import cron from 'node-cron';

import { connectRedis } from './db/redis.js';
import authRoutes from './routes/auth.js';
import spotifyRoutes from './routes/spotify.js';
import usersRoutes from './routes/users.js';
import tracksRoutes from './routes/tracks.js';
import reviewsRoutes from './routes/reviews.js';
import insightsRoutes from './routes/insights.js';
import notificationsRoutes from './routes/notifications.js';
import mediaRoutes from './routes/media.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000');

// ─── Security ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://yourdomain.com', 'tapin://']
    : '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts.' },
});

app.use(globalLimiter);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/auth', authLimiter, authRoutes);
app.use('/spotify', spotifyRoutes);
app.use('/users', usersRoutes);
app.use('/tracks', tracksRoutes);
app.use('/reviews', reviewsRoutes);
app.use('/insights', insightsRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/media', mediaRoutes);

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ─── Scheduled jobs ──────────────────────────────────────────────────────────
// Sync Spotify data for active users every hour
cron.schedule('0 * * * *', async () => {
  console.log('⏰ Running hourly Spotify sync job');
  const { query } = await import('./db/index.js');
  const activeUsers = await query<{ user_id: string; access_token: string; token_expires_at: string }>(
    `SELECT mc.user_id, mc.access_token, mc.token_expires_at
     FROM music_connections mc
     WHERE mc.service = 'spotify'
       AND mc.user_id IN (
         SELECT DISTINCT user_id FROM listening_history
         WHERE played_at > NOW() - INTERVAL '24 hours'
       )`,
    []
  );
  console.log(`Syncing ${activeUsers.length} active Spotify users`);
  // Individual syncs are handled by spotify.ts syncSpotifyData
});

// Clean up expired refresh tokens daily at 3AM
cron.schedule('0 3 * * *', async () => {
  const { query } = await import('./db/index.js');
  const result = await query('DELETE FROM refresh_tokens WHERE expires_at < NOW() RETURNING id', []);
  console.log(`🗑️  Cleaned up ${result.length} expired refresh tokens`);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  await connectRedis();
  app.listen(PORT, () => {
    console.log(`🚀 TapIn API running on port ${PORT} (${process.env.NODE_ENV ?? 'development'})`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
