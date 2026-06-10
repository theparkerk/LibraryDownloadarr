import { DatabaseService } from '../models/database';
import { plexService } from './plexService';
import { logger } from '../utils/logger';

// Resolves which Plex server a request should talk to. The home server is
// the admin-configured one (same behavior as before multi-server support).
// Any other server must appear in plex.tv's resource list for the
// requesting user's own account — we never proxy to arbitrary URLs, only
// to servers plex.tv vouches the user can access.

export interface ServerInfo {
  machineId: string;
  name: string;
  owned: boolean;
  isHome: boolean;
}

export interface ServerContext {
  token?: string;
  serverUrl: string;
  serverName: string;
  isHome: boolean;
  error?: string;
}

interface RequestUser {
  id: string;
  isAdmin: boolean;
  plexToken?: string;
  plexAccountToken?: string;
}

// plex.tv resources change rarely; cache per account token briefly so
// every sidebar render / download doesn't hit plex.tv
const RESOURCE_CACHE_TTL_MS = 5 * 60 * 1000;
const resourceCache = new Map<string, { at: number; devices: any[] }>();

const devicesForToken = async (accountToken: string): Promise<any[]> => {
  const cached = resourceCache.get(accountToken);
  if (cached && Date.now() - cached.at < RESOURCE_CACHE_TTL_MS) {
    return cached.devices;
  }
  const devices = await plexService.getUserServers(accountToken);
  resourceCache.set(accountToken, { at: Date.now(), devices });
  return devices;
};

// The Plex account token used to enumerate servers: the user's own OAuth
// account token, or the admin's stored account token for the local admin
// login. plexToken is the legacy fallback — for users who got home-server
// access via a share it's a server-scoped token and won't enumerate other
// servers (fixed by their next login storing plexAccountToken).
const accountTokenFor = (db: DatabaseService, user?: RequestUser): string | undefined => {
  if (user?.plexAccountToken) return user.plexAccountToken;
  if (user?.plexToken) return user.plexToken;
  if (user?.isAdmin) return db.getSetting('plex_token') || undefined;
  return undefined;
};

const providesServer = (device: any): boolean =>
  typeof device.provides === 'string' && device.provides.split(',').includes('server');

const asBool = (v: any): boolean => v === '1' || v === 1 || v === true;

export const listServers = async (db: DatabaseService, user?: RequestUser): Promise<ServerInfo[]> => {
  const homeMachineId = db.getSetting('plex_machine_id') || '';
  const homeName = db.getSetting('plex_server_name') || 'Home';
  const servers: ServerInfo[] = [
    { machineId: homeMachineId || 'home', name: homeName, owned: true, isHome: true },
  ];

  const accountToken = accountTokenFor(db, user);
  if (!accountToken) {
    return servers;
  }

  try {
    const devices = await devicesForToken(accountToken);
    for (const device of devices) {
      if (!providesServer(device)) continue;
      if (device.clientIdentifier === homeMachineId) continue;
      // Shared servers come with a share access token; skip entries we
      // couldn't authenticate against
      if (!asBool(device.owned) && !device.accessToken) continue;
      servers.push({
        machineId: device.clientIdentifier,
        name: device.name,
        owned: asBool(device.owned),
        isHome: false,
      });
    }
  } catch (error) {
    logger.warn('Failed to list plex.tv servers; offering home server only', { error });
  }

  return servers;
};

export const resolveServer = async (
  db: DatabaseService,
  user: RequestUser | undefined,
  serverId?: string
): Promise<ServerContext> => {
  const adminUrl = db.getSetting('plex_url') || '';
  const homeMachineId = db.getSetting('plex_machine_id') || '';
  const homeName = db.getSetting('plex_server_name') || 'Home';

  // Home server — identical semantics to the original single-server logic
  if (!serverId || serverId === 'home' || serverId === homeMachineId) {
    if (!adminUrl) {
      return {
        serverUrl: '',
        serverName: homeName,
        isHome: true,
        error: 'Plex server not configured. Please contact administrator.',
      };
    }
    if (user?.plexToken) {
      return { token: user.plexToken, serverUrl: adminUrl, serverName: homeName, isHome: true };
    }
    const adminToken = db.getSetting('plex_token') || undefined;
    if (user?.isAdmin && adminToken) {
      return { token: adminToken, serverUrl: adminUrl, serverName: homeName, isHome: true };
    }
    return {
      serverUrl: '',
      serverName: homeName,
      isHome: true,
      error: 'Access denied. Please log out and log in again to configure your Plex access.',
    };
  }

  // Shared/remote server — must be in the user's own plex.tv resource list
  const accountToken = accountTokenFor(db, user);
  if (!accountToken) {
    return {
      serverUrl: '',
      serverName: '',
      isHome: false,
      error: 'Access denied. Please log out and log in again to configure your Plex access.',
    };
  }

  let devices: any[];
  try {
    devices = await devicesForToken(accountToken);
  } catch (error) {
    logger.error('Failed to resolve server via plex.tv', { serverId, error });
    return { serverUrl: '', serverName: '', isHome: false, error: 'Could not reach plex.tv to verify server access' };
  }

  const device = devices.find(
    (d) => d.clientIdentifier === serverId && providesServer(d)
  );
  // Mirror listServers: a non-owned server without a share accessToken is
  // not actually accessible — deny rather than falling back to the account
  // token (which would let a hand-crafted serverId target servers the UI
  // refuses to list)
  if (!device || (!asBool(device.owned) && !device.accessToken)) {
    return { serverUrl: '', serverName: '', isHome: false, error: 'You do not have access to that Plex server.' };
  }

  const rawConnections = device.Connection || device.connections || [];
  const connections: any[] = Array.isArray(rawConnections) ? rawConnections : [rawConnections];
  // We connect server-side (from this host), so the target's LAN addresses
  // are useless to us: prefer direct remote, fall back to relay (slow but
  // works), and only then try local
  const pick =
    connections.find((c) => c.uri && !asBool(c.local) && !asBool(c.relay)) ||
    connections.find((c) => c.uri && asBool(c.relay)) ||
    connections.find((c) => c.uri);

  if (!pick) {
    return { serverUrl: '', serverName: device.name || '', isHome: false, error: 'No reachable connection for that Plex server.' };
  }

  return {
    token: device.accessToken || accountToken,
    serverUrl: pick.uri,
    serverName: device.name || serverId,
    isHome: false,
  };
};
