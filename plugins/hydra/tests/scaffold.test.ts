import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(root, path), 'utf8')) as unknown;
}

describe('Hydra plugin scaffold', () => {
  test('declares strict ESM compilation', async () => {
    const packageJson = await readJson('package.json');
    const tsconfig = await readJson('tsconfig.json');

    expect(packageJson).toMatchObject({ type: 'module' });
    expect(tsconfig).toMatchObject({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
      },
    });
  });

  test('build script produces both runtime entry points', async () => {
    const packageJson = await readJson('package.json');

    expect(packageJson).toMatchObject({
      scripts: {
        build: 'node scripts/build.mjs',
      },
    });
  });

  test('manifest exposes the MCP companion file', async () => {
    const pluginJson = await readJson('plugins/hydra/.codex-plugin/plugin.json');

    expect(pluginJson).toMatchObject({
      name: 'hydra',
      mcpServers: './.mcp.json',
    });
  });

  test('MCP configuration launches the bundled server from the plugin root', async () => {
    const mcpJson = await readJson('plugins/hydra/.mcp.json');

    expect(mcpJson).toEqual({
      mcpServers: {
        hydra: {
          command: 'node',
          args: ['./dist/server.js'],
          cwd: '.',
        },
      },
    });
  });
});
