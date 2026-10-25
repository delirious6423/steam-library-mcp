export interface CacheResult<T> {
  value: T;
  hit: boolean;
  stale: boolean;
  fetchedAt: string;
}

interface CacheEntry<T> {
  value: T;
  fetchedAtMs: number;
}

export interface TtlCacheOptions {
  ttlMs: number;
  maxStaleMs?: number;
  now?: () => number;
  staleIfError?: (error: unknown) => boolean;
  retryDelayMs?: (error: unknown) => number;
}

export class TtlCache<T> {
  readonly #ttlMs: number;
  readonly #maxStaleMs: number;
  readonly #now: () => number;
  readonly #staleIfError: (error: unknown) => boolean;
  readonly #retryDelayMs: (error: unknown) => number;
  #failure: { error: unknown; retryAtMs: number } | undefined;
  #entry: CacheEntry<T> | undefined;
  #inFlight: Promise<CacheResult<T>> | undefined;

  constructor(options: TtlCacheOptions) {
    this.#ttlMs = options.ttlMs;
    this.#maxStaleMs = options.maxStaleMs ?? 0;
    this.#now = options.now ?? Date.now;
    this.#staleIfError = options.staleIfError ?? (() => false);
    this.#retryDelayMs = options.retryDelayMs ?? (() => 0);
  }

  async getOrLoad(loader: () => Promise<T>): Promise<CacheResult<T>> {
    const now = this.#now();
    if (this.#entry && now - this.#entry.fetchedAtMs < this.#ttlMs) {
      return {
        value: this.#entry.value,
        hit: true,
        stale: false,
        fetchedAt: new Date(this.#entry.fetchedAtMs).toISOString(),
      };
    }

    if (this.#failure && now < this.#failure.retryAtMs) {
      return this.#fallback(this.#failure.error);
    }

    if (this.#inFlight) {
      return this.#inFlight;
    }

    this.#inFlight = (async () => {
      try {
        const value = await loader();
        const fetchedAtMs = this.#now();
        this.#entry = { value, fetchedAtMs };
        this.#failure = undefined;
        return {
          value,
          hit: false,
          stale: false,
          fetchedAt: new Date(fetchedAtMs).toISOString(),
        };
      } catch (error) {
        this.#failure = { error, retryAtMs: this.#now() + this.#retryDelayMs(error) };
        // Never resurrect data after an explicit privacy or authentication failure.
        if (!this.#staleIfError(error)) this.#entry = undefined;
        return this.#fallback(error);
      }
    })();
    try {
      return await this.#inFlight;
    } finally {
      this.#inFlight = undefined;
    }
  }

  #fallback(error: unknown): CacheResult<T> {
    if (
      this.#entry &&
      this.#now() - this.#entry.fetchedAtMs <= this.#maxStaleMs &&
      this.#staleIfError(error)
    ) {
      return {
        value: this.#entry.value,
        hit: true,
        stale: true,
        fetchedAt: new Date(this.#entry.fetchedAtMs).toISOString(),
      };
    }
    throw error;
  }
}
