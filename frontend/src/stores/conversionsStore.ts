import { useEffect } from 'react';
import { create } from 'zustand';
import { api, TranscodeJobView } from '../services/api';

interface ConversionsState {
  jobs: TranscodeJobView[];
  activeCount: number;
  loaded: boolean;
  refresh: () => Promise<void>;
}

export const useConversionsStore = create<ConversionsState>((set) => ({
  jobs: [],
  activeCount: 0,
  loaded: false,
  refresh: async () => {
    try {
      const { jobs, activeCount } = await api.getTranscodeJobs();
      set({ jobs, activeCount, loaded: true });
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
