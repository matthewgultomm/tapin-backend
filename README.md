# TapIn Backend

Node.js + Express + PostgreSQL + Redis API, with a Python/FastAPI AI recommendation microservice.

---

## Stack

| Layer | Tech |
|---|---|
| API server | Node.js 20, Express, TypeScript |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Auth | JWT (access + refresh token rotation) |
| AI service | Python 3.12, FastAPI, NumPy |
| Media | AWS S3 |
| Container | Docker + Docker Compose |

---

## Quick Start (local)

### 1. Clone and install

```bash
cd tapin-backend
npm install
cp .env.example .env   # fill in your secrets
```

### 2. Start infrastructure

```bash
docker compose up postgres redis -d
```

### 3. Run migrations

```bash
npm run db:migrate
```

### 4. Start both services

```bash
# Terminal 1 — API
npm run dev

# Terminal 2 — AI service
cd ai-service
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Or run everything at once:

```bash
docker compose up --build
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret for access tokens (min 32 chars) |
| `JWT_REFRESH_SECRET` | Secret for refresh tokens |
| `SPOTIFY_CLIENT_ID` | From Spotify Developer Dashboard |
| `SPOTIFY_CLIENT_SECRET` | From Spotify Developer Dashboard |
| `AWS_ACCESS_KEY_ID` | For S3 avatar uploads |
| `AWS_SECRET_ACCESS_KEY` | For S3 avatar uploads |
| `AWS_S3_BUCKET` | Your S3 bucket name |
| `AI_SERVICE_URL` | URL of the Python AI service |

---

## API Reference

All protected routes require `Authorization: Bearer <access_token>`.

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/signup` | ✗ | Create account |
| POST | `/auth/signin` | ✗ | Sign in, get tokens |
| POST | `/auth/refresh` | ✗ | Rotate refresh token |
| POST | `/auth/signout` | ✓ | Revoke refresh token |
| GET | `/auth/me` | ✓ | Get current user |

**Sign up body:**
```json
{
  "username": "nighttape",
  "display_name": "Maya Brooks",
  "bio": "Late-night listener.",
  "hometown": "Chicago, IL"
}
```

**Response:**
```json
{
  "user": { "id": "...", "username": "nighttape", ... },
  "access_token": "eyJ...",
  "refresh_token": "eyJ..."
}
```

---

### Spotify

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/spotify/exchange` | ✓ | Exchange PKCE code for tokens |
| POST | `/spotify/refresh` | ✓ | Refresh Spotify access token |
| GET | `/spotify/status` | ✓ | Connection status |
| POST | `/spotify/sync` | ✓ | Trigger manual data sync |
| DELETE | `/spotify/disconnect` | ✓ | Remove Spotify connection |

**iOS PKCE flow:**
```swift
// 1. Generate code verifier + challenge in app
// 2. Open Spotify auth URL in ASWebAuthenticationSession
// 3. Handle tapin://spotify-callback?code=...
// 4. POST to /spotify/exchange with { code, code_verifier, redirect_uri }
```

---

### Tracks

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/tracks/feed` | ✓ | AI-personalized feed (paginated) |
| GET | `/tracks/friends-feed` | ✓ | What friends listened to |
| GET | `/tracks/search?q=` | ✓ | Search catalog |
| GET | `/tracks/:id` | ✓ | Track detail |
| POST | `/tracks` | ✓ | Upsert track (from Apple Music) |
| POST | `/tracks/:id/save` | ✓ | Save track |
| DELETE | `/tracks/:id/save` | ✓ | Unsave |
| POST | `/tracks/:id/like` | ✓ | Like track |
| DELETE | `/tracks/:id/like` | ✓ | Unlike |
| POST | `/tracks/:id/play` | ✓ | Log playback |

**Feed pagination:** `GET /tracks/feed?page=0`, `?page=1`, etc.

---

### Reviews

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/reviews/track/:trackId` | ✓ | All reviews for a track |
| GET | `/reviews/user/:username` | ✓ | User's reviews |
| GET | `/reviews/feed` | ✓ | Reviews from people you follow |
| POST | `/reviews` | ✓ | Create review |
| PATCH | `/reviews/:id` | ✓ | Edit review |
| DELETE | `/reviews/:id` | ✓ | Delete review |
| POST | `/reviews/:id/like` | ✓ | Like a review |
| DELETE | `/reviews/:id/like` | ✓ | Unlike |

