import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** 扩展主进程打包（webview 资产由各 ui 会话经 webview.asWebviewUri 引用，不在此打包） */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await (await import('esbuild')).context(options);
  await ctx.watch();
} else {
  await build(options);
}
