import { Router } from 'express';
import { DatabaseService } from '../models/database';
import { listServers } from '../services/serverRegistry';
import { logger } from '../utils/logger';
import { AuthRequest, createAuthMiddleware } from '../middleware/auth';

// Lists the Plex servers the logged-in user can browse: the home server
// plus any server plex.tv says is shared with their account.
export const createServersRouter = (db: DatabaseService) => {
  const router = Router();
  const authMiddleware = createAuthMiddleware(db);

  router.get('/', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const servers = await listServers(db, req.user);
      return res.json({ servers });
    } catch (error) {
      logger.error('Failed to list servers', { error });
      return res.status(500).json({ error: 'Failed to list servers' });
    }
  });

  return router;
};
