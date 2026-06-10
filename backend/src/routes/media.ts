import { Router, Response, NextFunction } from 'express';
import { DatabaseService, DownloadScopeType } from '../models/database';
import { createPlexClient } from '../services/plexService';
import { resolveServer, ServerContext } from '../services/serverRegistry';
import { searchAllServers, getRecentlyAddedAllServers } from '../services/crossServerService';
import { TranscodeService } from '../services/transcodeService';
import { getPreset } from '../services/transcodePresets';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AuthRequest, createAuthMiddleware, resolveUserById } from '../middleware/auth';
import axios from 'axios';
import contentDisposition from 'content-disposition';
import https from 'https';
import path from 'path';
import fs from 'fs';
import { createZipStream, ZipFileEntry } from '../utils/zipUtils';

// HTTPS agent that bypasses SSL certificate validation for local Plex servers
// This is necessary when connecting to Plex servers with self-signed certificates
// or when using local IPs with plex.direct certificates
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

export const createMediaRouter = (db: DatabaseService, transcodeService: TranscodeService) => {
  const router = Router();
  const authMiddleware = createAuthMiddleware(db);

  // Auth for download endpoints: a session Bearer header as usual, OR a
  // scoped download token in ?dl=. The token path is what lets the
  // browser's native download manager (which can't send headers) fetch
  // files directly — required for streaming-to-disk on mobile (#16).
  const createDownloadAuth = (scopeType: DownloadScopeType, ratingKeyParam: string) => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
      if (req.headers.authorization) {
        return authMiddleware(req, res, next);
      }

      const dl = req.query.dl;
      if (typeof dl === 'string' && dl.length > 0) {
        const downloadToken = db.getDownloadToken(dl);
        const ratingKey = req.params[ratingKeyParam];
        const partKeyMatches =
          scopeType !== 'file' || downloadToken?.partKey === req.query.partKey;

        if (
          downloadToken &&
          downloadToken.scopeType === scopeType &&
          downloadToken.ratingKey === ratingKey &&
          partKeyMatches
        ) {
          const user = resolveUserById(db, downloadToken.userId);
          if (user) {
            req.user = user;
            req.downloadServerId = downloadToken.serverId;
            return next();
          }
        }

        logger.warn('Download token rejected', { scopeType, ratingKey });
        return res.status(401).json({ error: 'Invalid or expired download link. Please start the download again.' });
      }

      return res.status(401).json({ error: 'No token provided' });
    };
  };

  // Helper function to format media title for download logs
  const formatMediaTitle = (metadata: any, libraryTitle?: string): string => {
    const type = metadata.type;
    const library = libraryTitle || 'Unknown Library';

    if (type === 'episode') {
      // Format: "{Library} - {ShowTitle} - {SeasonTitle} - E{##} - {EpisodeName}"
      const showName = metadata.grandparentTitle || 'Unknown Show';
      const seasonTitle = metadata.parentTitle || 'Unknown Season';
      const episodeNum = metadata.index ? String(metadata.index).padStart(2, '0') : '00';
      const episodeTitle = metadata.title || 'Unknown Episode';
      return `${library} - ${showName} - ${seasonTitle} - E${episodeNum} - ${episodeTitle}`;
    }

    if (type === 'track') {
      // Format: "{Library} - {AlbumTitle} - {TrackName}"
      const albumName = metadata.parentTitle || 'Unknown Album';
      const trackTitle = metadata.title || 'Unknown Track';
      return `${library} - ${albumName} - ${trackTitle}`;
    }

    if (type === 'movie') {
      // Format: "{Library} - {MovieTitle}"
      return `${library} - ${metadata.title || 'Unknown Movie'}`;
    }

    // For seasons, albums, or anything else: "{Library} - {Title}"
    return `${library} - ${metadata.title || 'Unknown Media'}`;
  };

  const requestedServerId = (req: AuthRequest): string | undefined =>
    req.downloadServerId ??
    (typeof req.query.serverId === 'string' ? req.query.serverId : undefined) ??
    (typeof req.body?.serverId === 'string' ? req.body.serverId : undefined);

  // Resolves which server this request targets and the credentials for it.
  // No serverId (or the home machine id) keeps the original single-server
  // semantics: admin's configured URL, user's own token. Any other serverId
  // must appear in plex.tv's resource list for the requesting user's
  // account — never an arbitrary URL. The synthetic 'all' selection has no
  // single server, so server-scoped endpoints reject it here (search and
  // recently-added handle 'all' before calling this).
  const resolveServerContext = (req: AuthRequest): Promise<ServerContext> => {
    const requested = requestedServerId(req);
    if (requested === 'all') {
      return Promise.resolve({
        serverUrl: '',
        serverName: '',
        isHome: false,
        error: 'Pick a specific server for this action.',
      });
    }
    return resolveServer(db, req.user, requested);
  };

  // Get recently added media
  router.get('/recently-added', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

      // All-Servers mode: merged across every reachable server
      if (requestedServerId(req) === 'all') {
        const { items, failures } = await getRecentlyAddedAllServers(db, req.user, limit);
        return res.json({ media: items, failures });
      }

      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      const plex = createPlexClient(serverUrl);
      const media = await plex.getRecentlyAdded(token, limit);
      return res.json({ media });
    } catch (error) {
      logger.error('Failed to get recently added', { error });
      return res.status(500).json({ error: 'Failed to get recently added media' });
    }
  });

  // Get download history (user's own downloads)
  router.get('/download-history', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const history = db.getDownloadHistory(req.user!.id, limit);
      return res.json({ history });
    } catch (error) {
      logger.error('Failed to get download history', { error });
      return res.status(500).json({ error: 'Failed to get download history' });
    }
  });

  // Get all download history (admin only - shows all users' downloads)
  router.get('/download-history/all', authMiddleware, async (req: AuthRequest, res) => {
    try {
      // Only admins can view all downloads
      if (!req.user?.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      const history = db.getAllDownloadHistory(limit);
      return res.json({ history });
    } catch (error) {
      logger.error('Failed to get all download history', { error });
      return res.status(500).json({ error: 'Failed to get all download history' });
    }
  });

  // Get download stats (global for all users)
  router.get('/download-stats', authMiddleware, async (_req: AuthRequest, res) => {
    try {
      // Get stats for all users (don't pass userId)
      const stats = db.getDownloadStats();
      return res.json({ stats });
    } catch (error) {
      logger.error('Failed to get download stats', { error });
      return res.status(500).json({ error: 'Failed to get download stats' });
    }
  });

  // Helper function to calculate relevance score
  const calculateRelevanceScore = (item: any, query: string): number => {
    const queryLower = query.toLowerCase();
    const title = (item.title || '').toLowerCase();
    const originalTitle = (item.originalTitle || '').toLowerCase();
    const year = item.year?.toString() || '';
    const summary = (item.summary || '').toLowerCase();

    let score = 0;

    // Exact title match: highest score
    if (title === queryLower) {
      score += 100;
    }
    // Title starts with query
    else if (title.startsWith(queryLower)) {
      score += 80;
    }
    // Title contains query
    else if (title.includes(queryLower)) {
      score += 60;
    }

    // Original title matches
    if (originalTitle.includes(queryLower)) {
      score += 30;
    }

    // Year matches
    if (year === query) {
      score += 50;
    }

    // Summary contains query
    if (summary.includes(queryLower)) {
      score += 20;
    }

    // Boost movies and shows over other types
    if (item.type === 'movie' || item.type === 'show') {
      score += 10;
    }

    // Boost recently added items slightly
    if (item.addedAt) {
      const daysOld = (Date.now() - item.addedAt * 1000) / (1000 * 60 * 60 * 24);
      if (daysOld < 30) {
        score += 5;
      }
    }

    return score;
  };

  // Search media
  router.get('/search', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { q } = req.query;
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ error: 'Search query is required' });
      }

      if (q.trim().length < 2) {
        return res.status(400).json({ error: 'Search query must be at least 2 characters' });
      }

      // All-Servers mode: merged + deduped across every reachable server,
      // then relevance-scored
      if (requestedServerId(req) === 'all') {
        const { items, failures } = await searchAllServers(db, req.user, q);
        const scored = items
          .map((item) => ({ ...item, _relevanceScore: calculateRelevanceScore(item, q) }))
          .sort((a, b) => b._relevanceScore - a._relevanceScore)
          .map(({ _relevanceScore, ...item }) => item);
        return res.json({ results: scored, failures });
      }

      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        logger.warn('Search access denied', { userId: req.user?.id, error });
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        logger.error('Search failed: Plex not configured', { userId: req.user?.id });
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      logger.debug('Performing search', { query: q, userId: req.user?.id });

      const plex = createPlexClient(serverUrl);
      let results = await plex.search(q, token);

      // Ensure results is an array
      if (!Array.isArray(results)) {
        logger.warn('Search returned non-array results', { results });
        results = [];
      }

      // Calculate relevance scores and sort by them
      const scoredResults = results.map(item => ({
        ...item,
        _relevanceScore: calculateRelevanceScore(item, q)
      }));

      // Sort by relevance score (descending)
      scoredResults.sort((a, b) => b._relevanceScore - a._relevanceScore);

      // Remove the score field before sending to client
      const finalResults = scoredResults.map(({ _relevanceScore, ...item }) => item);

      logger.debug('Search completed', { query: q, resultCount: finalResults.length });

      return res.json({ results: finalResults });
    } catch (error: any) {
      logger.error('Search failed', {
        error: error.message,
        stack: error.stack,
        query: req.query.q,
        userId: req.user?.id
      });
      return res.status(500).json({
        error: 'Search failed',
        details: error.message
      });
    }
  });

  // Issue a scoped, expiring download token. The returned URL can be opened
  // directly by the browser (no Authorization header needed), so the native
  // download manager streams the file to disk instead of buffering in RAM.
  router.post('/download-token', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { scopeType, ratingKey, partKey } = req.body as {
        scopeType?: string;
        ratingKey?: string;
        partKey?: string;
      };

      if (scopeType !== 'file' && scopeType !== 'season' && scopeType !== 'album') {
        return res.status(400).json({ error: 'scopeType must be file, season, or album' });
      }
      if (!ratingKey || typeof ratingKey !== 'string') {
        return res.status(400).json({ error: 'ratingKey is required' });
      }
      if (scopeType === 'file' && (!partKey || typeof partKey !== 'string')) {
        return res.status(400).json({ error: 'partKey is required for file downloads' });
      }

      // Verify the user can actually reach the requested server before
      // minting a token scoped to it
      const serverContext = await resolveServerContext(req);
      if (serverContext.error) {
        return res.status(403).json({ error: serverContext.error });
      }
      const serverId = serverContext.isHome
        ? undefined
        : (typeof req.query.serverId === 'string' ? req.query.serverId : undefined) ??
          (typeof req.body?.serverId === 'string' ? req.body.serverId : undefined);

      const downloadToken = db.createDownloadToken(
        req.user!.id,
        scopeType,
        ratingKey,
        scopeType === 'file' ? partKey : undefined,
        serverId
      );

      let url: string;
      if (scopeType === 'file') {
        url = `/api/media/${encodeURIComponent(ratingKey)}/download?partKey=${encodeURIComponent(partKey!)}&dl=${downloadToken.token}`;
      } else {
        url = `/api/media/${scopeType}/${encodeURIComponent(ratingKey)}/download?dl=${downloadToken.token}`;
      }

      return res.json({ url, expiresAt: downloadToken.expiresAt });
    } catch (error) {
      logger.error('Failed to create download token', { error });
      return res.status(500).json({ error: 'Failed to create download token' });
    }
  });

  // Start a device-quality conversion job. Pre-builds a smaller MP4 on the
  // server (Plex does the encode) for download, so devices don't store the
  // full-size original.
  router.post('/transcode', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { ratingKey, quality } = req.body as { ratingKey?: string; quality?: string };

      // ratingKey is interpolated into the Plex transcode path — keep it numeric
      if (!ratingKey || typeof ratingKey !== 'string' || !/^\d+$/.test(ratingKey)) {
        return res.status(400).json({ error: 'A numeric ratingKey is required' });
      }
      const preset = quality ? getPreset(quality) : undefined;
      if (!preset) {
        return res.status(400).json({ error: 'Unknown quality preset' });
      }

      // resolveServerContext rejects 'all' and resolves a concrete vouched server
      const { token, serverUrl, serverName, isHome, error } = await resolveServerContext(req);
      if (error) return res.status(403).json({ error });
      if (!token || !serverUrl) return res.status(500).json({ error: 'Plex server not configured' });

      const plex = createPlexClient(serverUrl);
      const metadata = await plex.getMediaMetadata(ratingKey, token);
      if (!metadata) return res.status(404).json({ error: 'Media not found' });
      if (metadata.type !== 'movie' && metadata.type !== 'episode') {
        return res.status(400).json({ error: 'Only movies and episodes can be converted' });
      }

      // Same allowSync gate as the file download — admin bypass is home-only
      const isExplicitlyDisabled =
        metadata.allowSync === false || metadata.allowSync === 0 || metadata.allowSync === '0';
      if (isExplicitlyDisabled && !(isHome && req.user?.isAdmin)) {
        return res.status(403).json({ error: 'Download not allowed for this item.' });
      }

      const serverId = isHome ? undefined : (typeof req.query.serverId === 'string' ? req.query.serverId : undefined) ?? (typeof req.body?.serverId === 'string' ? req.body.serverId : undefined);

      // Attach to an existing in-flight/ready job rather than re-transcoding
      const existing = db.findReusableTranscodeJob(req.user!.id, ratingKey, serverId, preset.id);
      if (existing) {
        return res.json({ jobId: existing.id, status: existing.status, reused: true });
      }

      // Bound the queue so a user can't pile up unlimited conversions
      if (transcodeService.pendingCount() >= config.transcode.maxQueue) {
        return res.status(429).json({ error: 'Too many conversions in progress. Try again shortly.' });
      }

      const job = db.createTranscodeJob(req.user!.id, ratingKey, serverId, preset.id, metadata.title || 'download');
      const durationSec = metadata.duration ? metadata.duration / 1000 : undefined;
      transcodeService.enqueue({ id: job.id, ratingKey, serverUrl, token, preset, durationSec });
      logger.info('Transcode requested', { jobId: job.id, ratingKey, quality: preset.id, server: serverName });
      return res.json({ jobId: job.id, status: 'queued', reused: false });
    } catch (error) {
      logger.error('Failed to start transcode', { error });
      return res.status(500).json({ error: 'Failed to start conversion' });
    }
  });

  // Poll a conversion job's status (owner-scoped)
  router.get('/transcode/:jobId', authMiddleware, async (req: AuthRequest, res) => {
    const job = db.getTranscodeJob(req.params.jobId);
    if (!job || job.userId !== req.user!.id) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json({
      job: {
        id: job.id,
        status: job.status,
        progress: job.progress,
        quality: job.quality,
        title: job.title,
        fileSize: job.fileSize,
        error: job.error,
      },
    });
  });

  // Mint a headerless download link for a finished conversion (so the
  // browser's native downloader can fetch it on mobile)
  router.post('/transcode/:jobId/download-token', authMiddleware, async (req: AuthRequest, res) => {
    const job = db.getTranscodeJob(req.params.jobId);
    if (!job || job.userId !== req.user!.id) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'ready') {
      return res.status(409).json({ error: 'Conversion is not ready yet' });
    }
    const dt = db.createDownloadToken(req.user!.id, 'transcode', job.id);
    return res.json({
      url: `/api/media/transcode/${encodeURIComponent(job.id)}/download?dl=${dt.token}`,
      expiresAt: dt.expiresAt,
    });
  });

  // Stream a finished conversion's temp file with Range/resume. Auth via a
  // session Bearer (owner) OR a scoped ?dl= transcode token for this jobId.
  router.get('/transcode/:jobId/download', async (req: AuthRequest, res) => {
    try {
      const { jobId } = req.params;
      let userId: string | undefined;

      const dl = req.query.dl;
      if (typeof dl === 'string' && dl.length > 0) {
        const dt = db.getDownloadToken(dl);
        if (dt && dt.scopeType === 'transcode' && dt.ratingKey === jobId) {
          userId = dt.userId;
        }
      } else if (req.headers.authorization?.startsWith('Bearer ')) {
        const session = db.getSessionByToken(req.headers.authorization.substring(7));
        if (session) userId = session.userId;
      }
      if (!userId) {
        return res.status(401).json({ error: 'Invalid or expired download link.' });
      }

      const job = db.getTranscodeJob(jobId);
      if (!job || job.userId !== userId) {
        return res.status(404).json({ error: 'Conversion not found' });
      }
      if (job.status !== 'ready' || !job.outputPath || !fs.existsSync(job.outputPath)) {
        return res.status(409).json({ error: 'Conversion is not ready (it may have expired — start it again).' });
      }

      const size = fs.statSync(job.outputPath).size;
      const safeTitle = (job.title || 'download').replace(/[\\/:*?"<>|]+/g, '_');
      const filename = `${safeTitle} (${job.quality}).mp4`;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', contentDisposition(filename));
      res.setHeader('Accept-Ranges', 'bytes');

      const range = req.headers.range;
      const rangeMatch = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (rangeMatch) {
        let start: number;
        let end: number;
        if (rangeMatch[1] === '' && rangeMatch[2] !== '') {
          // Suffix range: last N bytes (bytes=-N)
          const n = parseInt(rangeMatch[2], 10);
          start = Math.max(0, size - n);
          end = size - 1;
        } else {
          start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
          end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1;
        }
        if (start >= size || end >= size || start > end) {
          res.setHeader('Content-Range', `bytes */${size}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(job.outputPath, { start, end }).pipe(res);
      } else {
        res.setHeader('Content-Length', size);
        fs.createReadStream(job.outputPath).pipe(res);
      }
      return;
    } catch (error) {
      logger.error('Transcode download failed', { error });
      if (!res.headersSent) return res.status(500).json({ error: 'Download failed' });
      return;
    }
  });

  // Get media metadata
  router.get('/:ratingKey', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { ratingKey } = req.params;
      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      const plex = createPlexClient(serverUrl);
      const metadata = await plex.getMediaMetadata(ratingKey, token);
      return res.json({ metadata });
    } catch (error) {
      logger.error('Failed to get media metadata', { error });
      return res.status(500).json({ error: 'Failed to get media metadata' });
    }
  });

  // Get seasons for a TV show
  router.get('/:ratingKey/seasons', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { ratingKey } = req.params;
      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      const plex = createPlexClient(serverUrl);
      const seasons = await plex.getSeasons(ratingKey, token);
      return res.json({ seasons });
    } catch (error) {
      logger.error('Failed to get seasons', { error });
      return res.status(500).json({ error: 'Failed to get seasons' });
    }
  });

  // Get episodes for a season
  router.get('/:ratingKey/episodes', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { ratingKey } = req.params;
      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      const plex = createPlexClient(serverUrl);
      const episodes = await plex.getEpisodes(ratingKey, token);
      return res.json({ episodes });
    } catch (error) {
      logger.error('Failed to get episodes', { error });
      return res.status(500).json({ error: 'Failed to get episodes' });
    }
  });

  // Get tracks for an album
  router.get('/:ratingKey/tracks', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { ratingKey } = req.params;
      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(500).json({ error: 'Plex server not configured' });
      }

      const plex = createPlexClient(serverUrl);
      const tracks = await plex.getTracks(ratingKey, token);
      return res.json({ tracks });
    } catch (error) {
      logger.error('Failed to get tracks', { error });
      return res.status(500).json({ error: 'Failed to get tracks' });
    }
  });

  // Download media
  router.get('/:ratingKey/download', createDownloadAuth('file', 'ratingKey'), async (req: AuthRequest, res) => {
    try {
      const { ratingKey } = req.params;
      const { partKey } = req.query;

      if (!partKey || typeof partKey !== 'string') {
        return res.status(400).json({ error: 'Part key is required' });
      }

      const { token, serverUrl, serverName, isHome, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(401).json({ error: 'Plex token required - configure in settings' });
      }

      const plex = createPlexClient(serverUrl);

      const metadata = await plex.getMediaMetadata(ratingKey, token);

      // Log metadata for debugging permission issues
      logger.info('Download request metadata', {
        userId: req.user?.id,
        username: req.user?.username,
        isAdmin: req.user?.isAdmin,
        ratingKey,
        mediaTitle: metadata.title,
        allowSync: metadata.allowSync,
        allowSyncType: typeof metadata.allowSync,
        metadataKeys: Object.keys(metadata).filter(k => k.includes('allow') || k.includes('sync') || k.includes('permission'))
      });

      // Check if user has download permission
      // Logic: Block ONLY if allowSync is explicitly disabled (false/0)
      // - Admin users: always allowed (they manage the server)
      // - Owned server users: allowSync undefined = allowed (no restriction)
      // - Shared server users: allowSync false/0 = explicitly disabled
      const isExplicitlyDisabled = metadata.allowSync === false ||
                                   metadata.allowSync === 0 ||
                                   metadata.allowSync === '0';

      if (isExplicitlyDisabled && !(isHome && req.user?.isAdmin)) {
        logger.warn('Download denied: user lacks download permission', {
          userId: req.user?.id,
          username: req.user?.username,
          isAdmin: req.user?.isAdmin,
          ratingKey,
          mediaTitle: metadata.title,
          allowSync: metadata.allowSync
        });
        return res.status(403).json({
          error: 'Download not allowed. The server administrator has disabled downloads for your account.'
        });
      }

      // Get library information for better download title
      let libraryTitle = metadata.librarySectionTitle || 'Unknown Library';
      if (!libraryTitle || libraryTitle === 'Unknown Library') {
        // Try to fetch library name from librarySectionID
        if (metadata.librarySectionID) {
          try {
            const libraries = await plex.getLibraries(token);
            const library = libraries.find(l => l.key === metadata.librarySectionID);
            if (library) {
              libraryTitle = library.title;
            }
          } catch (err) {
            logger.warn('Failed to fetch library info for download', { librarySectionID: metadata.librarySectionID });
          }
        }
      }

      // The permission check above ran against ratingKey, but the stream
      // serves partKey — reject part keys that don't belong to this item so
      // a token scoped to one item can't fetch another item's file
      const parts = (metadata.Media || []).flatMap((m: any) => m.Part || []);
      const matchedPart = parts.find((p: any) => p.key === partKey);
      if (!matchedPart) {
        logger.warn('Download rejected: partKey does not belong to ratingKey', {
          userId: req.user?.id,
          ratingKey,
          partKey
        });
        return res.status(404).json({ error: 'File not found for this media item' });
      }

      const downloadUrl = plex.getDownloadUrl(partKey, token);

      // Forward Range/If-Range so the browser's download manager can resume
      // interrupted downloads — essential on flaky mobile connections (#16)
      const rangeHeader = req.headers.range;
      const upstreamHeaders: Record<string, string> = {};
      if (typeof rangeHeader === 'string') {
        upstreamHeaders['Range'] = rangeHeader;
      }
      if (typeof req.headers['if-range'] === 'string') {
        upstreamHeaders['If-Range'] = req.headers['if-range'];
      }

      // Stream the file through our server
      let response;
      try {
        response = await axios({
          method: 'GET',
          url: downloadUrl,
          responseType: 'stream',
          httpsAgent: httpsAgent,
          headers: upstreamHeaders,
        });
      } catch (downloadError: any) {
        // If Plex returns 403, it means the user doesn't have download permission
        if (downloadError.response?.status === 403) {
          logger.warn('Download denied by Plex server (403)', {
            userId: req.user?.id,
            username: req.user?.username,
            isAdmin: req.user?.isAdmin,
            ratingKey,
            mediaTitle: metadata.title,
            allowSync: metadata.allowSync,
            plexErrorStatus: 403
          });
          return res.status(403).json({
            error: 'Download not allowed. The Plex server has denied access to this file. Check your download permissions in Plex settings.'
          });
        }
        if (downloadError.response?.status === 416) {
          // Content-Range: bytes */<total> lets the browser repair a stale
          // resume offset instead of giving up
          const upstream416Range = downloadError.response.headers?.['content-range'];
          if (upstream416Range) {
            res.setHeader('Content-Range', upstream416Range);
          }
          return res.status(416).end();
        }
        // Re-throw other errors
        throw downloadError;
      }

      // Get file size from response headers (works for all media types)
      const fileSize = response.headers['content-length']
        ? parseInt(response.headers['content-length'], 10)
        : undefined;

      const serverPrefix = isHome ? '' : `[${serverName}] `;
      const formattedTitle = serverPrefix + formatMediaTitle(metadata, libraryTitle);
      const isResume = typeof rangeHeader === 'string' && !/^bytes=0-/.test(rangeHeader);

      // Log the download. logDownload reuses the recent non-completed row
      // for this user+media, so retries and ranged resumes update one
      // history entry instead of piling up duplicates (#13). Resume
      // requests don't pass fileSize — the partial content-length would
      // overwrite the real total.
      const logId = db.logDownload(
        req.user!.id,
        formattedTitle,
        ratingKey,
        isResume ? undefined : fileSize
      );

      // Track the actual outcome so history doesn't record aborted streams
      // as successful downloads (#13)
      const contentRange = response.headers['content-range'] as string | undefined;
      const reachesEof = (() => {
        if (response.status !== 206) return true; // full-body response
        const m = contentRange?.match(/bytes \d+-(\d+)\/(\d+)/);
        return m ? parseInt(m[1], 10) + 1 === parseInt(m[2], 10) : false;
      })();

      res.on('finish', () => {
        if (reachesEof) {
          db.updateDownloadLogStatus(logId, 'completed');
        }
        // else: mid-file chunk delivered; row stays 'started' for the next resume
      });
      res.on('close', () => {
        if (!res.writableEnded) {
          db.updateDownloadLogStatus(logId, 'interrupted');
        }
      });

      // Set headers for download. contentDisposition() RFC-6266-encodes the
      // name — raw quotes or non-ASCII characters used to make setHeader
      // throw, killing the download entirely (#18).
      const filename = (matchedPart.file ? path.basename(matchedPart.file) : '') || 'download';
      res.status(response.status);
      res.setHeader('Content-Disposition', contentDisposition(filename));
      res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      if (contentRange) {
        res.setHeader('Content-Range', contentRange);
      }
      // Pass validators through so the browser can send a correct If-Range
      // on resume
      if (response.headers['etag']) {
        res.setHeader('ETag', response.headers['etag']);
      }
      if (response.headers['last-modified']) {
        res.setHeader('Last-Modified', response.headers['last-modified']);
      }
      if (fileSize) {
        res.setHeader('Content-Length', fileSize.toString());
      }

      response.data.pipe(res);

      logger.info(`Download ${isResume ? 'resumed' : 'started'} for ${formattedTitle} by user ${req.user?.username}`);
      return;
    } catch (error) {
      logger.error('Download failed', { error });
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Download failed' });
      }
      return;
    }
  });

  // Get season download size info
  router.get('/season/:seasonRatingKey/size', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { seasonRatingKey } = req.params;
      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(401).json({ error: 'Plex token required - configure in settings' });
      }

      const plex = createPlexClient(serverUrl);

      // Get all episodes in the season
      const episodes = await plex.getEpisodes(seasonRatingKey, token);

      if (!episodes || episodes.length === 0) {
        return res.status(404).json({ error: 'No episodes found in this season' });
      }

      // Calculate total size
      let totalSize = 0;
      let fileCount = 0;

      for (const episode of episodes) {
        if (episode.Media?.[0]?.Part?.[0]) {
          const part = episode.Media[0].Part[0];
          totalSize += part.size || 0;
          fileCount++;
        }
      }

      return res.json({
        totalSize,
        fileCount,
        totalSizeGB: (totalSize / 1073741824).toFixed(2)
      });
    } catch (error) {
      logger.error('Failed to get season size', { error });
      return res.status(500).json({ error: 'Failed to get season size' });
    }
  });

  // Get album download size info
  router.get('/album/:albumRatingKey/size', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const { albumRatingKey } = req.params;
      const { token, serverUrl, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(401).json({ error: 'Plex token required - configure in settings' });
      }

      const plex = createPlexClient(serverUrl);

      // Get all tracks in the album
      const tracks = await plex.getTracks(albumRatingKey, token);

      if (!tracks || tracks.length === 0) {
        return res.status(404).json({ error: 'No tracks found in this album' });
      }

      // Calculate total size
      let totalSize = 0;
      let fileCount = 0;

      for (const track of tracks) {
        if (track.Media?.[0]?.Part?.[0]) {
          const part = track.Media[0].Part[0];
          totalSize += part.size || 0;
          fileCount++;
        }
      }

      return res.json({
        totalSize,
        fileCount,
        totalSizeGB: (totalSize / 1073741824).toFixed(2)
      });
    } catch (error) {
      logger.error('Failed to get album size', { error });
      return res.status(500).json({ error: 'Failed to get album size' });
    }
  });

  // Download entire season as zip
  router.get('/season/:seasonRatingKey/download', createDownloadAuth('season', 'seasonRatingKey'), async (req: AuthRequest, res) => {
    try {
      const { seasonRatingKey } = req.params;

      const { token, serverUrl, serverName, isHome, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(401).json({ error: 'Plex token required - configure in settings' });
      }

      const plex = createPlexClient(serverUrl);

      // Get season metadata
      const seasonMetadata = await plex.getMediaMetadata(seasonRatingKey, token);

      // Get all episodes in the season
      const episodes = await plex.getEpisodes(seasonRatingKey, token);

      if (!episodes || episodes.length === 0) {
        return res.status(404).json({ error: 'No episodes found in this season' });
      }

      // Check download permissions for each episode
      // Admin users bypass permission checks
      const isAdmin = isHome && req.user?.isAdmin; // admin bypass applies to the home server only
      if (!isAdmin) {
        for (const episode of episodes) {
          const isExplicitlyDisabled = episode.allowSync === false ||
                                       episode.allowSync === 0 ||
                                       episode.allowSync === '0';
          if (isExplicitlyDisabled) {
            logger.warn('Season download denied: user lacks download permission for at least one episode', {
              userId: req.user?.id,
              seasonRatingKey,
              episodeRatingKey: episode.ratingKey,
              episodeTitle: episode.title
            });
            return res.status(403).json({
              error: 'Download not allowed. Some episodes in this season are not available for download.'
            });
          }
        }
      }

      // Prepare files for zipping
      const files: ZipFileEntry[] = [];
      let totalSize = 0;

      for (const episode of episodes) {
        if (episode.Media?.[0]?.Part?.[0]) {
          const part = episode.Media[0].Part[0];
          const downloadUrl = plex.getDownloadUrl(part.key, token);
          // Use path.basename to ensure we only get the filename, not the full path
          const filename = path.basename(part.file) || `Episode_${episode.index}.${part.container}`;
          const size = part.size || 0;

          files.push({
            url: downloadUrl,
            filename,
            size
          });

          totalSize += size;
        }
      }

      // Warn if total size is over 10GB (10737418240 bytes)
      const tenGB = 10737418240;
      if (totalSize > tenGB) {
        logger.warn('Large season download initiated', {
          userId: req.user?.id,
          seasonRatingKey,
          totalSizeGB: (totalSize / 1073741824).toFixed(2),
          episodeCount: files.length
        });
      }

      // Generate zip filename: "ShowName - SXX.zip"
      const showName = seasonMetadata.grandparentTitle || 'Unknown Show';
      const seasonNumber = seasonMetadata.index || seasonMetadata.parentIndex || 0;
      const zipFilename = `${showName} - S${String(seasonNumber).padStart(2, '0')}.zip`;

      // Log the download and track its outcome (#13)
      const libraryTitle = seasonMetadata.librarySectionTitle || 'Unknown Library';
      const downloadTitle = `${isHome ? '' : `[${serverName}] `}${libraryTitle} - ${showName} - ${seasonMetadata.title} (${files.length} episodes)`;
      const logId = db.logDownload(
        req.user!.id,
        downloadTitle,
        seasonRatingKey,
        totalSize
      );
      res.on('finish', () => db.updateDownloadLogStatus(logId, 'completed'));
      res.on('close', () => {
        if (!res.writableEnded) db.updateDownloadLogStatus(logId, 'interrupted');
      });

      logger.info(`Season download started: ${downloadTitle} by user ${req.user?.username}`);

      // Stream zip to client
      await createZipStream(res, files, zipFilename);

      return;
    } catch (error) {
      logger.error('Season download failed', { error });
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Season download failed' });
      }
      return;
    }
  });

  // Download entire album as zip
  router.get('/album/:albumRatingKey/download', createDownloadAuth('album', 'albumRatingKey'), async (req: AuthRequest, res) => {
    try {
      const { albumRatingKey } = req.params;

      const { token, serverUrl, serverName, isHome, error } = await resolveServerContext(req);

      if (error) {
        return res.status(403).json({ error });
      }

      if (!token || !serverUrl) {
        return res.status(401).json({ error: 'Plex token required - configure in settings' });
      }

      const plex = createPlexClient(serverUrl);

      // Get album metadata
      const albumMetadata = await plex.getMediaMetadata(albumRatingKey, token);

      // Get all tracks in the album
      const tracks = await plex.getTracks(albumRatingKey, token);

      if (!tracks || tracks.length === 0) {
        return res.status(404).json({ error: 'No tracks found in this album' });
      }

      // Check download permissions for each track
      // Admin users bypass permission checks
      const isAdmin = isHome && req.user?.isAdmin; // admin bypass applies to the home server only
      if (!isAdmin) {
        for (const track of tracks) {
          const isExplicitlyDisabled = track.allowSync === false ||
                                       track.allowSync === 0 ||
                                       track.allowSync === '0';
          if (isExplicitlyDisabled) {
            logger.warn('Album download denied: user lacks download permission for at least one track', {
              userId: req.user?.id,
              albumRatingKey,
              trackRatingKey: track.ratingKey,
              trackTitle: track.title
            });
            return res.status(403).json({
              error: 'Download not allowed. Some tracks in this album are not available for download.'
            });
          }
        }
      }

      // Prepare files for zipping
      const files: ZipFileEntry[] = [];
      let totalSize = 0;

      for (const track of tracks) {
        if (track.Media?.[0]?.Part?.[0]) {
          const part = track.Media[0].Part[0];
          const downloadUrl = plex.getDownloadUrl(part.key, token);
          // Use path.basename to ensure we only get the filename, not the full path
          const filename = path.basename(part.file) || `Track_${track.index}.${part.container}`;
          const size = part.size || 0;

          files.push({
            url: downloadUrl,
            filename,
            size
          });

          totalSize += size;
        }
      }

      // Warn if total size is over 10GB (10737418240 bytes)
      const tenGB = 10737418240;
      if (totalSize > tenGB) {
        logger.warn('Large album download initiated', {
          userId: req.user?.id,
          albumRatingKey,
          totalSizeGB: (totalSize / 1073741824).toFixed(2),
          trackCount: files.length
        });
      }

      // Generate zip filename: "Album.zip"
      const zipFilename = `${albumMetadata.title}.zip`;

      // Log the download and track its outcome (#13)
      const libraryTitle = albumMetadata.librarySectionTitle || 'Unknown Library';
      const downloadTitle = `${isHome ? '' : `[${serverName}] `}${libraryTitle} - ${albumMetadata.title} (${files.length} tracks)`;
      const logId = db.logDownload(
        req.user!.id,
        downloadTitle,
        albumRatingKey,
        totalSize
      );
      res.on('finish', () => db.updateDownloadLogStatus(logId, 'completed'));
      res.on('close', () => {
        if (!res.writableEnded) db.updateDownloadLogStatus(logId, 'interrupted');
      });

      logger.info(`Album download started: ${downloadTitle} by user ${req.user?.username}`);

      // Stream zip to client
      await createZipStream(res, files, zipFilename);

      return;
    } catch (error) {
      logger.error('Album download failed', { error });
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Album download failed' });
      }
      return;
    }
  });

  // Get thumbnail/poster proxy
  // Support both Authorization header and query parameter token for image requests
  router.get('/thumb/:ratingKey', async (req: AuthRequest, res) => {
    try {
      const { path, token } = req.query;

      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'Thumbnail path is required' });
      }

      // Check authentication from query parameter first (for <img> tags), then from header
      let user = req.user;
      if (!user && token && typeof token === 'string') {
        const session = db.getSessionByToken(token);
        if (session) {
          const adminUser = db.getAdminUserById(session.userId);
          if (adminUser) {
            user = {
              id: adminUser.id,
              username: adminUser.username,
              isAdmin: adminUser.isAdmin,
            };
          } else {
            const plexUser = db.getPlexUserById(session.userId);
            if (plexUser) {
              user = {
                id: plexUser.id,
                username: plexUser.username,
                isAdmin: plexUser.isAdmin,
                plexToken: plexUser.plexToken,
                plexAccountToken: plexUser.plexAccountToken,
                serverUrl: plexUser.serverUrl,
              };
            }
          }
        }
      }

      if (!user) {
        return res.status(401).json({ error: 'No token provided' });
      }

      // Temporarily set req.user for the server-context helper
      req.user = user;
      const { token: plexToken, serverUrl, error: credError } = await resolveServerContext(req);

      if (credError) {
        return res.status(403).json({ error: credError });
      }

      if (!plexToken || !serverUrl) {
        return res.status(401).json({ error: 'Plex token required - configure in settings' });
      }

      const plex = createPlexClient(serverUrl);
      const thumbUrl = plex.getThumbnailUrl(path, plexToken);
      const response = await axios({
        method: 'GET',
        url: thumbUrl,
        responseType: 'stream',
        httpsAgent: httpsAgent,
      });

      res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }

      response.data.pipe(res);
      return;
    } catch (error) {
      logger.error('Thumbnail proxy failed', { error });
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to load thumbnail' });
      }
      return;
    }
  });

  return router;
};
