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
  // Remote-server jobs encode locally on the M4 from the original file
  // (reliable) instead of streaming the source Plex's live HLS transcode
  // (fragile across the internet). localEncode=true uses the original at
  // partKey + software x264.
  localEncode?: boolean;
  partKey?: string;
}

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export class TranscodeService {
  private db: DatabaseService;
  private queue: JobSpec[] = [];
  // Track in-flight jobs. HLS/download phases have a `child` ffmpeg; the host
  // encode phase has no local child — `cancelHost` writes the .cancel marker
  // so the host helper aborts.
  private active = new Map<string, { child?: ChildProcess; spec: JobSpec; cancelHost?: () => void }>();

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

  // Run one conversion per server in parallel (a server only does one at a
  // time, but home + each remote can encode simultaneously), capped by a
  // global safety limit so we never spawn too many ffmpeg at once.
  private pump(): void {
    const busy = new Set<string>();
    for (const { spec } of this.active.values()) busy.add(spec.serverUrl);

    let i = 0;
    while (i < this.queue.length) {
      if (this.active.size >= config.transcode.maxConcurrent) break; // global cap
      const spec = this.queue[i];
      const job = this.db.getTranscodeJob(spec.id);
      if (!job || job.status === 'canceled') {
        this.queue.splice(i, 1);
        continue;
      }
      if (busy.has(spec.serverUrl)) {
        i++; // that server is already converting; leave this one queued
        continue;
      }
      this.queue.splice(i, 1);
      busy.add(spec.serverUrl);
      this.run(spec);
    }
  }

  private run(spec: JobSpec): void {
    if (spec.localEncode) {
      void this.runLocalEncode(spec);
      return;
    }
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
      // Fail a stalled network read after 60s instead of hanging forever when
      // a remote Plex session dies mid-stream (µs).
      '-rw_timeout', '60000000',
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
    let lastAdvanceAt = Date.now();
    let lastOutTime = -1;

    // Watchdog: kill a job whose actual output time hasn't advanced for a
    // while (remote Plex session died / segments stopped flowing). Keyed on
    // real progress, NOT any ffmpeg output — `-progress` emits keepalive
    // lines even while stuck, which would otherwise reset the timer forever.
    const watchdog = setInterval(() => {
      if (Date.now() - lastAdvanceAt > config.transcode.stallTimeoutMs) {
        logger.warn('Transcode job stalled; killing', { jobId: spec.id });
        this.fail(spec, 'Conversion stalled — the source server stopped sending video.');
      }
    }, 30_000);

    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString();
      const m = text.match(/out_time_ms=(\d+)/g);
      if (m) {
        const us = parseInt(m[m.length - 1].split('=')[1], 10);
        if (us > lastOutTime) {
          lastOutTime = us;
          lastAdvanceAt = Date.now(); // only real advancement resets the watchdog
          if (spec.durationSec && spec.durationSec > 0) {
            const pct = Math.min(99, (us / 1_000_000 / spec.durationSec) * 100);
            this.db.updateTranscodeJobProgress(spec.id, pct);
          }
        }
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

  // Remote path: pull the original file (robust static serve + reconnect),
  // then software-encode it locally on the M4. Avoids the fragile live Plex
  // transcode session that keeps dying across the internet. Two ffmpeg
  // phases; the original is deleted right after the encode.
  private async runLocalEncode(spec: JobSpec): Promise<void> {
    this.db.setTranscodeJobProcessing(spec.id, spec.durationSec);
    const src = path.join(config.transcode.tempDir, `${spec.id}.src.mkv`);
    const final = this.outputPath(spec.id);
    const dur = spec.durationSec || 0;
    const originalUrl = `${spec.serverUrl}${spec.partKey}?download=1&X-Plex-Token=${encodeURIComponent(spec.token)}`;

    try {
      // Phase 1: download original → src (download progress maps to 0–15%)
      await this.runChild(
        spec,
        [
          '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1',
          '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
          '-rw_timeout', '60000000',
          '-i', originalUrl,
          '-c', 'copy', '-f', 'matroska', '-y', src,
        ],
        (us) => (dur > 0 ? Math.min(15, (us / 1e6 / dur) * 15) : 0)
      );

      // Pick the English text subtitle stream from the downloaded original
      const subIdx = spec.subtitleStreamId ? this.findEngTextSubIndex(src) : null;

      // Phase 2: hand the heavy encode to the host's hardware encoder
      // (VideoToolbox) via the file-queue helper — ~4x faster + off the CPU.
      // The helper writes the finished MP4 directly to `final`.
      await this.hostEncode(spec, src, final, subIdx);

      const size = fs.statSync(final).size;
      const subsIncluded = subIdx != null && this.hasSubtitleStream(final);
      this.db.setTranscodeJobReady(spec.id, final, size, subsIncluded);
      this.safeUnlink(src); // drop the original once converted
      this.cleanJobArtifacts(spec.id);
      logger.info('Transcode (host encode) ready', { jobId: spec.id, size, subsIncluded });
    } catch (err: any) {
      this.safeUnlink(src);
      this.safeUnlink(final);
      this.safeUnlink(`${final}.part`);
      // If canceled mid-flight, don't overwrite the canceled status
      const current = this.db.getTranscodeJob(spec.id);
      if (current?.status !== 'canceled') {
        logger.warn('Local encode failed', { jobId: spec.id, error: err?.message });
        this.db.setTranscodeJobFailed(spec.id, err?.message || 'Local encode failed');
      }
      this.cleanJobArtifacts(spec.id);
    }
    this.pump();
  }

  // Hand the encode to the macOS host's VideoToolbox helper via the shared
  // file queue. Writes a job spec (host paths), polls progress + the done
  // marker; tracked in `active` (no child — cancel writes a .cancel marker).
  private hostEncode(spec: JobSpec, src: string, out: string, subIdx: number | null): Promise<void> {
    const jobsDir = path.join(config.transcode.tempDir, 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    // Translate a container cache path to the host's view, with a path
    // boundary check (so /transcode-cache2/… can't be mistaken for inside).
    const base = config.transcode.tempDir;
    const toHost = (cp: string) =>
      cp === base || cp.startsWith(base + path.sep)
        ? config.transcode.hostTempDir + cp.slice(base.length)
        : cp;
    const jp = (ext: string) => path.join(jobsDir, `${spec.id}.${ext}`);
    const height = parseInt(spec.preset.videoResolution.split('x')[1] || '1080', 10);
    // VideoToolbox is a bit less bitrate-efficient than x264 — bump ~15%
    const bitrateK = Math.round(spec.preset.maxVideoBitrate * 1.15);
    const jobSpec = {
      src: toHost(src),
      out: toHost(out),
      bitrateK,
      height,
      subIndex: subIdx,
      audioBitrateK: 192,
    };

    return new Promise<void>((resolve, reject) => {
      // Register in active so pump() keeps this server busy; cancel() writes
      // the .cancel marker via cancelHost.
      this.active.set(spec.id, { spec, cancelHost: () => this.writeCancelMarker(spec.id) });

      // Write the job atomically so the helper never reads a partial spec
      try {
        const tmp = jp('job.json.tmp');
        fs.writeFileSync(tmp, JSON.stringify(jobSpec));
        fs.renameSync(tmp, jp('job.json'));
      } catch (e: any) {
        this.active.delete(spec.id);
        reject(new Error(`failed to queue host job: ${e.message}`));
        return;
      }

      const dur = spec.durationSec || 0;
      let lastAdvanceAt = Date.now();
      let lastProg = -1;
      const poll = setInterval(() => {
        // Canceled out from under us (active removed) → stop
        if (this.active.get(spec.id)?.spec !== spec) {
          clearInterval(poll);
          reject(new Error('canceled'));
          return;
        }
        // Stall: no progress (and no done) for the timeout → give up
        if (Date.now() - lastAdvanceAt > config.transcode.stallTimeoutMs) {
          clearInterval(poll);
          this.active.delete(spec.id);
          this.writeCancelMarker(spec.id);
          reject(new Error('host encode stalled (no progress)'));
          return;
        }
        try {
          const v = parseInt(fs.readFileSync(jp('progress'), 'utf8'), 10);
          // Any change counts as liveness — a decrease means the helper
          // restarted and is re-encoding from 0 (not a stall).
          if (v !== lastProg) {
            lastProg = v;
            lastAdvanceAt = Date.now();
            if (dur > 0) this.db.updateTranscodeJobProgress(spec.id, 15 + Math.min(84, (v / 1e6 / dur) * 85));
          }
        } catch {/* no progress yet */}
        try {
          const done = JSON.parse(fs.readFileSync(jp('done.json'), 'utf8'));
          clearInterval(poll);
          this.active.delete(spec.id);
          if (done.ok) resolve();
          else reject(new Error(done.error || 'host encode failed'));
        } catch {/* not done yet */}
      }, 2000);
    });
  }

  private writeCancelMarker(jobId: string): void {
    try {
      fs.writeFileSync(path.join(config.transcode.tempDir, 'jobs', `${jobId}.cancel`), '1');
    } catch {/* helper will also idle out */}
  }

  // Only delete container-owned artifacts. `.claimed` and `.cancel` belong to
  // the helper (it consumes/removes them) — deleting `.cancel` here would race
  // the helper's 2s cancel check and leave a zombie encode running.
  private cleanJobArtifacts(jobId: string): void {
    const jobsDir = path.join(config.transcode.tempDir, 'jobs');
    for (const ext of ['job.json', 'job.json.tmp', 'progress', 'done.json']) {
      this.safeUnlink(path.join(jobsDir, `${jobId}.${ext}`));
    }
  }

  // Spawn one ffmpeg, tracking it in `active`, parsing -progress for real
  // advancement (drives progress + stall watchdog). Resolves on exit 0,
  // rejects otherwise (incl. kill via cancel/stall).
  private runChild(spec: JobSpec, args: string[], progressPct: (us: number) => number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.active.set(spec.id, { child, spec });
      let stderr = '';
      let lastAdvanceAt = Date.now();
      let lastOutTime = -1;

      const watchdog = setInterval(() => {
        if (Date.now() - lastAdvanceAt > config.transcode.stallTimeoutMs) {
          clearInterval(watchdog);
          logger.warn('Local job stalled; killing', { jobId: spec.id });
          child.kill('SIGKILL');
        }
      }, 30_000);

      child.stdout.on('data', (buf: Buffer) => {
        const m = buf.toString().match(/out_time_ms=(\d+)/g);
        if (m) {
          const us = parseInt(m[m.length - 1].split('=')[1], 10);
          if (us > lastOutTime) {
            lastOutTime = us;
            lastAdvanceAt = Date.now();
            this.db.updateTranscodeJobProgress(spec.id, progressPct(us));
          }
        }
      });
      child.stderr.on('data', (buf: Buffer) => {
        stderr += buf.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.on('error', (e) => {
        clearInterval(watchdog);
        if (this.active.get(spec.id)?.child === child) this.active.delete(spec.id);
        reject(e);
      });
      child.on('close', (code) => {
        clearInterval(watchdog);
        if (this.active.get(spec.id)?.child === child) this.active.delete(spec.id);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`));
      });
    });
  }

  // First English text-subtitle stream index (relative to subtitle streams,
  // for -map 0:s:N), or null. Excludes image subs (pgs/vobsub) and commentary.
  private findEngTextSubIndex(file: string): number | null {
    try {
      const out = spawnSync(
        'ffprobe',
        ['-v', 'error', '-select_streams', 's', '-show_entries',
         'stream=codec_name:stream_tags=language,title', '-of', 'json', file],
        { encoding: 'utf8', timeout: 20000 }
      );
      const streams = JSON.parse(out.stdout || '{}').streams || [];
      const TEXT = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
      for (let i = 0; i < streams.length; i++) {
        const s = streams[i];
        const lang = (s.tags?.language || '').toLowerCase();
        const title = (s.tags?.title || '').toLowerCase();
        if ((lang === 'eng' || lang === 'en') && TEXT.has((s.codec_name || '').toLowerCase()) && !title.includes('commentary')) {
          return i; // i = index among subtitle streams → 0:s:i
        }
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  private fail(spec: JobSpec, message: string): void {
    const entry = this.active.get(spec.id);
    if (entry) {
      this.active.delete(spec.id);
      entry.child?.kill('SIGKILL');
      entry.cancelHost?.();
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
      entry.child?.kill('SIGKILL'); // download phase: close handler sees it's gone
      entry.cancelHost?.(); // host encode phase: tell the helper to abort
      this.db.setTranscodeJobStatus(jobId, 'canceled');
      this.deleteJobOutput(jobId); // .part + .mp4 + .src
      this.cleanJobArtifacts(jobId);
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
    this.safeUnlink(path.join(config.transcode.tempDir, `${jobId}.src.mkv`)); // pulled original
  }

  // On boot: fail jobs left mid-flight by a crash/restart and clear orphan
  // .part files (the ffmpeg processes died with the old container).
  recoverOnStartup(): void {
    const interrupted = this.db.getInterruptedTranscodeJobs();
    for (const job of interrupted) {
      this.db.setTranscodeJobFailed(job.id, 'Interrupted by server restart');
      // A host encode may still be running for this job (the helper outlives
      // the container) — tell it to abort, then clean up.
      this.writeCancelMarker(job.id);
      this.deleteJobOutput(job.id);
      this.cleanJobArtifacts(job.id);
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
    // Sweep orphaned job-queue artifacts (e.g. a .cancel left when the helper
    // was down, or stray markers from a crash) older than 6h.
    try {
      const jobsDir = path.join(config.transcode.tempDir, 'jobs');
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(jobsDir)) {
        const f = path.join(jobsDir, name);
        try { if (fs.statSync(f).mtimeMs < cutoff) this.safeUnlink(f); } catch {}
      }
    } catch {/* jobs dir may not exist yet */}
  }

  // SIGTERM/SIGINT: kill active ffmpeg, release their Plex sessions, mark the
  // rows failed, and drop partial files so nothing outlives the process.
  shutdown(): void {
    for (const [jobId, { child, spec, cancelHost }] of this.active) {
      child?.kill('SIGKILL');
      cancelHost?.(); // tell the host helper to abort its encode
      this.db.setTranscodeJobFailed(jobId, 'Interrupted by server shutdown');
      this.deleteJobOutput(jobId); // .part + .mp4 + the pulled .src.mkv (can be huge)
      this.cleanJobArtifacts(jobId);
      this.stopPlexSession(spec);
    }
    this.active.clear();
  }
}
