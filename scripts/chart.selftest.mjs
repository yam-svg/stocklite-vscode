/**
 * S3 自测驱动：① esbuild 打包 chart.selftest.ts 并 node 直跑；
 * ② webview 资产存在性 + JS 语法门禁（esbuild transform 即编译期检查）；
 * ③ npm run compile（tsc --noEmit）覆盖 src/ui/chart 的宿主侧。
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const assets = [
  'webview/chart/assets/klinecharts.min.js',
  'webview/chart/chart.js',
  'webview/chart/chart.css',
  'webview/chart/pnl.js',
  'webview/chart/pnl.css',
];
for (const a of assets) {
  if (!existsSync(a)) {
    console.error(`✗ 缺少 webview 资产: ${a}`);
    process.exit(1);
  }
}

await build({
  entryPoints: ['scripts/chart.selftest.ts'],
  bundle: true,
  outfile: 'out/chart.selftest.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'warning',
});

// webview JS 语法门禁（不打包依赖，只做解析/转译检查）
for (const f of ['webview/chart/chart.js', 'webview/chart/pnl.js']) {
  await build({ entryPoints: [f], bundle: false, outfile: 'out/webview-syntax-check.cjs', format: 'cjs', logLevel: 'silent' });
}

const r = spawnSync(process.execPath, ['out/chart.selftest.cjs'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
