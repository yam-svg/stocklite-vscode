/**
 * 占位视图/面板工厂（S0 产出）：S2/S3/S5/S6 实现真实 UI 后，删除对相应 placeholder 的调用即可。
 * 自带 CSP + 随机 nonce，后续会话写真实 webview 时照此模板。
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { FeatureDeps } from '../extension';

export function placeholderHtml(title: string, note: string, cspSource: string): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         display: flex; flex-direction: column; align-items: center; justify-content: center;
         height: 92vh; gap: 8px; text-align: center; }
  .title { font-size: 15px; font-weight: 600; }
  .note { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 8px;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
</style>
</head>
<body>
  <div class="title">${title}</div>
  <div class="note">${note}</div>
  <div class="badge">占位视图</div>
</body>
</html>`;
}

/** 注册一个占位 WebviewView，S2/S6 接管同名 viewId 时移除本调用 */
export function registerPlaceholderView(deps: FeatureDeps, viewId: string, title: string, note: string): void {
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView: vscode.WebviewView): void {
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = placeholderHtml(title, note, webviewView.webview.cspSource);
    },
  };
  deps.context.subscriptions.push(vscode.window.registerWebviewViewProvider(viewId, provider, {
    webviewOptions: { retainContextWhenHidden: true },
  }));
}

/** 打开一个占位 WebviewPanel（图表/设置等），返回已注册的命令即可 */
export function openPlaceholderPanel(deps: FeatureDeps, viewType: string, title: string, note: string): void {
  const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, {
    enableScripts: true,
  });
  panel.webview.html = placeholderHtml(title, note, panel.webview.cspSource);
}

/** 提示“由会话 X 实现”的占位命令 */
export function registerStubCommand(deps: FeatureDeps, id: string, owner: string): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand(id, async () => {
      await vscode.window.showInformationMessage(`StockLite: 该功能由后续会话 ${owner} 实现`);
    }),
  );
}
