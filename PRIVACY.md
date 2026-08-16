# Privacy

Steam Library MCP is local software, not a hosted service. It has no analytics, telemetry, database, advertising identifier, or inbound HTTP server.

## Data flow

When a connected MCP client invokes a tool, the process may send:

| Data                       | Destination                                      | Purpose                                                                                   |
| -------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| SteamID64                  | `https://api.steampowered.com`                   | Read the configured account's library, recent games, or wishlist.                         |
| Steam Web API key          | `https://api.steampowered.com` in an HTTP header | Authenticate APIs that require a normal user key. Wishlist retrieval itself is anonymous. |
| Catalog continuation state | `https://api.steampowered.com`                   | Resolve best-effort app names for wishlist entries.                                       |

Steam's handling of those requests is governed by Valve's terms and privacy policies.

Results return over stdio to the MCP client that launched the server. That client—and any model provider it sends tool results to—can see the returned game names, playtime, recent activity, and wishlist data. Review the client's data controls before connecting it.

## Local handling

- Credentials come from `STEAM_WEB_API_KEY` and `STEAM_ID64` environment variables.
- The optional Windows launcher reads those values from the current user's `HKCU\Environment` registry key when its process environment does not contain them.
- Credentials are not tool parameters and are not included in request URLs.
- The server does not intentionally log credentials or raw Steam response bodies.
- Short-lived caches exist only in process memory and are cleared on exit.
- No Steam response is written to disk by this project.

Your operating system, shell, MCP host, crash reporter, or model provider may have its own logging and retention behavior. Prefer an OS credential/environment manager, avoid putting keys on command lines, and do not paste secrets into prompts.

## Visibility and accuracy

The server can only return what Steam exposes to the configured account and API key. It does not bypass profile privacy settings. “All games” means all entries in Steam's `GetOwnedGames` response, not necessarily every license, DLC, tool, or family-shared entitlement visible elsewhere in Steam.

Wishlist access is experimental. Steam's observed empty response does not distinguish an empty wishlist from a private or unavailable wishlist, so the server reports that ambiguity rather than asserting that no data exists.

## Removing access

Stop the MCP process and remove its configuration to end local access. Revoke the key at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) to invalidate the credential, then remove the environment variables from the operating system and restart the MCP host.
