import { describe, expect, it } from 'vitest';

import type { WishlistItem } from '../src/steam-client.js';
import { createWishlistPage } from '../src/wishlist-service.js';

function wishlistItem(index: number): WishlistItem {
  const appId = 10_000 + index;
  return {
    appId,
    priority: index,
    dateAddedAt: new Date((1_700_000_000 + index) * 1_000).toISOString(),
    storeUrl: `https://store.steampowered.com/app/${appId}/`,
  };
}

describe('createWishlistPage', () => {
  it('keeps every wishlist entry beyond the first 50 reachable and enriches names', () => {
    const items = Array.from({ length: 137 }, (_, index) => wishlistItem(index));
    const catalog = new Map(items.map((item) => [item.appId, `Wish ${item.appId}`]));

    const result = createWishlistPage(items, catalog, {
      offset: 50,
      limit: 50,
      sort: 'priority',
    });

    expect(result.counts).toEqual({ total: 137, matched: 137 });
    expect(result.items).toHaveLength(50);
    expect(result.items[0]).toMatchObject({ appId: 10_050, name: 'Wish 10050' });
    expect(result.items.at(-1)?.appId).toBe(10_099);
    expect(result.page).toEqual({ offset: 50, limit: 50, returned: 50, nextOffset: 100 });
  });

  it('searches the fully enriched wishlist without hiding unmatched totals', () => {
    const items = [wishlistItem(1), wishlistItem(2), wishlistItem(3)];
    const catalog = new Map([
      [items[0]!.appId, 'Portal'],
      [items[1]!.appId, 'Half-Life'],
      [items[2]!.appId, 'Portal 2'],
    ]);

    const result = createWishlistPage(items, catalog, {
      query: 'PORTAL',
      offset: 0,
      limit: 50,
      sort: 'priority',
    });

    expect(result.counts).toEqual({ total: 3, matched: 2 });
    expect(result.items.map(({ name }) => name)).toEqual(['Portal', 'Portal 2']);
  });

  it('sorts newest wishlist additions first when requested', () => {
    const items = [wishlistItem(1), wishlistItem(2), wishlistItem(3)];

    const result = createWishlistPage(items, new Map(), {
      offset: 0,
      limit: 50,
      sort: 'date_added_desc',
    });

    expect(result.items.map(({ appId }) => appId)).toEqual([10_003, 10_002, 10_001]);
  });
});
