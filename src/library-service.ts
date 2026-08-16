import type { OwnedGame } from './steam-client.js';

export interface OwnedGamesPageInput {
  query?: string;
  offset: number;
  limit: number;
  played: 'any' | 'played' | 'never_played';
  sort: 'name' | 'playtime_desc' | 'last_played_desc';
}

export interface OwnedGamesPage {
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
  games: OwnedGame[];
}

export function createOwnedGamesPage(
  games: readonly OwnedGame[],
  input: OwnedGamesPageInput,
): OwnedGamesPage {
  const query = input.query?.trim().toLocaleLowerCase();
  let filtered = query
    ? games.filter((game) => game.name.toLocaleLowerCase().includes(query))
    : [...games];
  if (input.played === 'played') {
    filtered = filtered.filter((game) => game.playtimeMinutes > 0);
  } else if (input.played === 'never_played') {
    filtered = filtered.filter((game) => game.playtimeMinutes === 0);
  }
  const sorted = [...filtered].sort((left, right) => {
    if (input.sort === 'playtime_desc') {
      return right.playtimeMinutes - left.playtimeMinutes || left.appId - right.appId;
    }
    if (input.sort === 'last_played_desc') {
      const leftTime = left.lastPlayedAt ? Date.parse(left.lastPlayedAt) : 0;
      const rightTime = right.lastPlayedAt ? Date.parse(right.lastPlayedAt) : 0;
      return rightTime - leftTime || left.appId - right.appId;
    }
    return left.name.localeCompare(right.name) || left.appId - right.appId;
  });
  const pageGames = sorted.slice(input.offset, input.offset + input.limit);
  const nextOffset =
    input.offset + pageGames.length < sorted.length ? input.offset + pageGames.length : null;

  return {
    counts: { total: games.length, matched: sorted.length },
    page: {
      offset: input.offset,
      limit: input.limit,
      returned: pageGames.length,
      nextOffset,
    },
    games: pageGames,
  };
}

export function summarizeLibrary(games: readonly OwnedGame[], topN: number) {
  const playedGames = games.filter((game) => game.playtimeMinutes > 0).length;
  const totalPlaytimeMinutes = games.reduce((total, game) => total + game.playtimeMinutes, 0);
  const topGames = [...games]
    .sort((left, right) => right.playtimeMinutes - left.playtimeMinutes || left.appId - right.appId)
    .slice(0, topN);

  return {
    totalGames: games.length,
    playedGames,
    neverPlayedGames: games.length - playedGames,
    totalPlaytimeMinutes,
    topGames,
  };
}
