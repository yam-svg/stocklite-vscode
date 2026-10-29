/**
 * 图表数据源解析（S3 本地垫片）。
 * 契约只有 providerRegistered 事件（不带实例），暂无按 id 取 Provider 的通道——
 * 已在 docs/contract-changes.md 提案共享注册表；S7 集成时调用 setChartDataProvider() 注入真实 Provider。
 * 在此之前图表一律走 mockProvider，保证 S3 可独立开发验收。
 */
import type { QuoteProvider } from '../../shared/types';
import { createMockProvider } from '../../shared/mockProvider';

let provider: QuoteProvider = createMockProvider('chart');

export function setChartDataProvider(p: QuoteProvider): void {
  provider = p;
}

export function getChartDataProvider(): QuoteProvider {
  return provider;
}
