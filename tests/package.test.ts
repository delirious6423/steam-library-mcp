import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('npm package metadata', () => {
  it('ships every local document linked from the packaged README', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      files: string[];
    };

    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        'README.md',
        'LICENSE',
        'SECURITY.md',
        'PRIVACY.md',
        'CONTRIBUTING.md',
      ]),
    );
  });

  it('builds before tests that exercise the packaged Windows launcher', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: { check: string };
    };

    expect(packageJson.scripts.check.indexOf('npm run build')).toBeLessThan(
      packageJson.scripts.check.indexOf('npm test'),
    );
  });

  it('runs CI on Windows as well as Linux', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('ubuntu-latest');
    expect(workflow).toContain('windows-latest');
  });

  it('does not echo invalid credentials from the live smoke script', () => {
    const invalidCredential = 'mistyped-private-value';
    const result = spawnSync(process.execPath, ['scripts/live-smoke.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        STEAM_WEB_API_KEY: invalidCredential,
        STEAM_ID64: 'invalid-steam-id',
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(invalidCredential);
  });
});
