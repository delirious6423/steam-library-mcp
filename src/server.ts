import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { TtlCache, type CacheResult } from './cache.js';
import { loadConfig } from './config.js';
import { SteamApiError } from './errors.js';
import { createOwnedGamesPage, summarizeLibrary } from './library-service.js';
import { SteamClient, type OwnedGame, type WishlistItem } from './steam-client.js';
import { createWishlistPage } from './wishlist-service.js';

const SERVER_NAME = 'steam-library-mcp';
const SERVER_VERSION = '0.1.0';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const CacheSchema = z.object({
  hit: z.boolean(),
  stale: z.boolean(),
  fetchedAt: z.string(),
});

const OwnedGameSchema = z.object({
  appId: z.number().int().nonnegative(),
  name: z.string(),
  playtimeMinutes: z.number().int().nonnegative(),
  playtimeTwoWeeksMinutes: z.number().int().nonnegative().nullable(),
  playtimeWindowsMinutes: z.number().int().nonnegative().nullable(),
  playtimeMacMinutes: z.number().int().nonnegative().nullable(),
  playtimeLinuxMinutes: z.number().int().nonnegative().nullable(),
  playtimeDeckMinutes: z.number().int().nonnegative().nullable(),
  playtimeDisconnectedMinutes: z.number().int().nonnegative().nullable(),
  contentDescriptorIds: z.array(z.number().int().nonnegative()),
  lastPlayedAt: z.string().nullable(),
  iconHash: z.string().nullable(),
  communityStatsVisible: z.boolean().nullable(),
});

const PageSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  returned: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const CountsSchema = z.object({
  total: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
});

const OwnedGamesOutputSchema = z.object({
  cache: CacheSchema,
  counts: CountsSchema,
  page: PageSchema,
  games: z.array(OwnedGameSchema),
});

const SummaryOutputSchema = z.object({
  cache: CacheSchema,
  totalGames: z.number().int().nonnegative(),
  playedGames: z.number().int().nonnegative(),
  neverPlayedGames: z.number().int().nonnegative(),
  totalPlaytimeMinutes: z.number().int().nonnegative(),
  topGames: z.array(OwnedGameSchema),
});

const RecentOutputSchema = z.object({
  cache: CacheSchema,
  counts: CountsSchema,
  page: PageSchema,
  games: z.array(OwnedGameSchema),
});

const WishlistItemSchema = z.object({
  appId: z.number().int().nonnegative(),
  name: z.string().nullable(),
  priority: z.number().int().nonnegative(),
  dateAddedAt: z.string().nullable(),
  storeUrl: z.string(),
});

const CatalogSchema = z.object({
  status: z.enum(['complete', 'partial', 'unavailable', 'not_requested']),
  cache: CacheSchema.nullable(),
});

const WishlistOutputSchema = z.object({
  experimental: z.literal(true),
  warning: z.string().nullable(),
  cache: CacheSchema,
  catalog: CatalogSchema,
  search: z.object({ complete: z.boolean(), missingNameCount: z.number().int().nonnegative() }),
  counts: CountsSchema,
  page: PageSchema,
  items: z.array(WishlistItemSchema),
});

const QuerySchema = z.string().trim().min(1).max(100).optional();
const OffsetSchema = z.number().int().min(0).max(1_000_000).default(0);
const LimitSchema = z.number().int().min(1).max(100).default(50);

export interface SteamDataSource {
  getOwnedGames(): Promise<OwnedGame[]>;
  getWishlist(): Promise<WishlistItem[]>;
  getRecentlyPlayedGames(): Promise<OwnedGame[]>;
  getAppCatalog(): Promise<Map<number, string>>;
}

export interface CreateSteamLibraryServerOptions {
  source?: SteamDataSource;
}

function cacheMetadata<T>(result: CacheResult<T>) {
  return {
    hit: result.hit,
    stale: result.stale,
    fetchedAt: result.fetchedAt,
  };
}

function successResult(output: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: 'text' as const, text: `${summary}\n${JSON.stringify(output)}` }],
    structuredContent: output,
  };
}

function errorResult(error: unknown) {
  const steamError =
    error instanceof SteamApiError
      ? error
      : new SteamApiError(
          'STEAM_UPSTREAM_UNAVAILABLE',
          'The Steam request failed unexpectedly.',
          true,
        );
  const output = {
    error: {
      code: steamError.code,
      message: steamError.message,
      retryable: steamError.retryable,
      ...(steamError.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: steamError.retryAfterSeconds }),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
  };
}

function staleOnRetryable(error: unknown) {
  return error instanceof SteamApiError && error.retryable;
}

function retryDelayMs(error: unknown): number {
  if (!(error instanceof SteamApiError) || !error.retryable) return 0;
  return Math.max(1_000, Math.min(error.retryAfterSeconds ?? 5, 3_600) * 1_000);
}

