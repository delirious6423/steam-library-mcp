import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('accepts an API key and preserves SteamID64 as an exact string', () => {
    const config = loadConfig({
      STEAM_WEB_API_KEY: 'A'.repeat(32),
      STEAM_ID64: '76561197960265728',
    });

    expect(config).toEqual({
      apiKey: 'A'.repeat(32),
      steamId64: '76561197960265728',
    });
    expect(typeof config.steamId64).toBe('string');
  });

  it('accepts the full upper range of individual SteamID64 values', () => {
    expect(
      loadConfig({
        STEAM_WEB_API_KEY: 'A'.repeat(32),
        STEAM_ID64: '76561202255233023',
      }).steamId64,
    ).toBe('76561202255233023');
  });

  it('rejects 17-digit values outside the individual SteamID64 range', () => {
    expect(() =>
      loadConfig({
        STEAM_WEB_API_KEY: 'A'.repeat(32),
        STEAM_ID64: '76561197960265727',
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        STEAM_WEB_API_KEY: 'A'.repeat(32),
        STEAM_ID64: '76561202255233024',
      }),
    ).toThrow();
  });
});
