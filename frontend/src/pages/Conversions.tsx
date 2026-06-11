import React, { useState } from 'react';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { api, TranscodeJobView, ArchiveJobView } from '../services/api';
import { useConversionsStore, refreshConversions } from '../stores/conversionsStore';
import { useMobileMenu } from '../hooks/useMobileMenu';

const fmtEta = (sec: number | null): string => {
  if (sec == null || sec <= 0) return '';
  if (sec < 60) return `~${sec}s`;
  if (sec < 3600) return `~${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `~${h}h ${m}m`;
};

const fmtSize = (bytes?: number): string => {
  if (!bytes) return '';
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1048576)} MB`;
};

const qualityLabel = (q: string) => (q === '720p' ? 'iPhone 720p' : q === '1080p' ? 'iPad/Mac 1080p' : q);

export const Conversions: React.FC = () => {
  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();
  const jobs = useConversionsStore((s) => s.jobs);
  const archives = useConversionsStore((s) => s.archives);
  const loaded = useConversionsStore((s) => s.loaded);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Multi-select → zip
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [autoDelete, setAutoDelete] = useState(false);
  const [building, setBuilding] = useState(false);

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const startDownload = async (job: TranscodeJobView) => {
    setDownloadingId(job.id);
    try {
      const { url } = await api.transcodeDownloadUrl(job.id);
      window.location.assign(url);
    } catch {
      /* leave as ready */
    } finally {
      setTimeout(() => setDownloadingId(null), 4000);
    }
  };

  const deleteConversion = async (job: TranscodeJobView) => {
    setBusyId(job.id);
    try {
      await api.deleteConversion(job.id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      refreshConversions();
    } catch {
      /* next poll reconciles */
    } finally {
      setBusyId(null);
    }
  };

  const buildArchive = async () => {
    if (selected.size === 0) return;
    setBuilding(true);
    try {
      await api.createArchive([...selected], autoDelete);
      setSelected(new Set());
      refreshConversions();
    } catch {
      /* panel state unchanged */
    } finally {
      setTimeout(() => setBuilding(false), 1500);
    }
  };

  const downloadArchive = async (arc: ArchiveJobView) => {
    setDownloadingId(arc.id);
    try {
      const { url } = await api.archiveDownloadUrl(arc.id);
      window.location.assign(url);
    } catch {
      /* leave as ready */
    } finally {
      setTimeout(() => setDownloadingId(null), 4000);
    }
  };

  const deleteArchive = async (arc: ArchiveJobView) => {
    setBusyId(arc.id);
    try {
      await api.deleteArchive(arc.id);
      refreshConversions();
    } catch {
      /* next poll reconciles */
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (job: TranscodeJobView) => {
    try {
      await api.cancelTranscode(job.id);
      refreshConversions();
    } catch {
      /* it may have just finished; the next poll reconciles */
    }
  };

  const [retryingId, setRetryingId] = useState<string | null>(null);
  const retry = async (job: TranscodeJobView) => {
    setRetryingId(job.id);
    try {
      // Pin to the job's OWN server ('home' when it has none) — otherwise the
      // request inherits the sidebar's selected server, which can be a
      // different one (or 'All Servers') and the backend rejects it.
      await api.startTranscode(job.ratingKey, job.quality, job.serverId || 'home', job.subtitles);
      refreshConversions();
    } finally {
      setTimeout(() => setRetryingId(null), 3000);
    }
  };

  const processing = jobs.filter((j) => j.status === 'processing');
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => (a.queuePosition || 0) - (b.queuePosition || 0));
  const ready = jobs.filter((j) => j.status === 'ready');
  // 'expired' = ready job whose file was swept; offer a re-convert like failures
  const failed = jobs.filter((j) => j.status === 'failed' || j.status === 'canceled' || j.status === 'expired');
  const buildingArchives = archives.filter((a) => a.status === 'processing');
  const readyArchives = archives.filter((a) => a.status === 'ready');
  const failedArchives = archives.filter((a) => a.status === 'failed');

  const Row: React.FC<{ job: TranscodeJobView; children?: React.ReactNode; sub?: string }> = ({ job, children, sub }) => (
    <div className="card p-3 md:p-4 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm md:text-base truncate">{job.title}</div>
        <div className="text-xs text-gray-400">
          {qualityLabel(job.quality)}
          {sub ? ` · ${sub}` : ''}
        </div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col">
      <Header onMenuClick={toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
        <main className="flex-1 p-4 md:p-8 overflow-y-auto">
          <h1 className="text-2xl md:text-3xl font-bold mb-4 md:mb-6">Conversions</h1>

          {loaded && jobs.length === 0 && archives.length === 0 && (
            <div className="card p-6 md:p-8 text-center">
              <p className="text-gray-400 text-sm md:text-base">
                No conversions yet. Pick a device quality on any movie or episode and it'll queue here.
              </p>
            </div>
          )}

          {processing.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">In progress</h2>
              <div className="space-y-2">
                {processing.map((job) => (
                  <div key={job.id} className="card p-3 md:p-4">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <div className="font-medium text-sm md:text-base truncate">{job.title}</div>
                        <div className="text-xs text-gray-400">{qualityLabel(job.quality)}</div>
                      </div>
                      <div className="flex items-center gap-3 whitespace-nowrap">
                        <span className="text-sm text-primary-400 font-semibold">
                          {job.progress}%{job.etaSec ? ` · ${fmtEta(job.etaSec)} left` : ''}
                        </span>
                        <button
                          onClick={() => cancel(job)}
                          className="text-xs text-gray-400 hover:text-red-400 transition-colors"
                          title="Cancel conversion"
                        >
                          ✕ Cancel
                        </button>
                      </div>
                    </div>
                    <div className="w-full h-2 bg-dark-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-primary-500 to-primary-400 transition-all duration-500 ease-out"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {queued.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">Queued</h2>
              <div className="space-y-2">
                {queued.map((job) => (
                  <Row key={job.id} job={job}>
                    <div className="flex items-center gap-3 whitespace-nowrap">
                      <span className="text-xs text-gray-400">
                        #{job.queuePosition}{job.etaSec ? ` · starts in ${fmtEta(job.etaSec)}` : ''}
                      </span>
                      <button
                        onClick={() => cancel(job)}
                        className="text-xs text-gray-400 hover:text-red-400 transition-colors"
                        title="Remove from queue"
                      >
                        ✕
                      </button>
                    </div>
                  </Row>
                ))}
              </div>
            </section>
          )}

          {ready.length > 0 && (
            <section className="mb-6">
              <div className="flex items-center justify-between mb-2 gap-2">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Ready</h2>
                {ready.length > 1 && (
                  <button
                    onClick={() =>
                      setSelected((prev) => (prev.size === ready.length ? new Set() : new Set(ready.map((r) => r.id))))
                    }
                    className="text-xs text-gray-400 hover:text-primary-400 transition-colors"
                  >
                    {selected.size === ready.length ? 'Clear all' : 'Select all'}
                  </button>
                )}
              </div>

              {/* Multi-select action bar */}
              {selected.size > 0 && (
                <div className="card p-3 mb-2 flex flex-wrap items-center justify-between gap-3 border border-primary-500/40">
                  <span className="text-sm">{selected.size} selected</span>
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
                      <input type="checkbox" checked={autoDelete} onChange={(e) => setAutoDelete(e.target.checked)} />
                      Delete from server after download
                    </label>
                    <button onClick={() => setSelected(new Set())} className="text-xs text-gray-400 hover:text-gray-200">
                      Cancel
                    </button>
                    <button
                      onClick={buildArchive}
                      disabled={building}
                      className="btn-primary text-sm disabled:opacity-50 whitespace-nowrap"
                    >
                      {building ? 'Building…' : `⬇ Download ${selected.size} as .zip`}
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {ready.map((job) => (
                  <div key={job.id} className="card p-3 md:p-4 flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selected.has(job.id)}
                      onChange={() => toggleSelected(job.id)}
                      className="flex-shrink-0 w-4 h-4"
                      title="Select for zip download"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm md:text-base truncate">{job.title}</div>
                      <div className="text-xs text-gray-400">
                        {qualityLabel(job.quality)}
                        {` · ${fmtSize(job.fileSize)}`}
                        {job.subtitles ? (job.subtitlesIncluded ? ' · English subs' : ' · no text subtitles') : ''}
                      </div>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-2">
                      <button
                        onClick={() => startDownload(job)}
                        disabled={downloadingId === job.id}
                        className="btn-primary disabled:opacity-50 whitespace-nowrap"
                      >
                        {downloadingId === job.id ? 'Starting…' : '⬇ Download'}
                      </button>
                      <button
                        onClick={() => deleteConversion(job)}
                        disabled={busyId === job.id}
                        className="text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50 px-1"
                        title="Delete from server"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(buildingArchives.length > 0 || readyArchives.length > 0 || failedArchives.length > 0) && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">Zip downloads</h2>
              <div className="space-y-2">
                {buildingArchives.map((arc) => (
                  <div key={arc.id} className="card p-3 md:p-4">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <div className="font-medium text-sm md:text-base truncate">{arc.title} (.zip)</div>
                        <div className="text-xs text-gray-400">{arc.sourceCount} items · building</div>
                      </div>
                      <span className="text-sm text-primary-400 font-semibold whitespace-nowrap">{arc.progress}%</span>
                    </div>
                    <div className="w-full h-2 bg-dark-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-primary-500 to-primary-400 transition-all duration-500 ease-out"
                        style={{ width: `${arc.progress}%` }}
                      />
                    </div>
                  </div>
                ))}

                {readyArchives.map((arc) => (
                  <div key={arc.id} className="card p-3 md:p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm md:text-base truncate">{arc.title} (.zip)</div>
                      <div className="text-xs text-gray-400">
                        {arc.sourceCount} items · {fmtSize(arc.fileSize)}
                        {arc.autoDelete ? ' · deletes after download' : ''}
                      </div>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-2">
                      <button
                        onClick={() => downloadArchive(arc)}
                        disabled={downloadingId === arc.id}
                        className="btn-primary disabled:opacity-50 whitespace-nowrap"
                      >
                        {downloadingId === arc.id ? 'Starting…' : '⬇ Download .zip'}
                      </button>
                      <button
                        onClick={() => deleteArchive(arc)}
                        disabled={busyId === arc.id}
                        className="text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50 px-1"
                        title="Delete zip from server"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                ))}

                {failedArchives.map((arc) => (
                  <div key={arc.id} className="card p-3 md:p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm md:text-base truncate">{arc.title} (.zip)</div>
                      <div className="text-xs text-red-400">{arc.error || 'Build failed'}</div>
                    </div>
                    <button
                      onClick={() => deleteArchive(arc)}
                      disabled={busyId === arc.id}
                      className="text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50 px-2"
                      title="Dismiss"
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {failed.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">
                Failed / expired
              </h2>
              <div className="space-y-2">
                {failed.map((job) => (
                  <Row
                    key={job.id}
                    job={job}
                    sub={job.status === 'expired' ? 'Expired — file removed after 24h' : job.error || job.status}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => retry(job)}
                        disabled={retryingId === job.id}
                        className="btn-secondary text-sm disabled:opacity-50 whitespace-nowrap"
                      >
                        {retryingId === job.id ? 'Starting…' : '↻ Try again'}
                      </button>
                      <button
                        onClick={() => deleteConversion(job)}
                        disabled={busyId === job.id}
                        className="text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50 px-1"
                        title="Dismiss"
                      >
                        🗑
                      </button>
                    </div>
                  </Row>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
};
