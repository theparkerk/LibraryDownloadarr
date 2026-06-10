import React from 'react';
import { Collection } from '../types';
import { api } from '../services/api';

interface CollectionGridProps {
  collections: Collection[];
  isLoading?: boolean;
  onSelect: (collection: Collection) => void;
}

// Poster grid of Plex collections (franchises, holiday sets, etc.). Mirrors
// MediaGrid's grid layout; clicking a collection opens its contents.
export const CollectionGrid: React.FC<CollectionGridProps> = ({ collections, isLoading, onSelect }) => {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (collections.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400">No collections in this library</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-4">
      {collections.map((c) => {
        const thumb = c.thumb ? api.getThumbnailUrl(c.ratingKey, c.thumb) : null;
        return (
          <div
            key={c.ratingKey}
            onClick={() => onSelect(c)}
            className="card cursor-pointer transition-all duration-300 hover:scale-105 hover:shadow-2xl group"
          >
            <div className="relative aspect-[2/3] bg-dark-200">
              {thumb ? (
                <img src={thumb} alt={c.title} className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-600">
                  <span className="text-4xl">📚</span>
                </div>
              )}
              {c.childCount != null && (
                <span className="absolute top-2 right-2 bg-black/70 text-white text-xs rounded px-1.5 py-0.5">
                  {c.childCount}
                </span>
              )}
            </div>
            <div className="p-3">
              <h3 className="font-medium text-sm line-clamp-1">{c.title}</h3>
            </div>
          </div>
        );
      })}
    </div>
  );
};
