#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createSteamLibraryServer } from './server.js';

serveStdio(() => createSteamLibraryServer(), {
  onerror: () => {
    process.stderr.write('[steam-library-mcp] MCP transport error.\n');
  },
});
