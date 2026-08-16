import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

describe('stdio entry point', () => {
  it('negotiates MCP and lists tools without writing credentials to stderr', async () => {
    const fakeKey = 'C'.repeat(32);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('src/index.ts')],
      cwd: process.cwd(),
      env: {
        STEAM_WEB_API_KEY: fakeKey,
        STEAM_ID64: '76561197960265728',
      },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(4);
      expect(stderr).not.toContain(fakeKey);
    } finally {
      await client.close();
    }
  });

  it.runIf(process.platform === 'win32')(
    'starts through the Windows environment launcher without storing credentials',
    async () => {
      const fakeKey = 'D'.repeat(32);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve('scripts/start-windows.mjs')],
        cwd: process.cwd(),
        env: {
          ...getDefaultEnvironment(),
          STEAM_WEB_API_KEY: fakeKey,
          STEAM_ID64: '76561197960265728',
        },
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const client = new Client({ name: 'windows-launcher-test', version: '1.0.0' });

      try {
        await client.connect(transport);
        await expect(client.listTools()).resolves.toMatchObject({ tools: { length: 4 } });
        expect(stderr).not.toContain(fakeKey);
      } finally {
        await client.close();
      }
    },
  );
});
