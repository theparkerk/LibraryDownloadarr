#!/usr/bin/env node
// LibraryDownloadarr host transcode helper.
//
// Runs on the macOS host (NOT in the Docker container) so it can use the M4's
// hardware encoder (VideoToolbox) — ~4x faster than software libx264 and off
// the CPU. The container downloads the original + drops a job file in the
// shared queue dir; this helper claims it, runs the hardware encode, and
// writes the result back. Files are exchanged on /Volumes/Media (the same
// path the container sees, via its bind mount).
//
// Job protocol (per job id, all in JOBS_DIR):
//   <id>.job.json   container → spec { src, out, bitrateK, height, subIndex|null, audioBitrateK }
//   <id>.claimed    helper renames .job.json → .claimed to take the job (atomic)
//   <id>.progress   helper writes out_time_ms (encoded media-ms) ~every 2s
//   <id>.cancel     container → request abort
//   <id>.done.json  helper writes { ok, error?, size? }; the container reads + cleans up

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const JOBS_DIR = process.env.LDA_JOBS_DIR || '/Volumes/Media/lda-transcode-cache/jobs';
const FFMPEG = process.env.LDA_FFMPEG || '/opt/homebrew/bin/ffmpeg';
const MAX_CONCURRENT = parseInt(process.env.LDA_HELPER_CONCURRENCY || '2', 10);
const POLL_MS = 2000;

const active = new Map(); // id → child process
const log = (...a) => console.log(new Date().toISOString(), ...a);

const p = (id, ext) => path.join(JOBS_DIR, `${id}.${ext}`);
const writeAtomic = (file, data) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};
const safeUnlink = (f) => { try { fs.unlinkSync(f); } catch {} };

function processJob(id, spec) {
  const partOut = `${spec.out}.part`;
  const subMap =
    spec.subIndex != null
      ? ['-map', `0:s:${spec.subIndex}`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng']
      : [];
  const args = [
    '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1',
    '-i', spec.src,
    '-map', '0:v:0', '-map', '0:a:0', ...subMap,
    '-c:v', 'h264_videotoolbox', '-b:v', `${spec.bitrateK}k`,
    '-vf', `scale=-2:min(ih\\,${spec.height})`,
    '-c:a', 'aac', '-ac', '2', '-b:a', `${spec.audioBitrateK || 192}k`,
    '-movflags', '+faststart', '-f', 'mp4', '-y', partOut,
  ];

  log(`encode start ${id} → ${path.basename(spec.out)} (${spec.height}p ${spec.bitrateK}k${spec.subIndex != null ? ' +subs' : ''})`);
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  active.set(id, child);

  let stderr = '';
  let lastWrite = 0;
  let canceledByMarker = false;
  const cancelTimer = setInterval(() => {
    if (fs.existsSync(p(id, 'cancel'))) { canceledByMarker = true; log(`cancel ${id}`); child.kill('SIGKILL'); }
  }, 2000);

  child.stdout.on('data', (b) => {
    const m = b.toString().match(/out_time_ms=(\d+)/g);
    if (m && Date.now() - lastWrite > 1500) {
      lastWrite = Date.now();
      try { writeAtomic(p(id, 'progress'), m[m.length - 1].split('=')[1]); } catch {}
    }
  });
  child.stderr.on('data', (b) => { stderr += b.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

  const finish = (ok, error) => {
    clearInterval(cancelTimer);
    active.delete(id);
    // Canceled by the container's marker: it owns the lifecycle + cleanup of
    // its own files. Just drop our partial output + claim, no done.json.
    if (canceledByMarker) {
      safeUnlink(partOut);
      safeUnlink(p(id, 'claimed'));
      safeUnlink(p(id, 'cancel'));
      log(`canceled ${id}`);
      return;
    }
    if (ok) {
      try {
        fs.renameSync(partOut, spec.out);
        const size = fs.statSync(spec.out).size;
        writeAtomic(p(id, 'done.json'), JSON.stringify({ ok: true, size }));
        log(`encode done ${id} (${(size / 1073741824).toFixed(2)} GB)`);
      } catch (e) {
        writeAtomic(p(id, 'done.json'), JSON.stringify({ ok: false, error: `finalize: ${e.message}` }));
      }
    } else {
      safeUnlink(partOut);
      writeAtomic(p(id, 'done.json'), JSON.stringify({ ok: false, error: error || `ffmpeg exited` }));
      log(`encode failed ${id}: ${error}`);
    }
    safeUnlink(p(id, 'claimed'));
    safeUnlink(p(id, 'cancel'));
  };

  child.on('error', (e) => finish(false, `spawn: ${e.message}`));
  child.on('close', (code) =>
    finish(code === 0, code === 0 ? undefined : (stderr.trim().split('\n').pop() || `exit ${code}`))
  );
}

function scan() {
  let entries;
  try { entries = fs.readdirSync(JOBS_DIR); } catch { return; }
  for (const name of entries) {
    if (active.size >= MAX_CONCURRENT) break;
    if (!name.endsWith('.job.json')) continue;
    const id = name.slice(0, -'.job.json'.length);
    const jobPath = p(id, 'job.json');
    const claimedPath = p(id, 'claimed');
    try {
      fs.renameSync(jobPath, claimedPath); // atomic claim; throws if already taken
    } catch {
      continue;
    }
    try {
      const spec = JSON.parse(fs.readFileSync(claimedPath, 'utf8'));
      processJob(id, spec);
    } catch (e) {
      writeAtomic(p(id, 'done.json'), JSON.stringify({ ok: false, error: `bad job spec: ${e.message}` }));
      safeUnlink(claimedPath);
    }
  }
}

// On startup, re-queue any jobs left .claimed by a previous run (their ffmpeg
// died with the old process) so they get retried.
function recover() {
  try {
    for (const name of fs.readdirSync(JOBS_DIR)) {
      if (name.endsWith('.claimed')) {
        const id = name.slice(0, -'.claimed'.length);
        // Clear stale progress so the container's poller doesn't see the old
        // (higher) value as a stall when the re-encode starts from 0.
        safeUnlink(p(id, 'progress'));
        try { fs.renameSync(p(id, 'claimed'), p(id, 'job.json')); log(`re-queued stale ${id}`); } catch {}
      }
    }
  } catch {}
}

fs.mkdirSync(JOBS_DIR, { recursive: true });
log(`transcode-helper watching ${JOBS_DIR} (ffmpeg=${FFMPEG}, concurrency=${MAX_CONCURRENT})`);
recover();
setInterval(scan, POLL_MS);
scan();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const child of active.values()) child.kill('SIGKILL');
    process.exit(0);
  });
}
