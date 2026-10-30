/**
 * 跨会话 Provider 注册表（S7a 落实，原 S2 ui/watchlist/providers.ts 与
 * S4 features/{alerts,statusbar}/providerRef.ts 三处过渡层上收至此）。
 * 契约事件 providerRegistered 只带 id 不带实例，注册表补上“按 id 取实例”的通道：
 * 数据层（S1 activateData，经 extension.ts 装配注入 registerProvider）注册真实 provider，
 * UI 会话按 id 取用；未注册时回落同名 mock（id 前缀 'mock:' 可用于状态提示）。
 */
import type { QuoteProvider } from './types';
import { createMockProvider } from './mockProvider';

const bindings = new Map<string, QuoteProvider>();

export function registerProvider(provider: QuoteProvider): void {
  bindings.set(provider.id, provider);
}

/** 取 provider；未注册时回落到同名 mock（id 前缀 'mock:' 可用于状态提示） */
export function getProvider(id: string): QuoteProvider {
  return bindings.get(id) ?? createMockProvider(id);
}

/** 该 id 是否仍是 mock（真实 provider 未注册） */
export function isMock(id: string): boolean {
  return !bindings.has(id);
}
