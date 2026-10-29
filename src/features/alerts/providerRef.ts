/**
 * 行情 Provider 解析垫片 —— S4 临时方案（alerts 目录自包含副本）。
 * 契约缺口：EventBus 的 providerRegistered 只带 id 不带实例，跨 feature 又禁止互相 import。
 * 这里用 globalThis 的 Symbol.for 键做绑定槽：S1 真实 provider 就绪后（或 S7 装配时）调用
 * bindStockProvider()，未绑定前一律回落 mockProvider，保证本会话可独立开发/自测。
 * 正式方案（ProviderRegistry）已写入 docs/contract-changes.md，由 S7 落实。
 */
import type { QuoteProvider } from '../../shared/types';
import { createMockProvider } from '../../shared/mockProvider';

const KEY = Symbol.for('stocklite.quoteProvider.stock');

interface BindingBox {
  provider?: QuoteProvider;
}

function box(): BindingBox {
  const g = globalThis as unknown as Record<symbol, BindingBox | undefined>;
  let b = g[KEY];
  if (!b) {
    b = {};
    g[KEY] = b;
  }
  return b;
}

export function bindStockProvider(provider: QuoteProvider): void {
  box().provider = provider;
}

export function resolveStockProvider(): QuoteProvider {
  return box().provider ?? createMockProvider('stock');
}
