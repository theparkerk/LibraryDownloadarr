import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { MediaGrid } from '../components/MediaGrid';
import { MediaControls } from '../components/MediaControls';
import { CollectionGrid } from '../components/CollectionGrid';
import { api } from '../services/api';
import { Collection, MediaItem } from '../types';
import { useMobileMenu } from '../hooks/useMobileMenu';
import { useMediaView } from '../hooks/useMediaView';

type Tab = 'library' | 'collections';

export const LibraryView: React.FC = () => {
  const { libraryKey } = useParams<{ libraryKey: string }>();
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [libraryTitle, setLibraryTitle] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const [tab, setTab] = useState<Tab>('library');
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  // When set, we're viewing one collection's contents (still on the
  // Collections tab); null = the grid of collections
  const [openCollection, setOpenCollection] = useState<Collection | null>(null);
  const [collectionContent, setCollectionContent] = useState<MediaItem[]>([]);
  const [collectionContentLoading, setCollectionContentLoading] = useState(false);

  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();

  // The view hook drives whichever set is currently on screen
  const activeMedia = tab === 'collections' && openCollection ? collectionContent : media;
  const view = useMediaView(activeMedia);

  // Reset everything when the library (or selected server) changes
  useEffect(() => {
    if (!libraryKey) return;
    setTab('library');
    setCollections([]);
    setCollectionsLoaded(false);
    setOpenCollection(null);
    setCollectionContent([]);
    loadLibraryContent();
  }, [libraryKey]);

  const loadLibraryContent = async () => {
    if (!libraryKey) return;

    setIsLoading(true);
    setError('');

    try {
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

  const showCollectionsTab = async () => {
    setTab('collections');
    setOpenCollection(null);
    if (collectionsLoaded || !libraryKey) return;

    setCollectionsLoading(true);
    try {
      const cols = await api.getCollections(libraryKey);
      setCollections(cols);
    } catch {
      setCollections([]);
    } finally {
      setCollectionsLoaded(true);
      setCollectionsLoading(false);
    }
  };

  const openCollectionContent = async (collection: Collection) => {
    setOpenCollection(collection);
    setCollectionContentLoading(true);
    try {
      const content = await api.getCollectionContent(collection.ratingKey);
      setCollectionContent(content);
    } catch {
      setCollectionContent([]);
    } finally {
      setCollectionContentLoading(false);
    }
  };

  const tabButton = (id: Tab, label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm rounded-lg transition-colors ${
        tab === id ? 'bg-dark-200 text-primary-400' : 'text-gray-400 hover:bg-dark-200'
      }`}
    >
      {label}
    </button>
  );

  // Header title: drill into a collection shows its name + a back link
  const headingControls =
    tab === 'collections' && openCollection ? null : <MediaControls view={view} />;
  const showControls =
    (tab === 'library' && !isLoading && media.length > 0) ||
    (tab === 'collections' && openCollection && !collectionContentLoading && collectionContent.length > 0);

  return (
    <div className="min-h-screen flex flex-col">
      <Header onMenuClick={toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
        <main className="flex-1 p-4 md:p-8 overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-3 min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold truncate">{libraryTitle || 'Library'}</h1>
            </div>
            {showControls && headingControls}
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-2 mb-4 md:mb-6 border-b border-dark-50 pb-2">
            {tabButton('library', 'Library', () => {
              setTab('library');
              setOpenCollection(null);
            })}
            {tabButton('collections', 'Collections', showCollectionsTab)}
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 md:px-4 py-2 md:py-3 rounded-lg mb-4 md:mb-6 text-sm md:text-base">
              {error}
            </div>
          )}

          {tab === 'library' && <MediaGrid media={view.items} isLoading={isLoading} />}

          {tab === 'collections' && !openCollection && (
            <CollectionGrid
              collections={collections}
              isLoading={collectionsLoading}
              onSelect={openCollectionContent}
            />
          )}

          {tab === 'collections' && openCollection && (
            <div>
              <button
                onClick={() => setOpenCollection(null)}
                className="text-sm text-primary-400 hover:underline mb-4"
              >
                ← All collections
              </button>
              <h2 className="text-xl md:text-2xl font-bold mb-4">{openCollection.title}</h2>
              <MediaGrid media={view.items} isLoading={collectionContentLoading} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
