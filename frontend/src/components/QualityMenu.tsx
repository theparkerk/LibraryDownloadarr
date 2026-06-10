import React, { useState, useRef, useEffect } from 'react';

export type QualityChoice = 'original' | '1080p' | '720p';

interface QualityMenuProps {
  busy: boolean;
  onSelect: (quality: QualityChoice) => void;
}

const OPTIONS: { id: QualityChoice; label: string; hint: string }[] = [
  { id: 'original', label: 'Original', hint: 'full quality / largest' },
  { id: '1080p', label: 'iPad / Mac', hint: '1080p · smaller' },
  { id: '720p', label: 'iPhone', hint: '720p · smallest' },
];

// Download button with a quality picker. "Original" is the existing direct
// download; the others request a server-side conversion to a device-friendly
// size.
export const QualityMenu: React.FC<QualityMenuProps> = ({ busy, onSelect }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
      >
        {busy ? 'Starting…' : 'Download ▾'}
      </button>
      {open && !busy && (
        <div className="absolute right-0 mt-1 w-44 bg-dark-100 border border-dark-50 rounded-lg shadow-xl z-20 overflow-hidden">
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                setOpen(false);
                onSelect(o.id);
              }}
              className="w-full text-left px-3 py-2 hover:bg-dark-200 transition-colors"
            >
              <div className="text-sm">{o.label}</div>
              <div className="text-xs text-gray-500">{o.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
