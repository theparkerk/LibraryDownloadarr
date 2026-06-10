import React, { createContext, useContext, useState, ReactNode } from 'react';
import { api } from '../services/api';

// What to download. File downloads need the specific part; season/album
// downloads are zipped server-side.
export type DownloadScope =
  | { type: 'file'; ratingKey: string; partKey: string }
  | { type: 'season'; ratingKey: string }
  | { type: 'album'; ratingKey: string };

interface Download {
  id: string;
  ratingKey: string;
  partKey: string;
  filename: string;
  title: string;
  status: 'preparing' | 'started' | 'error';
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

  // Downloads are handled by the browser's native download manager: we ask
  // the backend for a scoped download URL, then navigate to it. Because the
  // response is Content-Disposition: attachment, the page never unloads —
  // the browser streams the file straight to disk. This is what makes large
  // downloads work on phones/tablets: the old approach buffered the whole
  // file into page memory (fetch -> Blob) and crashed on multi-GB files.
  const startDownload = async (
    scope: DownloadScope,
    filename: string,
    title: string
  ): Promise<void> => {
    const partKey = scope.type === 'file' ? scope.partKey : '';
    const downloadId = `${scope.ratingKey}-${scope.type}-${Date.now()}`;

    const newDownload: Download = {
      id: downloadId,
      ratingKey: scope.ratingKey,
      partKey,
      filename,
      title,
      status: 'preparing',
    };

    setDownloads((prev) => [...prev, newDownload]);

    try {
      const { url } = await api.createDownloadToken(
        scope.type,
        scope.ratingKey,
        scope.type === 'file' ? scope.partKey : undefined
      );

      // Same-origin navigation is never popup-blocked (unlike programmatic
      // anchor clicks after an async boundary on iOS Safari)
      window.location.assign(url);

      setDownloads((prev) =>
        prev.map((d) => (d.id === downloadId ? { ...d, status: 'started' } : d))
      );

      // Remove after 8 seconds — the browser shows its own progress from here
      setTimeout(() => {
        setDownloads((prev) => prev.filter((d) => d.id !== downloadId));
      }, 8000);
    } catch (error: any) {
      const message =
        error.response?.data?.error || error.message || 'Failed to start download';
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === downloadId ? { ...d, status: 'error', error: message } : d
        )
      );

      // Remove after 8 seconds
      setTimeout(() => {
        setDownloads((prev) => prev.filter((d) => d.id !== downloadId));
      }, 8000);
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
