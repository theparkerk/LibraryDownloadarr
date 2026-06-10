import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import axios from 'axios';
import { DatabaseService } from '../models/database';
import { TranscodePreset } from './transcodePresets';
import { config } from '../config';
import { logger } from '../utils/logger';

// Plex local/plex.direct endpoints use self-signed-ish certs; match the
// rest of the app's agent so stop requests don't fail TLS verification.
const plexHttpsAgent = new https.Agent({ rejectUnauthorized: false });

// Pre-builds a device-quality download by driving the source Plex server's
// transcoder (it does the heavy encode) and remuxing the resulting HLS
// stream into a seekable MP4 with `ffmpeg -c copy` (cheap, no re-encode).
// One ffmpeg per job; a small bounded queue gates concurrency since the
// Plex-side encode is heavy.

interface JobSpec {
  id: string;
  ratingKey: string; // numeric Plex ratingKey (validated by caller)
  serverUrl: string; // resolved, plex.tv-vouched URL (never client-supplied)
  token: string;
  preset: TranscodePreset;
  durationSec?: number; // for progress %
  subtitleStreamId?: string; // English text subtitle to mux as soft mov_text
  subsRetried?: boolean; // internal: already retried once without subs
}

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export class TranscodeService {
  private db: DatabaseService;
  private queue: JobSpec[] = [];
  // Track the spec alongside the child so teardown/shutdown can stop the
  // matching Plex session.
  private active = new Map<string, { child: ChildProcess; spec: JobSpec }>();

  constructor(db: DatabaseService) {
    this.db = db;
    fs.mkdirSync(config.transcode.tempDir, { recursive: true });
  }

  // queued + in-flight; the route uses this to enforce the queue cap
  pendingCount(): number {
    return this.queue.length + this.active.size;
  }

  private outputPath(jobId: string): string {
    return path.join(config.transcode.tempDir, `${jobId}.mp4`);
  }
  private partPath(jobId: string): string {
    return path.join(config.transcode.tempDir, `${jobId}.mp4.part`);
  }

  // Build the Plex universal-transcoder HLS URL. All interpolated values are
  // either resolved server data or our own preset/session constants —
  // ratingKey is validated numeric by the caller — so nothing user-controlled
  // reaches a shell (spawn uses an args array, no shell anyway).
  private buildTranscodeUrl(spec: JobSpec): string {
    const p = spec.preset;
    const sessionId = `ldarr-${spec.id}`;
    const params = new URLSearchParams({
      path: `/library/metadata/${spec.ratingKey}`,
      mediaIndex: '0',
      partIndex: '0',
      protocol: 'hls',
      directPlay: '0',
      directStream: '0',
      videoResolution: p.videoResolution,
      maxVideoBitrate: String(p.maxVideoBitrate),
      videoQuality: String(p.videoQuality),
      'X-Plex-Token': spec.token,
      'X-Plex-Client-Identifier': sessionId,
      session: sessionId,
      'X-Plex-Product': config.plex.product,
      'X-Plex-Platform': 'Web',
    });
    if (spec.subtitleStreamId) {
      // Ask Plex to deliver the English text subtitle as a sidecar (WebVTT)
      // rendition; the profile hint pushes its decision to "transcode" rather
      // than "burn", and ffmpeg muxes it as a soft mov_text track.
      params.set('subtitles', 'auto');
      params.set('subtitleStreamID', spec.subtitleStreamId);
      params.set('X-Plex-Client-Profile-Extra', 'add-direct-play-profile(type=subtitleProfile&codec=srt)');
    } else {
      params.set('subtitles', 'none');
    }
    return `${spec.serverUrl}/video/:/transcode/universal/start.m3u8?${params.toString()}`;
  }

  enqueue(spec: JobSpec): void {
    this.queue.push(spec);
    this.pump();
  }

  private pump(): void {
    while (this.active.size < config.transcode.maxConcurrent && this.queue.length > 0) {
      const spec = this.queue.shift()!;
      // Skip jobs canceled while queued
      const job = this.db.getTranscodeJob(spec.id);
      if (!job || job.status === 'canceled') continue;
      this.run(spec);
    }
  }

  private run(spec: JobSpec): void {
    const url = this.buildTranscodeUrl(spec);
    const out = this.partPath(spec.id);
    this.db.setTranscodeJobProcessing(spec.id, spec.durationSec);

    // When subtitles are requested, map them optionally (trailing '?') and
    // convert to mov_text, so a missing/undeliverable sub never fails the
    // video conversion — worst case you get a video-only file.
    const codecArgs = spec.subtitleStreamId
      ? [
          '-map', '0:v:0?', '-map', '0:a:0?', '-map', '0:s:0?',
          '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
          '-metadata:s:s:0', 'language=eng',
        ]
      : ['-c', 'copy'];

    const args = [
      '-nostdin',
      '-loglevel', 'error',
      '-progress', 'pipe:1',
      // HLS over https (plex.direct) needs the protocol whitelist
      '-protocol_whitelist', 'file,crypto,data,http,https,tcp,tls',
      '-i', url,
      ...codecArgs,
      '-movflags', '+faststart',
      // Output goes to a .part file; ffmpeg can't infer the muxer from that
      // extension, so name it explicitly
      '-f', 'mp4',
      '-y',
      out,
    ];

    logger.info('Transcode job starting', { jobId: spec.id, quality: spec.preset.id });
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.active.set(spec.id, { child, spec });

    let stderr = '';
    let lastProgressAt = Date.now();

    // Watchdog: kill a stalled job (Plex session died / no segments flowing)
    const watchdog = setInterval(() => {
      if (Date.now() - lastProgressAt > config.transcode.stallTimeoutMs) {
        logger.warn('Transcode job stalled; killing', { jobId: spec.id });
        this.fail(spec, 'Transcode stalled (no progress)');
      }
    }, 30_000);

    child.stdout.on('data', (buf: Buffer) => {
      lastProgressAt = Date.now();
      const text = buf.toString();
      const m = text.match(/out_time_ms=(\d+)/g);
      if (m && spec.durationSec && spec.durationSec > 0) {
        const last = m[m.length - 1];
        const us = parseInt(last.split('=')[1], 10);
        const pct = Math.min(99, (us / 1_000_000 / spec.durationSec) * 100);
        this.db.updateTranscodeJobProgress(spec.id, pct);
      }
    });
    child.stderr.on('data', (buf: Buffer) => {
      stderr += buf.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (err) => {
      clearInterval(watchdog);
      this.fail(spec, `ffmpeg spawn failed: ${err.message}`);
    });

    child.on('close', (code) => {
      clearInterval(watchdog);
      if (!this.active.has(spec.id)) {
        // Already torn down (cancel/fail/stall) — nothing more to do
        this.pump();
        return;
      }
      this.active.delete(spec.id);
      if (code === 0) {
        try {
          const final = this.outputPath(spec.id);
          fs.renameSync(out, final);
          const size = fs.statSync(final).size;
          const subsIncluded = spec.subtitleStreamId ? this.hasSubtitleStream(final) : false;
          this.db.setTranscodeJobReady(spec.id, final, size, subsIncluded);
          this.stopPlexSession(spec); // release the source session promptly
          logger.info('Transcode job ready', { jobId: spec.id, size, subsIncluded });
        } catch (e: any) {
          this.db.setTranscodeJobFailed(spec.id, `finalize failed: ${e.message}`);
          this.stopPlexSession(spec);
        }
      } else {
        const reason = stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`;
        // If a subtitled conversion failed, retry once without subtitles so
        // the video still gets through (a bad text-sub stream shouldn't sink
        // the whole download).
        if (spec.subtitleStreamId && !spec.subsRetried) {
          logger.warn('Transcode failed with subtitles; retrying without', { jobId: spec.id, reason });
          this.stopPlexSession(spec);
          this.safeUnlink(out);
          this.run({ ...spec, subtitleStreamId: undefined, subsRetried: true });
          return;
        }
        logger.warn('Transcode job failed', { jobId: spec.id, code, reason });
        this.db.setTranscodeJobFailed(spec.id, reason);
        this.safeUnlink(out);
        this.stopPlexSession(spec);
      }
      this.pump();
    });
  }

  private fail(spec: JobSpec, message: string): void {
    const entry = this.active.get(spec.id);
    if (entry) {
      this.active.delete(spec.id);
      entry.child.kill('SIGKILL');
    }
    this.db.setTranscodeJobFailed(spec.id, message);
    this.safeUnlink(this.partPath(spec.id));
    this.stopPlexSession(spec);
    this.pump();
  }

  // Cancel a queued or in-flight job. Returns false if it wasn't cancelable
  // (already finished/gone). The route validates ownership first.
  cancel(jobId: string): boolean {
    const qi = this.queue.findIndex((s) => s.id === jobId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.db.setTranscodeJobStatus(jobId, 'canceled');
      return true;
    }
    const entry = this.active.get(jobId);
    if (entry) {
      this.active.delete(jobId);
      entry.child.kill('SIGKILL'); // the close handler sees it's gone and just pumps
      this.db.setTranscodeJobStatus(jobId, 'canceled');
      this.safeUnlink(this.partPath(jobId));
      this.stopPlexSession(entry.spec);
      this.pump();
      return true;
    }
    return false;
  }

  // Best-effort release of the Plex transcode session
  private stopPlexSession(spec: JobSpec): void {
    const sessionId = `ldarr-${spec.id}`;
    const url = `${spec.serverUrl}/video/:/transcode/universal/stop?session=${encodeURIComponent(
      sessionId
    )}&X-Plex-Token=${encodeURIComponent(spec.token)}`;
    axios
      .get(url, { httpsAgent: plexHttpsAgent, timeout: 8000 })
      .catch(() => {/* session will idle out on its own */});
  }

  private safeUnlink(p: string): void {
    fs.promises.unlink(p).catch(() => {});
  }

  // Did a subtitle track actually land in the output? (ffprobe ships with the
  // ffmpeg apk package.) Best-effort — false on any error.
  private hasSubtitleStream(file: string): boolean {
    try {
      const out = spawnSync(
        'ffprobe',
        ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
        { encoding: 'utf8', timeout: 15000 }
      );
      return !!out.stdout && out.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  // Called by the route when a download finishes (or the file ages out)
  deleteJobOutput(jobId: string): void {
    this.safeUnlink(this.outputPath(jobId));
    this.safeUnlink(this.partPath(jobId));
  }

  // On boot: fail jobs left mid-flight by a crash/restart and clear orphan
  // .part files (the ffmpeg processes died with the old container).
  recoverOnStartup(): void {
    const interrupted = this.db.getInterruptedTranscodeJobs();
    for (const job of interrupted) {
      this.db.setTranscodeJobFailed(job.id, 'Interrupted by server restart');
      this.deleteJobOutput(job.id);
    }
    if (interrupted.length > 0) {
      logger.info(`Recovered ${interrupted.length} interrupted transcode jobs`);
    }
  }

  // Hourly: drop aged-out ready files + their rows, and tidy old terminal rows
  cleanupExpired(): void {
    const expired = this.db.getExpiredTranscodeJobs(config.transcode.fileTtlMs);
    for (const job of expired) {
      this.deleteJobOutput(job.id);
      this.db.deleteTranscodeJob(job.id);
    }
    if (expired.length > 0) {
      logger.info(`Cleaned up ${expired.length} expired transcode files`);
    }
    // Failed/canceled rows have no file; clear ones older than the TTL
    const purged = this.db.deleteStaleTerminalTranscodeJobs(config.transcode.fileTtlMs);
    if (purged > 0) {
      logger.info(`Cleared ${purged} old failed/canceled transcode rows`);
    }
  }

  // SIGTERM/SIGINT: kill active ffmpeg, release their Plex sessions, mark the
  // rows failed, and drop partial files so nothing outlives the process.
  shutdown(): void {
    for (const [jobId, { child, spec }] of this.active) {
      child.kill('SIGKILL');
      this.db.setTranscodeJobFailed(jobId, 'Interrupted by server shutdown');
      this.safeUnlink(this.partPath(jobId));
      this.stopPlexSession(spec);
    }
    this.active.clear();
  }
}
