/**
 * 期货 tab（S6）：自选列表走 StateKeys.futures，列参照 Kotlin FuturesPanel
 * （合约/名称/最新价/涨跌幅/昨收）。首用播种 hf_NQ/hf_OIL——判据照搬 S2
 * watchlistDefaultsSeeded 的独立布尔键模式（置位后用户删除不再复活）。
 * 数据直接取 S1 的 data/futures（nf_ 国内 / hf_ 外盘，新浪 GBK 批量）。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import { StateKeys } from '../../shared/config';
import type { ColumnDef, Quote } from '../../shared/types';
import { fetchFutureQuotes, getFutureQuotes, normalizeFutureSymbol, searchFutures } from '../../data/futures';
import { cnRefreshIntervalMs } from '../../data/marketTime';
import { TabListStore, FUTURES_SEEDED_KEY, FUTURE_SEEDS } from './store';
import { SimpleQuoteTab, pickToAdd } from './tabkit';

const FUTURE_COLUMNS: ColumnDef[] = [
  { key: 'code', title: '合约', kind: 'text', width: 78, align: 'left' },
  { key: 'name', title: '名称', kind: 'text', width: 108, align: 'left' },
  { key: 'price', title: '最新价', kind: 'price', width: 74 },
  { key: 'changePct', title: '涨跌幅', kind: 'percent', width: 64 },
  { key: 'prevClose', title: '昨收', kind: 'price', width: 74 },
];

export class FuturesTab extends SimpleQuoteTab {
  private readonly store: TabListStore;

  constructor(deps: FeatureDeps) {
    super(deps, {
      viewId: 'stocklite.future',
      tabId: 'future',
      title: '期货',
      columns: FUTURE_COLUMNS,
      emptyMessage: '暂无期货合约：点上方「＋ 添加」（支持 NQ / 纳斯达克 / hf_GC 等搜索）',
      intervalMs: () => cnRefreshIntervalMs(Date.now()),
      enabled: () => deps.config.tabEnabled('future'),
    });
    this.store = new TabListStore(deps.config, StateKeys.futures, {
      seedKey: FUTURES_SEEDED_KEY,
      seedCodes: FUTURE_SEEDS,
    });
  }

  protected override async seedDefaults(): Promise<void> {
    await this.store.seedDefaultsIfNeeded();
  }

  protected codesForView(): string[] {
    return this.store.list();
  }

  protected async fetch(codes: string[]): Promise<Quote[]> {
    if (codes.length === 0) return [];
    return fetchFutureQuotes(codes);
  }

  /** addFuture 命令与「＋」入口：搜索 + 编码直查；添加前拉一次行情验真 */
  async addFuture(): Promise<void> {
    const typed = await pickToAdd(
      '输入合约代码或名称搜索（如 NQ / IF / 布伦特），回车直接添加代码',
      searchFutures,
    );
    if (!typed) return;
    const symbol = normalizeFutureSymbol(typed);
    try {
      const map = await getFutureQuotes([symbol]);
      const quote = map.get(symbol);
      if (!quote || !(quote.price > 0)) {
        await vscode.window.showWarningMessage(`StockLite: ${symbol} 无法获取行情，请检查合约代码`);
        return;
      }
      this.quotes.set(symbol, quote);
    } catch {
      await vscode.window.showWarningMessage(`StockLite: ${symbol} 行情查询失败，已取消添加`);
      return;
    }
    if (!(await this.store.add(symbol))) {
      await vscode.window.showInformationMessage(`StockLite: ${symbol} 已在自选`);
      return;
    }
    await this.table.refresh();
  }

  protected async onAdd(): Promise<void> {
    return this.addFuture();
  }

  protected async batchImportCodes(): Promise<void> {
    const raw = await vscode.window.showInputBox({
      title: '批量添加期货',
      prompt: '多个合约代码用空格/逗号/换行分隔（如 hf_NQ, nf_AU0）',
      ignoreFocusOut: true,
    });
    if (!raw) return;
    const tokens = [...new Set(raw.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean))];
    if (tokens.length === 0) return;
    const symbols = [...new Set(tokens.map(normalizeFutureSymbol))].filter((s) => s.length > 3);
    const map = await getFutureQuotes(symbols).catch(() => new Map<string, Quote>());
    let added = 0;
    for (const [symbol, quote] of map) {
      if (quote.price > 0 && (await this.store.add(symbol))) {
        this.quotes.set(symbol, quote);
        added++;
      }
    }
    await this.table.refresh();
    await vscode.window.showInformationMessage(`StockLite: 批量添加完成，新增 ${added} 个合约（${symbols.length - map.size} 个无行情跳过）`);
  }

  protected override async unsupported(name: 'add' | 'refresh' | 'batchImport' | 'manageGroups'): Promise<void> {
    if (name === 'batchImport') return this.batchImportCodes();
    await vscode.window.showInformationMessage('StockLite: 期货页支持「＋ 添加」「导入」与行右键删除');
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
