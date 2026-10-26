# Steam Library MCP

> Every Steam game your profile exposes—not just a “top 50.”

[![CI](https://github.com/jamesmgg/steam-library-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesmgg/steam-library-mcp/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Steam Library MCP is a small, read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for exploring one Steam account's owned games, playtime, recently played games, and wishlist. It runs locally over stdio, keeps credentials out of tool arguments, and exposes four focused tools instead of a general-purpose Steam API proxy.

## Why this server

- **The complete Steam-returned library.** It fetches the entire `GetOwnedGames` result before applying search, sorting, or MCP response pagination. A response page may be small; the upstream fetch is not capped at 50.
- **A useful wishlist.** Wishlist entries include priority and added date, with best-effort game-name enrichment from Steam's catalog.
- **Model-friendly answers.** Structured output includes counts and page metadata so a client can continue through every result.
- **A deliberately narrow trust boundary.** One account, fixed HTTPS Steam endpoints, read-only operations, no arbitrary URLs, and no account-changing tools.
- **Local and ephemeral.** The server has no database, telemetry, or HTTP listener. Caches live only in process memory.

“Complete” means every game returned by Steam's Web API for the configured account. Steam privacy settings and Steam's own entitlement rules still apply; this is not a replacement for the Steam client's license ledger and may not include DLC, tools, or every family-shared entitlement.

## Tools

| Tool                      | What it provides                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `steam_list_owned_games`  | Searchable, sortable, locally paginated owned games with playtime and last-played details. |
| `steam_summarize_library` | Library totals, played/unplayed counts, playtime, and top-played games.                    |
| `steam_get_recent_games`  | Locally paginated recent games from the complete `GetRecentlyPlayedGames` result.          |
| `steam_list_wishlist`     | Searchable, locally paginated wishlist entries with optional best-effort names.            |

For collection tools, use `offset` and `limit` to traverse the results. Page size only bounds the MCP response—it does not reduce the collection fetched from Steam.

## Requirements

- Node.js 20 or newer
- A 17-digit SteamID64
- A Steam Web API key from [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey)
- A Steam profile whose **Game details** privacy setting permits the data you want to read

### What domain should I use for a personal key?

For a local, personal MCP server, `localhost` is a suitable value in Steam's **Domain Name** field. The registration field describes the site or use associated with the key; it is not a browser-origin or runtime hostname allowlist. This server still makes its API requests from Node.js to `https://api.steampowered.com`.

Normal user Web API keys belong on `api.steampowered.com`, not the publisher-only partner host.

## Install from source

```sh
git clone https://github.com/jamesmgg/steam-library-mcp.git
cd steam-library-mcp
npm ci
npm run build
```

Set these values in the environment that launches your MCP client:

| Variable            | Value                                              |
| ------------------- | -------------------------------------------------- |
| `STEAM_WEB_API_KEY` | Your 32-character Steam Web API key                |
| `STEAM_ID64`        | The fixed 17-digit account ID this server may read |

Prefer your operating system's environment-variable UI or a secret manager so the key does not enter shell history. Restart desktop MCP clients after adding user-level environment variables. Do not put the key in this repository, an MCP configuration file, a prompt, or an issue.

## Configure Codex

Add the server to `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`) and use an absolute path:

```toml
[mcp_servers.steam-library]
command = "node"
args = ["C:\\absolute\\path\\to\\steam-library-mcp\\dist\\index.js"]
env_vars = ["STEAM_WEB_API_KEY", "STEAM_ID64"]
```

`env_vars` forwards the already-set variables by name; their values stay out of the Codex configuration. Restart Codex, then ask it to list the server's tools or try:

- “Summarize my Steam library and show my ten most-played games.”
- “Find every unplayed game with ‘space’ in its name.”
- “Walk through my entire library, one page at a time.”
- “Which games were added to my wishlist most recently?”

On Windows, this repository also includes a secret-free launcher that reads the same two user-level environment variables from `HKCU\Environment` when the MCP host does not forward them. After building, register it with an absolute path:

```powershell
codex mcp add steam-library -- node C:\absolute\path\to\steam-library-mcp\scripts\start-windows.mjs
```

The command saved by Codex contains paths and variable names only—not either value.

## Configure another MCP client

Most stdio MCP clients accept this shape or a close equivalent:

```json
{
  "mcpServers": {
    "steam-library": {
      "command": "node",
      "args": ["/absolute/path/to/steam-library-mcp/dist/index.js"]
    }
  }
}
```

Launch the client from an environment containing `STEAM_WEB_API_KEY` and `STEAM_ID64`, or use that client's secret manager/environment-forwarding feature. Configuration formats differ; never fall back to committing credentials or placing them in tool arguments.

## Wishlist status and limitations

Wishlist access uses `IWishlistService/GetWishlist`, an endpoint advertised by Steam's live API service list but not fully documented in Steam's static Web API reference. Treat it as experimental and subject to change.

Steam currently returns the whole wishlist in one response, so this server fetches that response before paginating locally. An empty response is ambiguous: it can mean an empty wishlist, a private wishlist, or an unavailable endpoint. The server reports `STEAM_WISHLIST_UNAVAILABLE` instead of inventing a zero count. Name enrichment is best-effort and does not discard valid wishlist entries when catalog data is unavailable.

For available wishlists, the server independently checks `GetWishlistItemCount` and rejects a mismatch rather than presenting a truncated list as complete.

Wishlist results include `search.complete` and `search.missingNameCount`. When a query is supplied and names are missing (including when `includeNames` is false), the matched count is only a lower bound: zero known matches does not prove the game is absent. A warning explains the limitation. List without a query to retrieve every AppID, even when names are unavailable.

Catalog enrichment has a 30-second overall deadline and limits of 64 MiB total response bytes and 1,000,000 received app entries across all pages. Hitting a limit leaves raw wishlist AppIDs usable without names. Non-retryable catalog failures, including size-limit failures, pause name-enrichment retries for one hour instead of repeating the same failed download on every call.

Temporary upstream failures use a five-second retry cooldown; rate-limit responses honor Steam's `Retry-After` delay (integer seconds or an HTTP date, bounded to one second through one hour). Eligible stale data remains available during the cooldown without extending its original maximum age. Non-retryable failures invalidate the cached data, including authentication, privacy, malformed-response and size-limit failures. Errors returned during a retry cooldown report the remaining delay, not Steam's original delay.

## Security and privacy

- Tools cannot select another SteamID or proxy arbitrary requests.
- The API key is read from the environment and sent in an HTTP header, never in a request URL.
- Redirects are rejected so credentials cannot be forwarded to another host.
- The server writes MCP protocol messages to stdout and does not log credentials or Steam response bodies.
- All operations are read-only. There are no purchase, install, launch, social, or account-mutation tools.

Your MCP host and the model using it can see tool results. Review their privacy terms and only connect clients you trust. See [PRIVACY.md](PRIVACY.md) for the data flow and [SECURITY.md](SECURITY.md) for reporting and key-rotation guidance.

## Troubleshooting

- **Authentication failure:** confirm the key is active and belongs to the expected Steam account. Rotate it if it has ever appeared in chat, logs, or source control.
- **Library unavailable:** make the profile's **Game details** visible and retry. A key does not bypass privacy settings.
- **Wishlist unavailable:** Steam does not distinguish empty, private, and unavailable in the observed empty response; check wishlist visibility directly on Steam.
- **Only one page is visible:** request the next `offset`. Pagination is local and all Steam-returned items remain reachable.
- **Environment changes are ignored:** fully restart the MCP host so its child process inherits the updated variables.

## Development

```sh
npm ci
npm run check
```

Tests use mocked transports and Steam responses; they do not require real credentials. Contributions are welcome—start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
