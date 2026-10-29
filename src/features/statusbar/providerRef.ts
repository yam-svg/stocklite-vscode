/**
 * 行情 Provider 解析垫片 —— S4 临时方案（statusbar 目录自包含副本，与 alerts 同实现）。
 * 契约缺口与正式方案（ProviderRegistry）见 docs/contract-changes.md。
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
