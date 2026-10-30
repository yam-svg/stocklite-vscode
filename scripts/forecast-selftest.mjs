import { build } from 'esbuild';

/** G2 研判自测入口：node scripts/forecast-selftest.mjs（vscode 依赖用桩替换） */
await build({
  entryPoints: ['scripts/forecast.selftest.ts'],
  bundle: true,
  outfile: 'out/forecast-selftest.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  alias: { vscode: './scripts/vscode-stub.mjs' },
  logLevel: 'warning',
});
