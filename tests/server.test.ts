import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SteamApiError } from '../src/errors.js';
import { createSteamLibraryServer, type SteamDataSource } from '../src/server.js';
import { SteamClient, type OwnedGame, type WishlistItem } from '../src/steam-client.js';

function ownedGame(appId: number): OwnedGame {
  return {
    appId,
    name: `Game ${String(appId).padStart(3, '0')}`,
    playtimeMinutes: appId,
    playtimeTwoWeeksMinutes: null,
    playtimeWindowsMinutes: null,
    playtimeMacMinutes: null,
    playtimeLinuxMinutes: null,
    playtimeDeckMinutes: null,
    playtimeDisconnectedMinutes: null,
    contentDescriptorIds: [],
    lastPlayedAt: null,
    iconHash: null,
    communityStatsVisible: null,
  };
}

function wishlistItem(appId: number): WishlistItem {
  return {
    appId,
    priority: appId,
    dateAddedAt: '2023-11-14T22:13:20.000Z',
    storeUrl: `https://store.steampowered.com/app/${appId}/`,
  };
}

function dataSource(overrides: Partial<SteamDataSource> = {}): SteamDataSource {
  return {
    getOwnedGames: vi.fn().mockResolvedValue([]),
    getWishlist: vi.fn().mockResolvedValue([]),
    getRecentlyPlayedGames: vi.fn().mockResolvedValue([]),
    getAppCatalog: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  };
}

const openClients: Client[] = [];
const openServers: Array<{ close(): Promise<void> }> = [];

async function connect(source: SteamDataSource) {
  const server = createSteamLibraryServer({ source });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'steam-library-mcp-test', version: '1.0.0' });
  await client.connect(clientTransport);
  openClients.push(client);
  openServers.push(server);
  return client;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  vi.useRealTimers();
});

