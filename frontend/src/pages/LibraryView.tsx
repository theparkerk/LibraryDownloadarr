import React, { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { MediaGrid } from '../components/MediaGrid';
import { MediaControls } from '../components/MediaControls';
import { CollectionGrid } from '../components/CollectionGrid';
import { api } from '../services/api';
import { Collection, MediaItem } from '../types';
import { useMobileMenu } from '../hooks/useMobileMenu';
import { useMediaView } from '../hooks/useMediaView';
import { useScrollRestoration } from '../hooks/useScrollRestoration';

type Tab = 'library' | 'collections' | 'categories';
interface Genre { key: string; title: string }

export const LibraryView: React.FC = () => {
  const { libraryKey } = useParams<{ libraryKey: string }>();
  // Tab + the open category/collection live in the URL so that navigating into
  // a title and pressing Back restores exactly where you were (which tab, which
  // category) instead of resetting to the Library tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = ((searchParams.get('tab') as Tab) || 'library');
  const genreKey = searchParams.get('g');
  const collectionKey = searchParams.get('c');
  const openGenre: Genre | null = genreKey ? { key: genreKey, title: searchParams.get('gt') || '' } : null;
  const openCollection = collectionKey
    ? ({ ratingKey: collectionKey, title: searchParams.get('ct') || '' } as Collection)
    : null;

  const [media, setMedia] = useState<MediaItem[]>([]);
  const [libraryTitle, setLibraryTitle] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // Collections tab
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [collectionContent, setCollectionContent] = useState<MediaItem[]>([]);

  // Categories (genres) tab
  const [genres, setGenres] = useState<Genre[]>([]);
  const [genresLoaded, setGenresLoaded] = useState(false);
  const [genresLoading, setGenresLoading] = useState(false);
  const [genreContent, setGenreContent] = useState<MediaItem[]>([]);

  const [drillLoading, setDrillLoading] = useState(false);

  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();
  const mainRef = useRef<HTMLElement>(null);

  // The media currently on screen, fed through the sort/filter/view hook
  const activeMedia =
    tab === 'collections' && openCollection
      ? collectionContent
      : tab === 'categories' && openGenre
      ? genreContent
      : media;
  const view = useMediaView(activeMedia);

  // ---- URL → tab/selection helpers ----
  const goLibrary = () => setSearchParams({});
  const goCollections = () => setSearchParams({ tab: 'collections' });
  const goCategories = () => setSearchParams({ tab: 'categories' });
  const openCollectionContent = (c: Collection) => setSearchParams({ tab: 'collections', c: c.ratingKey, ct: c.title });
  const closeCollection = () => setSearchParams({ tab: 'collections' });
  const openGenreContent = (g: Genre) => setSearchParams({ tab: 'categories', g: g.key, gt: g.title });
  const closeGenre = () => setSearchParams({ tab: 'categories' });

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

  // Reset caches + (re)load the library list when the library/server changes.
  useEffect(() => {
    if (!libraryKey) return;
    setCollections([]);
    setCollectionsLoaded(false);
    setGenres([]);
    setGenresLoaded(false);
    loadLibraryContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryKey]);

  // Lazy-load the genre/collection lists when their tab is active.
  useEffect(() => {
    if (tab !== 'categories' || !libraryKey || genresLoaded) return;
    setGenresLoading(true);
    api.getGenres(libraryKey)
      .then(setGenres)
      .catch(() => setGenres([]))
      .finally(() => { setGenresLoaded(true); setGenresLoading(false); });
  }, [tab, libraryKey, genresLoaded]);

  useEffect(() => {
    if (tab !== 'collections' || !libraryKey || collectionsLoaded) return;
    setCollectionsLoading(true);
    api.getCollections(libraryKey)
      .then(setCollections)
      .catch(() => setCollections([]))
      .finally(() => { setCollectionsLoaded(true); setCollectionsLoading(false); });
  }, [tab, libraryKey, collectionsLoaded]);

  // Load the drill-in content for whichever category/collection the URL names
  // (also runs on a fresh mount after Back, restoring the grid).
  useEffect(() => {
    if (tab !== 'categories' || !genreKey || !libraryKey) return;
    let cancelled = false;
    setDrillLoading(true);
    api.getGenreContent(libraryKey, genreKey)
      .then((c) => { if (!cancelled) setGenreContent(c); })
      .catch(() => { if (!cancelled) setGenreContent([]); })
      .finally(() => { if (!cancelled) setDrillLoading(false); });
    return () => { cancelled = true; };
  }, [tab, genreKey, libraryKey]);

  useEffect(() => {
    if (tab !== 'collections' || !collectionKey) return;
    let cancelled = false;
    setDrillLoading(true);
    api.getCollectionContent(collectionKey)
      .then((c) => { if (!cancelled) setCollectionContent(c); })
      .catch(() => { if (!cancelled) setCollectionContent([]); })
      .finally(() => { if (!cancelled) setDrillLoading(false); });
    return () => { cancelled = true; };
  }, [tab, collectionKey]);

  const inDrill = (tab === 'collections' && !!openCollection) || (tab === 'categories' && !!openGenre);

  // Restore scroll once the on-screen content has loaded.
  const ready = inDrill ? !drillLoading : tab === 'library' ? !isLoading : true;
  useScrollRestoration(mainRef, ready);

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

  const showControls =
    (tab === 'library' && !isLoading && media.length > 0) ||
    (inDrill && !drillLoading && view.items.length > 0);

  return (
    <div className="min-h-screen flex flex-col">
      <Header onMenuClick={toggleMobileMenu} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
        <main ref={mainRef} className="flex-1 p-4 md:p-8 overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
            <h1 className="text-2xl md:text-3xl font-bold truncate">{libraryTitle || 'Library'}</h1>
            {showControls && <MediaControls view={view} />}
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-2 mb-4 md:mb-6 border-b border-dark-50 pb-2">
            {tabButton('library', 'Library', goLibrary)}
            {tabButton('collections', 'Collections', goCollections)}
            {tabButton('categories', 'Categories', goCategories)}
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
              <button onClick={closeCollection} className="text-sm text-primary-400 hover:underline mb-4">
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
              <button onClick={closeGenre} className="text-sm text-primary-400 hover:underline mb-4">
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
