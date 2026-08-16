import type { WishlistItem } from './steam-client.js';

export interface WishlistPageInput {
  query?: string;
  offset: number;
  limit: number;
  sort: 'priority' | 'date_added_desc';
}

export interface EnrichedWishlistItem extends WishlistItem {
  name: string | null;
}

export interface WishlistPage {
  counts: {
    total: number;
    matched: number;
  };
  page: {
    offset: number;
    limit: number;
    returned: number;
    nextOffset: number | null;
  };
  items: EnrichedWishlistItem[];
}

export function createWishlistPage(
  items: readonly WishlistItem[],
  catalog: ReadonlyMap<number, string>,
  input: WishlistPageInput,
): WishlistPage {
  const enriched = items.map((item) => ({
    ...item,
    name: catalog.get(item.appId) ?? null,
  }));
  const query = input.query?.trim().toLocaleLowerCase();
  const filtered = query
    ? enriched.filter(
        (item) =>
          item.name?.toLocaleLowerCase().includes(query) || String(item.appId).includes(query),
      )
    : enriched;
  const sorted = [...filtered].sort((left, right) => {
    if (input.sort === 'date_added_desc') {
      const leftTime = left.dateAddedAt ? Date.parse(left.dateAddedAt) : 0;
      const rightTime = right.dateAddedAt ? Date.parse(right.dateAddedAt) : 0;
      return rightTime - leftTime || left.appId - right.appId;
    }
    return left.priority - right.priority || left.appId - right.appId;
  });
  const pageItems = sorted.slice(input.offset, input.offset + input.limit);
  const nextOffset =
    input.offset + pageItems.length < sorted.length ? input.offset + pageItems.length : null;

  return {
    counts: { total: items.length, matched: sorted.length },
    page: {
      offset: input.offset,
      limit: input.limit,
      returned: pageItems.length,
      nextOffset,
    },
    items: pageItems,
  };
}
