/**
 * 基金 tab（S6）：列=代码/名称/单位净值/日涨幅/净值日期。
 * 估值列不做（JetBrains 版已下线 fundgz/新浪 fund_ 估值接口）。
 * “持仓明细”弹窗（工具栏「分组」按钮承接）展示我的基金全量持仓：
 * 直接复用 data/funds.ts 的 getFundQuotes（腾讯 jj 批量 + 东财 F10 两级 + 水位线纠正）。
 * 数据取数直接走 S1 data 模块，轮询节奏同 S1 调度器（A 股时段感知）。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import { StateKeys } from '../../shared/config';
import type { ColumnDef, Quote } from '../../shared/types';
import { getFundQuotes, normFundCode, type FundNavRow } from '../../data/funds';
import { searchFunds } from '../../data/stocks';
import { cnRefreshIntervalMs } from '../../data/marketTime';
import { cellOf, formatNumber } from '../../ui/watchlist/table/format';
import type { CellVM, CellDir, RowAction } from '../../ui/watchlist/table/types';
import { TabListStore } from './store';
import { SimpleQuoteTab, nowText, pickToAdd } from './tabkit';

const FUND_COLUMNS: ColumnDef[] = [
  { key: 'code', title: '代码', kind: 'text', width: 64, align: 'left' },
  { key: 'name', title: '名称', kind: 'text', width: 116, align: 'left' },
  { key: 'nav', title: '净值', kind: 'price', width: 64 },
  { key: 'changePct', title: '日涨幅', kind: 'percent', width: 62 },
  { key: 'navDate', title: '净值日期', kind: 'text', width: 78 },
];

/** 净值单元格：固定 4 位小数（净值惯例，如 1.2345），随日涨幅着色 */
export function fundNavCell(nav: number, changePct: number): CellVM {
  if (!Number.isFinite(nav) || nav <= 0) return { text: '--' };
  const dir: CellDir = changePct > 0 ? 1 : changePct < 0 ? -1 : 0;
  return { text: formatNumber(nav, 4), dir };
}

function pctText(pct: number): string {
  return Number.isFinite(pct) ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '--';
}

export class FundsTab extends SimpleQuoteTab {
  private readonly store: TabListStore;
  /** 原始净值行（持仓明细弹窗展示用） */
  private navRows = new Map<string, FundNavRow>();

  constructor(deps: FeatureDeps) {
    super(deps, {
      viewId: 'stocklite.fund',
      tabId: 'fund',
      title: '基金',
      columns: FUND_COLUMNS,
      emptyMessage: '暂无基金：点上方「＋ 添加」，或「导入」粘贴基金代码批量导入',
      intervalMs: () => cnRefreshIntervalMs(Date.now()),
      enabled: () => deps.config.tabEnabled('fund'),
    });
    this.store = new TabListStore(deps.config, StateKeys.funds);
  }

  protected codesForView(): string[] {
    return this.store.list();
  }

  protected async fetch(codes: string[]): Promise<Quote[]> {
    if (codes.length === 0) return [];
    const rows = await getFundQuotes(codes);
    this.navRows = rows;
    const out: Quote[] = [];
    for (const raw of codes) {
      const code = normFundCode(raw);
      const r = rows.get(code);
      if (!r) continue;
      const prevNav = Number.isFinite(r.changePercent) && r.changePercent !== -100 ? r.nav / (1 + r.changePercent / 100) : r.nav;
      out.push({
        code: r.code, name: r.name,
        price: r.nav, prevClose: prevNav,
        change: r.nav - prevNav, changePct: r.changePercent,
        time: r.date,
        extra: { navDate: r.date },
      });
    }
    return out;
  }

  protected cellFor(col: ColumnDef, quote: Quote): CellVM {
    if (col.key === 'nav') return fundNavCell(quote.price, quote.changePct ?? 0);
    if (col.key === 'navDate') return { text: String(quote.extra?.navDate ?? '--') };
    return cellOf(col, quote);
  }

