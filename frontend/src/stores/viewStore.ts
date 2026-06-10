import { create } from 'zustand';

// How media grids render. Persisted globally (not per-library) — a single
// preference is simpler and matches how people pick one browsing style.
export type ViewMode = 'grid' | 'list' | 'compact';

// How a list of media is ordered. 'relevance' only makes sense for search
// results (the backend already relevance-sorts), so pages that aren't
// search default to 'added'.
export type SortMode = 'added' | 'title' | 'year' | 'rating' | 'relevance';

const VIEW_KEY = 'viewMode';
const SORT_KEY = 'sortMode';

const loadViewMode = (): ViewMode => {
  const v = localStorage.getItem(VIEW_KEY);
  return v === 'grid' || v === 'list' || v === 'compact' ? v : 'grid';
};

const loadSortMode = (): SortMode => {
  const v = localStorage.getItem(SORT_KEY);
  return v === 'added' || v === 'title' || v === 'year' || v === 'rating' ? v : 'added';
};

interface ViewState {
  viewMode: ViewMode;
  sortMode: SortMode;
  setViewMode: (mode: ViewMode) => void;
  setSortMode: (mode: SortMode) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  viewMode: loadViewMode(),
  sortMode: loadSortMode(),

  setViewMode: (mode) => {
    localStorage.setItem(VIEW_KEY, mode);
    set({ viewMode: mode });
  },

  // 'relevance' is transient (search-only) — never persist it, or a later
  // library view would have nothing to sort by
  setSortMode: (mode) => {
    if (mode !== 'relevance') {
      localStorage.setItem(SORT_KEY, mode);
    }
    set({ sortMode: mode });
  },
}));
