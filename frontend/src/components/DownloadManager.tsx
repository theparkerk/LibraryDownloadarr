import React from 'react';
import { useDownloads } from '../contexts/DownloadContext';

export const DownloadManager: React.FC = () => {
  const { downloads, removeDownload } = useDownloads();

  if (downloads.length === 0) {
    return null;
  }

  return (
    <div className="fixed top-20 right-6 z-50 space-y-2 max-w-sm">
      {downloads.map((download) => (
        <div
          key={download.id}
          className="bg-dark-100 border border-dark-50 rounded-lg shadow-lg p-4"
        >
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1 min-w-0 pr-2">
              <div className="text-sm font-medium truncate">{download.title}</div>
              <div className="text-xs text-gray-400 truncate">{download.filename}</div>
            </div>
            <button
              onClick={() => removeDownload(download.id)}
              className="text-gray-400 hover:text-white transition-colors flex-shrink-0"
            >
              ✕
            </button>
          </div>

          {download.status === 'preparing' && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-400">Preparing download...</span>
              <span className="text-primary-400 font-semibold animate-pulse">●</span>
            </div>
          )}

          {download.status === 'started' && (
            <div className="text-xs text-green-400">
              <span>✓ Download started — check your browser's downloads</span>
            </div>
          )}

          {download.status === 'error' && (
            <div className="flex items-center text-xs text-red-400">
              <span>✗ Download failed: {download.error || 'Unknown error'}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
