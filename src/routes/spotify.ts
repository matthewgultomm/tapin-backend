import { Router, Request, Response } from 'express';
import axios from 'axios';
import { z } from 'zod';
import { query, queryOne } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { cacheSet, cacheGet } from '../db/redis.js';
import type { Track } from '../types/index.js';

const router = Router();

const exchangeSchema = z.object({
  code: z.string(),
  code_verifier: z.string(),
  redirect_uri: z.string(),
});

const refreshSchema = z.object({
  refresh_token: z.string().optional(),
});

// POST /spotify/exchange
// Exchanges PKCE auth code for tokens — client secret never leaves server
router.post('/exchange', requireAuth, validate(exchangeSchema), async (req: Request, res: Response) => {
  const { code, code_verifier, redirect_uri } = req.body;

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri,
      client_id: process.env.SPOTIFY_CLIENT_ID!,
      code_verifier,
    });

    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: {
          username: process.env.SPOTIFY_CLIENT_ID!,
          password: process.env.SPOTIFY_CLIENT_SECRET!,
        },
      }
    );

    const { access_token, refresh_token, expires_in, scope } = tokenRes.data;

    // Get Spotify profile
    const profileRes = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const spotifyUser = profileRes.data;

    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
    const scopes = (scope as string).split(' ');

    await query(
      `INSERT INTO music_connections
         (user_id, service, access_token, refresh_token, token_expires_at, spotify_user_id, scopes)
       VALUES ($1, 'spotify', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, service)
       DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         spotify_user_id = EXCLUDED.spotify_user_id,
         scopes = EXCLUDED.scopes`,
      [req.user!.id, access_token, refresh_token, expiresAt, spotifyUser.id, scopes]
    );

    // Kick off initial sync in background
    syncSpotifyData(req.user!.id, access_token).catch(console.error);

    res.json({
      connected: true,
      spotify_display_name: spotifyUser.display_name,
      spotify_id: spotifyUser.id,
    });
  } catch (err: unknown) {
    const error = err as { response?: { data: unknown } };
    console.error('Spotify exchange error:', error.response?.data ?? err);
    res.status(400).json({ error: 'Failed to exchange Spotify token' });
  }
});

// POST /spotify/refresh
router.post('/refresh', requireAuth, async (req: Request, res: Response) => {
  const conn = await queryOne<{ refresh_token: string }>(
    `SELECT refresh_token FROM music_connections
     WHERE user_id = $1 AND service = 'spotify'`,
    [req.user!.id]
  );

  if (!conn?.refresh_token) {
    res.status(404).json({ error: 'No Spotify connection found' });
    return;
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: conn.refresh_token,
      client_id: process.env.SPOTIFY_CLIENT_ID!,
    });

    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: {
          username: process.env.SPOTIFY_CLIENT_ID!,
          password: process.env.SPOTIFY_CLIENT_SECRET!,
        },
      }
    );

    const { access_token, refresh_token: newRefresh, expires_in } = tokenRes.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    await query(
      `UPDATE music_connections
       SET access_token = $1,
           refresh_token = COALESCE($2, refresh_token),
           token_expires_at = $3
       WHERE user_id = $4 AND service = 'spotify'`,
      [access_token, newRefresh ?? null, expiresAt, req.user!.id]
    );

    res.json({ access_token, expires_in });
  } catch {
    res.status(400).json({ error: 'Failed to refresh Spotify token' });
  }
});

// GET /spotify/status
router.get('/status', requireAuth, async (req: Request, res: Response) => {
  const conn = await queryOne(
    `SELECT service, spotify_user_id, scopes, connected_at, last_synced_at, token_expires_at
     FROM music_connections
     WHERE user_id = $1 AND service = 'spotify'`,
    [req.user!.id]
  );
  res.json({ connected: !!conn, connection: conn });
});

