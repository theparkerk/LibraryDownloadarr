import path from 'path';

export const config = {
  server: {
    port: parseInt(process.env.PORT || '5069', 10),
  },
  plex: {
    clientIdentifier: 'librarydownloadarr',
    product: 'LibraryDownloadarr',
    version: '1.0.0',
    device: 'Server',
  },
  database: {
    path: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'librarydownloadarr.db'),
  },
  transcode: {
    // Temp dir for pre-built converted downloads. Defaults next to the DB so
    // it lives on the same mounted /app/data volume in Docker.
    tempDir:
      process.env.TRANSCODE_TEMP_DIR ||
      path.join(path.dirname(process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'x')), 'transcode-cache'),
    // Global safety cap on simultaneous ffmpeg jobs. One job runs per server
    // (home + each remote in parallel); this bounds the total across servers.
    maxConcurrent: parseInt(process.env.TRANSCODE_MAX_CONCURRENT || '3', 10),
    maxQueue: parseInt(process.env.TRANSCODE_MAX_QUEUE || '10', 10),
    // A ready converted file is kept this long (on our server) before the
    // hourly sweep deletes it + its job row. 24h by default.
    fileTtlMs: parseInt(process.env.TRANSCODE_FILE_TTL_MS || `${24 * 60 * 60 * 1000}`, 10),
    // Kill a job whose ffmpeg makes no progress for this long (stalled session)
    stallTimeoutMs: parseInt(process.env.TRANSCODE_STALL_MS || `${5 * 60 * 1000}`, 10),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  },
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10000, // limit each IP to 10000 requests per windowMs
  },
};
