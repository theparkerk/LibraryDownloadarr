import React from 'react';
import { MediaItem } from '../types';
import { api } from '../services/api';
import { ViewMode } from '../stores/viewStore';

interface MediaCardProps {
  media: MediaItem;
  onClick: () => void;
  mode?: ViewMode;
}

export const MediaCard: React.FC<MediaCardProps> = ({ media, onClick, mode = 'grid' }) => {
  const thumbnailUrl = media.thumb ? api.getThumbnailUrl(media.ratingKey, media.thumb) : null;

  // Format display info based on media type
  const getDisplayInfo = () => {
    if (media.type === 'episode') {
      // Show: Show Name
      // Subtitle: S##E## - Episode Title (or just E## if no season number)
      const showName = media.grandparentTitle || 'Unknown Show';
      const seasonNum = media.parentIndex ? `S${String(media.parentIndex).padStart(2, '0')}` : '';
      const episodeNum = media.index ? `E${String(media.index).padStart(2, '0')}` : '';
      const episodeInfo = seasonNum ? `${seasonNum}${episodeNum}` : episodeNum;
      const subtitle = episodeInfo ? `${episodeInfo} - ${media.title}` : media.title;

      return {
        title: showName,
        subtitle,
        meta: media.parentTitle || null, // Season name
      };
    }

    if (media.type === 'track') {
      // Show: Album Name
      // Subtitle: Track Title
      const albumName = media.parentTitle || 'Unknown Album';
      return {
        title: albumName,
        subtitle: media.title,
        meta: media.grandparentTitle || null, // Artist name
      };
    }

    // For movies, shows, seasons, albums - show normally
    return {
      title: media.title,
      subtitle: null,
      meta: media.year?.toString() || null,
    };
  };

  const { title, subtitle, meta } = getDisplayInfo();
  const fallbackIcon = media.type === 'movie' ? '🎬' : media.type === 'track' || media.type === 'album' ? '🎵' : '📺';

  // List view: one horizontal row, thumb + text. Reads well on phones and
  // is easy to scan when you know what you're looking for.
  if (mode === 'list') {
    return (
      <div
        onClick={onClick}
        className="card cursor-pointer transition-colors hover:bg-dark-200 flex items-center gap-3 p-2"
      >
        <div className="relative w-12 h-18 flex-shrink-0 bg-dark-200 rounded overflow-hidden">
          {thumbnailUrl ? (
            <img src={thumbnailUrl} alt={media.title} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600">
              <span className="text-xl">{fallbackIcon}</span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm line-clamp-1">{title}</h3>
          {subtitle && <p className="text-xs text-gray-400 line-clamp-1">{subtitle}</p>}
          <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
            {meta && <span>{meta}</span>}
            {media.contentRating && <span>· {media.contentRating}</span>}
            <span className="capitalize">· {media.type}</span>
          </div>
        </div>
      </div>
    );
  }

  // Grid (default) and compact share the poster layout; compact just shrinks
  // padding/text so more fit per row (the grid columns come from MediaGrid).
  const isCompact = mode === 'compact';

  return (
    <div
      onClick={onClick}
      className="card cursor-pointer transition-all duration-300 hover:scale-105 hover:shadow-2xl group"
    >
      <div className="relative aspect-[2/3] bg-dark-200">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={media.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600">
            <span className="text-4xl">{fallbackIcon}</span>
          </div>
        )}

        {/* Overlay on hover */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">
          <h3 className="font-semibold text-sm line-clamp-2 mb-1">{title}</h3>
          {subtitle && <p className="text-xs text-gray-300 line-clamp-2">{subtitle}</p>}
          {meta && <p className="text-xs text-gray-400 mt-1">{meta}</p>}
          {media.contentRating && (
            <span className="text-xs text-gray-400 mt-1">{media.contentRating}</span>
          )}
        </div>
      </div>

      {/* Title below card (always visible) */}
      <div className={isCompact ? 'p-1.5' : 'p-3'}>
        <h3 className={`font-medium line-clamp-1 ${isCompact ? 'text-xs' : 'text-sm'}`}>{title}</h3>
        {!isCompact && subtitle && <p className="text-xs text-gray-400 mt-1 line-clamp-1">{subtitle}</p>}
        {!isCompact && !subtitle && meta && <p className="text-xs text-gray-400 mt-1">{meta}</p>}
      </div>
    </div>
  );
};
