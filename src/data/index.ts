/**
 * S1 数据层激活入口：由 S7 在 extension.ts activate() 里调用 activateData(deps)。
 * 本文件不 import vscode —— 宿主能力经 DataDeps 以纯接口注入（duck-type 兼容 ConfigStore），
 * 保证 src/data 全目录可被 node 自测直跑。
 */
import type { EventBus } from '../shared/events';
import type { QuoteProvider } from '../shared/types';
import { PollScheduler } from './scheduler';
import { createDataProviders, probeCryptoStatus, type GlobalVisibility } from './providers';
import type { BreadthSnapshotStore } from './breadth';

export * from './providers';
export { PollScheduler } from './scheduler';
export { getMarketBreadth, getBreadthDataTimes, getLimitEcosystem, getUsdcnhPct, getAshareLastBarDate, getTencentIndexSnapshot, fetchIndexFuturesPosition, type BreadthSnapshotStore } from './breadth';
export { getIpoList, type IpoInfo } from './ipos';
export { getSectorQuotes, type AStockSector } from './sectors';
export { getUsSectorQuotes, US_SECTOR_ETFS, type SectorQuote } from './usMarket';
export { GLOBAL_INDEXES, visibleGlobalIndexes, type GlobalIndexConfig } from './globalIndex';
export { getFundQuotes, type FundNavRow } from './funds';
export { getStockQuotes, resolveImportCandidates, getEarningsDate, type ImportCandidate, type ImportToken, type ImportStatus } from './stocks';
export { getHistoryBars, getIntradayRows } from './kline';
export { probeCryptoNetwork, getCryptoQuotes, searchCryptos, normCryptoSymbol } from './cryptos';
export { searchFutures, getFutureQuotes } from './futures';

export interface DataDeps {
  bus: EventBus;
  /** S7 接线：注册进 tabs 会话的 provider 表（TabDescriptor.providerId 按 id 取用） */
  registerProvider(provider: QuoteProvider): void;
  /** 各 tab 自选代码（S7 从 ConfigStore StateKeys 读出；无自选返回空数组） */
  getTabCodes(tabId: string): string[];
  /** 轮询基准间隔（秒）（S7 转 ConfigStore.pollIntervalSeconds()）；默认 5 */
  pollIntervalSeconds?(): number;
  /** 全球指数双轨可见性（S5 设置页维护；缺省=全部默认指数、不含 optional） */
  getGlobalVisibility?(): GlobalVisibility;
  /** 除股票外的 tab 开关（S7 转 ConfigStore.tabEnabled）；缺省视为开启 */
  isTabEnabled?(tabId: string): boolean;
  /** 大盘概览磁盘快照兜底（对齐 Kotlin persistBreadthSnapshot），S7 可注入 globalState 实现 */
  breadthSnapshotStore?: BreadthSnapshotStore;
  /** 宿主释放列表（S7 传 context.subscriptions） */
  disposables: { push(d: { dispose(): void }): void };
}

/**
 * 激活数据层：注册 8 个 provider（广播 providerRegistered）+ 加密连通首探测。
 * **轮询由 tab 侧自持（S7b 定案，勿轻易改回）**：stockTab（S2）与 SimpleQuoteTab（S6）
 * 各自按 Kotlin 面板同档节奏 fetch 并按 tabId 广播 quotesUpdated，且持有页面私有态
 * （基金净值行/加密连通上报/全球限频标记）；若再启动调度器任务，同一批 codes 会被
 * 双倍请求（push2 本就按连接速率限流，双倍尤其有害）。PollScheduler 保留构造与
 * refreshNow 路由（无任务时自然落空），其 in-flight 合并/退避能力留作日后集中化备选。
 */
export function activateData(deps: DataDeps): { scheduler: PollScheduler } {
  const providers = createDataProviders(deps.getGlobalVisibility);
  for (const provider of Object.values(providers)) {
    deps.registerProvider(provider);
    deps.bus.emit('providerRegistered', { id: provider.id });
  }

  const scheduler = new PollScheduler(deps.bus);
  // 加密 tab 打开但自选为空时仍要出连通性徽章（Kotlin 首进探测）
  void probeCryptoStatus().catch(() => undefined);

  deps.disposables.push({ dispose: () => scheduler.stopAll() });
  return { scheduler };
}

/** 标题栏刷新接线：S7 把 refreshRequested 事件转发过来即可（按 viewId 即 tabId） */
export function bindRefresh(scheduler: PollScheduler, viewId: string): void {
  scheduler.refreshNow(viewId);
}
