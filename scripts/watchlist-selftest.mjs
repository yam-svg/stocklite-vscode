import { build } from 'esbuild';

/** S2 自测入口：node scripts/watchlist-selftest.mjs（vscode 依赖用桩替换） */
await build({
  entryPoints: ['scripts/watchlist.selftest.ts'],
  bundle: true,
  outfile: 'out/watchlist-selftest.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  alias: { vscode: './scripts/vscode-stub.mjs' },
  logLevel: 'warning',
});
