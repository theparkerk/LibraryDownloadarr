import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../utils/logger';

export interface User {
  id: string;
  username: string;
  email: string;
  // Token for talking to the home server (the share accessToken for users
  // whose access comes via a Plex share)
  plexToken?: string;
  // The user's own plex.tv account token (from OAuth) — required to
  // enumerate servers shared with their account; distinct from plexToken
  plexAccountToken?: string;
  plexId?: string;
  serverUrl?: string;
  isAdmin: boolean;
  createdAt: number;
  lastLogin?: number;
}

export interface AdminUser {
  id: string;
  username: string;
  passwordHash: string;
  email: string;
  isAdmin: boolean;
  createdAt: number;
  lastLogin?: number;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  expiresAt: number;
  createdAt: number;
}

export interface Settings {
  key: string;
  value: string;
  updatedAt: number;
}

// 'transcode' tokens authorize the headerless download of a finished
// transcode job's temp file; ratingKey holds the jobId in that case.
export type DownloadScopeType = 'file' | 'season' | 'album' | 'transcode';

export interface DownloadToken {
  id: string;
  token: string;
  userId: string;
  scopeType: DownloadScopeType;
  ratingKey: string;
  partKey?: string;
  serverId?: string;
  expiresAt: number;
  createdAt: number;
}

export type DownloadLogStatus = 'started' | 'completed' | 'interrupted' | 'failed';

export type TranscodeJobStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'canceled';

