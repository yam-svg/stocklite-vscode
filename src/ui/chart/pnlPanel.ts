/**
 * 盈亏日历 Webview Panel（S3）：持仓盈亏走势折线 + 月历热图（移植 PnlChartService/PortfolioPnlDialog/PnlCalendarPanel）。
 * 宿主侧算数据（pnl.ts 纯逻辑 + provider 拉日 K），webview 只做展示与月导航。
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { FeatureDeps } from '../../extension';
import { StateKeys } from '../../shared/config';
import type { Position, TradeRecord } from '../../shared/types';
import { calcStockDayRows, mergePortfolio, type PortfolioPnl, type StockPnl } from './pnl';
import { getChartDataProvider } from './dataSource';

const KLINE_COUNT = 400;

export class PnlPanel {
  private static instance: PnlPanel | undefined;

  private panel: vscode.WebviewPanel | undefined;
  private busy = false;

  static show(deps: FeatureDeps): void {
    if (!PnlPanel.instance) PnlPanel.instance = new PnlPanel(deps);
    PnlPanel.instance.open(deps);
  }

  private constructor(private readonly deps: FeatureDeps) {
    deps.context.subscriptions.push(
      deps.bus.on('tradesChanged', () => {
        if (this.panel) void this.refresh();
      }),
    );
  }

  private open(deps: FeatureDeps): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      void this.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel('stocklite.pnl', '盈亏日历', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.context.extensionUri, 'webview', 'chart')],
    });
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg.type === 'ready' || msg.type === 'refresh') void this.refresh();
    });
  }

  private async refresh(): Promise<void> {
    if (!this.panel || this.busy) return;
    this.busy = true;
    try {
      const payload = await this.compute();
      void this.panel?.webview.postMessage({ type: 'data', ...payload });
    } finally {
      this.busy = false;
    }
  }

  private async compute(): Promise<{ portfolio: PortfolioPnl; stocks: StockPnl[]; colorUpIsRed: boolean; errors: string[] }> {
    const trades = this.deps.config.get<TradeRecord[]>(StateKeys.trades, []);
    const positions = this.deps.config.get<Position[]>(StateKeys.positions, []);
    const posByCode = new Map(positions.map((p) => [p.code, p]));
    const codes = [...new Set([...trades.map((t) => t.code), ...positions.filter((p) => p.quantity > 0).map((p) => p.code)])];

    const provider = getChartDataProvider();
    const nameByCode = new Map(trades.map((t) => [t.code, t.name]));
    try {
      for (const q of await provider.fetchQuotes(codes)) {
        if (q.name) nameByCode.set(q.code, q.name);
      }
    } catch {
      /* 名称兜底为代码，不阻断 */
    }

    const stocks: StockPnl[] = [];
    const errors: string[] = [];
    for (const code of codes) {
      try {
        const bars = await provider.fetchKline(code, 'day', KLINE_COUNT);
        const rows = calcStockDayRows(
          trades.filter((t) => t.code === code),
          posByCode.get(code),
          bars,
        );
        if (rows.length > 0) stocks.push({ code, name: nameByCode.get(code) ?? code, rows });
      } catch (err) {
        errors.push(`${code}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { portfolio: mergePortfolio(stocks), stocks, colorUpIsRed: this.deps.config.colorUpIsRed(), errors };
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const root = vscode.Uri.joinPath(this.deps.context.extensionUri, 'webview', 'chart');
    const uri = (rel: string) => webview.asWebviewUri(root.with({ path: `${root.path}/${rel}` }));
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('pnl.css')}">
<title>盈亏日历</title>
</head>
<body>
<header id="topbar">
  <span class="title">持仓盈亏</span>
  <select id="stockSel" title="选择标的"></select>
  <button id="refresh" title="刷新">&#x21bb;</button>
</header>
<div id="summary"></div>
<svg id="trend" preserveAspectRatio="none"></svg>
<section id="calendar">
  <div id="calHead">
    <button id="prevM" title="上一月">&#x25C0;</button>
    <span id="monthLbl"></span>
    <button id="nextM" title="下一月">&#x25B6;</button>
    <button id="todayM">今天</button>
    <span id="monthSum"></span>
  </div>
  <div id="weekRow"></div>
  <div id="grid"></div>
</section>
<section id="detail">
  <div id="detailTitle">点击日期查看各股当日盈亏</div>
  <table id="detailTable"><tbody></tbody></table>
</section>
<div id="errors" class="hidden"></div>
<script nonce="${nonce}" src="${uri('pnl.js')}"></script>
</body>
</html>`;
  }
}
