/**
 * Provider 解析（S2 本地过渡层）。
 * shared/ 暂无跨会话 Provider 注册表（已在 docs/contract-changes.md 提案，S7 落实）；
 * 槽键与 S4 的 features/alerts/providerRef.ts 一致（Symbol.for('stocklite.quoteProvider.<id>')），
 * S1 真实 provider 就绪后经 registerProvider 或 S7 装配绑入同一槽，UI 无需改代码。
 */
import type { QuoteProvider } from '../../shared/types';
import { createMockProvider } from '../../shared/mockProvider';

interface BindingBox {
  provider?: QuoteProvider;
}

function box(id: string): BindingBox {
  const key = Symbol.for(`stocklite.quoteProvider.${id}`);
  const g = globalThis as unknown as Record<symbol, BindingBox | undefined>;
  let b = g[key];
  if (!b) {
    b = {};
    g[key] = b;
  }
  return b;
}

export function registerProvider(provider: QuoteProvider): void {
  box(provider.id).provider = provider;
}

/** 取 provider；未注册时回落到同名 mock（id 前缀 'mock:' 可用于状态提示） */
export function getProvider(id: string): QuoteProvider {
  return box(id).provider ?? createMockProvider(id);
}

export function isMock(id: string): boolean {
  return !box(id).provider;
}
