import React, { createContext, useContext, useState, ReactNode } from 'react';
import { api } from '../services/api';
import { refreshConversions } from '../stores/conversionsStore';

// What to download. File downloads need the specific part; season/album
// downloads are zipped server-side.
// serverId pins the download to a chosen server (All-Servers mode source
// picker). Omitted = the home/selected server, as before.
// quality (file scope only): undefined/'original' = the existing direct
// download; a preset id ('720p'/'1080p') = a server-side conversion job.
export type DownloadScope =
  | { type: 'file'; ratingKey: string; partKey: string; serverId?: string; quality?: string; subtitles?: boolean }
  | { type: 'season'; ratingKey: string; serverId?: string }
  | { type: 'album'; ratingKey: string; serverId?: string };

interface Download {
  id: string;
  ratingKey: string;
  partKey: string;
  filename: string;
  title: string;
  status: 'preparing' | 'queued' | 'started' | 'error';
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
        status: isConversion ? 'queued' : 'preparing',
      },
    ]);

    try {
      if (isConversion && scope.type === 'file') {
        // Server-side conversion: just enqueue. Progress, ETA, and the
        // download link live in the Conversions panel so several can queue
        // up at once without blocking the page.
        await api.startTranscode(scope.ratingKey, scope.quality!, scope.serverId, scope.subtitles !== false);
        refreshConversions();
        update(downloadId, { status: 'queued' });
        autoRemove(downloadId, 6000);
      } else {
        const { url } = await api.createDownloadToken(
          scope.type,
          scope.ratingKey,
          scope.type === 'file' ? scope.partKey : undefined,
          scope.serverId
        );
        triggerBrowserDownload(url);
        update(downloadId, { status: 'started' });
        autoRemove(downloadId, 8000);
      }
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
