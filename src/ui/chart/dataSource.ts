/**
 * 图表数据源解析：默认直取共享注册表的 stock provider
 * （日K/周K/月K/分时在 8 个 provider 间共用同一实现、按代码前缀路由，S7a 由过渡垫片切换而来）。
 * 未注册时注册表回落 mock，保证独立开发可跑；装配方仍可经 setChartDataProvider 显式覆盖。
 */
import type { QuoteProvider } from '../../shared/types';
import { getProvider } from '../../shared/registry';

let injected: QuoteProvider | undefined;

export function setChartDataProvider(p: QuoteProvider): void {
  injected = p;
}

export function getChartDataProvider(): QuoteProvider {
  return injected ?? getProvider('stock');
}