// POST /spotify/sync  — manually trigger a data sync
router.post('/sync', requireAuth, async (req: Request, res: Response) => {
  const conn = await queryOne<{ access_token: string; token_expires_at: string }>(
    `SELECT access_token, token_expires_at FROM music_connections
     WHERE user_id = $1 AND service = 'spotify'`,
    [req.user!.id]
  );

  if (!conn) {
    res.status(404).json({ error: 'No Spotify connection' });
    return;
  }

  // Check if token needs refresh
  let token = conn.access_token;
  if (new Date(conn.token_expires_at) < new Date()) {
    const refreshRes = await axios.post(
      `${process.env.AI_SERVICE_URL ?? 'http://localhost:8000'}/internal/spotify-refresh`,
      { user_id: req.user!.id }
    ).catch(() => null);
    token = refreshRes?.data?.access_token ?? token;
  }

  // Run sync in background, return immediately
  res.json({ message: 'Sync started' });
  syncSpotifyData(req.user!.id, token).catch(console.error);
});

// DELETE /spotify/disconnect
router.delete('/disconnect', requireAuth, async (req: Request, res: Response) => {
  await query(
    `DELETE FROM music_connections WHERE user_id = $1 AND service = 'spotify'`,
    [req.user!.id]
  );
  res.json({ disconnected: true });
});

// ─── Internal sync function ───────────────────────────────────────────────────

async function syncSpotifyData(userId: string, accessToken: string) {
  try {
    // 1. Recent listening history (last 50 tracks)
    const recentRes = await axios.get(
      'https://api.spotify.com/v1/me/player/recently-played?limit=50',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    for (const item of recentRes.data.items) {
      const song = item.track;
      if (!song?.id) continue;

      // Upsert track
      const [track] = await query<Track>(
        `INSERT INTO tracks (spotify_id, title, artist, album, artwork_url, preview_url, duration_ms, popularity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (spotify_id) DO UPDATE SET
           popularity = EXCLUDED.popularity,
           updated_at = NOW()
         RETURNING id`,
        [
          song.id,
          song.name,
          song.artists[0]?.name ?? 'Unknown',
          song.album?.name ?? '',
          song.album?.images?.[0]?.url ?? null,
          song.preview_url ?? null,
          song.duration_ms ?? null,
          song.popularity ?? 0,
        ]
      );

      // Insert listening event (ignore duplicates within 30s)
      await query(
        `INSERT INTO listening_history (user_id, track_id, played_at, source)
         VALUES ($1, $2, $3, 'spotify')
         ON CONFLICT DO NOTHING`,
        [userId, track.id, item.played_at]
      );
    }

    // 2. Fetch audio features for all new tracks in batch
    const trackSpotifyIds = recentRes.data.items
      .map((i: { track: { id: string } }) => i.track?.id)
      .filter(Boolean)
      .slice(0, 100)
      .join(',');

    if (trackSpotifyIds) {
      const featuresRes = await axios.get(
        `https://api.spotify.com/v1/audio-features?ids=${trackSpotifyIds}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      for (const feat of featuresRes.data.audio_features ?? []) {
        if (!feat) continue;
        await query(
          `UPDATE tracks SET
             tempo = $1, energy = $2, valence = $3,
             danceability = $4, acousticness = $5, instrumentalness = $6
           WHERE spotify_id = $7`,
          [feat.tempo, feat.energy, feat.valence, feat.danceability, feat.acousticness, feat.instrumentalness, feat.id]
        );
      }
    }

    // 3. Top artists → derive genre tags for taste vector
    const topArtistsRes = await axios.get(
      'https://api.spotify.com/v1/me/top/artists?limit=20&time_range=medium_term',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const genres: string[] = topArtistsRes.data.items.flatMap((a: { genres: string[] }) => a.genres);
    const topGenres = [...new Set(genres)].slice(0, 8);

    await query(
      `INSERT INTO user_taste_vectors (user_id, top_genres, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET top_genres = $2, updated_at = NOW()`,
      [userId, topGenres]
    );

    // 4. Mark last synced
    await query(
      `UPDATE music_connections SET last_synced_at = NOW() WHERE user_id = $1 AND service = 'spotify'`,
      [userId]
    );

    // 5. Trigger AI recommendation rebuild
    await axios.post(`${process.env.AI_SERVICE_URL}/internal/rebuild-vector`, { user_id: userId })
      .catch(() => null);

    // Invalidate feed cache
    await cacheSet(`feed:${userId}:dirty`, true, 60);

    console.log(`✅ Spotify sync complete for user ${userId}`);
  } catch (err) {
    console.error(`Spotify sync failed for user ${userId}:`, err);
  }
}

export default router;
