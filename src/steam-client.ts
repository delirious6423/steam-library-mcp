import * as z from 'zod/v4';

import type { SteamConfig } from './config.js';
import { SteamApiError } from './errors.js';

const OwnedGameSchema = z
  .object({
    appid: z.number().int().nonnegative(),
    name: z.string().default('Unknown Steam app'),
    playtime_forever: z.number().int().nonnegative().default(0),
    playtime_2weeks: z.number().int().nonnegative().optional(),
    playtime_windows_forever: z.number().int().nonnegative().optional(),
    playtime_mac_forever: z.number().int().nonnegative().optional(),
    playtime_linux_forever: z.number().int().nonnegative().optional(),
    playtime_deck_forever: z.number().int().nonnegative().optional(),
    playtime_disconnected: z.number().int().nonnegative().optional(),
    content_descriptorids: z.array(z.number().int().nonnegative()).optional(),
    rtime_last_played: z.number().int().nonnegative().optional(),
    img_icon_url: z.string().optional(),
    has_community_visible_stats: z.boolean().optional(),
  })
  .passthrough();

const OwnedGamesResponseSchema = z.object({
  response: z.object({
    game_count: z.number().int().nonnegative().optional(),
    games: z.array(OwnedGameSchema).optional(),
  }),
});

const RecentGamesResponseSchema = z.object({
  response: z.object({
    total_count: z.number().int().nonnegative().optional(),
    games: z.array(OwnedGameSchema).default([]),
  }),
});

const WishlistResponseSchema = z.object({
  response: z.object({
    items: z
      .array(
        z
          .object({
            appid: z.number().int().nonnegative(),
            priority: z.number().int().nonnegative(),
            date_added: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .optional(),
  }),
});

const WishlistCountResponseSchema = z.object({
  response: z.object({
    count: z.number().int().nonnegative().optional(),
  }),
});

const AppCatalogResponseSchema = z.object({
  response: z.object({
    apps: z.array(
      z
        .object({
          appid: z.number().int().nonnegative(),
          name: z.string(),
        })
        .passthrough(),
    ),
    have_more_results: z.boolean().default(false),
    last_appid: z.number().int().nonnegative().optional(),
  }),
});

export interface OwnedGame {
  appId: number;
  name: string;
  playtimeMinutes: number;
  playtimeTwoWeeksMinutes: number | null;
  playtimeWindowsMinutes: number | null;
  playtimeMacMinutes: number | null;
  playtimeLinuxMinutes: number | null;
  playtimeDeckMinutes: number | null;
  playtimeDisconnectedMinutes: number | null;
  contentDescriptorIds: number[];
  lastPlayedAt: string | null;
  iconHash: string | null;
  communityStatsVisible: boolean | null;
}

export interface WishlistItem {
  appId: number;
  priority: number;
  dateAddedAt: string | null;
  storeUrl: string;
}

export interface SteamClientOptions {
  fetchFn?: typeof fetch;
  catalogLimits?: { maxBytes?: number; maxItems?: number; timeoutMs?: number };
}

type UpstreamOwnedGame = z.infer<typeof OwnedGameSchema>;

const STANDARD_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const CATALOG_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_CATALOG_PAGES = 100;
const CATALOG_TOTAL_LIMIT_BYTES = 64 * 1024 * 1024;
const CATALOG_TOTAL_LIMIT_ITEMS = 1_000_000;
const CATALOG_TIMEOUT_MS = 30_000;

type ByteBudget = { remainingBytes: number };

function badResponse(message: string): SteamApiError {
  return new SteamApiError('STEAM_BAD_RESPONSE', message, false);
}

function sanitizeName(name: string): string {
  return (
    name
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || 'Unknown Steam app'
  );
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  budget?: ByteBudget,
): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw badResponse('Steam returned a response that was not JSON.');
  }

  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SteamApiError(
      'STEAM_RESPONSE_TOO_LARGE',
      'Steam returned a response larger than the configured safety limit.',
      false,
    );
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted();
        for (;;) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            throw new SteamApiError(
              'STEAM_RESPONSE_TOO_LARGE',
              'Steam returned a response larger than the configured safety limit.',
              false,
            );
          }
          if (budget) budget.remainingBytes -= value.byteLength;
          chunks.push(value);
        }
      } catch (error) {
        cancel();
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
    }
  } catch (error) {
    if (error instanceof SteamApiError) throw error;
    throw new SteamApiError(
      'STEAM_UPSTREAM_UNAVAILABLE',
      'Steam disconnected while returning a response.',
      true,
    );
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw badResponse('Steam returned malformed JSON.');
  }
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badResponse('Steam returned an unexpected response shape.');
  }
  return result.data;
}

