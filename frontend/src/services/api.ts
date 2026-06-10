import axios, { AxiosInstance } from 'axios';
import {
  User,
  AuthResponse,
  Collection,
  Library,
  MediaItem,
  PlexPin,
  ServerInfo,
  Settings,
} from '../types';

// A conversion job as shown in the Conversions panel.
export interface TranscodeJobView {
  id: string;
  ratingKey: string;
  title: string;
  quality: string;
  serverId?: string;
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'canceled' | 'expired';
  progress: number;
  fileSize?: number;
  error?: string;
  subtitles: boolean;
  subtitlesIncluded?: boolean;
  createdAt: number;
  etaSec: number | null;
  queuePosition?: number;
}

// Which Plex server the UI is browsing. 'home' (or unset) = the
// admin-configured server; anything else is a plex.tv machine id the
// backend verifies against the user's own account.
const SERVER_KEY = 'selectedServerId';

export const getSelectedServerId = (): string => localStorage.getItem(SERVER_KEY) || 'home';

// Switching servers does a full reload: every page refetches against the
// new server and no stale cross-server state survives.
export const selectServer = (machineId: string): void => {
  localStorage.setItem(SERVER_KEY, machineId);
  window.location.assign('/');
};

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: '/api',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add token + selected server to requests
    this.client.interceptors.request.use((config) => {
      const token = localStorage.getItem('token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      // Default to the dropdown's selected server, but never clobber a
      // serverId a specific call already set (e.g. a download targeting a
      // concrete source while the dropdown is on 'all')
      const alreadyScoped = config.params && config.params.serverId != null;
      const serverId = getSelectedServerId();
      if (!alreadyScoped && serverId && serverId !== 'home') {
        config.params = { ...(config.params || {}), serverId };
      }
      return config;
    });

    // Handle 401 responses
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          localStorage.removeItem('token');
          // Server selection is per-login: don't let the next user on this
          // browser inherit someone else's selected server
          localStorage.removeItem(SERVER_KEY);
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    );
  }

  // Auth endpoints
  async checkSetupRequired(): Promise<boolean> {
    const response = await this.client.get<{ setupRequired: boolean }>('/auth/setup/required');
    return response.data.setupRequired;
  }

  async setup(data: {
    username: string;
    password: string;
  }): Promise<AuthResponse> {
    const response = await this.client.post<AuthResponse>('/auth/setup', data);
    return response.data;
  }

  async login(username: string, password: string): Promise<AuthResponse> {
    const response = await this.client.post<AuthResponse>('/auth/login', { username, password });
    return response.data;
  }

  async generatePlexPin(): Promise<PlexPin> {
    const response = await this.client.post<PlexPin>('/auth/plex/pin');
    return response.data;
  }

  async authenticatePlexPin(pinId: number): Promise<AuthResponse> {
    const response = await this.client.post<AuthResponse>('/auth/plex/authenticate', { pinId });
    return response.data;
  }

  async getCurrentUser(): Promise<User> {
    const response = await this.client.get<{ user: User }>('/auth/me');
    return response.data.user;
  }

  async logout(): Promise<void> {
    await this.client.post('/auth/logout');
    localStorage.removeItem('token');
    localStorage.removeItem(SERVER_KEY);
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.client.post('/auth/change-password', {
      currentPassword,
      newPassword,
    });
  }

  // Server endpoints
  async getServers(): Promise<ServerInfo[]> {
    const response = await this.client.get<{ servers: ServerInfo[] }>('/servers');
    return response.data.servers;
  }

  // Library endpoints
  async getLibraries(): Promise<Library[]> {
    const response = await this.client.get<{ libraries: Library[] }>('/libraries');
    return response.data.libraries;
  }

  async getLibraryContent(libraryKey: string, viewType?: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ content: MediaItem[] }>(
      `/libraries/${libraryKey}/content`,
      {
        params: viewType ? { viewType } : undefined,
      }
    );
    return response.data.content;
  }

  async getCollections(libraryKey: string): Promise<Collection[]> {
    const response = await this.client.get<{ collections: Collection[] }>(
      `/libraries/${libraryKey}/collections`
    );
    return response.data.collections;
  }

  async getCollectionContent(collectionRatingKey: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ content: MediaItem[] }>(
      `/libraries/collections/${collectionRatingKey}/content`
    );
    return response.data.content;
  }

  async getGenres(libraryKey: string): Promise<{ key: string; title: string }[]> {
    const response = await this.client.get<{ genres: { key: string; title: string }[] }>(
      `/libraries/${libraryKey}/genres`
    );
    return response.data.genres;
  }

  async getGenreContent(libraryKey: string, genreKey: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ content: MediaItem[] }>(
      `/libraries/${libraryKey}/genre/${encodeURIComponent(genreKey)}/content`
    );
    return response.data.content;
  }

  // Media endpoints
  async getRecentlyAdded(limit: number = 20): Promise<MediaItem[]> {
    const response = await this.client.get<{ media: MediaItem[] }>('/media/recently-added', {
      params: { limit },
    });
    return response.data.media;
  }

  async searchMedia(query: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ results: MediaItem[] }>('/media/search', {
      params: { q: query },
    });
    return response.data.results;
  }

  // serverId pins a request to a concrete server even while the dropdown is
  // on 'all' (used after drilling into a merged item). undefined = let the
  // interceptor apply the dropdown selection.
  async getMediaMetadata(ratingKey: string, serverId?: string): Promise<MediaItem> {
    const response = await this.client.get<{ metadata: MediaItem }>(`/media/${ratingKey}`, {
      params: serverId ? { serverId } : undefined,
    });
    return response.data.metadata;
  }

  async getSeasons(showRatingKey: string, serverId?: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ seasons: MediaItem[] }>(`/media/${showRatingKey}/seasons`, {
      params: serverId ? { serverId } : undefined,
    });
    return response.data.seasons;
  }

  async getEpisodes(seasonRatingKey: string, serverId?: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ episodes: MediaItem[] }>(`/media/${seasonRatingKey}/episodes`, {
      params: serverId ? { serverId } : undefined,
    });
    return response.data.episodes;
  }

  async getTracks(albumRatingKey: string, serverId?: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ tracks: MediaItem[] }>(`/media/${albumRatingKey}/tracks`, {
      params: serverId ? { serverId } : undefined,
    });
    return response.data.tracks;
  }

  async getDownloadHistory(limit: number = 50): Promise<any[]> {
    const response = await this.client.get<{ history: any[] }>('/media/download-history', {
      params: { limit },
    });
    return response.data.history;
  }

  async getAllDownloadHistory(limit: number = 100): Promise<any[]> {
    const response = await this.client.get<{ history: any[] }>('/media/download-history/all', {
      params: { limit },
    });
    return response.data.history;
  }

  async getDownloadStats(): Promise<any> {
    const response = await this.client.get<{ stats: any }>('/media/download-stats');
    return response.data.stats;
  }

  // Issues a scoped, expiring download URL that works without an
  // Authorization header, so the browser's native download manager can
  // stream it straight to disk (required for large files on mobile).
  async createDownloadToken(
    scopeType: 'file' | 'season' | 'album',
    ratingKey: string,
    partKey?: string,
    serverId?: string
  ): Promise<{ url: string; expiresAt: number }> {
    // serverId goes in the query, not the body: the request interceptor
    // treats an explicit params.serverId as authoritative and won't overlay
    // the dropdown's selection (which is 'all' here). Backend reads query
    // first, so this pins the token to the chosen source server.
    const response = await this.client.post<{ url: string; expiresAt: number }>(
      '/media/download-token',
      { scopeType, ratingKey, partKey },
      { params: serverId ? { serverId } : undefined }
    );
    return response.data;
  }

  // Device-quality conversion (transcode) jobs
  async startTranscode(
    ratingKey: string,
    quality: string,
    serverId?: string,
    subtitles: boolean = true
  ): Promise<{ jobId: string; status: string; reused: boolean }> {
    const response = await this.client.post<{ jobId: string; status: string; reused: boolean }>(
      '/media/transcode',
      { ratingKey, quality, subtitles },
      { params: serverId ? { serverId } : undefined }
    );
    return response.data;
  }

  async getTranscodeJob(jobId: string): Promise<{
    id: string;
    status: 'queued' | 'processing' | 'ready' | 'failed' | 'canceled';
    progress: number;
    quality: string;
    title: string;
    fileSize?: number;
    error?: string;
  }> {
    const response = await this.client.get<{ job: any }>(`/media/transcode/${jobId}`);
    return response.data.job;
  }

  async getTranscodeJobs(): Promise<{ jobs: TranscodeJobView[]; activeCount: number }> {
    const response = await this.client.get<{ jobs: TranscodeJobView[]; activeCount: number }>(
      '/media/transcode/jobs'
    );
    return response.data;
  }

  async cancelTranscode(jobId: string): Promise<void> {
    await this.client.post(`/media/transcode/${jobId}/cancel`);
  }

  async transcodeDownloadUrl(jobId: string): Promise<{ url: string; expiresAt: number }> {
    const response = await this.client.post<{ url: string; expiresAt: number }>(
      `/media/transcode/${jobId}/download-token`
    );
    return response.data;
  }

  async getSeasonSize(
    seasonRatingKey: string,
    serverId?: string
  ): Promise<{ totalSize: number; fileCount: number; totalSizeGB: string }> {
    const response = await this.client.get<{ totalSize: number; fileCount: number; totalSizeGB: string }>(
      `/media/season/${seasonRatingKey}/size`,
      { params: serverId ? { serverId } : undefined }
    );
    return response.data;
  }

  async getAlbumSize(
    albumRatingKey: string,
    serverId?: string
  ): Promise<{ totalSize: number; fileCount: number; totalSizeGB: string }> {
    const response = await this.client.get<{ totalSize: number; fileCount: number; totalSizeGB: string }>(
      `/media/album/${albumRatingKey}/size`,
      { params: serverId ? { serverId } : undefined }
    );
    return response.data;
  }

  // serverId override is required for merged ('all'-mode) items, whose thumb
  // lives on the preferred source server, not the 'all' selection.
  getThumbnailUrl(ratingKey: string, path: string, serverId?: string): string {
    const token = localStorage.getItem('token');
    const effective = serverId ?? getSelectedServerId();
    // 'all' is not a real server — a thumb must come from a concrete one
    const serverParam =
      effective && effective !== 'home' && effective !== 'all'
        ? `&serverId=${encodeURIComponent(effective)}`
        : '';
    return `/api/media/thumb/${ratingKey}?path=${encodeURIComponent(path)}&token=${token}${serverParam}`;
  }

  // Settings endpoints
  async getSettings(): Promise<Settings> {
    const response = await this.client.get<{ settings: Settings }>('/settings');
    return response.data.settings;
  }

  async updateSettings(settings: Partial<Settings>): Promise<void> {
    await this.client.put('/settings', settings);
  }

  async testPlexConnection(plexUrl?: string, plexToken?: string): Promise<boolean> {
    const response = await this.client.post<{ connected: boolean }>('/settings/test-connection', {
      plexUrl,
      plexToken,
    });
    return response.data.connected;
  }

  // Logs endpoints
  async getLogs(params: {
    level?: string;
    search?: string;
    page?: number;
    limit?: number;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ logs: any[]; total: number; page: number; limit: number; totalPages: number }> {
    const response = await this.client.get('/logs', { params });
    return response.data;
  }
}

export const api = new ApiClient();
