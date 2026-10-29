import { build } from 'esbuild';

/** S1 数据层自测入口：node scripts/data-selftest.mjs && node out/data-selftest.cjs */
await build({
  entryPoints: ['scripts/data.selftest.ts'],
  bundle: true,
  outfile: 'out/data-selftest.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'warning',
});
