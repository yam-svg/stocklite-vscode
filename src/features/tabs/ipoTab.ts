/**
 * 新股 tab（S6）：东财新股日历（data/ipos.ts），分组条切「申购日历 / 新股次新股」。
 * 只读榜单：无增删导入；已上市行双击走 openChart 出图（sinaSymbol 与股票页同源），
 * 未上市行提示不可出图。次新股按上市日倒序（对齐 JetBrains 版细线分隔+倒序结论）。
 * 现价列复用 data/stocks.getStockQuotes（仅对已上市行拉取）。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import type { ColumnDef, Quote } from '../../shared/types';
import { getIpoList, type IpoInfo } from '../../data/ipos';
import { getStockQuotes } from '../../data/stocks';
import type { GroupVM, RowVM } from '../../ui/watchlist/table/types';
import { SimpleQuoteTab } from './tabkit';

const IPO_COLUMNS: ColumnDef[] = [
  { key: 'code', title: '代码', kind: 'text', width: 62, align: 'left' },
  { key: 'name', title: '名称', kind: 'text', width: 92, align: 'left' },
  { key: 'applyDate', title: '申购日', kind: 'text', width: 74 },
  { key: 'listingDate', title: '上市日', kind: 'text', width: 74 },
  { key: 'issuePrice', title: '发行价', kind: 'price', width: 64 },
  { key: 'price', title: '现价', kind: 'price', width: 72 },
  { key: 'changePct', title: '涨跌幅', kind: 'percent', width: 62 },
  { key: 'issuePe', title: '发行PE', kind: 'number', width: 62 },
];

const GROUPS: GroupVM[] = [
  { id: 'apply', name: '申购日历' },
  { id: 'listed', name: '新股/次新股' },
];

/**
 * 新股分组（纯函数，自测覆盖）：未上市=申购日历保持数据序（申购日升序，最近在前）；
 * 已上市=次新股按上市日倒序。数据序约定来自 data/ipos（applyDate 升序）。
 */
export function splitIpoGroups(list: IpoInfo[]): { apply: IpoInfo[]; listed: IpoInfo[] } {
  const apply = list.filter((x) => !x.listed);
  const listed = list
    .filter((x) => x.listed)
    .sort((a, b) => (b.listingDate ?? '').localeCompare(a.listingDate ?? ''));
  return { apply, listed };
}

function fmtPrice(v: number | null): string {
  return v !== null && Number.isFinite(v) && v > 0 ? v.toFixed(v >= 100 ? 2 : 3) : '--';
}

function fmtPct(v: number | null | undefined): { text: string; dir?: -1 | 0 | 1 } {
  if (v === null || v === undefined || !Number.isFinite(v)) return { text: '--' };
  return { text: `${v > 0 ? '+' : ''}${v.toFixed(2)}%`, dir: v > 0 ? 1 : v < 0 ? -1 : 0 };
}

export class IpoTab extends SimpleQuoteTab {
  private ipoRows = new Map<string, IpoInfo>();
  private live = new Map<string, Quote>();
  private stale = false;

  constructor(deps: FeatureDeps) {
    super(deps, {
      viewId: 'stocklite.ipo',
      tabId: 'ipo',
      title: '新股',
      columns: IPO_COLUMNS,
      emptyMessage: '暂无新股数据（东财新股日历拉取中或近期无安排）',
      intervalMs: () => 300_000,
      enabled: () => deps.config.tabEnabled('ipo'),
    });
    this.activeGroup = 'apply';
  }

  protected groupVms(): GroupVM[] {
    return GROUPS;
  }

  private currentRows(): IpoInfo[] {
    const all = [...this.ipoRows.values()];
    const { apply, listed } = splitIpoGroups(all);
    return (this.activeGroup || 'apply') === 'listed' ? listed : apply;
  }

  protected codesForView(): string[] {
    return this.currentRows().map((x) => x.sinaSymbol);
  }

  protected async fetch(_codes: string[]): Promise<Quote[]> {
    const list = await getIpoList();
    if (list) {
      this.stale = false;
      this.ipoRows = new Map(list.map((x) => [x.sinaSymbol, x]));
    }
    const listed = this.currentRows().filter((x) => x.listed).map((x) => x.sinaSymbol);
    if (listed.length > 0) {
      try {
        for (const [sym, q] of await getStockQuotes(listed)) this.live.set(sym, q);
      } catch { /* 现价拉取失败保持旧值，列显示 '--' */ }
    }
    return this.currentRows()
      .map((x) => this.live.get(x.sinaSymbol))
      .filter((q): q is Quote => Boolean(q));
  }

  protected override buildRow(symbol: string): RowVM {
    const x = this.ipoRows.get(symbol);
    if (!x) return { key: symbol, name: symbol, cells: IPO_COLUMNS.map((c) => ({ text: c.key === 'code' ? symbol : '--' })) };
    const live = x.listed ? this.live.get(symbol) : undefined;
    const livePct = live ? (live.changePct ?? 0) : null;
    return {
      key: symbol, name: x.name,
      cells: [
        { text: x.pureCode },
        { text: x.name },
        { text: x.applyDate || '--' },
        { text: x.listingDate ?? '待公告' },
        { text: fmtPrice(x.issuePrice) },
        { text: live && live.price > 0 ? live.price.toFixed(2) : '--', dir: live ? (livePct! > 0 ? 1 : livePct! < 0 ? -1 : 0) : undefined },
        fmtPct(livePct),
        { text: x.issuePe !== null && Number.isFinite(x.issuePe) ? x.issuePe.toFixed(2) : '--' },
      ],
    };
  }

  protected override statusSuffix(count: number): string {
    return ` · 共 ${count} 条${this.stale ? ' · 接口暂不可用，显示缓存' : ''}`;
  }

  protected override onGroupSelect(groupId: string): void {
    super.onGroupSelect(groupId);
    void this.refreshQuotes();
  }

  protected override onRowOpen(symbol: string, name: string): void {
    const x = this.ipoRows.get(symbol);
    if (x && !x.listed) {
      void vscode.window.showInformationMessage(`StockLite: ${x.name} 尚未上市，暂无走势图`);
      return;
    }
    this.deps.bus.emit('openChart', { code: symbol, name });
  }

  protected override async onRowAction(action: 'openChart' | 'setAlert' | 'trades' | 'delete', code: string, name: string): Promise<void> {
    if (action === 'delete') {
      await vscode.window.showInformationMessage('StockLite: 新股为内置日历榜单，行不可删除');
      return;
    }
    if (action === 'trades') {
      await vscode.window.showInformationMessage('StockLite: 交易记录仅自选股 tab 支持');
      return;
    }
    return super.onRowAction(action, code, name);
  }

  protected override async unsupported(name: 'add' | 'refresh' | 'batchImport' | 'manageGroups'): Promise<void> {
    void name;
    await vscode.window.showInformationMessage('StockLite: 新股为东财内置日历，点击上方分组切换申购/次新股');
  }
}