describe('Steam Library MCP server', () => {
  it('does not fetch again before an HTTP-date Retry-After deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T07:26:00Z'));
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response('', {
          status: 429,
          headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
        }),
    );
    const client = await connect(
      new SteamClient({ apiKey: 'B'.repeat(32), steamId64: '76561197960265728' }, { fetchFn }),
    );
    const call = () => client.callTool({ name: 'steam_list_owned_games', arguments: {} });
    expect((await call()).isError).toBe(true);
    vi.setSystemTime(new Date('2026-10-21T07:27:59Z'));
    const waiting = await call();
    expect(waiting.isError).toBe(true);
    expect(waiting.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('"retryAfterSeconds":1'),
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-21T07:28:00Z'));
    await call();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('honors Steam Retry-After while returning stale library pages', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const getOwnedGames = vi
      .fn<SteamDataSource['getOwnedGames']>()
      .mockResolvedValueOnce([ownedGame(1)])
      .mockRejectedValue(new SteamApiError('STEAM_RATE_LIMITED', 'rate limited', true, 30));
    const client = await connect(dataSource({ getOwnedGames }));
    const call = () => client.callTool({ name: 'steam_list_owned_games', arguments: {} });
    await call();
    vi.setSystemTime(300_001);
    expect((await call()).structuredContent).toMatchObject({ cache: { stale: true } });
    vi.setSystemTime(330_000);
    expect((await call()).structuredContent).toMatchObject({ cache: { stale: true } });
    expect(getOwnedGames).toHaveBeenCalledTimes(2);
    vi.setSystemTime(330_001);
    await call();
    expect(getOwnedGames).toHaveBeenCalledTimes(3);
  });

  it.each(['STEAM_RESPONSE_TOO_LARGE', 'STEAM_BAD_RESPONSE', 'STEAM_AUTH_FAILED'] as const)(
    'pauses catalog retries for one hour after %s without hiding wishlist AppIDs',
    async (code) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(0);
      const getAppCatalog = vi
        .fn<SteamDataSource['getAppCatalog']>()
        .mockRejectedValueOnce(new SteamApiError(code, 'catalog unavailable', false))
        .mockResolvedValue(new Map([[1, 'Portal']]));
      const client = await connect(
        dataSource({ getAppCatalog, getWishlist: async () => [wishlistItem(1)] }),
      );
      const call = () => client.callTool({ name: 'steam_list_wishlist', arguments: {} });
      expect((await call()).structuredContent).toMatchObject({
        catalog: { status: 'unavailable' },
        items: [{ appId: 1, name: null }],
      });
      vi.setSystemTime(3_599_999);
      const pages = await Promise.all([call(), call()]);
      for (const page of pages) {
        expect(page.isError).not.toBe(true);
        expect(page.structuredContent).toMatchObject({
          catalog: { status: 'unavailable' },
          counts: { total: 1 },
          items: [{ appId: 1, name: null }],
        });
      }
      expect(getAppCatalog).toHaveBeenCalledTimes(1);
      vi.setSystemTime(3_600_000);
      expect((await call()).structuredContent).toMatchObject({
        catalog: { status: 'complete' },
        items: [{ appId: 1, name: 'Portal' }],
      });
      expect(getAppCatalog).toHaveBeenCalledTimes(2);
    },
  );

  it('backs off failed optional catalog enrichment for five seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const getAppCatalog = vi
      .fn<SteamDataSource['getAppCatalog']>()
      .mockRejectedValue(new SteamApiError('STEAM_UPSTREAM_UNAVAILABLE', 'outage', true));
    const client = await connect(
      dataSource({ getAppCatalog, getWishlist: async () => [wishlistItem(1)] }),
    );
    const call = () => client.callTool({ name: 'steam_list_wishlist', arguments: {} });
    await call();
    vi.setSystemTime(4_999);
    expect((await call()).structuredContent).toMatchObject({ catalog: { status: 'unavailable' } });
    expect(getAppCatalog).toHaveBeenCalledTimes(1);
    vi.setSystemTime(5_000);
    await call();
    expect(getAppCatalog).toHaveBeenCalledTimes(2);
  });

  it.each(['disabled', 'partial', 'unavailable'] as const)(
    'marks name searches incomplete when catalog enrichment is %s',
    async (mode) => {
      const getAppCatalog = vi.fn<SteamDataSource['getAppCatalog']>();
      if (mode === 'unavailable') getAppCatalog.mockRejectedValue(new Error('unavailable'));
      else getAppCatalog.mockResolvedValue(new Map([[1, 'Other game']]));
      const client = await connect(
        dataSource({
          getWishlist: async () => [wishlistItem(1), wishlistItem(2)],
          getAppCatalog,
        }),
      );
      const result = await client.callTool({
        name: 'steam_list_wishlist',
        arguments: { query: 'Portal', includeNames: mode !== 'disabled' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        search: { complete: false, missingNameCount: mode === 'partial' ? 1 : 2 },
        counts: { total: 2, matched: 0 },
        warning: expect.stringContaining('lower bound'),
      });
      expect(JSON.stringify(result.content)).toContain('Search is incomplete');
      if (mode === 'disabled') expect(getAppCatalog).not.toHaveBeenCalled();
    },
  );

  it('marks fully named searches and unfiltered raw listings complete', async () => {
    const client = await connect(
      dataSource({
        getWishlist: async () => [wishlistItem(1), wishlistItem(2)],
        getAppCatalog: async () =>
          new Map([
            [1, 'Portal'],
            [2, 'Other game'],
          ]),
      }),
    );
    const named = await client.callTool({
      name: 'steam_list_wishlist',
      arguments: { query: 'Portal' },
    });
    expect(named.structuredContent).toMatchObject({
      search: { complete: true, missingNameCount: 0 },
      counts: { matched: 1 },
      warning: null,
    });
    const raw = await client.callTool({
      name: 'steam_list_wishlist',
      arguments: { includeNames: false },
    });
    expect(raw.structuredContent).toMatchObject({
      search: { complete: true, missingNameCount: 2 },
      counts: { total: 2, matched: 2 },
      warning: null,
    });
  });

  it('advertises only four read-only, non-destructive tools', async () => {
    const client = await connect(dataSource());

    const result = await client.listTools();

    expect(result.tools.map(({ name }) => name)).toEqual([
      'steam_list_owned_games',
      'steam_summarize_library',
      'steam_get_recent_games',
      'steam_list_wishlist',
    ]);
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.outputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('keeps all 137 upstream games reachable through MCP pagination', async () => {
    const getOwnedGames = vi
      .fn<SteamDataSource['getOwnedGames']>()
      .mockResolvedValue(Array.from({ length: 137 }, (_, index) => ownedGame(index + 1)));
    const client = await connect(dataSource({ getOwnedGames }));

    const result = await client.callTool({
      name: 'steam_list_owned_games',
      arguments: { offset: 100, limit: 50 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      counts: { total: 137, matched: 137 },
      page: { offset: 100, limit: 50, returned: 37, nextOffset: null },
    });
    expect((result.structuredContent as { games: unknown[] }).games).toHaveLength(37);
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('"appId":137') }),
    ]);
    expect(getOwnedGames).toHaveBeenCalledTimes(1);
  });

  it('can return the complete wishlist without downloading the name catalog', async () => {
    const getWishlist = vi
      .fn<SteamDataSource['getWishlist']>()
      .mockResolvedValue(Array.from({ length: 137 }, (_, index) => wishlistItem(index + 1)));
    const getAppCatalog = vi.fn<SteamDataSource['getAppCatalog']>();
    const client = await connect(dataSource({ getWishlist, getAppCatalog }));

    const result = await client.callTool({
      name: 'steam_list_wishlist',
      arguments: { offset: 50, limit: 50, includeNames: false },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      experimental: true,
      counts: { total: 137, matched: 137 },
      page: { offset: 50, limit: 50, returned: 50, nextOffset: 100 },
      catalog: { status: 'not_requested' },
    });
    expect((result.structuredContent as { items: unknown[] }).items).toHaveLength(50);
    expect(getAppCatalog).not.toHaveBeenCalled();
  });

  it('keeps recent games after the first 50 reachable through local pagination', async () => {
    const getRecentlyPlayedGames = vi
      .fn<SteamDataSource['getRecentlyPlayedGames']>()
      .mockResolvedValue(Array.from({ length: 137 }, (_, index) => ownedGame(index + 1)));
    const client = await connect(dataSource({ getRecentlyPlayedGames }));

    const result = await client.callTool({
      name: 'steam_get_recent_games',
      arguments: { offset: 100, limit: 50 },
    });

    expect(result.structuredContent).toMatchObject({
      counts: { total: 137, matched: 137 },
      page: { offset: 100, limit: 50, returned: 37, nextOffset: null },
    });
    expect((result.structuredContent as { games: unknown[] }).games).toHaveLength(37);
    expect(getRecentlyPlayedGames).toHaveBeenCalledWith();
  });

  it('marks name enrichment partial when any wishlist entry is absent from the catalog', async () => {
    const client = await connect(
      dataSource({
        getWishlist: vi
          .fn<SteamDataSource['getWishlist']>()
          .mockResolvedValue([wishlistItem(1), wishlistItem(2), wishlistItem(3)]),
        getAppCatalog: vi
          .fn<SteamDataSource['getAppCatalog']>()
          .mockResolvedValue(new Map([[1, 'First']])),
      }),
    );

    const result = await client.callTool({
      name: 'steam_list_wishlist',
      arguments: { offset: 0, limit: 1, includeNames: true },
    });

    expect(result.structuredContent).toMatchObject({
      catalog: { status: 'partial' },
      search: { complete: true, missingNameCount: 2 },
      warning: expect.stringContaining('Some wishlist game names are unavailable'),
    });
  });

  it('keeps valid wishlist AppIDs when optional catalog enrichment fails', async () => {
    const client = await connect(
      dataSource({
        getWishlist: vi
          .fn<SteamDataSource['getWishlist']>()
          .mockResolvedValue([wishlistItem(1), wishlistItem(2)]),
        getAppCatalog: vi
          .fn<SteamDataSource['getAppCatalog']>()
          .mockRejectedValue(
            new SteamApiError('STEAM_UPSTREAM_UNAVAILABLE', 'catalog unavailable', true),
          ),
      }),
    );

    const result = await client.callTool({
      name: 'steam_list_wishlist',
      arguments: { includeNames: true },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      catalog: { status: 'unavailable' },
      counts: { total: 2 },
      items: [
        { appId: 1, name: null },
        { appId: 2, name: null },
      ],
    });
  });

  it('sanitizes unexpected failures at the MCP boundary', async () => {
    const sensitiveText = 'socket failure containing a credential-like value';
    const client = await connect(
      dataSource({
        getOwnedGames: vi
          .fn<SteamDataSource['getOwnedGames']>()
          .mockRejectedValue(new Error(sensitiveText)),
      }),
    );

    const result = await client.callTool({
      name: 'steam_list_owned_games',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('STEAM_UPSTREAM_UNAVAILABLE');
    expect(JSON.stringify(result.content)).not.toContain(sensitiveText);
  });
});
