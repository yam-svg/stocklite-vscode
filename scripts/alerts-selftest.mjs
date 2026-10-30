import { build } from 'esbuild';

/** S4 自测入口：node scripts/alerts-selftest.mjs（vscode 依赖用桩替换） */
await build({
  entryPoints: ['scripts/alerts-statusbar.selftest.ts'],
  bundle: true,
  outfile: 'out/alerts.selftest.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  alias: { vscode: './scripts/vscode-stub.mjs' },
  logLevel: 'warning',
});