function normalizeGame(game: UpstreamOwnedGame): OwnedGame {
  return {
    appId: game.appid,
    name: sanitizeName(game.name),
    playtimeMinutes: game.playtime_forever,
    playtimeTwoWeeksMinutes: game.playtime_2weeks ?? null,
    playtimeWindowsMinutes: game.playtime_windows_forever ?? null,
    playtimeMacMinutes: game.playtime_mac_forever ?? null,
    playtimeLinuxMinutes: game.playtime_linux_forever ?? null,
    playtimeDeckMinutes: game.playtime_deck_forever ?? null,
    playtimeDisconnectedMinutes: game.playtime_disconnected ?? null,
    contentDescriptorIds: game.content_descriptorids ?? [],
    lastPlayedAt:
      game.rtime_last_played && game.rtime_last_played > 0
        ? new Date(game.rtime_last_played * 1_000).toISOString()
        : null,
    iconHash: game.img_icon_url ?? null,
    communityStatsVisible: game.has_community_visible_stats ?? null,
  };
}

export class SteamClient {
  readonly #config: SteamConfig;
  readonly #fetch: typeof fetch;
  readonly #catalogLimits: { maxBytes: number; maxItems: number; timeoutMs: number };

  constructor(config: SteamConfig, options: SteamClientOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetchFn ?? fetch;
    this.#catalogLimits = {
      maxBytes: options.catalogLimits?.maxBytes ?? CATALOG_TOTAL_LIMIT_BYTES,
      maxItems: options.catalogLimits?.maxItems ?? CATALOG_TOTAL_LIMIT_ITEMS,
      timeoutMs: options.catalogLimits?.timeoutMs ?? CATALOG_TIMEOUT_MS,
    };
    for (const value of Object.values(this.#catalogLimits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError('Catalog limits must be positive safe integers.');
      }
    }
  }

  async #requestJson(
    url: URL,
    options: {
      authenticated: boolean;
      maxBytes?: number;
      signal?: AbortSignal;
      budget?: ByteBudget;
    },
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 10_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const signal = controller.signal;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: {
          accept: 'application/json',
          ...(options.authenticated ? { 'x-webapi-key': this.#config.apiKey } : {}),
        },
        redirect: 'error',
        signal,
      });
    } catch {
      cleanup();
      throw new SteamApiError('STEAM_UPSTREAM_UNAVAILABLE', 'Steam could not be reached.', true);
    }

    try {
      signal.throwIfAborted();
      if (!response.ok) {
        if (options.authenticated && (response.status === 401 || response.status === 403)) {
          throw new SteamApiError(
            'STEAM_AUTH_FAILED',
            'Steam rejected the configured Web API key.',
            false,
          );
        }
        if (!options.authenticated && (response.status === 401 || response.status === 403)) {
          throw new SteamApiError(
            'STEAM_WISHLIST_UNAVAILABLE',
            'Steam did not expose the configured account wishlist.',
            false,
          );
        }
        if (response.status === 429) {
          const value = response.headers.get('retry-after')?.trim() ?? '';
          const retryAfter = /^\d+$/.test(value)
            ? Number(value)
            : /^[A-Za-z]/.test(value)
              ? Math.ceil((Date.parse(value) - Date.now()) / 1_000)
              : NaN;
          throw new SteamApiError(
            'STEAM_RATE_LIMITED',
            'Steam rate-limited the request.',
            true,
            Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 0), 3_600) : undefined,
          );
        }
        throw new SteamApiError(
          'STEAM_UPSTREAM_UNAVAILABLE',
          `Steam returned HTTP ${response.status}.`,
          response.status >= 500,
        );
      }

      return await readBoundedJson(
        response,
        Math.min(
          options.maxBytes ?? STANDARD_RESPONSE_LIMIT_BYTES,
          options.budget?.remainingBytes ?? Infinity,
        ),
        signal,
        options.budget,
      );
    } catch (error) {
      if (error instanceof SteamApiError) throw error;
      throw new SteamApiError(
        'STEAM_UPSTREAM_UNAVAILABLE',
        'Steam disconnected while returning a response.',
        true,
      );
    } finally {
      cleanup();
      if (response.body && !response.body.locked) {
        void response.body.cancel().catch(() => {});
      }
    }
  }

  async getOwnedGames(): Promise<OwnedGame[]> {
    const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
    url.searchParams.set('steamid', this.#config.steamId64);
    url.searchParams.set('include_appinfo', 'true');
    url.searchParams.set('include_played_free_games', 'true');

    const parsed = parseResponse(
      OwnedGamesResponseSchema,
      await this.#requestJson(url, { authenticated: true }),
    );
    if (parsed.response.game_count === undefined) {
      throw new SteamApiError(
        'STEAM_PROFILE_PRIVATE_OR_UNAVAILABLE',
        'Steam did not expose the configured account library.',
        false,
      );
    }
    const games = parsed.response.games ?? [];
    if (games.length !== parsed.response.game_count) {
      throw badResponse('Steam returned fewer owned games than its declared game count.');
    }
    return games.map(normalizeGame);
  }

  async getWishlist(): Promise<WishlistItem[]> {
    const url = new URL('https://api.steampowered.com/IWishlistService/GetWishlist/v1/');
    url.searchParams.set('steamid', this.#config.steamId64);

    const parsed = parseResponse(
      WishlistResponseSchema,
      await this.#requestJson(url, { authenticated: false }),
    );
    if (!parsed.response.items) {
      throw new SteamApiError(
        'STEAM_WISHLIST_UNAVAILABLE',
        'Steam did not distinguish whether this wishlist is empty, private, or unavailable.',
        false,
      );
    }
    const countUrl = new URL(
      'https://api.steampowered.com/IWishlistService/GetWishlistItemCount/v1/',
    );
    countUrl.searchParams.set('steamid', this.#config.steamId64);
    const count = parseResponse(
      WishlistCountResponseSchema,
      await this.#requestJson(countUrl, { authenticated: false }),
    ).response.count;
    if (count === undefined) {
      throw new SteamApiError(
        'STEAM_WISHLIST_UNAVAILABLE',
        'Steam did not expose a wishlist count for the configured account.',
        false,
      );
    }
    if (parsed.response.items.length !== count) {
      throw badResponse('Steam returned fewer wishlist items than its declared wishlist count.');
    }
    return parsed.response.items.map((item) => ({
      appId: item.appid,
      priority: item.priority,
      dateAddedAt:
        item.date_added && item.date_added > 0
          ? new Date(item.date_added * 1_000).toISOString()
          : null,
      storeUrl: `https://store.steampowered.com/app/${item.appid}/`,
    }));
  }

  async getRecentlyPlayedGames(): Promise<OwnedGame[]> {
    const url = new URL('https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/');
    url.searchParams.set('steamid', this.#config.steamId64);
    url.searchParams.set('count', '0');

    const parsed = parseResponse(
      RecentGamesResponseSchema,
      await this.#requestJson(url, { authenticated: true }),
    );
    if (parsed.response.total_count === undefined) {
      throw new SteamApiError(
        'STEAM_PROFILE_PRIVATE_OR_UNAVAILABLE',
        'Steam did not expose recently played games for the configured account.',
        false,
      );
    }
    if (parsed.response.games.length !== parsed.response.total_count) {
      throw badResponse(
        'Steam returned fewer recently played games than its declared total count.',
      );
    }
    return parsed.response.games.map(normalizeGame);
  }

  async getAppCatalog(): Promise<Map<number, string>> {
    const catalog = new Map<number, string>();
    let lastAppId: number | undefined;
    let totalItems = 0;
    const budget: ByteBudget = { remainingBytes: this.#catalogLimits.maxBytes };
    const controller = new AbortController();
    const deadline = performance.now() + this.#catalogLimits.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.#catalogLimits.timeoutMs);
    const checkDeadline = () => {
      if (controller.signal.aborted || performance.now() >= deadline) {
        controller.abort();
        throw new SteamApiError(
          'STEAM_UPSTREAM_UNAVAILABLE',
          'Steam catalog retrieval timed out.',
          true,
        );
      }
    };

    try {
      for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
        checkDeadline();
        const url = new URL('https://api.steampowered.com/IStoreService/GetAppList/v1/');
        const input: Record<string, boolean | number> = {
          include_games: true,
          max_results: 50_000,
        };
        if (lastAppId !== undefined) {
          input.last_appid = lastAppId;
        }
        url.searchParams.set('input_json', JSON.stringify(input));

        const parsed = parseResponse(
          AppCatalogResponseSchema,
          await this.#requestJson(url, {
            authenticated: true,
            maxBytes: CATALOG_RESPONSE_LIMIT_BYTES,
            signal: controller.signal,
            budget,
          }),
        ).response;
        checkDeadline();
        totalItems += parsed.apps.length;
        if (totalItems > this.#catalogLimits.maxItems) {
          throw new SteamApiError(
            'STEAM_RESPONSE_TOO_LARGE',
            'Steam returned more catalog items than the configured safety limit.',
            false,
          );
        }
        for (const app of parsed.apps) {
          catalog.set(app.appid, sanitizeName(app.name));
        }
        checkDeadline();
        if (!parsed.have_more_results) {
          return catalog;
        }
        if (parsed.last_appid === undefined) {
          throw new SteamApiError(
            'STEAM_BAD_RESPONSE',
            'Steam omitted the catalog continuation marker.',
            false,
          );
        }
        if (lastAppId !== undefined && parsed.last_appid <= lastAppId) {
          throw badResponse('Steam returned a catalog continuation marker that did not advance.');
        }
        lastAppId = parsed.last_appid;
      }

      throw badResponse('Steam returned too many catalog continuation pages.');
    } finally {
      clearTimeout(timer);
    }
  }
}
