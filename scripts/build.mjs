import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const outputDirectory = fileURLToPath(new URL('../plugins/hydra/dist', import.meta.url));
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: {
    server: 'plugins/hydra/src/server.ts',
    worker: 'plugins/hydra/src/worker.ts',
  },
  outdir: 'plugins/hydra/dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  legalComments: 'eof',
});
