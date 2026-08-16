# Security policy

Steam Library MCP is intentionally small and read-only, but it still handles a Steam Web API credential and personal library data. Please report security problems responsibly.

## Supported versions

Only the `main` branch and the most recent release, when one exists, receive security fixes. Pre-1.0 releases may change configuration or tool schemas between minor versions.

## Report a vulnerability

Use the repository's **Security → Report a vulnerability** workflow when it is available. If private vulnerability reporting is unavailable, open a minimal issue asking the maintainer to establish a private channel.

Do not include API keys, Steam account data, exploit details, or proof-of-concept payloads in a public issue. You can expect an acknowledgement when the project is actively maintained, but no response-time guarantee is offered.

Useful reports include:

- The affected version or commit
- The smallest safe reproduction
- Expected and observed behavior
- The security impact and any known mitigations

## Credential handling

The server expects `STEAM_WEB_API_KEY` and `STEAM_ID64` in its process environment. It does not need credentials in command-line arguments, configuration committed to the repository, prompts, or tool inputs.

The optional Windows launcher can copy those variables from the current user's `HKCU\Environment` registry key into its own process environment. It never prints or persists their values.

If a key may have been exposed:

1. Revoke it at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).
2. Create a replacement and update the environment used by your MCP host.
3. Restart the host so the child process receives the new value.
4. Remove the old value from source, logs, or Git history as appropriate. Rotation is still required even after cleanup.

Never use a production publisher key with this server. A normal personal key and `api.steampowered.com` are sufficient.

## Security boundaries

- The server is a local stdio process; it does not open a network listener.
- Its outbound API destinations are fixed Steam HTTPS endpoints.
- Steam account identity is fixed at startup, not accepted from tool calls.
- Operations read library, recent-play, wishlist, and catalog information only.
- In-memory caches disappear when the process exits.

Any MCP client connected to the process can request data for the configured account. Treat the client, its model provider, local process environment, and machine account as part of the trusted computing base.

Out of scope are vulnerabilities in Steam itself, compromised local administrator accounts, or a client/model intentionally redistributing data it was authorized to receive. Reports showing this server leaks credentials, crosses its fixed-host boundary, performs mutations, or exposes data beyond Steam's response are in scope.
