import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });

client.on('error', (err) => console.error('Redis error:', err));
client.on('connect', () => console.log('✅ Redis connected'));

export async function connectRedis() {
  if (!client.isOpen) await client.connect();
}

export const redis = client;

// Helpers
export async function cacheGet<T>(key: string): Promise<T | null> {
  const val = await client.get(key);
  return val ? (JSON.parse(val) as T) : null;
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 300) {
  await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
}

export async function cacheDel(key: string) {
  await client.del(key);
}

export async function cacheDelPattern(pattern: string) {
  const keys = await client.keys(pattern);
  if (keys.length > 0) await client.del(keys);
}
