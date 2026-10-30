/**
 * 加密币 tab（S6）：三源降级（Bitget→Gate→binance 镜像）在 data/cryptos.ts 已备；
 * 本 tab 延续 Kotlin CryptoPanel 的连通状态徽章意图——状态行进状态栏文案，
 * 状态翻转（全断/恢复）额外弹一次性通知，绝不静默显示空数据。
 * 首用播种主流六币 USDT 对（判据独立布尔键，同期货模式）。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import { StateKeys } from '../../shared/config';
import type { ColumnDef, Quote } from '../../shared/types';
import { getCryptoQuotes, normCryptoSymbol, searchCryptos, type CryptoNetStatus } from '../../data/cryptos';
import { cellOf, formatCompact } from '../../ui/watchlist/table/format';
import type { CellVM } from '../../ui/watchlist/table/types';
import { TabListStore, CRYPTO_SEEDED_KEY, CRYPTO_SEEDS } from './store';
import { SimpleQuoteTab, pickToAdd } from './tabkit';

const CRYPTO_COLUMNS: ColumnDef[] = [
  { key: 'code', title: '交易对', kind: 'text', width: 92, align: 'left' },
  { key: 'price', title: '最新价', kind: 'price', width: 92 },
  { key: 'changePct', title: '涨跌幅', kind: 'percent', width: 66 },
  { key: 'high24h', title: '24h高', kind: 'price', width: 92 },
  { key: 'low24h', title: '24h低', kind: 'price', width: 92 },
  { key: 'amount', title: '24h成交额', kind: 'amount', width: 82 },
];

export class CryptoTab extends SimpleQuoteTab {
  private readonly store: TabListStore;
  private status: CryptoNetStatus | null = null;
  private workingSource: string | null = null;

  constructor(deps: FeatureDeps) {
    super(deps, {
      viewId: 'stocklite.crypto',
      tabId: 'crypto',
      title: '加密币',
      columns: CRYPTO_COLUMNS,
      emptyMessage: '暂无加密币：点上方「＋ 添加」（支持 BTC / SOL / ETH_USDT 搜索）',
      intervalMs: () => deps.config.pollIntervalSeconds() * 1000,
      enabled: () => deps.config.tabEnabled('crypto'),
    });
    this.store = new TabListStore(deps.config, StateKeys.cryptos, {
      seedKey: CRYPTO_SEEDED_KEY,
      seedCodes: CRYPTO_SEEDS,
    });
  }

  protected override async seedDefaults(): Promise<void> {
    await this.store.seedDefaultsIfNeeded();
  }

  protected codesForView(): string[] {
    return this.store.list().map(normCryptoSymbol);
  }

  protected async fetch(codes: string[]): Promise<Quote[]> {
    const { quotes, status, workingSource } = await getCryptoQuotes(codes);
    await this.reportStatus(status, workingSource);
    const out: Quote[] = [];
    for (const raw of codes) {
      const pair = normCryptoSymbol(raw);
      const row = quotes.get(pair);
      if (!row) continue;
      out.push({
        code: pair, name: pair.replace('_', '/'),
        price: row.price,
        prevClose: row.changePct !== -100 ? row.price / (1 + row.changePct / 100) : row.price,
        changePct: row.changePct,
        amount: row.quoteVolume,
        extra: { high24h: row.high24h, low24h: row.low24h },
      });
    }
    return out;
  }

  /** 24h 成交额无涨跌语义：不跟随 cellOf 的 amount 列按正负着色 */
  protected override cellFor(col: ColumnDef, quote: Quote): CellVM {
    if (col.key === 'amount') {
      const v = quote.amount;
      return { text: typeof v === 'number' && Number.isFinite(v) ? formatCompact(v) : '--' };
    }
    return cellOf(col, quote);
  }

  protected override statusSuffix(count: number): string {
    const badge = this.status === 'OFFLINE'
      ? ' · ⚠ 三源不可达'
      : this.status === 'DEGRADED'
        ? ` · ⚠ 部分降级（${this.workingSource ?? '未知源'}）`
        : this.status === 'CONNECTED'
          ? ` · 来源 ${this.workingSource ?? ''}`
          : '';
    return ` · 共 ${count} 条${badge}`;
  }

  /** 状态翻转才通知（徽章意图延续）：全断弹警告，恢复弹提示，稳定期不打扰 */
  private async reportStatus(next: CryptoNetStatus, source: string | null): Promise<void> {
    const prev = this.status;
    this.status = next;
    this.workingSource = source;
    if (next === prev) return;
    if (next === 'OFFLINE') {
      await vscode.window.showWarningMessage('StockLite 加密币：Bitget / Gate / Binance 镜像均无法连接，请检查网络或代理');
    } else if (prev === 'OFFLINE') {
      await vscode.window.showInformationMessage(`StockLite 加密币：网络已恢复（当前来源 ${source ?? '未知'}）`);
    }
  }

  /** addCrypto 命令与「＋」入口：搜索 + 代码直添，添加前验行情可达 */
  async addCrypto(): Promise<void> {
    const typed = await pickToAdd('输入币种代码搜索（如 BTC / PEPE / BTC_USDT），回车直接添加代码', searchCryptos);
    if (!typed) return;
    const pair = normCryptoSymbol(typed);
    const { quotes } = await getCryptoQuotes([pair]).catch(() => ({ quotes: new Map(), status: 'OFFLINE' as CryptoNetStatus, workingSource: null }));
    if (!quotes.has(pair)) {
      await vscode.window.showWarningMessage(`StockLite: ${pair} 无行情或交易对不存在（未带计价币时默认 USDT）`);
      return;
    }
    if (!(await this.store.add(pair))) {
      await vscode.window.showInformationMessage(`StockLite: ${pair} 已在自选`);
      return;
    }
    await this.refreshQuotes();
  }

  protected async onAdd(): Promise<void> {
    return this.addCrypto();
  }

  async batchImportPairs(): Promise<void> {
    const raw = await vscode.window.showInputBox({
      title: '批量添加加密币',
      prompt: '多个交易对用空格/逗号/换行分隔（如 BTC ETH SOL_USDT）',
      ignoreFocusOut: true,
    });
    if (!raw) return;
    const tokens = [...new Set(raw.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean))];
    if (tokens.length === 0) return;
    const pairs = [...new Set(tokens.map(normCryptoSymbol))].filter((s) => s.length > 4);
    const { quotes } = await getCryptoQuotes(pairs).catch(() => ({ quotes: new Map(), status: 'OFFLINE' as CryptoNetStatus, workingSource: null }));
    let added = 0;
    for (const pair of pairs) {
      if (quotes.has(pair) && (await this.store.add(pair))) added++;
    }
    await this.refreshQuotes();
    await vscode.window.showInformationMessage(`StockLite: 批量添加完成，新增 ${added} 个交易对（${pairs.length - quotes.size} 个无行情跳过）`);
  }

  protected override async unsupported(name: 'add' | 'refresh' | 'batchImport' | 'manageGroups'): Promise<void> {
    if (name === 'batchImport') return this.batchImportPairs();
    await vscode.window.showInformationMessage('StockLite: 加密币页支持「＋ 添加」「导入」与行右键删除');
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
