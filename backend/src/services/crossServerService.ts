import { DatabaseService } from '../models/database';
import { listServers, resolveServer, ServerInfo } from './serverRegistry';
import { createPlexClient, PlexMedia } from './plexService';
import { logger } from '../utils/logger';

// Unified "All Servers" view: fan out to every server the user can reach,
// merge the same title (keyed on Plex's global guid) into one entry that
// records which servers have it, so the UI can show "on N servers" and let
// the user pick a download source.

interface RequestUser {
  id: string;
  isAdmin: boolean;
  plexToken?: string;
  plexAccountToken?: string;
}

export interface SourceRef {
  serverId: string;
  serverName: string;
  ratingKey: string; // server-scoped — differs per server
  isHome: boolean;
  owned: boolean;
  allowSync?: boolean | number | string;
}

export interface MergedMedia extends PlexMedia {
  availability: SourceRef[];
  _preferredServerId: string;
  _fuzzyMatched?: boolean;
}

export interface MergeResult {
  items: MergedMedia[];
  failures: string[]; // names of servers that errored/timed out
}

interface ResolvedServer {
  info: ServerInfo;
  serverUrl: string;
  token: string;
}

const asDisabled = (v: any): boolean => v === false || v === 0 || v === '0';

// A title's dedup key. Plex-matched items share a global guid across
// servers; unmatched items fall back to a fuzzy type:title:year key.
const mergeKeyOf = (m: PlexMedia): { key: string; fuzzy: boolean } => {
  if (m.guid) return { key: `guid:${m.guid}`, fuzzy: false };
  const title = (m.title || '').trim().toLowerCase();
  return { key: `fuzzy:${m.type}:${title}:${m.year || ''}`, fuzzy: true };
};

// Prefer a source that can actually download (allowSync not disabled), then
// the home server, then an owned server, then whatever's first.
const pickPreferred = (sources: SourceRef[]): string => {
  const downloadable = sources.filter((s) => !asDisabled(s.allowSync));
  const pool = downloadable.length > 0 ? downloadable : sources;
  const home = pool.find((s) => s.isHome);
  if (home) return home.serverId;
  const owned = pool.find((s) => s.owned);
  if (owned) return owned.serverId;
  return pool[0].serverId;
};

// Expand the user's reachable servers into concrete {url, token} contexts,
// dropping any that error (logged, never thrown).
export const resolveAllServers = async (
  db: DatabaseService,
  user?: RequestUser
): Promise<ResolvedServer[]> => {
  const servers = await listServers(db, user);
  const resolved = await Promise.all(
    servers.map(async (info) => {
      const ctx = await resolveServer(db, user, info.machineId);
      if (ctx.error || !ctx.token || !ctx.serverUrl) {
        if (ctx.error) logger.warn('Cross-server: skipping server', { server: info.name, error: ctx.error });
        return null;
      }
      return { info, serverUrl: ctx.serverUrl, token: ctx.token };
    })
  );
  return resolved.filter((r): r is ResolvedServer => r !== null);
};

// Run a per-server async fn with bounded concurrency + timeout; partial
// failure is fine (one slow/dead server must not break the whole view).
const fanOut = async <T>(
  servers: ResolvedServer[],
  fn: (s: ResolvedServer) => Promise<T>,
  opts: { concurrency?: number; perServerTimeoutMs?: number } = {}
): Promise<{ results: { server: ResolvedServer; value: T }[]; failures: string[] }> => {
  const { concurrency = 4, perServerTimeoutMs = 12000 } = opts;
  const results: { server: ResolvedServer; value: T }[] = [];
  const failures: string[] = [];
  let i = 0;

  const worker = async () => {
    while (i < servers.length) {
      const server = servers[i++];
      try {
        const value = await Promise.race([
          fn(server),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('server timeout')), perServerTimeoutMs)
          ),
        ]);
        results.push({ server, value });
      } catch (error) {
        failures.push(server.info.name);
        logger.warn('Cross-server: server fan-out failed', { server: server.info.name, error });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, servers.length) }, worker));
  return { results, failures };
};

// Merge per-server item lists into deduped MergedMedia keyed on guid.
const mergeItems = (
  perServer: { server: ResolvedServer; items: PlexMedia[] }[]
): MergedMedia[] => {
  const map = new Map<string, MergedMedia>();

  for (const { server, items } of perServer) {
    const ref = (m: PlexMedia): SourceRef => ({
      serverId: server.info.machineId,
      serverName: server.info.name,
      ratingKey: m.ratingKey,
      isHome: server.info.isHome,
      owned: server.info.owned,
      allowSync: m.allowSync,
    });

    for (const item of items) {
      const { key, fuzzy } = mergeKeyOf(item);
      const existing = map.get(key);
      if (existing) {
        existing.availability.push(ref(item));
      } else {
        map.set(key, {
          ...item,
          availability: [ref(item)],
          _preferredServerId: server.info.machineId,
          _fuzzyMatched: fuzzy || undefined,
        });
      }
    }
  }

  // Re-point each merged item to its preferred source so the card's
  // thumbnail/ratingKey resolve against a server that actually has it
  for (const merged of map.values()) {
    const preferred = pickPreferred(merged.availability);
    merged._preferredServerId = preferred;
    const src = merged.availability.find((s) => s.serverId === preferred)!;
    merged.ratingKey = src.ratingKey;
  }

  return Array.from(map.values());
};

// Per-server library list cache feeds the type→libraries mapping. Reuses the
// short TTL below.
const MERGE_TTL_MS = { browse: 90_000, search: 30_000, recent: 120_000 };
const mergeCache = new Map<string, { at: number; value: MergeResult }>();

