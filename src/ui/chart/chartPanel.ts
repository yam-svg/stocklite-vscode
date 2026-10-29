/**
 * K线/分时 Webview Panel（S3）。单例复用：再次 openChart 只换标的。
 * 宿主侧职责：拉数据（当前经 dataSource 垫片，默认 mock）、算 B/S 标记（markers.ts）、
 * 主题/涨跌配色变更推送；渲染全部在 webview（klinecharts，本地资产）。
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { FeatureDeps } from '../../extension';
import { StateKeys } from '../../shared/config';
import type { Period, TradeRecord } from '../../shared/types';
import { dayTimestamp, matchIntradayMarkers, matchKlineMarkers, minuteTimestamp } from './markers';
import { getChartDataProvider } from './dataSource';

export type ChartPeriod = Period | 'minute';

const KLINE_COUNT = 300;

/** 'YYYY-MM-DD'（上海时区今天），分时标记的“当日”判据 */
function todayShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

export class ChartPanel {
  private static instance: ChartPanel | undefined;

  private panel: vscode.WebviewPanel | undefined;
  private code = '';
  private name = '';
  private period: ChartPeriod = 'day';
  private readonly disposables: vscode.Disposable[] = [];

  static show(deps: FeatureDeps, code: string, name?: string): void {
    if (!ChartPanel.instance) ChartPanel.instance = new ChartPanel(deps);
    ChartPanel.instance.open(code, name ?? '');
  }

  static refreshFor(deps: FeatureDeps, codes: string[]): void {
    const inst = ChartPanel.instance;
    if (inst && (codes.length === 0 || codes.includes(inst.code))) inst.pushCurrent();
  }

  private constructor(private readonly deps: FeatureDeps) {
    // 交易记录变化 → 刷新标记；红涨绿跌开关变化 → 刷新配色
    this.disposables.push(
      deps.bus.on('tradesChanged', ({ codes }) => ChartPanel.refreshFor(deps, codes)),
      deps.bus.on('configChanged', ({ key }) => {
        if (key === '' || key === 'colorUp') this.pushSettings();
      }),
    );
  }

  open(code: string, name: string): void {
    this.code = code;
    this.name = name || code;
    const title = `${this.name} ${code}`;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('stocklite.chart', title, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.deps.context.extensionUri, 'webview', 'chart')],
      });
      this.panel = panel;
      panel.webview.html = this.html(panel.webview);
      panel.onDidDispose(() => {
        this.panel = undefined;
      });
      panel.webview.onDidReceiveMessage((msg: { type?: string; period?: ChartPeriod }) => {
        if (msg.type === 'ready') {
          this.pushSettings();
          void this.load(this.period);
        } else if (msg.type === 'setPeriod' && msg.period) {
          void this.load(msg.period);
        } else if (msg.type === 'refresh') {
          void this.load(this.period);
        }
      });
      // 数据在 webview 发回 ready 后再加载（见 onDidReceiveMessage）
    } else {
      this.panel.title = title;
      this.panel.reveal(undefined, true);
      void this.load(this.period);
    }
  }

  /** 上海时区当日分时 → 标记定位用的 day 与昨收 */
  private async load(period: ChartPeriod): Promise<void> {
    this.period = period;
    if (!this.panel) return;
    const webview = this.panel.webview;
    const provider = getChartDataProvider();
    try {
      if (period === 'minute') {
        if (!provider.fetchMinute) throw new Error('当前数据源不支持分时图');
        const points = await provider.fetchMinute(this.code);
        if (this.period !== period) return; // 竞态：晚到的旧请求丢弃
        let prevClose = 0;
        try {
          prevClose = (await provider.fetchQuotes([this.code]))[0]?.prevClose ?? 0;
        } catch {
          /* 昨收仅用于配色基准，失败不阻断 */
        }
        const day = todayShanghai();
        webview.postMessage({
          type: 'minute',
          // 与 matchIntradayMarkers 的时间戳同算法，标记才能落在曲线点上
          points: points.map((p) => ({ ...p, timestamp: minuteTimestamp(day, p.time) })),
          prevClose,
          markers: matchIntradayMarkers(this.trades(), points, day),
        });
      } else {
        const bars = await provider.fetchKline(this.code, period, KLINE_COUNT);
        if (this.period !== period) return;
        webview.postMessage({
          type: 'kline',
          period,
          bars: bars.map((b) => ({ ...b, timestamp: dayTimestamp(b.date) })),
          markers: matchKlineMarkers(this.trades(), bars),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void webview.postMessage({ type: 'error', period, message });
    }
  }

  /** 数据已在缓存里时仅重发（交易记录/配置变化后重算标记） */
  private pushCurrent(): void {
    if (this.panel) void this.load(this.period);
  }

  private pushSettings(): void {
    void this.panel?.webview.postMessage({
      type: 'settings',
      colorUpIsRed: this.deps.config.colorUpIsRed(),
      code: this.code,
      name: this.name || this.code,
    });
  }

  private trades(): TradeRecord[] {
    return this.deps.config.get<TradeRecord[]>(StateKeys.trades, []).filter((t) => t.code === this.code);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const root = vscode.Uri.joinPath(this.deps.context.extensionUri, 'webview', 'chart');
    const uri = (rel: string) => webview.asWebviewUri(root.with({ path: `${root.path}/${rel}` }));
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval';`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('chart.css')}">
<title>StockLite Chart</title>
</head>
<body>
<header id="topbar">
  <span id="title">StockLite</span>
  <nav id="periods">
    <button data-period="minute">分时</button>
    <button data-period="day" class="active">日K</button>
    <button data-period="week">周K</button>
    <button data-period="month">月K</button>
  </nav>
  <button id="refresh" title="刷新">&#x21bb;</button>
</header>
<div id="chart"></div>
<div id="status" class="hidden"></div>
<script nonce="${nonce}" src="${uri('assets/klinecharts.min.js')}"></script>
<script nonce="${nonce}" src="${uri('chart.js')}"></script>
</body>
</html>`;
  }
}

/** 供 index.ts 注册命令用的模块级入口 */
export function showChart(deps: FeatureDeps, code?: string, name?: string): void {
  const target = code || '';
  if (!target) {
    void vscode.window.showInformationMessage('StockLite: 请从行情表右键或命令参数指定股票代码');
    return;
  }
  ChartPanel.show(deps, target, name);
}
