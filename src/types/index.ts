export interface User {
  id: string;
  username: string;
  display_name: string;
  email?: string;
  bio: string;
  hometown: string;
  avatar_url?: string;
  is_private: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserPublic {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  hometown: string;
  avatar_url?: string;
  is_private: boolean;
  followers_count: number;
  following_count: number;
  friends_count: number;
  is_following?: boolean;
  is_friend?: boolean;
  top_genres?: string[];
}

export interface Track {
  id: string;
  spotify_id?: string;
  apple_music_id?: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  release_year?: number;
  artwork_url?: string;
  preview_url?: string;
  duration_ms?: number;
  tempo?: number;
  energy?: number;
  valence?: number;
  danceability?: number;
  popularity: number;
}

export interface Review {
  id: string;
  user_id: string;
  track_id: string;
  rating: number;
  body: string;
  is_edited: boolean;
  created_at: string;
  updated_at: string;
  // Joined fields
  user?: UserPublic;
  track?: Track;
  likes_count?: number;
  is_liked?: boolean;
}

export interface MusicConnection {
  id: string;
  user_id: string;
  service: 'spotify' | 'apple_music' | 'tidal';
  spotify_user_id?: string;
  scopes?: string[];
  connected_at: string;
  last_synced_at?: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: 'follow' | 'friend_request' | 'review_like' | 'new_review' | 'friend_request_accepted';
  actor_id?: string;
  entity_id?: string;
  entity_type?: string;
  is_read: boolean;
  created_at: string;
  actor?: UserPublic;
}

export interface InsightStats {
  total_minutes_this_week: number;
  top_genre: string;
  top_genre_active_hours: string;
  most_played_track?: Track;
  most_played_count: number;
  discovery_save_rate: number;
  tracks_saved: number;
  tracks_reviewed: number;
}

// Express augmentation
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
