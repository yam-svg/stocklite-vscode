/**
 * 板块 tab（S6）：东财 push2 板块榜单（data/sectors.ts），行业/概念/地域三分类
 * 用框架分组条切换。内置榜单只读：无增删/导入，行双击打开领涨股走势图
 * （对齐 JetBrains SectorPanel 点领涨股弹图的行为）。
 * 已知坑：push2 边缘节点随机断连是常态——getSectorQuotes 自带镜像轮换+重试，
 * 仍取不到时返回 null，本 tab 保留旧数据并在状态行标注，60s 轮询下一轮补全。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import type { ColumnDef, Quote } from '../../shared/types';
import { getSectorQuotes, sectorToQuote, type AStockSector } from '../../data/sectors';
import { formatCompact, formatNumber } from '../../ui/watchlist/table/format';
import type { GroupVM, RowVM } from '../../ui/watchlist/table/types';
import { SimpleQuoteTab } from './tabkit';

const SECTOR_COLUMNS: ColumnDef[] = [
  { key: 'name', title: '板块', kind: 'text', width: 92, align: 'left' },
  { key: 'changePct', title: '涨跌幅', kind: 'percent', width: 62 },
  { key: 'price', title: '点位', kind: 'price', width: 74 },
  { key: 'turnover', title: '换手', kind: 'text', width: 56 },
  { key: 'inflow', title: '主力净流入', kind: 'amount', width: 82 },
  { key: 'breadth', title: '涨/跌家数', kind: 'text', width: 66 },
  { key: 'leader', title: '领涨股', kind: 'text', width: 108, align: 'left' },
];

const CATEGORIES: GroupVM[] = [
  { id: '2', name: '行业' },
  { id: '3', name: '概念' },
  { id: '1', name: '地域' },
];

const BJ_PREFIXES = ['43', '83', '87', '88', '92'];

/**
 * 领涨股代码 → 走势图 symbol（纯函数，自测覆盖）：
 * 6 位数字才有效；北交所按代码前缀判 bj，其余按 f141（1=沪 0=深）。
 */
export function leaderStockSymbol(s: Pick<AStockSector, 'leaderCode' | 'leaderMarket'>): string | undefined {
  const code = s.leaderCode.trim();
  if (!/^\d{6}$/.test(code)) return undefined;
  if (BJ_PREFIXES.some((p) => code.startsWith(p))) return `bj${code}`;
  return s.leaderMarket === 1 ? `sh${code}` : `sz${code}`;
}

function pctText(pct: number): string {
  return Number.isFinite(pct) ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '--';
}

type Dir = -1 | 0 | 1;
function dirOf(v: number): Dir {
  return !Number.isFinite(v) || v === 0 ? 0 : v > 0 ? 1 : -1;
}

export class SectorTab extends SimpleQuoteTab {
  /** 分类榜单缓存：key = fsT（1地域/2行业/3概念） */
  private lists = new Map<number, AStockSector[]>();
  private sectors = new Map<string, AStockSector>();
  private lastFetchFailed = false;

  constructor(deps: FeatureDeps) {
    super(deps, {
      viewId: 'stocklite.sector',
      tabId: 'sector',
      title: '板块',
      columns: SECTOR_COLUMNS,
      emptyMessage: '板块榜单拉取中…（东财接口偶发断连，60 秒自动重试）',
      intervalMs: () => 60_000,
      enabled: () => deps.config.tabEnabled('sector'),
    });
    this.activeGroup = '2';
  }

  protected groupVms(): GroupVM[] {
    return CATEGORIES;
  }

  private activeFsT(): 1 | 2 | 3 {
    const n = Number(this.activeGroup || '2');
    return n === 1 || n === 3 ? n : 2;
  }

  protected codesForView(): string[] {
    return (this.lists.get(this.activeFsT()) ?? []).map((s) => s.code);
  }

  protected async fetch(_codes: string[]): Promise<Quote[]> {
    const cat = this.activeFsT();
    const list = await getSectorQuotes(cat);
    if (!list) {
      this.lastFetchFailed = true;
      return (this.lists.get(cat) ?? []).map((s) => sectorToQuote(s, 'sector'));
    }
    this.lastFetchFailed = false;
    this.lists.set(cat, list);
    this.sectors = new Map(list.map((s) => [s.code, s]));
    return list.map((s) => sectorToQuote(s, 'sector'));
  }

  protected override buildRow(code: string): RowVM {
    const s = this.sectors.get(code);
    if (!s) return { key: code, name: code, cells: SECTOR_COLUMNS.map((c) => ({ text: c.key === 'name' ? code : '--' })) };
    const leaderPctDir = dirOf(s.leaderPct);
    const breadthDir: Dir = s.upCount > s.downCount ? 1 : s.upCount < s.downCount ? -1 : 0;
    return {
      key: s.code, name: s.name,
      cells: [
        { text: s.name },
        { text: pctText(s.changePct), dir: dirOf(s.changePct) },
        { text: Number.isFinite(s.price) ? formatNumber(s.price, 2) : '--' },
        { text: Number.isFinite(s.turnoverRate) ? `${s.turnoverRate.toFixed(2)}%` : '--' },
        { text: formatCompact(s.mainInflow), dir: dirOf(s.mainInflow) },
        { text: `${s.upCount}/${s.downCount}`, dir: breadthDir },
        { text: s.leaderName ? `${s.leaderName} ${pctText(s.leaderPct)}` : '--', dir: leaderPctDir },
      ],
    };
  }

  protected override statusSuffix(count: number): string {
    return ` · 共 ${count} 条${this.lastFetchFailed ? ' · 东财源不稳定，显示上次数据' : ''}`;
  }

  /** 切换分类时若该分类还没拉到数据，立即打一次网络（框架已负责 refresh 视图） */
  protected override onGroupSelect(groupId: string): void {
    super.onGroupSelect(groupId);
    const cat = this.activeFsT();
    if (!this.lists.has(cat)) void this.refreshQuotes();
  }

  /** 双击行/右键“打开图表” → 领涨股走势图（对齐 JetBrains 点领涨股弹图） */
  protected override onRowOpen(code: string): void {
    const s = this.sectors.get(code);
    const symbol = s ? leaderStockSymbol(s) : undefined;
    if (!s || !symbol) {
      void vscode.window.showInformationMessage('StockLite: 该板块暂无领涨股数据');
      return;
    }
    this.deps.bus.emit('openChart', { code: symbol, name: s.leaderName });
  }

  protected override async onRowAction(action: 'openChart' | 'setAlert' | 'trades' | 'delete', code: string, name: string): Promise<void> {
    if (action === 'openChart') return this.onRowOpen(code);
    if (action === 'setAlert') {
      await vscode.window.showInformationMessage('StockLite: 板块行不支持提醒，可在股票页对个股设置');
      return;
    }
    return super.onRowAction(action, code, name);
  }

  protected override async unsupported(name: 'add' | 'refresh' | 'batchImport' | 'manageGroups'): Promise<void> {
    if (name === 'manageGroups') {
      await vscode.window.showInformationMessage('StockLite: 点击上方「行业 / 概念 / 地域」切换板块分类');
      return;
    }
    await vscode.window.showInformationMessage('StockLite: 板块为东财内置榜单，不支持添加与导入');
  }
}
