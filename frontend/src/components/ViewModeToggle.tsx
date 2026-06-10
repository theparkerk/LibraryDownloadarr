import React from 'react';
import { useViewStore, ViewMode } from '../stores/viewStore';

// Three icon buttons that switch the global media view mode. Used in the
// header of any page that renders a MediaGrid.
const MODES: { mode: ViewMode; label: string; icon: string }[] = [
  { mode: 'grid', label: 'Grid view', icon: '▦' },
  { mode: 'list', label: 'List view', icon: '☰' },
  { mode: 'compact', label: 'Compact view', icon: '⊞' },
];

export const ViewModeToggle: React.FC = () => {
  const { viewMode, setViewMode } = useViewStore();

  return (
    <div className="inline-flex rounded-lg border border-dark-50 overflow-hidden">
      {MODES.map(({ mode, label, icon }) => (
        <button
          key={mode}
          onClick={() => setViewMode(mode)}
          aria-label={label}
          title={label}
          className={`px-3 py-2 text-sm transition-colors ${
            viewMode === mode
              ? 'bg-primary-500 text-white'
              : 'bg-dark-100 text-gray-400 hover:bg-dark-200'
          }`}
        >
          {icon}
        </button>
      ))}
    </div>
  );
};
