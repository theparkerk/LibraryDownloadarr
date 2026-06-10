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
      const serverId = getSelectedServerId();
      if (serverId && serverId !== 'home') {
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

  async getMediaMetadata(ratingKey: string): Promise<MediaItem> {
    const response = await this.client.get<{ metadata: MediaItem }>(`/media/${ratingKey}`);
    return response.data.metadata;
  }

  async getSeasons(showRatingKey: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ seasons: MediaItem[] }>(`/media/${showRatingKey}/seasons`);
    return response.data.seasons;
  }

  async getEpisodes(seasonRatingKey: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ episodes: MediaItem[] }>(`/media/${seasonRatingKey}/episodes`);
    return response.data.episodes;
  }

  async getTracks(albumRatingKey: string): Promise<MediaItem[]> {
    const response = await this.client.get<{ tracks: MediaItem[] }>(`/media/${albumRatingKey}/tracks`);
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
    partKey?: string
  ): Promise<{ url: string; expiresAt: number }> {
    const response = await this.client.post<{ url: string; expiresAt: number }>(
      '/media/download-token',
      { scopeType, ratingKey, partKey }
    );
    return response.data;
  }

  async getSeasonSize(seasonRatingKey: string): Promise<{ totalSize: number; fileCount: number; totalSizeGB: string }> {
    const response = await this.client.get<{ totalSize: number; fileCount: number; totalSizeGB: string }>(
      `/media/season/${seasonRatingKey}/size`
    );
    return response.data;
  }

  async getAlbumSize(albumRatingKey: string): Promise<{ totalSize: number; fileCount: number; totalSizeGB: string }> {
    const response = await this.client.get<{ totalSize: number; fileCount: number; totalSizeGB: string }>(
      `/media/album/${albumRatingKey}/size`
    );
    return response.data;
  }

  getThumbnailUrl(ratingKey: string, path: string): string {
    const token = localStorage.getItem('token');
    const serverId = getSelectedServerId();
    const serverParam = serverId && serverId !== 'home' ? `&serverId=${encodeURIComponent(serverId)}` : '';
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
