import { Router } from 'express';
import { DatabaseService } from '../models/database';
import { createPlexClient } from '../services/plexService';
import { resolveServer } from '../services/serverRegistry';
import { logger } from '../utils/logger';
import { AuthRequest, createAuthMiddleware } from '../middleware/auth';

export const createLibrariesRouter = (db: DatabaseService) => {
  const router = Router();
  const authMiddleware = createAuthMiddleware(db);

  // Resolves which server this request targets (home by default; any other
  // serverId must be in the user's own plex.tv resource list)
  const resolveServerContext = (req: AuthRequest) => {
    const requested = typeof req.query.serverId === 'string' ? req.query.serverId : undefined;
    return resolveServer(db, req.user, requested);
  };

  // Get all libraries
  router.get('/', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      logger.debug('Getting libraries', {
        userId: req.user?.id,
        username: req.user?.username,
        isAdmin: req.user?.isAdmin
      });

      const plex = createPlexClient(serverUrl);
      const libraries = await plex.getLibraries(token);
      return res.json({ libraries });
    } catch (error: any) {
      logger.error('Failed to get libraries', {
        error: error.message,
        stack: error.stack
      });
      return res.status(500).json({ error: 'Failed to get libraries' });
    }
  });

  // Get collections in a library
  router.get('/:libraryKey/collections', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { libraryKey } = req.params;
      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }
      if (!token || !serverUrl) {
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      const plex = createPlexClient(serverUrl);
      const collections = await plex.getCollections(libraryKey, token);
      return res.json({ collections });
    } catch (error) {
      logger.error('Failed to get collections', { error });
      return res.status(500).json({ error: 'Failed to get collections' });
    }
  });

  // Get items inside a collection
  router.get('/collections/:collectionRatingKey/content', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { collectionRatingKey } = req.params;
      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }
      if (!token || !serverUrl) {
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      const plex = createPlexClient(serverUrl);
      const content = await plex.getCollectionContent(collectionRatingKey, token);
      return res.json({ content });
    } catch (error) {
      logger.error('Failed to get collection content', { error });
      return res.status(500).json({ error: 'Failed to get collection content' });
    }
  });

  // Get library content
  router.get('/:libraryKey/content', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { libraryKey } = req.params;
      const { viewType } = req.query;

      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      const plex = createPlexClient(serverUrl);

      const content = await plex.getLibraryContent(
        libraryKey,
        token,
        viewType as string | undefined
      );
      return res.json({ content });
    } catch (error) {
      logger.error('Failed to get library content', { error });
      return res.status(500).json({ error: 'Failed to get library content' });
    }
  });

  return router;
};