export function createSteamLibraryServer(options: CreateSteamLibraryServerOptions = {}): McpServer {
  const source = options.source ?? new SteamClient(loadConfig());
  const ownedCache = new TtlCache<OwnedGame[]>({
    ttlMs: 5 * 60_000,
    maxStaleMs: 60 * 60_000,
    staleIfError: staleOnRetryable,
    retryDelayMs,
  });
  const recentCache = new TtlCache<OwnedGame[]>({
    ttlMs: 60_000,
    maxStaleMs: 60 * 60_000,
    staleIfError: staleOnRetryable,
    retryDelayMs,
  });
  const wishlistCache = new TtlCache<WishlistItem[]>({
    ttlMs: 5 * 60_000,
    maxStaleMs: 60 * 60_000,
    staleIfError: staleOnRetryable,
    retryDelayMs,
  });
  const catalogCache = new TtlCache<Map<number, string>>({
    ttlMs: 24 * 60 * 60_000,
    maxStaleMs: 7 * 24 * 60 * 60_000,
    staleIfError: staleOnRetryable,
    retryDelayMs: (error) =>
      error instanceof SteamApiError && !error.retryable ? 60 * 60_000 : retryDelayMs(error),
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Read-only access to one configured Steam account. Library and wishlist collections are fetched in full, then filtered and paginated locally; pages are not an upstream top-games ranking. Steam privacy settings can hide library data. Wishlist access uses an experimental live Steam interface whose empty, private, and unavailable states are indistinguishable.',
    },
  );

  server.registerTool(
    'steam_list_owned_games',
    {
      title: 'List owned Steam games',
      description:
        'Fetch the complete Steam-returned library, then search, sort, filter, and paginate it locally. This is not capped at the first or top 50 games.',
      inputSchema: z
        .object({
          query: QuerySchema.describe('Optional case-insensitive game-name search.'),
          played: z.enum(['any', 'played', 'never_played']).default('any'),
          sort: z.enum(['name', 'playtime_desc', 'last_played_desc']).default('name'),
          offset: OffsetSchema,
          limit: LimitSchema,
        })
        .strict(),
      outputSchema: OwnedGamesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        const cached = await ownedCache.getOrLoad(() => source.getOwnedGames());
        const page = createOwnedGamesPage(cached.value, input);
        const output = { cache: cacheMetadata(cached), ...page };
        return successResult(
          output,
          `Returned ${page.page.returned} of ${page.counts.matched} matching games (${page.counts.total} total).`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'steam_summarize_library',
    {
      title: 'Summarize Steam library',
      description:
        'Summarize the complete Steam-returned library, including playtime and never-played counts.',
      inputSchema: z.object({ topN: z.number().int().min(1).max(25).default(10) }).strict(),
      outputSchema: SummaryOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ topN }) => {
      try {
        const cached = await ownedCache.getOrLoad(() => source.getOwnedGames());
        const summary = summarizeLibrary(cached.value, topN);
        const output = { cache: cacheMetadata(cached), ...summary };
        return successResult(
          output,
          `Summarized ${summary.totalGames} games and ${summary.totalPlaytimeMinutes} recorded playtime minutes.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'steam_get_recent_games',
    {
      title: 'Get recently played Steam games',
      description:
        'Fetch the complete recently played set, then paginate it locally with recent and lifetime playtime.',
      inputSchema: z.object({ offset: OffsetSchema, limit: LimitSchema }).strict(),
      outputSchema: RecentOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ offset, limit }) => {
      try {
        const cached = await recentCache.getOrLoad(() => source.getRecentlyPlayedGames());
        const games = cached.value.slice(offset, offset + limit);
        const nextOffset =
          offset + games.length < cached.value.length ? offset + games.length : null;
        const output = {
          cache: cacheMetadata(cached),
          counts: { total: cached.value.length, matched: cached.value.length },
          page: { offset, limit, returned: games.length, nextOffset },
          games,
        };
        return successResult(
          output,
          `Returned ${games.length} of ${cached.value.length} recently played games.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'steam_list_wishlist',
    {
      title: 'List Steam wishlist',
      description:
        'Fetch the complete wishlist, then search, sort, and paginate it locally. Wishlist access is experimental; Steam does not distinguish empty, private, and unavailable responses.',
      inputSchema: z
        .object({
          query: QuerySchema.describe(
            'Optional case-insensitive game-name or AppID search. Missing names make results incomplete; check search.complete.',
          ),
          sort: z.enum(['priority', 'date_added_desc']).default('priority'),
          includeNames: z
            .boolean()
            .default(true)
            .describe("Enrich AppIDs from Steam's catalog; disable for the fastest raw listing."),
          offset: OffsetSchema,
          limit: LimitSchema,
        })
        .strict(),
      outputSchema: WishlistOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        const wishlist = await wishlistCache.getOrLoad(() => source.getWishlist());
        let catalog = new Map<number, string>();
        let catalogResult: CacheResult<Map<number, string>> | undefined;
        let catalogUnavailable = false;

        if (input.includeNames) {
          try {
            catalogResult = await catalogCache.getOrLoad(() => source.getAppCatalog());
            catalog = catalogResult.value;
          } catch {
            catalogUnavailable = true;
          }
        }

        const page = createWishlistPage(wishlist.value, catalog, input);
        const missingNameCount = wishlist.value.filter((item) => !catalog.has(item.appId)).length;
        const searchComplete = !input.query || missingNameCount === 0;
        const catalogStatus = !input.includeNames
          ? 'not_requested'
          : catalogUnavailable
            ? 'unavailable'
            : missingNameCount > 0
              ? 'partial'
              : 'complete';
        const warning = !searchComplete
          ? 'Search is incomplete because some game names are unavailable. The matched count is a lower bound, not proof that other games are absent. List without a query to retrieve every AppID.'
          : catalogUnavailable
            ? 'Wishlist AppIDs are valid, but Steam catalog name enrichment was unavailable.'
            : input.includeNames && missingNameCount > 0
              ? 'Some wishlist game names are unavailable; all AppIDs remain accessible.'
              : null;
        const output = {
          experimental: true as const,
          warning,
          cache: cacheMetadata(wishlist),
          catalog: {
            status: catalogStatus,
            cache: catalogResult ? cacheMetadata(catalogResult) : null,
          },
          search: { complete: searchComplete, missingNameCount },
          ...page,
        };
        return successResult(
          output,
          `Returned ${page.page.returned} of ${page.counts.matched} known matching wishlist items (${page.counts.total} total).${searchComplete ? '' : ' Search is incomplete; missing names may hide matches.'}`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
