/**
 * 新手指引 —— 移植 JetBrains 版 OnboardingDialog：
 * 把藏在右键菜单、列点击、默认关闭开关后面的功能做成可点击清单，"去看看"直达对应页面。
 * 入口：命令面板「StockLite: 新手指引」/ 设置页按钮；首启（onboarded 键未写入）自动弹一次通知引导。
 * 注意首启判据是 onboarded 键是否写入过，不能用"数据为空"（示例播种也会写数据）。
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { FeatureDeps } from '../../extension';
import { StateKeys } from '../../shared/config';

interface Tip {
  title: string;
  detail: string;
  button?: string;
  command?: string;
}

const TIPS: Tip[] = [
  { title: 'K 线 / 分时图', detail: '股票行右键「查看K线/分时」，K 线上自动标注 B/S 买卖点。', button: '去股票页试试', command: 'stocklite.stock.focus' },
  { title: '交易记录与持仓盈亏', detail: '右键股票行：录入交易记录、查看历史；持仓列显示成本/今日盈亏。', button: '去股票页试试', command: 'stocklite.stock.focus' },
  { title: '到价提醒', detail: '右键股票行「设置提醒」，触发时 VSCode 弹通知。', button: '去股票页试试', command: 'stocklite.stock.focus' },
  { title: '排序', detail: '点列头三态排序；表格内拖拽行调整顺序。', button: '去股票页试试', command: 'stocklite.stock.focus' },
  { title: '场外基金净值', detail: '基金页显示净值与估值走势，净值更新自动通知。', button: '去基金页试试', command: 'stocklite.fund.focus' },
  { title: '底部状态栏', detail: '状态栏常驻行情轮播与持仓盈亏，点击弹出快捷操作。', button: '打开设置', command: 'stocklite.openSettings' },
  { title: '功能开关', detail: '设置里可开关基金/期货/全球/板块/新股/美股/加密币标签页，选择要显示的全球指数。', button: '打开设置', command: 'stocklite.openSettings' },
  { title: '数据导入导出', detail: '设置页一键导出/导入全部数据（换机备份），兼容 JetBrains 版 StockLite 备份文件。', button: '打开设置', command: 'stocklite.openSettings' },
  { title: '全部命令', detail: '按 Ctrl+Shift+P 搜索「StockLite」，可见全部功能命令。' },
];

/** 指引按钮允许执行的命令白名单（webview 消息不可信，逐个校验） */
const ALLOWED_COMMANDS = new Set([
  'stocklite.stock.focus', 'stocklite.fund.focus', 'stocklite.openSettings',
  'stocklite.donate', 'stocklite.exportConfig', 'stocklite.importConfig',
]);

let panel: vscode.WebviewPanel | undefined;

export function openOnboardingPanel(deps: FeatureDeps): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'stocklite.onboarding', 'StockLite 新手指引', vscode.ViewColumn.Active,
    { enableScripts: true },
  );
  panel.webview.html = html(panel.webview);
  panel.webview.onDidReceiveMessage(async (msg) => {
    const command = String((msg as { command?: unknown }).command ?? '');
    if (!ALLOWED_COMMANDS.has(command)) return;
    panel?.dispose();
    // 先关面板再跳目标视图，与 JetBrains 版"关闭后跳转"的时序一致
    setTimeout(() => void vscode.commands.executeCommand(command), 80);
  });
  panel.onDidDispose(() => { panel = undefined; });
}

/** 首启一次：弹通知引导打开指引（判据 = onboarded 键从未写入） */
export function maybeShowFirstRunHint(deps: FeatureDeps): void {
  if (deps.config.get<boolean>(StateKeys.onboarded, false)) return;
  void deps.context.globalState.update(StateKeys.onboarded, true);
  setTimeout(() => {
    void vscode.window
      .showInformationMessage('StockLite 已就绪：内置示例行情，点「新手指引」照着点几条即可上手。', '新手指引')
      .then((pick) => {
        if (pick) openOnboardingPanel(deps);
      });
  }, 2500);
}

function html(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const rows = TIPS.map((t) => `
    <div class="row">
      <div class="txt"><b>${t.title}</b><div class="detail">${t.detail}</div></div>
      ${t.button && t.command ? `<button data-cmd="${t.command}">${t.button}</button>` : ''}
    </div>`).join('');
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 18px 24px; }
  .wrap { max-width: 640px; }
  h1 { font-size: 17px; margin: 2px 0 6px; }
  .intro { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 14px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 8px 4px;
         border-bottom: 1px solid var(--vscode-panel-border); }
  .txt { flex: 1; }
  .detail { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 2px; }
  button { font-size: 12px; padding: 3px 10px; cursor: pointer; border: none; border-radius: 2px;
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<div class="wrap">
  <h1>StockLite 新手指引</h1>
  <div class="intro">安装时已内置示例行情，照着下面几条点一点就能上手。</div>
  ${rows}
</div>
<script nonce="${nonce}">
  document.querySelectorAll('button[data-cmd]').forEach(function (b) {
    b.addEventListener('click', function () {
      vscode_postMessage({ command: b.getAttribute('data-cmd') });
    });
  });
  function vscode_postMessage(m) { acquireVsCodeApi().postMessage(m); }
</script>
</body>
</html>`;
}
