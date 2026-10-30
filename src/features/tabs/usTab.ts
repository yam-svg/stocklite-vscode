/**
 * 美股 tab（S6）：分组条切「板块 ETF / 美股指数」两类。
 *  ETF 榜单（data/usMarket.ts 新浪 gb_ 批量 + Yahoo 兜底）：盘前/盘后时段展示延伸涨跌幅
 *  （JetBrains 版盘前盘后基线修复的同款语义）；指数行复用 data/globalIndex.ts 目录的 US 条目，
 *  严禁再造目录。ETF 显示清单走 globalState 独立键（未写入=33 只全显，删改后显式落盘）。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import type { ColumnDef, Quote } from '../../shared/types';
import { getUsSectorQuotes, usSectorToQuote, US_SECTOR_ETFS, type SectorQuote } from '../../data/usMarket';
import { currentUsSession, type UsSession } from '../../data/marketTime';
import { GLOBAL_INDEXES, getGlobalIndexQuotes, globalRowToQuote } from '../../data/globalIndex';
import { formatNumber } from '../../ui/watchlist/table/format';
import type { GroupVM, RowVM } from '../../ui/watchlist/table/types';
import { usEtfDisplayList, US_ETF_LIST_KEY } from './store';
import { SimpleQuoteTab, pickMany } from './tabkit';

const ETF_COLUMNS: ColumnDef[] = [
  { key: 'name', title: '板块 ETF', kind: 'text', width: 128, align: 'left' },
  { key: 'price', title: '正股价', kind: 'price', width: 74 },
  { key: 'regularPct', title: '涨跌幅', kind: 'percent', width: 64 },
  { key: 'prePct', title: '盘前', kind: 'percent', width: 64 },
  { key: 'postPct', title: '盘后', kind: 'percent', width: 64 },
];

const INDEX_COLUMNS: ColumnDef[] = [
  { key: 'name', title: '指数', kind: 'text', width: 132, align: 'left' },
  { key: 'price', title: '现价', kind: 'price', width: 84 },
  { key: 'changePct', title: '涨跌幅', kind: 'percent', width: 64 },
  { key: 'state', title: '状态', kind: 'text', width: 58 },
];

const US_INDEXES = GLOBAL_INDEXES.filter((c) => c.market === 'US');
const ALL_ETF_SYMBOLS = US_SECTOR_ETFS.map(([s]) => s);

const GROUPS: GroupVM[] = [
  { id: 'etf', name: '板块ETF' },
  { id: 'index', name: '美股指数' },
];

const SESSION_LABEL: Record<UsSession, string> = { PRE: '盘前', REGULAR: '常规盘', POST: '盘后', CLOSED: '休市' };

function pctText(pct: number | null): { text: string; dir?: -1 | 0 | 1 } {
  if (pct === null || !Number.isFinite(pct)) return { text: '--' };
  return { text: `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`, dir: pct > 0 ? 1 : pct < 0 ? -1 : 0 };
}

export class UsTab extends SimpleQuoteTab {
  private usRows = new Map<string, SectorQuote>();
  private session: UsSession = currentUsSession();
  private rateLimited = false;

  constructor(deps: FeatureDeps) {
    super(deps, {
      viewId: 'stocklite.us',
      tabId: 'us',
      title: '美股',
      columns: ETF_COLUMNS,
      emptyMessage: '没有显示中的板块 ETF：点上方「＋ 添加」勾选（美股指数请去全球指数页管理）',
      intervalMs: () => Math.max(30_000, deps.config.pollIntervalSeconds() * 1000),
      enabled: () => deps.config.tabEnabled('us'),
    });
    this.activeGroup = 'etf';
  }

  private isEtfGroup(): boolean {
    return (this.activeGroup || 'etf') === 'etf';
  }

  protected groupVms(): GroupVM[] {
    return GROUPS;
  }

  protected override columnsForView(): ColumnDef[] {
    return this.isEtfGroup() ? ETF_COLUMNS : INDEX_COLUMNS;
  }

  protected codesForView(): string[] {
    if (this.isEtfGroup()) return usEtfDisplayList(this.deps.config, ALL_ETF_SYMBOLS);
    return US_INDEXES.map((c) => c.symbol);
  }

  protected async fetch(codes: string[]): Promise<Quote[]> {
    if (this.isEtfGroup()) {
      const now = Date.now();
      this.session = currentUsSession(now);
      const map = await getUsSectorQuotes(now);
      this.usRows = map;
      return codes
        .map((s) => map.get(s))
        .filter((q): q is SectorQuote => Boolean(q))
        .map((q) => usSectorToQuote(q, this.session));
    }
    const configs = US_INDEXES.filter((c) => codes.length === 0 || codes.includes(c.symbol));
    const { quotes, rateLimited } = await getGlobalIndexQuotes(configs);
    this.rateLimited = rateLimited;
    return quotes.map(globalRowToQuote);
  }

  protected override buildRow(code: string): RowVM {
    if (!this.isEtfGroup()) return this.buildIndexRow(code);
    const q = this.usRows.get(code);
    const name = q ? `${q.nameCn} (${q.symbol})` : code;
    if (!q) {
      return { key: code, name, cells: ETF_COLUMNS.map((c) => ({ text: c.key === 'name' ? code : '--' })) };
    }
    return {
      key: q.symbol, name,
      cells: [
        { text: name },
        { text: formatNumber(q.price, 2), dir: q.regularPct > 0 ? 1 : q.regularPct < 0 ? -1 : 0 },
        pctText(q.regularPct),
        pctText(q.prePct),
        pctText(q.postPct),
      ],
    };
  }

  private buildIndexRow(symbol: string): RowVM {
    const q = this.quotes.get(symbol);
    const cfg = US_INDEXES.find((c) => c.symbol === symbol);
    const name = q?.name ?? `${cfg?.nameCn ?? symbol} (${cfg?.nameEn ?? ''})`;
    if (!q) {
      return { key: symbol, name, cells: [{ text: name }, { text: '--' }, { text: '--' }, { text: '--' }] };
    }
    const pct = q.changePct ?? 0;
    const dir: -1 | 0 | 1 = pct > 0 ? 1 : pct < 0 ? -1 : 0;
    const digits = Math.abs(q.price) >= 1 ? 2 : 4;
    return {
      key: symbol, name,
      cells: [
        { text: name },
        { text: q.price > 0 ? formatNumber(q.price, digits) : '--', dir },
        { text: `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`, dir },
        { text: q.extra?.isOpen === 1 ? '交易中' : '休市', sub: q.extra?.isDelayed === 1 ? '延迟' : undefined },
      ],
    };
  }

  protected override statusSuffix(count: number): string {
    if (this.isEtfGroup()) return ` · 共 ${count} 条 · ${SESSION_LABEL[this.session]}`;
    return ` · 共 ${count} 条${this.rateLimited ? ' · Yahoo 限流退避中' : ''}`;
  }

  /** 分组只在切到该组时重新取数（ETF 与指数数据源不同，省一半请求） */
  protected override onGroupSelect(groupId: string): void {
    super.onGroupSelect(groupId);
    void this.refreshQuotes();
  }

  /** 「＋」：ETF 组=33 只多选清单；指数组=引导去全球指数页（目录/可见性单一入口） */
  protected override async onAdd(): Promise<void> {
    if (!this.isEtfGroup()) {
      await vscode.window.showInformationMessage('StockLite: 美股指数显示与否在「全球指数」页或设置页管理');
      return;
    }
    const display = new Set(usEtfDisplayList(this.deps.config, ALL_ETF_SYMBOLS));
    const items = US_SECTOR_ETFS.map(([sym, cn]) => ({ label: `${cn}（${sym}）`, description: sym, picked: display.has(sym) }));
    const picked = await pickMany(items, '勾选要显示的板块 ETF（取消勾选=从列表移除）');
    if (!picked) return;
    const chosen = new Set(picked.map((p) => p.description ?? ''));
    await this.deps.config.set(US_ETF_LIST_KEY, ALL_ETF_SYMBOLS.filter((s) => chosen.has(s)));
    await this.table.refresh();
  }

  protected override async deleteCode(symbol: string): Promise<void> {
    if (!this.isEtfGroup()) {
      await vscode.window.showInformationMessage('StockLite: 美股指数请在「全球指数」页隐藏');
      return;
    }
    const next = usEtfDisplayList(this.deps.config, ALL_ETF_SYMBOLS).filter((s) => s !== symbol);
    await this.deps.config.set(US_ETF_LIST_KEY, next);
    await this.table.refresh();
  }

  protected override async unsupported(name: 'add' | 'refresh' | 'batchImport' | 'manageGroups'): Promise<void> {
    void name;
    await vscode.window.showInformationMessage('StockLite: 美股页用「＋ 添加」勾选 ETF，分组条切换指数/ETF');
  }
}
