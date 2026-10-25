import { describe, expect, it, vi } from 'vitest';

import { TtlCache } from '../src/cache.js';
import { SteamApiError } from '../src/errors.js';

describe('TtlCache', () => {
  it('honors the retry cooldown across sequential and concurrent calls, then recovers', async () => {
    let now = 0;
    const cache = new TtlCache<number>({
      ttlMs: 1_000,
      maxStaleMs: 60_000,
      now: () => now,
      staleIfError: (error) => error instanceof SteamApiError && error.retryable,
      retryDelayMs: () => 10_000,
    });
    const loader = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(7)
      .mockRejectedValueOnce(new SteamApiError('STEAM_RATE_LIMITED', 'rate limited', true, 10))
      .mockResolvedValue(8);
    await cache.getOrLoad(loader);
    now = 1_001;
    await expect(cache.getOrLoad(loader)).resolves.toMatchObject({ value: 7, stale: true });
    now = 11_000;
    const results = await Promise.all([cache.getOrLoad(loader), cache.getOrLoad(loader)]);
    expect(
      results.every((result) => result.stale && result.fetchedAt === new Date(0).toISOString()),
    ).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
    now = 11_001;
    await expect(cache.getOrLoad(loader)).resolves.toMatchObject({ value: 8, stale: false });
    expect(loader).toHaveBeenCalledTimes(3);
    await cache.getOrLoad(loader);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('rethrows during cooldown without a cached value or another request', async () => {
    const error = new SteamApiError('STEAM_RATE_LIMITED', 'rate limited', true, 10);
    const loader = vi.fn<() => Promise<number>>().mockRejectedValue(error);
    const cache = new TtlCache<number>({ ttlMs: 1_000, now: () => 0, retryDelayMs: () => 10_000 });
    await expect(cache.getOrLoad(loader)).rejects.toBe(error);
    await expect(cache.getOrLoad(loader)).rejects.toBe(error);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not extend the stale-data lifetime during a retry cooldown', async () => {
    let now = 0;
    const error = new SteamApiError('STEAM_RATE_LIMITED', 'rate limited', true, 10);
    const cache = new TtlCache<number>({
      ttlMs: 1_000,
      maxStaleMs: 2_000,
      now: () => now,
      staleIfError: () => true,
      retryDelayMs: () => 10_000,
    });
    const loader = vi.fn<() => Promise<number>>().mockResolvedValueOnce(7).mockRejectedValue(error);
    await cache.getOrLoad(loader);
    now = 1_001;
    await expect(cache.getOrLoad(loader)).resolves.toMatchObject({ stale: true });
    now = 2_001;
    await expect(cache.getOrLoad(loader)).rejects.toBe(error);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect cached data after a permanent failure followed by an outage', async () => {
    let now = 0;
    const cache = new TtlCache<number>({
      ttlMs: 1_000,
      maxStaleMs: 60_000,
      now: () => now,
      staleIfError: (error) => error instanceof SteamApiError && error.retryable,
    });
    await cache.getOrLoad(async () => 7);
    now = 1_001;
    await expect(
      cache.getOrLoad(async () => {
        throw new SteamApiError('STEAM_PROFILE_PRIVATE_OR_UNAVAILABLE', 'private', false);
      }),
    ).rejects.toMatchObject({ code: 'STEAM_PROFILE_PRIVATE_OR_UNAVAILABLE' });
    await expect(
      cache.getOrLoad(async () => {
        throw new SteamApiError('STEAM_UPSTREAM_UNAVAILABLE', 'outage', true);
      }),
    ).rejects.toMatchObject({ code: 'STEAM_UPSTREAM_UNAVAILABLE' });
  });

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
