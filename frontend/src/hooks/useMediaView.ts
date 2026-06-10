import { useMemo, useState } from 'react';
import { MediaItem } from '../types';
import { SortMode, useViewStore } from '../stores/viewStore';

export interface MediaFilters {
  type: string; // '' = all
  contentRating: string; // '' = all
  decade: string; // '' = all, else e.g. '2020'
  watched: '' | 'watched' | 'unwatched'; // '' = all
}

const EMPTY_FILTERS: MediaFilters = { type: '', contentRating: '', decade: '', watched: '' };

const decadeOf = (year?: number): string | null =>
  year ? `${Math.floor(year / 10) * 10}` : null;

// Fully watched: movies/episodes by viewCount; shows by all episodes watched.
const isWatched = (m: MediaItem): boolean => {
  if (m.type === 'show') return (m.leafCount || 0) > 0 && (m.viewedLeafCount || 0) >= (m.leafCount || 0);
  return (m.viewCount || 0) > 0;
};
// Has any watched-state info we can filter on?
const hasWatchState = (m: MediaItem): boolean =>
  m.viewCount != null || m.viewedLeafCount != null || m.leafCount != null;

export interface MediaView {
  items: MediaItem[];
  sortMode: SortMode;
  setSortMode: (m: SortMode) => void;
  filters: MediaFilters;
  setFilters: (f: MediaFilters) => void;
  // Distinct values present in the source set, so the UI only offers
  // filters that can actually match something
  availableTypes: string[];
  availableRatings: string[];
  availableDecades: string[];
  canFilterWatched: boolean;
  allowRelevance: boolean;
}

// Client-side sort + filter over an already-loaded media list. Libraries
// load fully today, so this needs no backend round-trip. searchMode keeps
// the backend's relevance ordering as the default and offers it as a sort.
export const useMediaView = (
  source: MediaItem[],
  opts: { searchMode?: boolean } = {}
): MediaView => {
  const { searchMode = false } = opts;
  const { sortMode: storedSort, setSortMode } = useViewStore();
  const [filters, setFilters] = useState<MediaFilters>(EMPTY_FILTERS);

  // In search mode default to relevance (backend order); elsewhere the
  // stored sort applies
  const sortMode: SortMode = searchMode && storedSort === 'added' ? 'relevance' : storedSort;

  const availableTypes = useMemo(
    () => Array.from(new Set(source.map((m) => m.type).filter(Boolean))).sort(),
    [source]
  );
  const availableRatings = useMemo(
    () => Array.from(new Set(source.map((m) => m.contentRating).filter(Boolean) as string[])).sort(),
    [source]
  );
  const availableDecades = useMemo(
    () =>
      Array.from(new Set(source.map((m) => decadeOf(m.year)).filter(Boolean) as string[])).sort(
        (a, b) => Number(b) - Number(a)
      ),
    [source]
  );
  const canFilterWatched = useMemo(() => source.some(hasWatchState), [source]);

  const items = useMemo(() => {
    let out = source.filter((m) => {
      if (filters.type && m.type !== filters.type) return false;
      if (filters.contentRating && m.contentRating !== filters.contentRating) return false;
      if (filters.decade && decadeOf(m.year) !== filters.decade) return false;
      if (filters.watched === 'watched' && !isWatched(m)) return false;
      if (filters.watched === 'unwatched' && isWatched(m)) return false;
      return true;
    });

    // 'relevance' = leave the backend's order untouched
    if (sortMode !== 'relevance') {
      out = [...out].sort((a, b) => {
        switch (sortMode) {
          case 'title':
            return (a.title || '').localeCompare(b.title || '');
          case 'year':
            return (b.year || 0) - (a.year || 0);
          case 'rating':
            return (b.rating || 0) - (a.rating || 0);
          case 'added':
          default:
            return (b.addedAt || 0) - (a.addedAt || 0);
        }
      });
    }

    return out;
  }, [source, filters, sortMode]);

  return {
    items,
    sortMode,
    setSortMode,
    filters,
    setFilters,
    availableTypes,
    availableRatings,
    availableDecades,
    canFilterWatched,
    allowRelevance: searchMode,
  };
};
