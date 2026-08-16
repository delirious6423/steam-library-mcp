#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { isValidSteamId64 } from '../dist/config.js';

const args = new Set(process.argv.slice(2));
const wishlistOnly = args.has('--wishlist-only');
const requireWishlist = args.has('--require-wishlist');
const requireOver50 = args.has('--require-over-50');
const windowsLauncher = args.has('--windows-launcher');

if (
  !/^[A-Fa-f0-9]{32}$/.test(process.env.STEAM_WEB_API_KEY ?? '') ||
  !isValidSteamId64(process.env.STEAM_ID64 ?? '')
) {
  throw new Error('Missing or invalid Steam environment configuration.');
}

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) =>
      typeof value === 'string' &&
      (!windowsLauncher || !['STEAM_WEB_API_KEY', 'STEAM_ID64'].includes(name)),
  ),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(windowsLauncher ? 'scripts/start-windows.mjs' : 'dist/index.js')],
  cwd: process.cwd(),
  env: childEnv,
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => {
  stderr += String(chunk);
});
const client = new Client({ name: 'steam-library-mcp-live-smoke', version: '1.0.0' });

function structured(result) {
  assert.equal(result.isError, undefined, 'Tool returned an error');
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  return result.structuredContent;
}

async function collectPages(tool, itemField, arguments_) {
  const appIds = new Set();
  let offset = 0;
  let total;
  do {
    const output = structured(
      await client.callTool({
        name: tool,
        arguments: { ...arguments_, offset, limit: 100 },
      }),
    );
    total ??= output.counts.total;
    assert.equal(output.counts.total, total);
    for (const item of output[itemField]) {
      assert.equal(appIds.has(item.appId), false, `Duplicate AppID ${item.appId}`);
      appIds.add(item.appId);
    }
    offset = output.page.nextOffset;
  } while (offset !== null);
  assert.equal(appIds.size, total);
  return total;
}

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      'steam_list_owned_games',
      'steam_summarize_library',
      'steam_get_recent_games',
      'steam_list_wishlist',
    ],
  );

  let libraryCount = null;
  let recentCount = null;
  if (!wishlistOnly) {
    libraryCount = await collectPages('steam_list_owned_games', 'games', {});
    if (requireOver50) assert.ok(libraryCount > 50, 'Expected a library larger than 50 games');

    const summary = structured(
      await client.callTool({ name: 'steam_summarize_library', arguments: { topN: 10 } }),
    );
    assert.equal(summary.totalGames, libraryCount);

    const recent = structured(
      await client.callTool({
        name: 'steam_get_recent_games',
        arguments: { offset: 0, limit: 10 },
      }),
    );
    recentCount = recent.counts.total;
  }

  let wishlistCount = null;
  let wishlistStatus = 'available';
  const firstWishlist = await client.callTool({
    name: 'steam_list_wishlist',
    arguments: { includeNames: false, offset: 0, limit: 100 },
  });
  if (firstWishlist.isError) {
    wishlistStatus = 'empty_private_or_unavailable';
    assert.equal(requireWishlist, false, 'Expected an available public wishlist');
    assert.match(JSON.stringify(firstWishlist.content), /STEAM_WISHLIST_UNAVAILABLE/);
  } else {
    wishlistCount = await collectPages('steam_list_wishlist', 'items', {
      includeNames: false,
    });
    if (requireOver50 && wishlistOnly) {
      assert.ok(wishlistCount > 50, 'Expected a wishlist larger than 50 items');
    }
  }

  assert.equal(stderr.includes(process.env.STEAM_WEB_API_KEY), false);
  process.stdout.write(
    `${JSON.stringify({ tools: listed.tools.length, libraryCount, recentCount, wishlistStatus, wishlistCount })}\n`,
  );
} finally {
  await client.close();
}
