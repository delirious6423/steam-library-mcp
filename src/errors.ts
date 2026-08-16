export type SteamErrorCode =
  | 'STEAM_AUTH_FAILED'
  | 'STEAM_PROFILE_PRIVATE_OR_UNAVAILABLE'
  | 'STEAM_WISHLIST_UNAVAILABLE'
  | 'STEAM_RATE_LIMITED'
  | 'STEAM_UPSTREAM_UNAVAILABLE'
  | 'STEAM_RESPONSE_TOO_LARGE'
  | 'STEAM_BAD_RESPONSE';

export class SteamApiError extends Error {
  readonly code: SteamErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    code: SteamErrorCode,
    message: string,
    retryable: boolean,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SteamApiError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
