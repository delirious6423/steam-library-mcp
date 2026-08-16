#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

import { isValidSteamId64 } from '../dist/config.js';

function readUserEnvironment(name) {
  if (process.platform !== 'win32') return undefined;
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = output.match(
      new RegExp(`^\\s*${escapedName}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, 'm'),
    );
    return match?.[1];
  } catch {
    return undefined;
  }
}

process.env.STEAM_WEB_API_KEY ||= readUserEnvironment('STEAM_WEB_API_KEY');
process.env.STEAM_ID64 ||= readUserEnvironment('STEAM_ID64');

if (
  !/^[A-Fa-f0-9]{32}$/.test(process.env.STEAM_WEB_API_KEY ?? '') ||
  !isValidSteamId64(process.env.STEAM_ID64 ?? '')
) {
  process.stderr.write('[steam-library-mcp] Missing or invalid Steam environment configuration.\n');
  process.exit(1);
}

await import('../dist/index.js');