  /** addFund 命令与「＋」入口：东财搜索 + 6 位代码直添，添加前验净值有效性 */
  async addFund(): Promise<void> {
    const typed = await pickToAdd('输入 6 位基金代码或名称搜索（如 012414 / 纳斯达克），回车直接添加代码', searchFunds);
    if (!typed) return;
    const code = normFundCode(typed);
    if (!/^\d{6}$/.test(code)) {
      await vscode.window.showWarningMessage(`StockLite: ${typed} 不是有效的 6 位基金代码`);
      return;
    }
    const rows = await getFundQuotes([code]).catch(() => new Map<string, FundNavRow>());
    const row = rows.get(code);
    if (!row || !(row.nav > 0)) {
      await vscode.window.showWarningMessage(`StockLite: ${code} 未查到净值，请检查代码`);
      return;
    }
    if (!(await this.store.add(code))) {
      await vscode.window.showInformationMessage(`StockLite: ${code} 已在自选`);
      return;
    }
    await this.refreshQuotes();
  }

  protected async onAdd(): Promise<void> {
    return this.addFund();
  }

  /** 「导入」：粘贴文本 → 提取 6 位数字代码 → 验净值后批量入列 */
  async batchImportFunds(): Promise<void> {
    const raw = await vscode.window.showInputBox({
      title: '批量导入基金',
      prompt: '粘贴基金代码文本（空格/逗号/换行分隔，自动提取 6 位数字代码）',
      ignoreFocusOut: true,
    });
    if (!raw) return;
    const codes = [...new Set((raw.match(/\d{6}/g) ?? []).map(normFundCode))];
    if (codes.length === 0) {
      await vscode.window.showWarningMessage('StockLite: 未从文本中提取到 6 位基金代码');
      return;
    }
    const rows = await getFundQuotes(codes).catch(() => new Map<string, FundNavRow>());
    let added = 0;
    for (const code of codes) {
      if (rows.get(code)?.nav && (await this.store.add(code))) added++;
    }
    await this.refreshQuotes();
    await vscode.window.showInformationMessage(`StockLite: 批量导入完成，新增 ${added} 只基金（${codes.length - rows.size} 只未查到净值跳过）`);
  }

  /**
   * 「我的基金持仓」明细弹窗：框架工具栏固定四键，「分组」按钮在基金页
   * 复用为该入口（webview 模板归 S2 不改，S7 契约落地后可做成可配置按钮）。
   */
  async showHoldingsDialog(): Promise<void> {
    const codes = this.store.list();
    if (codes.length === 0) {
      await vscode.window.showInformationMessage('StockLite: 暂无基金，先点「＋ 添加」');
      return;
    }
    // 弹窗数据即取即得：优先本轮缓存行，缺的补拉一次
    let rows = this.navRows;
    const missing = codes.filter((c) => !rows.has(normFundCode(c)));
    if (missing.length > 0) {
      rows = new Map(rows);
      try {
        for (const [c, r] of await getFundQuotes(missing)) rows.set(c, r);
      } catch { /* 拉取失败按缺数据处理 */ }
    }
    const items = codes.map((raw) => {
      const r = rows.get(normFundCode(raw));
      return {
        label: `${r?.code ?? raw}  ${r?.name ?? '（未查到净值）'}`,
        description: r ? `净值 ${formatNumber(r.nav, 4)} · ${pctText(r.changePercent)} · ${r.date}` : undefined,
      };
    });
    await vscode.window.showQuickPick(items, {
      title: `我的基金持仓明细（${codes.length} 只）`,
      placeHolder: `${nowText()} 更新 · 数据源：腾讯 jj 批量 + 东财 F10 官方净值`,
      matchOnDescription: true,
    });
  }

  protected override async unsupported(name: 'add' | 'refresh' | 'batchImport' | 'manageGroups'): Promise<void> {
    if (name === 'batchImport') return this.batchImportFunds();
    if (name === 'manageGroups') return this.showHoldingsDialog();
  }

  protected async onRowAction(action: RowAction, code: string, name: string): Promise<void> {
    if (action === 'trades') {
      // 基金行右键“交易记录”同样进持仓明细（框架菜单四键固定，语义在基金页映射为明细）
      return this.showHoldingsDialog();
    }
    return super.onRowAction(action, code, name);
  }

  protected async deleteCode(code: string): Promise<void> {
    await this.store.remove(code);
    this.quotes.delete(code);
    await this.table.refresh();
  }

  protected async onReorder(codes: string[]): Promise<void> {
    await this.store.applyOrder(codes);
    await this.table.refresh();
  }
}
