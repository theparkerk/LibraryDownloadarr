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

type Tab = 'library' | 'collections' | 'categories';
interface Genre { key: string; title: string }

export const LibraryView: React.FC = () => {
  const { libraryKey } = useParams<{ libraryKey: string }>();
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [libraryTitle, setLibraryTitle] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const [tab, setTab] = useState<Tab>('library');

  // Collections tab
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [openCollection, setOpenCollection] = useState<Collection | null>(null);
  const [collectionContent, setCollectionContent] = useState<MediaItem[]>([]);
  const [drillLoading, setDrillLoading] = useState(false);

  // Categories (genres) tab
  const [genres, setGenres] = useState<Genre[]>([]);
  const [genresLoaded, setGenresLoaded] = useState(false);
  const [genresLoading, setGenresLoading] = useState(false);
  const [openGenre, setOpenGenre] = useState<Genre | null>(null);
  const [genreContent, setGenreContent] = useState<MediaItem[]>([]);

  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();

  // The media currently on screen, fed through the sort/filter/view hook
  const activeMedia =
    tab === 'collections' && openCollection
      ? collectionContent
      : tab === 'categories' && openGenre
      ? genreContent
      : media;
  const view = useMediaView(activeMedia);

  // Reset when the library (or selected server) changes
  useEffect(() => {
    if (!libraryKey) return;
    setTab('library');
    setCollections([]);
    setCollectionsLoaded(false);
    setOpenCollection(null);
    setCollectionContent([]);
    setGenres([]);
    setGenresLoaded(false);
    setOpenGenre(null);
    setGenreContent([]);
    loadLibraryContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryKey]);

  const loadLibraryContent = async () => {
    if (!libraryKey) return;
    setIsLoading(true);
    setError('');
    try {
      const libraries = await api.getLibraries();
      const currentLibrary = libraries.find((lib) => lib.key === libraryKey);
      setLibraryTitle(currentLibrary?.title || '');
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
      setCollections(await api.getCollections(libraryKey));
    } catch {
      setCollections([]);
    } finally {
      setCollectionsLoaded(true);
      setCollectionsLoading(false);
    }
  };

  const openCollectionContent = async (collection: Collection) => {
    setOpenCollection(collection);
    setDrillLoading(true);
    try {
      setCollectionContent(await api.getCollectionContent(collection.ratingKey));
    } catch {
      setCollectionContent([]);
    } finally {
      setDrillLoading(false);
    }
  };

  const showCategoriesTab = async () => {
    setTab('categories');
    setOpenGenre(null);
    if (genresLoaded || !libraryKey) return;
    setGenresLoading(true);
    try {
      setGenres(await api.getGenres(libraryKey));
    } catch {
      setGenres([]);
    } finally {
      setGenresLoaded(true);
      setGenresLoading(false);
    }
  };

  const openGenreContent = async (genre: Genre) => {
    if (!libraryKey) return;
    setOpenGenre(genre);
    setDrillLoading(true);
    try {
      setGenreContent(await api.getGenreContent(libraryKey, genre.key));
    } catch {
      setGenreContent([]);
    } finally {
      setDrillLoading(false);
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

  // Sort/filter/view controls show whenever a populated media grid is on screen
  const inDrill =
    (tab === 'collections' && openCollection) || (tab === 'categories' && openGenre);
  const showControls =
    (tab === 'library' && !isLoading && media.length > 0) ||
    (!!inDrill && !drillLoading && view.items.length > 0);

  return (
    <div className="min-h-screen flex flex-col">
      <Header onMenuClick={toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
        <main className="flex-1 p-4 md:p-8 overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
            <h1 className="text-2xl md:text-3xl font-bold truncate">{libraryTitle || 'Library'}</h1>
            {showControls && <MediaControls view={view} />}
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-2 mb-4 md:mb-6 border-b border-dark-50 pb-2">
            {tabButton('library', 'Library', () => {
              setTab('library');
            })}
            {tabButton('collections', 'Collections', showCollectionsTab)}
            {tabButton('categories', 'Categories', showCategoriesTab)}
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 md:px-4 py-2 md:py-3 rounded-lg mb-4 md:mb-6 text-sm md:text-base">
              {error}
            </div>
          )}

          {tab === 'library' && <MediaGrid media={view.items} isLoading={isLoading} />}

          {tab === 'collections' && !openCollection && (
            <CollectionGrid collections={collections} isLoading={collectionsLoading} onSelect={openCollectionContent} />
          )}
          {tab === 'collections' && openCollection && (
            <div>
              <button onClick={() => setOpenCollection(null)} className="text-sm text-primary-400 hover:underline mb-4">
                ← All collections
              </button>
              <h2 className="text-xl md:text-2xl font-bold mb-4">{openCollection.title}</h2>
              <MediaGrid media={view.items} isLoading={drillLoading} />
            </div>
          )}

          {tab === 'categories' && !openGenre && (
            genresLoading ? (
              <div className="flex items-center justify-center py-20 text-gray-400">Loading...</div>
            ) : genres.length === 0 ? (
              <div className="flex items-center justify-center py-20 text-gray-400">No categories in this library</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {genres.map((g) => (
                  <button
                    key={g.key}
                    onClick={() => openGenreContent(g)}
                    className="px-4 py-2 rounded-full bg-dark-100 border border-dark-50 hover:border-primary-500 hover:text-primary-400 transition-colors text-sm"
                  >
                    {g.title}
                  </button>
                ))}
              </div>
            )
          )}
          {tab === 'categories' && openGenre && (
            <div>
              <button onClick={() => setOpenGenre(null)} className="text-sm text-primary-400 hover:underline mb-4">
                ← All categories
              </button>
              <h2 className="text-xl md:text-2xl font-bold mb-4">{openGenre.title}</h2>
              <MediaGrid media={view.items} isLoading={drillLoading} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
