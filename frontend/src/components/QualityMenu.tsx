import React from 'react';

export type QualityChoice = 'original' | '1080p' | '720p';

interface QualityMenuProps {
  busy: boolean;
  onSelect: (quality: QualityChoice) => void;
}

// Download control with a quality picker. Implemented as a native <select>
// so mobile (iOS/iPadOS) renders its own full-screen picker — a custom
// absolutely-positioned menu gets clipped by the scrolling card containers
// on tablets/phones. "Original" is the existing direct download; the others
// request a server-side conversion to a device-friendly size.
export const QualityMenu: React.FC<QualityMenuProps> = ({ busy, onSelect }) => {
  return (
    <select
      disabled={busy}
      value=""
      onChange={(e) => {
        const v = e.target.value as QualityChoice;
        if (v) onSelect(v);
        // value is controlled to "" so the placeholder shows again next render
      }}
      aria-label="Download quality"
      // Solid background (not btn-primary's gradient): a CSS gradient is a
      // background-image, which would collide with the chevron background-image
      // and leave white-on-white text on iOS. bg-primary-500 is a real
      // background-color, so both coexist.
      // Fixed width + shrink-0: a native <select> otherwise sizes itself to
      // its WIDEST option ("Original — full quality"), ballooning the control
      // and overlapping the title on narrow columns. The control only ever
      // shows "Download ⌄"; the picker shows full option text regardless.
      className="w-36 flex-shrink-0 appearance-none cursor-pointer rounded-lg pl-4 pr-9 py-2 text-sm font-medium text-white bg-primary-500 hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-dark"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='white' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 0.6rem center',
      }}
    >
      <option value="" disabled>
        {busy ? 'Starting…' : 'Download ⌄'}
      </option>
      <option value="original">Original — full quality</option>
      <option value="1080p">iPad / Mac — 1080p</option>
      <option value="720p">iPhone — 720p</option>
    </select>
  );
};
