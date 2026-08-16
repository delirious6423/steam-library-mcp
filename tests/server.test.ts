import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SteamApiError } from '../src/errors.js';
import { createSteamLibraryServer, type SteamDataSource } from '../src/server.js';
import type { OwnedGame, WishlistItem } from '../src/steam-client.js';

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
});

describe('Steam Library MCP server', () => {
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

    expect(result.structuredContent).toMatchObject({ catalog: { status: 'partial' } });
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
