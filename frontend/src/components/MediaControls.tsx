import React from 'react';
import { MediaView, MediaFilters } from '../hooks/useMediaView';
import { SortMode } from '../stores/viewStore';
import { ViewModeToggle } from './ViewModeToggle';

interface MediaControlsProps {
  view: MediaView;
}

const SORT_LABELS: Record<SortMode, string> = {
  added: 'Recently added',
  title: 'Title (A–Z)',
  year: 'Year',
  rating: 'Rating',
  relevance: 'Relevance',
};

const selectClass =
  'bg-dark-100 border border-dark-50 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-primary-500';

// Sort + filter bar paired with the view-mode toggle. Only renders filters
// for fields actually present in the current set (from useMediaView).
export const MediaControls: React.FC<MediaControlsProps> = ({ view }) => {
  const { sortMode, setSortMode, filters, setFilters } = view;

  const sortOptions: SortMode[] = view.allowRelevance
    ? ['relevance', 'added', 'title', 'year', 'rating']
    : ['added', 'title', 'year', 'rating'];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={sortMode}
        onChange={(e) => setSortMode(e.target.value as SortMode)}
        className={selectClass}
        aria-label="Sort by"
      >
        {sortOptions.map((s) => (
          <option key={s} value={s}>
            {SORT_LABELS[s]}
          </option>
        ))}
      </select>

      {view.availableTypes.length > 1 && (
        <select
          value={filters.type}
          onChange={(e) => setFilters({ ...filters, type: e.target.value })}
          className={selectClass}
          aria-label="Filter by type"
        >
          <option value="">All types</option>
          {view.availableTypes.map((t) => (
            <option key={t} value={t} className="capitalize">
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
      )}

      {view.availableRatings.length > 1 && (
        <select
          value={filters.contentRating}
          onChange={(e) => setFilters({ ...filters, contentRating: e.target.value })}
          className={selectClass}
          aria-label="Filter by content rating"
        >
          <option value="">All ratings</option>
          {view.availableRatings.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      )}

      {view.availableDecades.length > 1 && (
        <select
          value={filters.decade}
          onChange={(e) => setFilters({ ...filters, decade: e.target.value })}
          className={selectClass}
          aria-label="Filter by decade"
        >
          <option value="">Any year</option>
          {view.availableDecades.map((d) => (
            <option key={d} value={d}>
              {d}s
            </option>
          ))}
        </select>
      )}

      {view.canFilterWatched && (
        <select
          value={filters.watched}
          onChange={(e) => setFilters({ ...filters, watched: e.target.value as MediaFilters['watched'] })}
          className={selectClass}
          aria-label="Filter by watched state"
        >
          <option value="">Watched & unwatched</option>
          <option value="unwatched">Unwatched</option>
          <option value="watched">Watched</option>
        </select>
      )}

      <ViewModeToggle />
    </div>
  );
};
