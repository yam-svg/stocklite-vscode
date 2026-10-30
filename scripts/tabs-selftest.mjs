import { build } from 'esbuild';

/** S6 自测入口：node scripts/tabs-selftest.mjs（vscode 依赖用桩替换） */
await build({
  entryPoints: ['scripts/tabs.selftest.ts'],
  bundle: true,
  outfile: 'out/tabs-selftest.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  alias: { vscode: './scripts/vscode-stub.mjs' },
  logLevel: 'warning',
});
