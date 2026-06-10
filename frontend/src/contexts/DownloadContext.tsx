import React, { createContext, useContext, useState, ReactNode } from 'react';
import { api } from '../services/api';

// What to download. File downloads need the specific part; season/album
// downloads are zipped server-side.
// serverId pins the download to a chosen server (All-Servers mode source
// picker). Omitted = the home/selected server, as before.
// quality (file scope only): undefined/'original' = the existing direct
// download; a preset id ('720p'/'1080p') = a server-side conversion job.
export type DownloadScope =
  | { type: 'file'; ratingKey: string; partKey: string; serverId?: string; quality?: string }
  | { type: 'season'; ratingKey: string; serverId?: string }
  | { type: 'album'; ratingKey: string; serverId?: string };

interface Download {
  id: string;
  ratingKey: string;
  partKey: string;
  filename: string;
  title: string;
  status: 'preparing' | 'converting' | 'started' | 'error';
  progress?: number; // converting %
  error?: string;
}

interface DownloadContextType {
  downloads: Download[];
  startDownload: (scope: DownloadScope, filename: string, title: string) => Promise<void>;
  removeDownload: (id: string) => void;
}

const DownloadContext = createContext<DownloadContextType | undefined>(undefined);

export const useDownloads = () => {
  const context = useContext(DownloadContext);
  if (!context) {
    throw new Error('useDownloads must be used within a DownloadProvider');
  }
  return context;
};

interface DownloadProviderProps {
  children: ReactNode;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DownloadProvider: React.FC<DownloadProviderProps> = ({ children }) => {
  const [downloads, setDownloads] = useState<Download[]>([]);

  const update = (id: string, patch: Partial<Download>) =>
    setDownloads((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const autoRemove = (id: string, ms: number) =>
    setTimeout(() => setDownloads((prev) => prev.filter((d) => d.id !== id)), ms);

  // Hand a URL to the browser's native download manager. Same-origin
  // navigation to a Content-Disposition: attachment response streams to disk
  // without unloading the page — what makes large downloads work on mobile.
  const triggerBrowserDownload = (url: string) => window.location.assign(url);

  const startDownload = async (
    scope: DownloadScope,
    filename: string,
    title: string
  ): Promise<void> => {
    const partKey = scope.type === 'file' ? scope.partKey : '';
    const downloadId = `${scope.ratingKey}-${scope.type}-${Date.now()}`;
    const isConversion = scope.type === 'file' && !!scope.quality && scope.quality !== 'original';

    setDownloads((prev) => [
      ...prev,
      {
        id: downloadId,
        ratingKey: scope.ratingKey,
        partKey,
        filename,
        title,
        status: isConversion ? 'converting' : 'preparing',
        progress: isConversion ? 0 : undefined,
      },
    ]);

    try {
      if (isConversion && scope.type === 'file') {
        // Server-side conversion: start the job, poll until ready, then hand
        // the finished file to the browser's downloader.
        const { jobId } = await api.startTranscode(scope.ratingKey, scope.quality!, scope.serverId);

        // Poll (~2s) until ready/failed. The transcode can take many minutes
        // for a long movie — that's expected; the tray shows progress.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          await sleep(2000);
          const job = await api.getTranscodeJob(jobId);
          if (job.status === 'ready') break;
          if (job.status === 'failed' || job.status === 'canceled') {
            throw new Error(job.error || 'Conversion failed');
          }
          update(downloadId, { progress: job.progress });
        }

        const { url } = await api.transcodeDownloadUrl(jobId);
        triggerBrowserDownload(url);
      } else {
        const { url } = await api.createDownloadToken(
          scope.type,
          scope.ratingKey,
          scope.type === 'file' ? scope.partKey : undefined,
          scope.serverId
        );
        triggerBrowserDownload(url);
      }

      update(downloadId, { status: 'started' });
      autoRemove(downloadId, 8000);
    } catch (error: any) {
      const message = error.response?.data?.error || error.message || 'Failed to start download';
      update(downloadId, { status: 'error', error: message });
      autoRemove(downloadId, 8000);
    }
  };

  const removeDownload = (id: string) => {
    setDownloads((prev) => prev.filter((d) => d.id !== id));
  };

  return (
    <DownloadContext.Provider value={{ downloads, startDownload, removeDownload }}>
      {children}
    </DownloadContext.Provider>
  );
};
