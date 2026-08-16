import { describe, expect, it } from 'vitest';

import { TtlCache } from '../src/cache.js';
import { SteamApiError } from '../src/errors.js';

describe('TtlCache', () => {
  it('returns a fresh cached value without calling the loader twice', async () => {
    let loads = 0;
    const cache = new TtlCache<number>({ ttlMs: 60_000, now: () => 1_000 });
    const loader = async () => ++loads;

    const first = await cache.getOrLoad(loader);
    const second = await cache.getOrLoad(loader);

    expect(first).toMatchObject({ value: 1, hit: false, stale: false });
    expect(second).toMatchObject({ value: 1, hit: true, stale: false });
    expect(loads).toBe(1);
  });

  it('coalesces concurrent cache misses into one upstream load', async () => {
    let loads = 0;
    let release!: (value: number) => void;
    const pending = new Promise<number>((resolve) => {
      release = resolve;
    });
    const cache = new TtlCache<number>({ ttlMs: 60_000 });
    const loader = async () => {
      loads += 1;
      return pending;
    };

    const first = cache.getOrLoad(loader);
    const second = cache.getOrLoad(loader);
    release(42);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ value: 42 }),
      expect.objectContaining({ value: 42 }),
    ]);
    expect(loads).toBe(1);
  });

  it('serves bounded stale data when a transient refresh fails', async () => {
    let now = 0;
    const cache = new TtlCache<number>({
      ttlMs: 60_000,
      maxStaleMs: 3_600_000,
      now: () => now,
      staleIfError: (error) => error instanceof SteamApiError && error.retryable,
    });
    await cache.getOrLoad(async () => 7);
    now = 61_000;

    const result = await cache.getOrLoad(async () => {
      throw new SteamApiError('STEAM_UPSTREAM_UNAVAILABLE', 'temporary outage', true);
    });

    expect(result).toMatchObject({ value: 7, hit: true, stale: true });
  });

  it('does not serve stale data for a non-retryable failure', async () => {
    let now = 0;
    const cache = new TtlCache<number>({
      ttlMs: 1_000,
      maxStaleMs: 10_000,
      now: () => now,
      staleIfError: (error) => error instanceof SteamApiError && error.retryable,
    });
    await cache.getOrLoad(async () => 7);
    now = 2_000;

    await expect(
      cache.getOrLoad(async () => {
        throw new SteamApiError('STEAM_AUTH_FAILED', 'permanent failure', false);
      }),
    ).rejects.toMatchObject({ code: 'STEAM_AUTH_FAILED' });
  });
});
