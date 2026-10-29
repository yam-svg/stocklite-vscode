/**
 * "支持作者"打赏面板 —— 移植 JetBrains 版 DonateDialog：Tab 切换微信/支付宝赞赏码，
 * 收款码图片在 webview/settings/donate/{wechat,alipay}.png（真实收款码，随包分发）。
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import type { FeatureDeps } from '../../extension';

let panel: vscode.WebviewPanel | undefined;

export function openDonatePanel(deps: FeatureDeps): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'stocklite.donate', '支持作者', vscode.ViewColumn.Active,
    { enableScripts: true },
  );
  panel.webview.html = html(deps, panel.webview);
  panel.onDidDispose(() => { panel = undefined; });
}

function html(deps: FeatureDeps, webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const srcFor = (name: string): string | null => {
    const p = deps.context.asAbsolutePath(`webview/settings/donate/${name}.png`);
    return existsSync(p) ? webview.asWebviewUri(vscode.Uri.file(p)).toString() : null;
  };
  const wechat = srcFor('wechat');
  const alipay = srcFor('alipay');
  if (!wechat && !alipay) {
    return `<html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px">未找到收款码图片（webview/settings/donate/*.png）</body></html>`;
  }
  const tabBtn = (id: string, label: string, active: boolean) =>
    `<span data-img="${id}" class="tab${active ? ' on' : ''}">${label}</span>`;
  const img = (id: string, src: string | null, label: string, active: boolean) =>
    src
      ? `<img id="${id}" class="qr${active ? '' : ' hidden'}" src="${src}" alt="${label}">`
      : `<div id="${id}" class="hidden">${label}收款码未打包</div>`;
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); display: flex; flex-direction: column;
         align-items: center; gap: 12px; padding: 20px; }
  .tabs { display: flex; gap: 4px; }
  .tab { padding: 4px 18px; cursor: pointer; border: 1px solid var(--vscode-panel-border);
         border-bottom: none; border-radius: 4px 4px 0 0; }
  .tab.on { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
  .qr { max-width: 320px; max-height: 400px; image-rendering: auto;
        border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px;
        background: #fff; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; max-width: 340px; text-align: center; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="tabs">${tabBtn('imgWechat', '微信', !!wechat)}${tabBtn('imgAlipay', '支付宝', !wechat && !!alipay)}</div>
  ${img('imgWechat', wechat, '微信', !!wechat)}${img('imgAlipay', alipay, '支付宝', !wechat && !!alipay)}
  <div class="hint">扫码自愿打赏：你的支持是 StockLite 持续更新的动力 ❤</div>
  <script nonce="${nonce}">
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        var target = t.getAttribute('data-img');
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('on', x === t); });
        document.querySelectorAll('.qr').forEach(function (x) { x.classList.toggle('hidden', x.id !== target); });
      });
    });
  </script>
</body>
</html>`;
}