export interface TranscodeJob {
  id: string;
  userId: string;
  ratingKey: string;
  serverId?: string;
  quality: string;
  title: string;
  status: TranscodeJobStatus;
  progress: number; // 0..100
  outputPath?: string;
  fileSize?: number;
  durationSec?: number;
  error?: string;
  subtitles: boolean; // English soft-subs requested
  subtitleStreamId?: string; // chosen English text subtitle stream, if any
  subtitlesIncluded?: boolean; // whether a sub track actually made it in
  createdAt: number;
  startedAt?: number; // processing-start, for ETA
  readyAt?: number;
}

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    // Use DELETE mode instead of WAL for Docker compatibility
    // WAL requires shared memory files that may not work with bind mounts
    this.db.pragma('journal_mode = DELETE');
    this.initializeTables();
    logger.info(`Database initialized at ${dbPath}`);
  }

  private initializeTables(): void {
    // Admin users table (local authentication)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        is_admin INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_login INTEGER
      )
    `);

    // Plex users table (OAuth authenticated users)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plex_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT,
        plex_token TEXT,
        plex_id TEXT UNIQUE,
        server_url TEXT,
        is_admin INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_login INTEGER
      )
    `);

    // Migration: Add server_url column if it doesn't exist
    const hasServerUrl = this.db.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('plex_users') WHERE name='server_url'
    `).get() as { count: number };

    if (hasServerUrl.count === 0) {
      logger.info('Adding server_url column to plex_users table');
      this.db.exec('ALTER TABLE plex_users ADD COLUMN server_url TEXT');
    }

    // Migration: multi-server support — keep the user's own plex.tv account
    // token (for enumerating their shared servers) separate from the
    // home-server access token. Populated on next login for existing users.
    const hasAccountToken = this.db.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('plex_users') WHERE name='plex_account_token'
    `).get() as { count: number };

    if (hasAccountToken.count === 0) {
      logger.info('Adding plex_account_token column to plex_users table');
      this.db.exec('ALTER TABLE plex_users ADD COLUMN plex_account_token TEXT');
    }

    // Migrate sessions table if it has the old FOREIGN KEY constraint
    // Check if sessions table exists with FOREIGN KEY
    const hasOldSchema = this.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='sessions' AND sql LIKE '%FOREIGN KEY%'
    `).get();

    if (hasOldSchema) {
      logger.info('Migrating sessions table to remove FOREIGN KEY constraint');
      // Drop old table and recreate without constraint
      this.db.exec('DROP TABLE IF EXISTS sessions');
    }

    // Sessions table (no FOREIGN KEY since we have both admin_users and plex_users)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // Settings table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Download logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS download_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        media_title TEXT NOT NULL,
        media_key TEXT NOT NULL,
        file_size INTEGER,
        downloaded_at INTEGER NOT NULL
      )
    `);

    // Migration: track download outcome (#13 - history used to record every
    // started stream as a download, including failed/aborted ones)
    const hasStatus = this.db.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('download_logs') WHERE name='status'
    `).get() as { count: number };

    if (hasStatus.count === 0) {
      logger.info('Adding status column to download_logs table');
      // Legacy rows predate tracking; label them 'completed' to preserve stats
      this.db.exec("ALTER TABLE download_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
    }

    // Short-lived scoped tokens that let the browser's native download
    // manager fetch files without an Authorization header (#16)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS download_tokens (
        id TEXT PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        rating_key TEXT NOT NULL,
        part_key TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // Migration: multi-server support — tokens are scoped to the server
    // they were issued for (NULL = home server)
    const hasServerId = this.db.prepare(`
      SELECT COUNT(*) as count FROM pragma_table_info('download_tokens') WHERE name='server_id'
    `).get() as { count: number };

    if (hasServerId.count === 0) {
      logger.info('Adding server_id column to download_tokens table');
      this.db.exec('ALTER TABLE download_tokens ADD COLUMN server_id TEXT');
    }

    // Server-side transcode jobs: a converted ("device quality") download is
    // pre-built to a temp file by ffmpeg, tracked here for progress polling
    // and reuse/dedup.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcode_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        rating_key TEXT NOT NULL,
        server_id TEXT,
        quality TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        output_path TEXT,
        file_size INTEGER,
        duration_sec REAL,
        error TEXT,
        created_at INTEGER NOT NULL,
        ready_at INTEGER
      )
    `);

    // Migration: ETA + subtitle support columns
    for (const [col, ddl] of [
      ['started_at', 'ALTER TABLE transcode_jobs ADD COLUMN started_at INTEGER'],
      ['subtitles', 'ALTER TABLE transcode_jobs ADD COLUMN subtitles INTEGER NOT NULL DEFAULT 0'],
      ['subtitle_stream_id', 'ALTER TABLE transcode_jobs ADD COLUMN subtitle_stream_id TEXT'],
      ['subtitles_included', 'ALTER TABLE transcode_jobs ADD COLUMN subtitles_included INTEGER'],
    ] as [string, string][]) {
      const has = this.db.prepare(
        `SELECT COUNT(*) as c FROM pragma_table_info('transcode_jobs') WHERE name=?`
      ).get(col) as { c: number };
      if (has.c === 0) {
        logger.info(`Adding ${col} column to transcode_jobs`);
        this.db.exec(ddl);
      }
    }

    logger.info('Database tables initialized');
  }

  // Admin user operations
  createAdminUser(user: Omit<AdminUser, 'id' | 'createdAt'>): AdminUser {
    const id = this.generateId();
    const createdAt = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO admin_users (id, username, password_hash, email, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, user.username, user.passwordHash, user.email, user.isAdmin ? 1 : 0, createdAt);

    return { ...user, id, createdAt };
  }

  getAdminUserByUsername(username: string): AdminUser | undefined {
    const stmt = this.db.prepare('SELECT * FROM admin_users WHERE username = ?');
    const row = stmt.get(username) as any;
    return row ? this.mapAdminUser(row) : undefined;
  }

  getAdminUserById(id: string): AdminUser | undefined {
    const stmt = this.db.prepare('SELECT * FROM admin_users WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapAdminUser(row) : undefined;
  }

  hasAdminUser(): boolean {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM admin_users WHERE is_admin = 1');
    const result = stmt.get() as { count: number };
    return result.count > 0;
  }

  updateAdminLastLogin(id: string): void {
    const stmt = this.db.prepare('UPDATE admin_users SET last_login = ? WHERE id = ?');
    stmt.run(Date.now(), id);
  }

  updateAdminPassword(id: string, passwordHash: string): void {
    const stmt = this.db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?');
    stmt.run(passwordHash, id);
  }

  // Plex user operations
  createOrUpdatePlexUser(plexUser: Omit<User, 'id' | 'createdAt' | 'isAdmin'>): User {
    const existing = this.getPlexUserByPlexId(plexUser.plexId!);

    if (existing) {
      // SECURITY: No longer store serverUrl - always use admin's configured server
      const stmt = this.db.prepare(`
        UPDATE plex_users
        SET username = ?, email = ?, plex_token = ?, plex_account_token = ?, server_url = NULL, last_login = ?
        WHERE plex_id = ?
      `);
      stmt.run(plexUser.username, plexUser.email, plexUser.plexToken, plexUser.plexAccountToken ?? null, Date.now(), plexUser.plexId);
      return { ...existing, ...plexUser, serverUrl: undefined, lastLogin: Date.now() };
    }

    const id = this.generateId();
    const createdAt = Date.now();
    // SECURITY: No longer store serverUrl - always use admin's configured server
    const stmt = this.db.prepare(`
      INSERT INTO plex_users (id, username, email, plex_token, plex_account_token, plex_id, server_url, created_at, last_login)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `);
    stmt.run(id, plexUser.username, plexUser.email, plexUser.plexToken, plexUser.plexAccountToken ?? null, plexUser.plexId, createdAt, createdAt);

    return { id, ...plexUser, isAdmin: false, createdAt, lastLogin: createdAt };
  }

  getPlexUserByPlexId(plexId: string): User | undefined {
    const stmt = this.db.prepare('SELECT * FROM plex_users WHERE plex_id = ?');
    const row = stmt.get(plexId) as any;
    return row ? this.mapPlexUser(row) : undefined;
  }

  getPlexUserById(id: string): User | undefined {
    const stmt = this.db.prepare('SELECT * FROM plex_users WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.mapPlexUser(row) : undefined;
  }

  // Session operations
  createSession(userId: string, expiresIn: number = 24 * 60 * 60 * 1000): Session {
    const id = this.generateId();
    const token = this.generateToken();
    const createdAt = Date.now();
    const expiresAt = createdAt + expiresIn;

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, user_id, token, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, userId, token, expiresAt, createdAt);

    return { id, userId, token, expiresAt, createdAt };
  }

  getSessionByToken(token: string): Session | undefined {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?');
    const row = stmt.get(token, Date.now()) as any;
    return row ? this.mapSession(row) : undefined;
  }

  deleteSession(token: string): void {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE token = ?');
    stmt.run(token);
  }

  cleanupExpiredSessions(): void {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
    const result = stmt.run(Date.now());
    if (result.changes > 0) {
      logger.info(`Cleaned up ${result.changes} expired sessions`);
    }
  }

  // Settings operations
  getSetting(key: string): string | undefined {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
    `);
    const now = Date.now();
    stmt.run(key, value, now, value, now);
  }

  // Download logs
  // Reuses a recent non-completed row for the same user+media so that
  // browser retries and ranged resumes don't pile up duplicate history
  // entries (#13). Returns the log row id for later status updates.
  logDownload(userId: string, mediaTitle: string, mediaKey: string, fileSize?: number): string {
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const existing = this.db.prepare(`
      SELECT id FROM download_logs
      WHERE user_id = ? AND media_key = ? AND status != 'completed' AND downloaded_at > ?
      ORDER BY downloaded_at DESC
      LIMIT 1
    `).get(userId, mediaKey, sixHoursAgo) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE download_logs SET downloaded_at = ?, status = 'started', file_size = COALESCE(?, file_size)
        WHERE id = ?
      `).run(Date.now(), fileSize, existing.id);
      return existing.id;
    }

    const id = this.generateId();
    const stmt = this.db.prepare(`
      INSERT INTO download_logs (id, user_id, media_title, media_key, file_size, downloaded_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'started')
    `);
    stmt.run(id, userId, mediaTitle, mediaKey, fileSize, Date.now());
    return id;
  }

  updateDownloadLogStatus(id: string, status: DownloadLogStatus): void {
    this.db.prepare('UPDATE download_logs SET status = ? WHERE id = ?').run(status, id);
  }

  // Download token operations
  createDownloadToken(
    userId: string,
    scopeType: DownloadScopeType,
    ratingKey: string,
    partKey?: string,
    serverId?: string,
    ttlMs: number = 24 * 60 * 60 * 1000
  ): DownloadToken {
    const id = this.generateId();
    const token = crypto.randomBytes(32).toString('hex');
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlMs;

    this.db.prepare(`
      INSERT INTO download_tokens (id, token, user_id, scope_type, rating_key, part_key, server_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, token, userId, scopeType, ratingKey, partKey ?? null, serverId ?? null, expiresAt, createdAt);

    return { id, token, userId, scopeType, ratingKey, partKey, serverId, expiresAt, createdAt };
  }

  getDownloadToken(token: string): DownloadToken | undefined {
    const row = this.db.prepare(
      'SELECT * FROM download_tokens WHERE token = ? AND expires_at > ?'
    ).get(token, Date.now()) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      token: row.token,
      userId: row.user_id,
      scopeType: row.scope_type,
      ratingKey: row.rating_key,
      partKey: row.part_key ?? undefined,
      serverId: row.server_id ?? undefined,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  cleanupExpiredDownloadTokens(): void {
    const result = this.db.prepare('DELETE FROM download_tokens WHERE expires_at <= ?').run(Date.now());
    if (result.changes > 0) {
      logger.info(`Cleaned up ${result.changes} expired download tokens`);
    }
  }

  // Transcode job operations
  private mapTranscodeJob(row: any): TranscodeJob {
    return {
      id: row.id,
      userId: row.user_id,
      ratingKey: row.rating_key,
      serverId: row.server_id ?? undefined,
      quality: row.quality,
      title: row.title,
      status: row.status,
      progress: row.progress,
      outputPath: row.output_path ?? undefined,
      fileSize: row.file_size ?? undefined,
      durationSec: row.duration_sec ?? undefined,
      error: row.error ?? undefined,
      subtitles: row.subtitles === 1,
      subtitleStreamId: row.subtitle_stream_id ?? undefined,
      subtitlesIncluded: row.subtitles_included == null ? undefined : row.subtitles_included === 1,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      readyAt: row.ready_at ?? undefined,
    };
  }

  createTranscodeJob(opts: {
    userId: string;
    ratingKey: string;
    serverId?: string;
    quality: string;
    title: string;
    subtitles: boolean;
    subtitleStreamId?: string;
  }): TranscodeJob {
    const id = this.generateId();
    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO transcode_jobs (id, user_id, rating_key, server_id, quality, title, status, progress, subtitles, subtitle_stream_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `).run(
      id, opts.userId, opts.ratingKey, opts.serverId ?? null, opts.quality, opts.title,
      opts.subtitles ? 1 : 0, opts.subtitleStreamId ?? null, createdAt
    );
    return {
      id, userId: opts.userId, ratingKey: opts.ratingKey, serverId: opts.serverId,
      quality: opts.quality, title: opts.title, status: 'queued', progress: 0,
      subtitles: opts.subtitles, subtitleStreamId: opts.subtitleStreamId, createdAt,
    };
  }

  getTranscodeJob(id: string): TranscodeJob | undefined {
    const row = this.db.prepare('SELECT * FROM transcode_jobs WHERE id = ?').get(id) as any;
    return row ? this.mapTranscodeJob(row) : undefined;
  }

  // Most recent jobs for a user (for the Conversions panel)
  getRecentTranscodeJobs(userId: string, limit: number = 25): TranscodeJob[] {
    const rows = this.db.prepare(
      'SELECT * FROM transcode_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit) as any[];
    return rows.map((r) => this.mapTranscodeJob(r));
  }

  // The currently-processing job (for ETA speed-factor); MAX_CONCURRENT=1
  getProcessingTranscodeJob(): TranscodeJob | undefined {
    const row = this.db.prepare(
      "SELECT * FROM transcode_jobs WHERE status = 'processing' ORDER BY started_at ASC LIMIT 1"
    ).get() as any;
    return row ? this.mapTranscodeJob(row) : undefined;
  }

  // Reuse a recent in-flight or ready job for the same content+server+quality
  // +subtitles so a double-click or a second family member doesn't re-transcode.
  findReusableTranscodeJob(
    userId: string,
    ratingKey: string,
    serverId: string | undefined,
    quality: string,
    subtitles: boolean
  ): TranscodeJob | undefined {
    const row = this.db.prepare(`
      SELECT * FROM transcode_jobs
      WHERE user_id = ? AND rating_key = ? AND quality = ? AND subtitles = ?
        AND ((server_id IS NULL AND ? IS NULL) OR server_id = ?)
        AND status IN ('queued', 'processing', 'ready')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(userId, ratingKey, quality, subtitles ? 1 : 0, serverId ?? null, serverId ?? null) as any;
    return row ? this.mapTranscodeJob(row) : undefined;
  }

  updateTranscodeJobProgress(id: string, progress: number): void {
    this.db.prepare('UPDATE transcode_jobs SET progress = ? WHERE id = ?').run(Math.round(progress), id);
  }

  setTranscodeJobProcessing(id: string, durationSec?: number): void {
    this.db.prepare(
      "UPDATE transcode_jobs SET status = 'processing', started_at = ?, duration_sec = COALESCE(?, duration_sec) WHERE id = ?"
    ).run(Date.now(), durationSec ?? null, id);
  }

  setTranscodeJobReady(id: string, outputPath: string, fileSize: number, subtitlesIncluded: boolean): void {
    this.db.prepare(
      "UPDATE transcode_jobs SET status = 'ready', progress = 100, output_path = ?, file_size = ?, subtitles_included = ?, ready_at = ? WHERE id = ?"
    ).run(outputPath, fileSize, subtitlesIncluded ? 1 : 0, Date.now(), id);
  }

  setTranscodeJobFailed(id: string, error: string): void {
    this.db.prepare("UPDATE transcode_jobs SET status = 'failed', error = ? WHERE id = ?").run(error, id);
  }

  setTranscodeJobStatus(id: string, status: TranscodeJobStatus): void {
    this.db.prepare('UPDATE transcode_jobs SET status = ? WHERE id = ?').run(status, id);
  }

  // Jobs left mid-flight by a restart (so the service can fail/sweep them)
  getInterruptedTranscodeJobs(): TranscodeJob[] {
    const rows = this.db.prepare(
      "SELECT * FROM transcode_jobs WHERE status IN ('queued', 'processing')"
    ).all() as any[];
    return rows.map((r) => this.mapTranscodeJob(r));
  }

  // Ready jobs whose temp file has aged out
  getExpiredTranscodeJobs(maxAgeMs: number): TranscodeJob[] {
    const cutoff = Date.now() - maxAgeMs;
    const rows = this.db.prepare(
      "SELECT * FROM transcode_jobs WHERE status = 'ready' AND ready_at IS NOT NULL AND ready_at < ?"
    ).all(cutoff) as any[];
    return rows.map((r) => this.mapTranscodeJob(r));
  }

  // Old failed/canceled rows — no file to clean, just tidy the table
  deleteStaleTerminalTranscodeJobs(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const res = this.db.prepare(
      "DELETE FROM transcode_jobs WHERE status IN ('failed','canceled') AND created_at < ?"
    ).run(cutoff);
    return res.changes;
  }

  deleteTranscodeJob(id: string): void {
    this.db.prepare('DELETE FROM transcode_jobs WHERE id = ?').run(id);
  }

  getDownloadHistory(userId: string, limit: number = 50): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM download_logs
      WHERE user_id = ?
      ORDER BY downloaded_at DESC
      LIMIT ?
    `);
    return stmt.all(userId, limit) as any[];
  }

  getAllDownloadHistory(limit: number = 100): any[] {
    const stmt = this.db.prepare(`
      SELECT dl.*,
             COALESCE(au.username, pu.username) as username
      FROM download_logs dl
      LEFT JOIN admin_users au ON dl.user_id = au.id
      LEFT JOIN plex_users pu ON dl.user_id = pu.id
      ORDER BY dl.downloaded_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as any[];
  }

  getDownloadStats(userId?: string): any {
    // Only completed downloads count toward stats (#13)
    let query = "SELECT COUNT(*) as count, SUM(file_size) as total_size FROM download_logs WHERE status = 'completed'";
    const params: any[] = [];

    if (userId) {
      query += ' AND user_id = ?';
      params.push(userId);
    }

    const stmt = this.db.prepare(query);
    return stmt.get(...params);
  }

  // Utility methods
  private mapAdminUser(row: any): AdminUser {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      email: row.email,
      isAdmin: row.is_admin === 1,
      createdAt: row.created_at,
      lastLogin: row.last_login,
    };
  }

  private mapPlexUser(row: any): User {
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      plexToken: row.plex_token,
      plexAccountToken: row.plex_account_token ?? undefined,
      plexId: row.plex_id,
      serverUrl: row.server_url,
      isAdmin: row.is_admin === 1,
      createdAt: row.created_at,
      lastLogin: row.last_login,
    };
  }

  private mapSession(row: any): Session {
    return {
      id: row.id,
      userId: row.user_id,
      token: row.token,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  close(): void {
    this.db.close();
  }
}
