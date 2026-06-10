import React, { useState } from 'react';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { api, TranscodeJobView } from '../services/api';
import { useConversionsStore } from '../stores/conversionsStore';
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
  const loaded = useConversionsStore((s) => s.loaded);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const startDownload = async (job: TranscodeJobView) => {
    setDownloadingId(job.id);
    try {
      const { url } = await api.transcodeDownloadUrl(job.id);
      window.location.assign(url);
    } catch {
      // leave as-is; the panel will keep showing it as ready
    } finally {
      setTimeout(() => setDownloadingId(null), 4000);
    }
  };

  const processing = jobs.filter((j) => j.status === 'processing');
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => (a.queuePosition || 0) - (b.queuePosition || 0));
  const ready = jobs.filter((j) => j.status === 'ready');
  const failed = jobs.filter((j) => j.status === 'failed' || j.status === 'canceled');

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

          {loaded && jobs.length === 0 && (
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
                      <div className="text-sm text-primary-400 font-semibold whitespace-nowrap">
                        {job.progress}%{job.etaSec ? ` · ${fmtEta(job.etaSec)} left` : ''}
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
                    <span className="text-xs text-gray-400 whitespace-nowrap">
                      #{job.queuePosition}{job.etaSec ? ` · starts in ${fmtEta(job.etaSec)}` : ''}
                    </span>
                  </Row>
                ))}
              </div>
            </section>
          )}

          {ready.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">Ready</h2>
              <div className="space-y-2">
                {ready.map((job) => (
                  <Row
                    key={job.id}
                    job={job}
                    sub={
                      fmtSize(job.fileSize) +
                      (job.subtitles ? (job.subtitlesIncluded ? ' · English subs' : ' · no text subtitles') : '')
                    }
                  >
                    <button
                      onClick={() => startDownload(job)}
                      disabled={downloadingId === job.id}
                      className="btn-primary disabled:opacity-50 whitespace-nowrap"
                    >
                      {downloadingId === job.id ? 'Starting…' : '⬇ Download'}
                    </button>
                  </Row>
                ))}
              </div>
            </section>
          )}

          {failed.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">Failed</h2>
              <div className="space-y-2">
                {failed.map((job) => (
                  <Row key={job.id} job={job} sub={job.error || job.status}>
                    <span className="text-xs text-red-400">✗</span>
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
