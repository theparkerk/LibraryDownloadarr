import { useEffect } from 'react';
import { create } from 'zustand';
import { api, TranscodeJobView, ArchiveJobView } from '../services/api';

interface ConversionsState {
  jobs: TranscodeJobView[];
  archives: ArchiveJobView[];
  activeCount: number;
  loaded: boolean;
  refresh: () => Promise<void>;
}

export const useConversionsStore = create<ConversionsState>((set) => ({
  jobs: [],
  archives: [],
  activeCount: 0,
  loaded: false,
  refresh: async () => {
    try {
      const [{ jobs, activeCount }, archives] = await Promise.all([
        api.getTranscodeJobs(),
        api.getArchives().catch(() => [] as ArchiveJobView[]),
      ]);
      // Count building archives as active too so the poller speeds up.
      const building = archives.filter((a) => a.status === 'processing').length;
      set({ jobs, archives, activeCount: activeCount + building, loaded: true });
    } catch {
      // transient; keep last known state
    }
  },
}));

// Polls the jobs endpoint, faster while conversions are active. Mounted once
// (in the Sidebar, which is present on every main page) so the badge and the
// Conversions page share one poller.
export const useConversionsPoll = () => {
  const refresh = useConversionsStore((s) => s.refresh);
  const activeCount = useConversionsStore((s) => s.activeCount);

  useEffect(() => {
    refresh();
    const ms = activeCount > 0 ? 3000 : 12000;
    const id = setInterval(refresh, ms);
    return () => clearInterval(id);
  }, [refresh, activeCount]);
};

// Kick a refresh imminently (e.g. right after enqueuing a conversion).
export const refreshConversions = () => useConversionsStore.getState().refresh();
