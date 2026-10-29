import { build } from 'esbuild';

await build({
  entryPoints: ['scripts/contract.selftest.ts'],
  bundle: true,
  outfile: 'out/selftest.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'warning',
});