const cached = async (
  key: string,
  ttl: number,
  produce: () => Promise<MergeResult>
): Promise<MergeResult> => {
  const hit = mergeCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await produce();
  mergeCache.set(key, { at: Date.now(), value });
  return value;
};

// Synthetic libraries for All-Servers mode: collapse every server's
// libraries by type (names differ per server; type is stable).
const TYPE_LABELS: Record<string, string> = {
  movie: 'Movies',
  show: 'TV Shows',
  artist: 'Music',
  photo: 'Photos',
};

export const listAllServersLibraries = async (db: DatabaseService, user?: RequestUser) => {
  const servers = await resolveAllServers(db, user);
  const { results } = await fanOut(servers, async (s) => {
    const plex = createPlexClient(s.serverUrl);
    return plex.getLibraries(s.token);
  });

  const types = new Set<string>();
  for (const { value } of results) {
    for (const lib of value) types.add(lib.type);
  }

  return Array.from(types)
    .filter((t) => TYPE_LABELS[t])
    .map((t) => ({ key: `type:${t}`, title: TYPE_LABELS[t], type: t }));
};

const typeOf = (syntheticKey: string) =>
  syntheticKey.startsWith('type:') ? syntheticKey.slice(5) : syntheticKey;

// Genres merged across servers. Genre IDs differ per server, so the merged
// genre is keyed by its (lowercased) title; the content lookup re-matches by
// title on each server.
export const listAllServersGenres = async (
  db: DatabaseService,
  user: RequestUser | undefined,
  syntheticKey: string
): Promise<{ key: string; title: string }[]> => {
  const type = typeOf(syntheticKey);
  const servers = await resolveAllServers(db, user);
  const { results } = await fanOut(servers, async (s) => {
    const plex = createPlexClient(s.serverUrl);
    const libs = await plex.getLibraries(s.token);
    const matching = libs.filter((l) => l.type === type);
    const lists = await Promise.all(matching.map((l) => plex.getGenres(l.key, s.token)));
    return lists.flat();
  });
  const byTitle = new Map<string, string>();
  for (const { value } of results) {
    for (const g of value) {
      const k = g.title.trim().toLowerCase();
      if (k && !byTitle.has(k)) byTitle.set(k, g.title);
    }
  }
  return Array.from(byTitle.values())
    .sort((a, b) => a.localeCompare(b))
    .map((t) => ({ key: t, title: t })); // key = title (cross-server handle)
};

export const getAllServersGenreContent = async (
  db: DatabaseService,
  user: RequestUser | undefined,
  syntheticKey: string,
  genreTitle: string
): Promise<MergeResult> => {
  const type = typeOf(syntheticKey);
  const want = genreTitle.trim().toLowerCase();
  return cached(`${user?.id}:genre:${type}:${want}`, MERGE_TTL_MS.browse, async () => {
    const servers = await resolveAllServers(db, user);
    const { results, failures } = await fanOut(servers, async (s) => {
      const plex = createPlexClient(s.serverUrl);
      const libs = await plex.getLibraries(s.token);
      const matching = libs.filter((l) => l.type === type);
      const out: PlexMedia[] = [];
      for (const lib of matching) {
        const genres = await plex.getGenres(lib.key, s.token);
        const g = genres.find((x) => x.title.trim().toLowerCase() === want);
        if (g) out.push(...(await plex.getGenreContent(lib.key, g.key, s.token)));
      }
      return out;
    });
    const items = mergeItems(results.map((r) => ({ server: r.server, items: r.value })));
    return { items, failures };
  });
};

export const getAllServersLibraryContent = async (
  db: DatabaseService,
  user: RequestUser | undefined,
  syntheticKey: string
): Promise<MergeResult> => {
  const type = syntheticKey.startsWith('type:') ? syntheticKey.slice(5) : syntheticKey;
  return cached(`${user?.id}:browse:${type}`, MERGE_TTL_MS.browse, async () => {
    const servers = await resolveAllServers(db, user);
    const { results, failures } = await fanOut(servers, async (s) => {
      const plex = createPlexClient(s.serverUrl);
      const libs = await plex.getLibraries(s.token);
      const matching = libs.filter((l) => l.type === type);
      const viewType = type === 'artist' ? 'albums' : undefined;
      const lists = await Promise.all(
        matching.map((l) => plex.getLibraryContent(l.key, s.token, viewType))
      );
      return lists.flat();
    });

    const items = mergeItems(results.map((r) => ({ server: r.server, items: r.value })));
    return { items, failures };
  });
};

export const searchAllServers = async (
  db: DatabaseService,
  user: RequestUser | undefined,
  query: string
): Promise<MergeResult> => {
  return cached(`${user?.id}:search:${query.toLowerCase()}`, MERGE_TTL_MS.search, async () => {
    const servers = await resolveAllServers(db, user);
    const { results, failures } = await fanOut(servers, async (s) => {
      const plex = createPlexClient(s.serverUrl);
      return plex.search(query, s.token);
    });
    const items = mergeItems(results.map((r) => ({ server: r.server, items: r.value })));
    return { items, failures };
  });
};

export const getRecentlyAddedAllServers = async (
  db: DatabaseService,
  user: RequestUser | undefined,
  limit: number
): Promise<MergeResult> => {
  return cached(`${user?.id}:recent:${limit}`, MERGE_TTL_MS.recent, async () => {
    const servers = await resolveAllServers(db, user);
    const { results, failures } = await fanOut(servers, async (s) => {
      const plex = createPlexClient(s.serverUrl);
      return plex.getRecentlyAdded(s.token, limit);
    });
    const merged = mergeItems(results.map((r) => ({ server: r.server, items: r.value })));
    // getRecentlyAdded already balances per library on each server; keep the
    // full balanced set (date-sorted) so movies aren't starved by episodes —
    // don't slice back to `limit` here.
    merged.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return { items: merged, failures };
  });
};
