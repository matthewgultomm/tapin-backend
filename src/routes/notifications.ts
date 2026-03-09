import { Router, Request, Response } from 'express';
import { query } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import type { Notification } from '../types/index.js';

const router = Router();

// GET /notifications
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const notifications = await query<Notification>(
    `SELECT
       n.*,
       u.username AS actor_username,
       u.display_name AS actor_display_name,
       u.avatar_url AS actor_avatar_url
     FROM notifications n
     LEFT JOIN users u ON n.actor_id = u.id
     WHERE n.user_id = $1
     ORDER BY n.created_at DESC
     LIMIT 50`,
    [req.user!.id]
  );
  res.json(notifications);
});

// GET /notifications/unread-count
router.get('/unread-count', requireAuth, async (req: Request, res: Response) => {
  const [row] = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
    [req.user!.id]
  );
  res.json({ count: parseInt(row?.count ?? '0') });
});

// PATCH /notifications/read-all
router.patch('/read-all', requireAuth, async (req: Request, res: Response) => {
  await query(
    'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
    [req.user!.id]
  );
  res.json({ success: true });
});

// PATCH /notifications/:id/read
router.patch('/:id/read', requireAuth, async (req: Request, res: Response) => {
  await query(
    'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user!.id]
  );
  res.json({ success: true });
});

// POST /notifications/push-token
router.post('/push-token', requireAuth, async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) { res.status(400).json({ error: 'Token required' }); return; }

  await query(
    'UPDATE users SET push_token = $1 WHERE id = $2',
    [token, req.user!.id]
  );
  res.json({ registered: true });
});

export default router;
