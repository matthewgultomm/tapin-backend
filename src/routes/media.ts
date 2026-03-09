import { Router, Request, Response } from 'express';
import multer from 'multer';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET ?? 'tapin-media';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

// POST /media/avatar — upload profile picture
router.post('/avatar', requireAuth, upload.single('file'), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'No file provided' }); return; }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.mimetype)) {
    res.status(400).json({ error: 'File must be JPEG, PNG, or WebP' });
    return;
  }

  const ext = file.mimetype.split('/')[1];
  const key = `avatars/${req.user!.id}/${uuidv4()}.${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'max-age=31536000',
  }));

  const avatarUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

  // Remove old avatar from S3 if exists
  const oldAvatarUrl = req.user!.avatar_url;
  if (oldAvatarUrl?.includes(BUCKET)) {
    const oldKey = oldAvatarUrl.split('.amazonaws.com/')[1];
    if (oldKey) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: oldKey })).catch(() => null);
    }
  }

  await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, req.user!.id]);

  res.json({ avatar_url: avatarUrl });
});

// GET /media/upload-url — presigned URL for direct browser upload (alternative)
router.get('/upload-url', requireAuth, async (req: Request, res: Response) => {
  const { type } = req.query; // 'jpeg' | 'png' | 'webp'
  const allowedExts = ['jpeg', 'png', 'webp'];
  if (!type || !allowedExts.includes(type as string)) {
    res.status(400).json({ error: 'type must be jpeg, png, or webp' });
    return;
  }

  const key = `avatars/${req.user!.id}/${uuidv4()}.${type}`;
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: `image/${type}`,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 min
  const finalUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

  res.json({ upload_url: url, final_url: finalUrl, key });
});

export default router;
