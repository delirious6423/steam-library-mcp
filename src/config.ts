import * as z from 'zod/v4';

const INDIVIDUAL_STEAM_ID64_MIN = 76_561_197_960_265_728n;
const INDIVIDUAL_STEAM_ID64_MAX = 76_561_202_255_233_023n;

export function isValidSteamId64(value: string): boolean {
  if (!/^\d{17}$/.test(value)) return false;
  const numericValue = BigInt(value);
  return numericValue >= INDIVIDUAL_STEAM_ID64_MIN && numericValue <= INDIVIDUAL_STEAM_ID64_MAX;
}

const ConfigSchema = z.object({
  STEAM_WEB_API_KEY: z.string().regex(/^[A-Fa-f0-9]{32}$/),
  STEAM_ID64: z.string().refine(isValidSteamId64, 'Invalid individual SteamID64'),
});

export interface SteamConfig {
  apiKey: string;
  steamId64: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): SteamConfig {
  const parsed = ConfigSchema.parse(env);

  return {
    apiKey: parsed.STEAM_WEB_API_KEY,
    steamId64: parsed.STEAM_ID64,
  };
}
