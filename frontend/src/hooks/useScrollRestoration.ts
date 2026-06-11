import { RefObject, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

// Remembers the scroll position of an inner scroll container (our pages scroll
// inside <main>, not the window) per history entry (location.key), so going
// Back from a detail page lands at the same spot. Restores once `ready` flips
// true — i.e. the list content has rendered and the scroll height is valid.
const positions = new Map<string, number>();

export function useScrollRestoration(ref: RefObject<HTMLElement>, ready: boolean) {
  const { key } = useLocation();
  const restored = useRef(false);

  // Continuously record where we are for this history entry.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => positions.set(key, el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref, key]);

  // Restore once, after the content for this entry has loaded.
  useEffect(() => {
    if (!ready || restored.current) return;
    const el = ref.current;
    if (!el) return;
    const y = positions.get(key);
    if (y != null) el.scrollTop = y;
    restored.current = true;
  }, [ready, key, ref]);
}
