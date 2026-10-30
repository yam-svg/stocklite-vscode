import { build } from 'esbuild';

/** S5 自测入口：node scripts/settings-selftest.mjs（vscode 依赖用桩替换） */
await build({
  entryPoints: ['scripts/settings.selftest.ts'],
  bundle: true,
  outfile: 'out/settings.selftest.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  alias: { vscode: './scripts/vscode-stub.mjs' },
  logLevel: 'warning',
});
