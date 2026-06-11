import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { DatabaseService } from '../models/database';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ArchiveSource {
  path: string; // absolute path to a finished conversion .mp4
  name: string; // filename to use inside the zip
}

// Builds a single .zip of several finished conversions into a file on the
// transcode drive, then it's served resumably (byte-range) like a single
// conversion. Store (no compression) — the media is already compressed, so
// this is I/O-bound and fast, and lets us know the final size for resume.
export class ArchiveService {
  private dir = path.join(config.transcode.tempDir, 'archives');

  constructor(private db: DatabaseService) {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* created lazily on build */ }
  }

  outPathFor(id: string): string {
    return path.join(this.dir, `${id}.zip`);
  }

  private async build(id: string, sources: ArchiveSource[]): Promise<void> {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    const outPath = this.outPathFor(id);
    const totalBytes = sources.reduce((sum, f) => {
      try { return sum + fs.statSync(f.path).size; } catch { return sum; }
    }, 0);

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(outPath);
      const archive = archiver('zip', { zlib: { level: 0 } });
      let lastPct = 0;

      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('progress', (p) => {
        const pct = totalBytes > 0 ? Math.min(99, Math.round((p.fs.processedBytes / totalBytes) * 100)) : 0;
        if (pct !== lastPct) {
          lastPct = pct;
          try { this.db.updateArchiveJobProgress(id, pct); } catch { /* transient */ }
        }
      });

      archive.pipe(output);
      for (const f of sources) {
        if (fs.existsSync(f.path)) archive.file(f.path, { name: f.name });
      }
      archive.finalize().catch(reject);
    });

    const size = fs.statSync(outPath).size;
    this.db.setArchiveJobReady(id, outPath, size);
    logger.info(`Archive ${id} ready (${(size / 1073741824).toFixed(2)} GB, ${sources.length} files)`);
  }

  private queue: { id: string; sources: ArchiveSource[] }[] = [];
  private running = false;

  // Fire-and-forget: the route responds immediately with the job id and the
  // client polls for progress. Builds are SERIALIZED — two concurrent zip
  // builds reading + writing the same drive thrash it to a near-standstill
  // (~KB/s), so each waits its turn instead.
  start(id: string, sources: ArchiveSource[]): void {
    this.queue.push({ id, sources });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        try {
          await this.build(next.id, next.sources);
        } catch (e: any) {
          logger.error('Archive build failed', { id: next.id, error: e?.message });
          try { fs.unlinkSync(this.outPathFor(next.id)); } catch {}
          this.db.setArchiveJobFailed(next.id, e?.message || 'Archive build failed');
        }
      }
    } finally {
      this.running = false;
    }
  }

  // A build that was mid-flight when the process died can't resume — fail it
  // and drop the partial zip so the user can rebuild.
  recoverOnStartup(): void {
    for (const j of this.db.getProcessingArchiveJobs()) {
      try { fs.unlinkSync(this.outPathFor(j.id)); } catch {}
      this.db.setArchiveJobFailed(j.id, 'Interrupted by server restart');
    }
  }

  cleanupExpired(): void {
    for (const j of this.db.getExpiredArchiveJobs(config.transcode.fileTtlMs)) {
      if (j.outputPath) { try { fs.unlinkSync(j.outputPath); } catch {} }
      this.db.deleteArchiveJob(j.id);
    }
  }
}