**Create review body:**
```json
{
  "track_id": "uuid",
  "rating": 5,
  "body": "Silk synths, 2 AM energy."
}
```

---

### Users & Social

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/users/search?q=` | ✓ | Search users |
| GET | `/users/:username` | ✓ | Public profile |
| PATCH | `/users/me` | ✓ | Update profile |
| POST | `/users/:username/follow` | ✓ | Follow user |
| DELETE | `/users/:username/follow` | ✓ | Unfollow |
| GET | `/users/:username/followers` | ✓ | Followers list |
| GET | `/users/:username/following` | ✓ | Following list |
| POST | `/users/friend-request/:username` | ✓ | Send friend request |
| PATCH | `/users/friend-request/:id` | ✓ | Accept/decline |
| GET | `/users/me/friend-requests` | ✓ | Inbound + outbound requests |

---

### Insights

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/insights/stats` | ✓ | Weekly listening stats |
| GET | `/insights/recap` | ✓ | Full weekly recap |
| GET | `/insights/mood` | ✓ | Hourly mood trends |

**Stats response:**
```json
{
  "total_minutes_this_week": 1842,
  "top_genre": "Alt R&B",
  "top_genre_active_hours": "late night",
  "most_played_track": { ... },
  "most_played_count": 27,
  "discovery_save_rate": 81,
  "tracks_saved": 14,
  "tracks_reviewed": 6
}
```

---

### Notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/notifications` | ✓ | All notifications |
| GET | `/notifications/unread-count` | ✓ | Badge count |
| PATCH | `/notifications/read-all` | ✓ | Mark all read |
| PATCH | `/notifications/:id/read` | ✓ | Mark one read |
| POST | `/notifications/push-token` | ✓ | Register APNs token |

---

### Media

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/media/avatar` | ✓ | Upload profile picture (multipart) |
| GET | `/media/upload-url` | ✓ | Get S3 presigned upload URL |

---

## AI Service (port 8000)

### Recommendation pipeline

```
POST /recommend
{ "user_id": "uuid", "limit": 20, "offset": 0 }

→ {
    "track_ids": ["uuid", ...],
    "strategy": "hybrid"   // or "popular" for new users
  }
```

**Hybrid strategy (per request):**
- **60%** Content-based — cosine similarity between user taste vector and track audio features (energy, valence, danceability, acousticness)
- **25%** Social collaborative filtering — tracks popular among users who follow the same people
- **15%** Genre-weighted popular — top tracks in the user's top genres

Taste vectors are rebuilt automatically after every Spotify sync.

---

## Deployment

### Render (recommended for MVP)

1. Create a PostgreSQL database on Render
2. Create a Redis instance
3. Deploy the Node API as a Web Service:
   - Build: `npm install && npm run build`
   - Start: `node dist/index.js`
4. Deploy the AI service as a separate Web Service:
   - Build: `pip install -r requirements.txt`
   - Start: `uvicorn main:app --host 0.0.0.0 --port 8000`

### Railway

```bash
railway init
railway add postgresql redis
railway up
```

---

## Scheduled Jobs (built-in)

| Schedule | Job |
|---|---|
| Every hour | Sync Spotify listening history for active users |
| Daily 3 AM | Clean up expired refresh tokens |

---

## iOS Integration Notes

### Token storage
Store `access_token` in Keychain (never UserDefaults). Store `refresh_token` in Keychain with `.whenUnlockedThisDeviceOnly`.

### Token refresh
When any API call returns 401, call `POST /auth/refresh` with the stored refresh token, update Keychain, retry the original request.

### Spotify PKCE
```swift
import CryptoKit

func generateCodeVerifier() -> String {
    var bytes = [UInt8](repeating: 0, count: 64)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    return Data(bytes).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func generateCodeChallenge(from verifier: String) -> String {
    let data = Data(verifier.utf8)
    let hash = SHA256.hash(data: data)
    return Data(hash).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
```
