-- TapIn Database Schema
-- Run: npm run db:migrate

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for fuzzy search

-- ─────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      TEXT UNIQUE NOT NULL CHECK (char_length(username) BETWEEN 2 AND 30),
  display_name  TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  email         TEXT UNIQUE,
  password_hash TEXT,
  bio           TEXT DEFAULT '',
  hometown      TEXT DEFAULT '',
  avatar_url    TEXT,
  is_private    BOOLEAN DEFAULT FALSE,
  push_token    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_username_trgm ON users USING GIN (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_display_name_trgm ON users USING GIN (display_name gin_trgm_ops);

-- ─────────────────────────────────────────
-- REFRESH TOKENS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- MUSIC SERVICE CONNECTIONS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS music_connections (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service         TEXT NOT NULL CHECK (service IN ('spotify', 'apple_music', 'tidal')),
  access_token    TEXT,
  refresh_token   TEXT,
  token_expires_at TIMESTAMPTZ,
  spotify_user_id TEXT,
  scopes          TEXT[],
  connected_at    TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at  TIMESTAMPTZ,
  UNIQUE (user_id, service)
);

-- ─────────────────────────────────────────
-- TRACKS (catalog cache)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tracks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  spotify_id      TEXT UNIQUE,
  apple_music_id  TEXT UNIQUE,
  title           TEXT NOT NULL,
  artist          TEXT NOT NULL,
  album           TEXT NOT NULL DEFAULT '',
  genre           TEXT DEFAULT 'Music',
  release_year    INT,
  artwork_url     TEXT,
  preview_url     TEXT,
  duration_ms     INT,
  tempo           FLOAT,
  energy          FLOAT,       -- 0.0–1.0 Spotify audio feature
  valence         FLOAT,       -- 0.0–1.0 (mood positivity)
  danceability    FLOAT,
  acousticness    FLOAT,
  instrumentalness FLOAT,
  popularity      INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tracks_spotify_id ON tracks(spotify_id);
CREATE INDEX IF NOT EXISTS tracks_apple_music_id ON tracks(apple_music_id);
CREATE INDEX IF NOT EXISTS tracks_title_trgm ON tracks USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS tracks_artist_trgm ON tracks USING GIN (artist gin_trgm_ops);

-- ─────────────────────────────────────────
-- REVIEWS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id     UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body         TEXT DEFAULT '',
  is_edited    BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS reviews_track_id ON reviews(track_id);
CREATE INDEX IF NOT EXISTS reviews_user_id ON reviews(user_id);

-- Review likes
CREATE TABLE IF NOT EXISTS review_likes (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_id  UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, review_id)
);

-- ─────────────────────────────────────────
-- SAVES & LIKES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS track_saves (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, track_id)
);

CREATE TABLE IF NOT EXISTS track_likes (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, track_id)
);

-- ─────────────────────────────────────────
-- LISTENING HISTORY
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listening_history (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id    UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at   TIMESTAMPTZ NOT NULL,
  duration_ms INT,           -- how long they actually listened
  source      TEXT DEFAULT 'spotify' -- 'spotify' | 'apple_music' | 'in_app'
);

CREATE INDEX IF NOT EXISTS listening_history_user_id ON listening_history(user_id);
CREATE INDEX IF NOT EXISTS listening_history_played_at ON listening_history(played_at DESC);

-- ─────────────────────────────────────────
-- SOCIAL GRAPH
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee_id);

-- Friend requests (bidirectional follow = friends)
CREATE TABLE IF NOT EXISTS friend_requests (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (sender_id, receiver_id),
  CHECK (sender_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS friend_requests_receiver ON friend_requests(receiver_id, status);

-- ─────────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL, -- 'follow', 'friend_request', 'review_like', 'new_review'
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  entity_id   UUID,          -- review_id, track_id, etc.
  entity_type TEXT,          -- 'review', 'track', 'user'
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_id ON notifications(user_id, is_read, created_at DESC);

-- ─────────────────────────────────────────
-- FEED EVENTS (for activity feed)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feed_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL, -- 'review', 'save', 'like'
  track_id    UUID REFERENCES tracks(id) ON DELETE CASCADE,
  review_id   UUID REFERENCES reviews(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feed_events_user_id ON feed_events(user_id, created_at DESC);

-- ─────────────────────────────────────────
-- USER RECOMMENDATION VECTORS (AI service writes here)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_taste_vectors (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vector        FLOAT[],     -- embedding from AI service
  top_genres    TEXT[],
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- HELPER: updated_at trigger
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER tracks_updated_at
  BEFORE UPDATE ON tracks FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER reviews_updated_at
  BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION update_updated_at();
