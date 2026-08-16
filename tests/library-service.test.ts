import { describe, expect, it } from 'vitest';

import { createOwnedGamesPage, summarizeLibrary } from '../src/library-service.js';
import type { OwnedGame } from '../src/steam-client.js';

function game(appId: number): OwnedGame {
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

describe('createOwnedGamesPage', () => {
  it('keeps games after the first 50 reachable through local pagination', () => {
    const result = createOwnedGamesPage(
      Array.from({ length: 137 }, (_, index) => game(index + 1)),
      {
        offset: 50,
        limit: 50,
        played: 'any',
        sort: 'name',
      },
    );

    expect(result.counts).toEqual({ total: 137, matched: 137 });
    expect(result.games).toHaveLength(50);
    expect(result.games[0]?.appId).toBe(51);
    expect(result.games.at(-1)?.appId).toBe(100);
    expect(result.page).toEqual({ offset: 50, limit: 50, returned: 50, nextOffset: 100 });
  });

  it('filters names case-insensitively before calculating matched count', () => {
    const result = createOwnedGamesPage([game(1), game(2), game(20)], {
      query: 'GAME 02',
      offset: 0,
      limit: 50,
      played: 'any',
      sort: 'name',
    });

    expect(result.counts).toEqual({ total: 3, matched: 1 });
    expect(result.games.map(({ appId }) => appId)).toEqual([20]);
  });

  it('distinguishes played games from games with zero recorded playtime', () => {
    const neverPlayed = { ...game(2), playtimeMinutes: 0 };
    const result = createOwnedGamesPage([game(1), neverPlayed], {
      offset: 0,
      limit: 50,
      played: 'never_played',
      sort: 'name',
    });

    expect(result.counts).toEqual({ total: 2, matched: 1 });
    expect(result.games.map(({ appId }) => appId)).toEqual([2]);
  });

  it('sorts by playtime descending with AppID as a deterministic tie-breaker', () => {
    const result = createOwnedGamesPage(
      [
        { ...game(3), name: 'Beta', playtimeMinutes: 10 },
        { ...game(2), name: 'Alpha', playtimeMinutes: 30 },
        { ...game(1), name: 'Zulu', playtimeMinutes: 30 },
      ],
      { offset: 0, limit: 50, played: 'any', sort: 'playtime_desc' },
    );

    expect(result.games.map(({ appId }) => appId)).toEqual([1, 2, 3]);
  });

  it('sorts by most recently played with never-played games last', () => {
    const result = createOwnedGamesPage(
      [
        { ...game(1), lastPlayedAt: null },
        { ...game(2), lastPlayedAt: '2024-01-01T00:00:00.000Z' },
        { ...game(3), lastPlayedAt: '2025-01-01T00:00:00.000Z' },
      ],
      { offset: 0, limit: 50, played: 'any', sort: 'last_played_desc' },
    );

    expect(result.games.map(({ appId }) => appId)).toEqual([3, 2, 1]);
  });
});

describe('summarizeLibrary', () => {
  it('calculates played, never-played, total-playtime, and top-game statistics', () => {
    const games = [
      { ...game(1), playtimeMinutes: 120 },
      { ...game(2), playtimeMinutes: 0 },
      { ...game(3), playtimeMinutes: 60 },
    ];

    const result = summarizeLibrary(games, 2);

    expect(result).toEqual({
      totalGames: 3,
      playedGames: 2,
      neverPlayedGames: 1,
      totalPlaytimeMinutes: 180,
      topGames: [games[0], games[2]],
    });
  });
});
