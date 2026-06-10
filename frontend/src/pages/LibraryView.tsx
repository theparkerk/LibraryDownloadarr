import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { MediaGrid } from '../components/MediaGrid';
import { MediaControls } from '../components/MediaControls';
import { api } from '../services/api';
import { MediaItem } from '../types';
import { useMobileMenu } from '../hooks/useMobileMenu';
import { useMediaView } from '../hooks/useMediaView';

export const LibraryView: React.FC = () => {
  const { libraryKey } = useParams<{ libraryKey: string }>();
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [libraryTitle, setLibraryTitle] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();
  const view = useMediaView(media);

  useEffect(() => {
    if (libraryKey) {
      loadLibraryContent();
    }
  }, [libraryKey]);

  const loadLibraryContent = async () => {
    if (!libraryKey) return;

    setIsLoading(true);
    setError('');

    try {
      // Get library info first to determine the type
      const libraries = await api.getLibraries();
      const currentLibrary = libraries.find((lib) => lib.key === libraryKey);
      setLibraryTitle(currentLibrary?.title || '');

      // For artist libraries (audiobooks/music), fetch albums instead of artists
      const viewType = currentLibrary?.type === 'artist' ? 'albums' : undefined;
      const content = await api.getLibraryContent(libraryKey, viewType);
      setMedia(content);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load library content');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header onMenuClick={toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
        <main className="flex-1 p-4 md:p-8 overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-4 md:mb-6">
            <h1 className="text-2xl md:text-3xl font-bold truncate">{libraryTitle || 'Library'}</h1>
            {!isLoading && media.length > 0 && <MediaControls view={view} />}
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 md:px-4 py-2 md:py-3 rounded-lg mb-4 md:mb-6 text-sm md:text-base">
              {error}
            </div>
          )}

          <MediaGrid media={view.items} isLoading={isLoading} />
        </main>
      </div>
    </div>
  );
};
