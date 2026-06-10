import React from 'react';
import { MediaItem } from '../types';
import { MediaCard } from './MediaCard';
import { useNavigate } from 'react-router-dom';
import { useViewStore } from '../stores/viewStore';

interface MediaGridProps {
  media: MediaItem[];
  isLoading?: boolean;
}

// Layout wrapper per view mode. Grid = roomy posters; compact = denser
// posters (more columns, tighter gap); list = single-column stacked rows.
const LAYOUT_CLASSES: Record<string, string> = {
  grid: 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4',
  compact: 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12 gap-2',
  list: 'flex flex-col gap-2',
};

export const MediaGrid: React.FC<MediaGridProps> = ({ media, isLoading }) => {
  const navigate = useNavigate();
  const { viewMode } = useViewStore();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (media.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400">No media found</div>
      </div>
    );
  }

  return (
    <div className={LAYOUT_CLASSES[viewMode]}>
      {media.map((item) => (
        <MediaCard
          key={`${item._preferredServerId || ''}:${item.ratingKey}`}
          media={item}
          mode={viewMode}
          onClick={() =>
            // Carry cross-server availability so MediaDetail can offer a
            // source picker without re-deriving it
            navigate(`/media/${item.ratingKey}`, {
              state: item.availability
                ? { availability: item.availability, preferredServerId: item._preferredServerId }
                : undefined,
            })
          }
        />
      ))}
    </div>
  );
};
