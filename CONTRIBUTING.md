# Contributing

Thanks for helping keep Steam Library MCP useful, small, and trustworthy.

## Set up

Requirements: Node.js 20 or newer and npm.

```sh
git clone https://github.com/jamesmgg/steam-library-mcp.git
cd steam-library-mcp
npm ci
npm run check
```

The automated tests use mocked Steam responses and MCP transports. Real Steam credentials should never be needed for development or CI.

## Design constraints

Changes should preserve the project's narrow security model:

- Read-only tools only; no purchases, installs, launches, messages, or account changes.
- Fixed HTTPS Steam API hosts; do not accept arbitrary URLs or hosts from tool input.
- One SteamID64 supplied at startup; do not turn tools into a public account lookup proxy.
- Credentials in environment variables and authenticated headers only—never query strings, source, fixtures, snapshots, logs, or error messages.
- Retrieve the full Steam-returned library or wishlist before local filtering and pagination. A page-size limit must never become an upstream “top N” cap.
- Preserve the ambiguous empty/private/unavailable wishlist error instead of inventing a zero count.
- Keep valid wishlist AppIDs usable if optional catalog name enrichment fails.

If a proposal needs to expand these boundaries, open an issue first and include a threat-model update.

## Make a change

1. Add a failing test that describes the behavior or regression.
2. Implement the smallest change that makes it pass.
3. Run `npm run check`.
4. Review the diff for credentials, personal account data, debug output, and accidental API-surface growth.
5. Update documentation when configuration, behavior, or limitations change.

Keep commits focused and use descriptive imperative messages. Pull requests should explain the user-visible outcome, security/privacy impact, test evidence, and any Steam API assumptions.

## Pull request checklist

- [ ] Tests cover the change and `npm run check` passes.
- [ ] No real key, SteamID, profile response, or personal library data is present.
- [ ] Read-only tool annotations and behavior remain accurate.
- [ ] More than 50 items remain retrievable through local pagination.
- [ ] Errors are stable and sanitized.
- [ ] README, privacy, or security guidance is updated where necessary.

By contributing, you agree that your work is licensed under the repository's [MIT License](LICENSE).
