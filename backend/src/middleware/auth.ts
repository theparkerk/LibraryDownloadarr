import { Request, Response, NextFunction } from 'express';
import { DatabaseService } from '../models/database';
import { logger } from '../utils/logger';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    isAdmin: boolean;
    plexToken?: string;
    serverUrl?: string;
  };
  authSession?: {
    id: string;
    token: string;
  };
}

// Resolves a user id to the request-user shape, checking admin users first
// then Plex OAuth users. Shared by session auth, the thumbnail query-token
// path, and download-token auth.
export const resolveUserById = (db: DatabaseService, userId: string): AuthRequest['user'] | undefined => {
  const adminUser = db.getAdminUserById(userId);
  if (adminUser) {
    return {
      id: adminUser.id,
      username: adminUser.username,
      isAdmin: adminUser.isAdmin,
    };
  }

  const plexUser = db.getPlexUserById(userId);
  if (plexUser) {
    return {
      id: plexUser.id,
      username: plexUser.username,
      isAdmin: plexUser.isAdmin,
      plexToken: plexUser.plexToken,
      serverUrl: plexUser.serverUrl,
    };
  }

  return undefined;
};

export const createAuthMiddleware = (db: DatabaseService) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

      if (!token) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const session = db.getSessionByToken(token);
      if (!session) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      const user = resolveUserById(db, session.userId);
      if (user) {
        req.user = user;
        req.authSession = {
          id: session.id,
          token: session.token,
        };
        return next();
      }

      return res.status(401).json({ error: 'User not found' });
    } catch (error) {
      logger.error('Authentication error', { error });
      return res.status(500).json({ error: 'Authentication failed' });
    }
  };
};

export const createAdminMiddleware = () => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    return next();
  };
};
