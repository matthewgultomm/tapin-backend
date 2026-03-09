import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { cacheGet, cacheSet } from '../db/redis.js';
import type { InsightStats, Track } from '../types/index.js';

const router = Router();

// GET /insights/stats — weekly listening stats
router.get('/stats', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const cacheKey = `insights:stats:${userId}`;
  const cached = await cacheGet<InsightStats>(cacheKey);
  if (cached) { res.json(cached); return; }

  // Total listen time this week
  const [timeRow] = await query<{ total_ms: string }>(
    `SELECT COALESCE(SUM(duration_ms), 0) AS total_ms
     FROM listening_history
     WHERE user_id = $1 AND played_at > NOW() - INTERVAL '7 days'`,
    [userId]
  );
  const totalMinutes = Math.round(parseInt(timeRow?.total_ms ?? '0') / 60000);

  // Top genre
  const [topGenreRow] = await query<{ genre: string; count: string }>(
    `SELECT t.genre, COUNT(*) AS count
     FROM listening_history lh
     JOIN tracks t ON lh.track_id = t.id
     WHERE lh.user_id = $1 AND lh.played_at > NOW() - INTERVAL '30 days'
     GROUP BY t.genre
     ORDER BY count DESC
     LIMIT 1`,
    [userId]
  );

  // Most active hour for top genre
  const [hourRow] = await query<{ hour: string }>(
    `SELECT EXTRACT(HOUR FROM lh.played_at) AS hour
     FROM listening_history lh
     JOIN tracks t ON lh.track_id = t.id
     WHERE lh.user_id = $1 AND t.genre = $2
     GROUP BY hour
     ORDER BY COUNT(*) DESC
     LIMIT 1`,
    [userId, topGenreRow?.genre ?? '']
  );
  const activeHour = hourRow?.hour ? formatHour(parseInt(hourRow.hour)) : 'evening';

  // Most played track this month
  const [mostPlayedRow] = await query<{ track_id: string; play_count: string }>(
    `SELECT track_id, COUNT(*) AS play_count
     FROM listening_history
     WHERE user_id = $1 AND played_at > NOW() - INTERVAL '30 days'
     GROUP BY track_id
     ORDER BY play_count DESC
     LIMIT 1`,
    [userId]
  );

  let mostPlayedTrack: Track | null = null;
  if (mostPlayedRow) {
    mostPlayedTrack = await queryOne<Track>(
      'SELECT id, title, artist, album, artwork_url FROM tracks WHERE id = $1',
      [mostPlayedRow.track_id]
    );
  }

  // Discovery save rate — tracks saved within 24h of first listen
  const [saveRateRow] = await query<{ saved: string; total: string }>(
    `SELECT
       COUNT(DISTINCT ts.track_id) FILTER (WHERE ts.created_at IS NOT NULL) AS saved,
       COUNT(DISTINCT lh.track_id) AS total
     FROM listening_history lh
     LEFT JOIN track_saves ts ON ts.track_id = lh.track_id
       AND ts.user_id = lh.user_id
       AND ts.created_at < lh.played_at + INTERVAL '24 hours'
     WHERE lh.user_id = $1 AND lh.played_at > NOW() - INTERVAL '30 days'`,
    [userId]
  );
  const totalDiscovered = parseInt(saveRateRow?.total ?? '1');
  const savedCount = parseInt(saveRateRow?.saved ?? '0');
  const saveRate = totalDiscovered > 0 ? Math.round((savedCount / totalDiscovered) * 100) : 0;

  // Tracks reviewed
  const [reviewedRow] = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM reviews WHERE user_id = $1`,
    [userId]
  );

  const stats: InsightStats = {
    total_minutes_this_week: totalMinutes,
    top_genre: topGenreRow?.genre ?? 'Unknown',
    top_genre_active_hours: activeHour,
    most_played_track: mostPlayedTrack ?? undefined,
    most_played_count: parseInt(mostPlayedRow?.play_count ?? '0'),
    discovery_save_rate: saveRate,
    tracks_saved: savedCount,
    tracks_reviewed: parseInt(reviewedRow?.count ?? '0'),
  };

  await cacheSet(cacheKey, stats, 600); // 10min cache
  res.json(stats);
});

// GET /insights/recap — weekly email-ready recap
router.get('/recap', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const topTracks = await query(
    `SELECT t.title, t.artist, t.artwork_url, COUNT(*) AS plays
     FROM listening_history lh
     JOIN tracks t ON lh.track_id = t.id
     WHERE lh.user_id = $1 AND lh.played_at > NOW() - INTERVAL '7 days'
     GROUP BY t.id
     ORDER BY plays DESC
     LIMIT 5`,
    [userId]
  );

  const topArtists = await query(
    `SELECT t.artist, COUNT(*) AS plays
     FROM listening_history lh
     JOIN tracks t ON lh.track_id = t.id
     WHERE lh.user_id = $1 AND lh.played_at > NOW() - INTERVAL '7 days'
     GROUP BY t.artist
     ORDER BY plays DESC
     LIMIT 5`,
    [userId]
  );

  const recentReviews = await query(
    `SELECT r.rating, r.body, t.title, t.artist, r.created_at
     FROM reviews r
     JOIN tracks t ON r.track_id = t.id
     WHERE r.user_id = $1 AND r.created_at > NOW() - INTERVAL '7 days'
     ORDER BY r.created_at DESC
     LIMIT 5`,
    [userId]
  );

  const friendActivity = await query(
    `SELECT u.username, u.display_name, t.title, t.artist, r.rating, r.body, r.created_at
     FROM reviews r
     JOIN users u ON r.user_id = u.id
     JOIN tracks t ON r.track_id = t.id
     WHERE r.user_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
       AND r.created_at > NOW() - INTERVAL '7 days'
     ORDER BY r.created_at DESC
     LIMIT 10`,
    [userId]
  );

  res.json({
    week_ending: new Date().toISOString(),
    top_tracks: topTracks,
    top_artists: topArtists,
    your_reviews: recentReviews,
    friend_activity: friendActivity,
  });
});

// GET /insights/mood — mood trends based on audio features
router.get('/mood', requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const hourlyMood = await query(
    `SELECT
       EXTRACT(HOUR FROM lh.played_at) AS hour,
       AVG(t.energy) AS avg_energy,
       AVG(t.valence) AS avg_valence,
       AVG(t.tempo) AS avg_tempo,
       COUNT(*) AS track_count
     FROM listening_history lh
     JOIN tracks t ON lh.track_id = t.id
     WHERE lh.user_id = $1
       AND lh.played_at > NOW() - INTERVAL '30 days'
       AND t.energy IS NOT NULL
     GROUP BY hour
     ORDER BY hour`,
    [userId]
  );

  const genreSplit = await query(
    `SELECT t.genre, COUNT(*) AS plays,
       AVG(t.energy) AS avg_energy,
       AVG(t.valence) AS avg_valence
     FROM listening_history lh
     JOIN tracks t ON lh.track_id = t.id
     WHERE lh.user_id = $1 AND lh.played_at > NOW() - INTERVAL '30 days'
     GROUP BY t.genre
     ORDER BY plays DESC
     LIMIT 8`,
    [userId]
  );

  res.json({ hourly_mood: hourlyMood, genre_split: genreSplit });
});

function formatHour(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'late night';
}

export default router;
