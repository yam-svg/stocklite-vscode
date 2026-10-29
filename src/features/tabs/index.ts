/**
 * 可选 tab（基金/期货/全球/板块/新股/美股/加密币）—— S6 独占本目录。
 * 每个 tab 的真实实现 = TabDescriptor + 列定义 + provider 适配，挂到 S2 的通用行情表框架上。
 * 视图显隐由 package.json 的 when: config.stocklite.tabs.* 控制，无需代码干预。
 */
import type { FeatureDeps } from '../../extension';
import { registerPlaceholderView, registerStubCommand } from '../../shared/placeholder';

const OPTIONAL_TABS = [
  { viewId: 'stocklite.fund', title: '基金' },
  { viewId: 'stocklite.future', title: '期货' },
  { viewId: 'stocklite.global', title: '全球指数' },
  { viewId: 'stocklite.sector', title: '板块' },
  { viewId: 'stocklite.ipo', title: '新股' },
  { viewId: 'stocklite.us', title: '美股' },
  { viewId: 'stocklite.crypto', title: '加密币' },
] as const;

export function activateTabs(deps: FeatureDeps): void {
  for (const tab of OPTIONAL_TABS) {
    registerPlaceholderView(deps, tab.viewId, tab.title, `本 tab 由会话 S6 基于通用行情表框架接入`);
  }

  registerStubCommand(deps, 'stocklite.addFund', 'S6');
  registerStubCommand(deps, 'stocklite.addFuture', 'S6');
  registerStubCommand(deps, 'stocklite.addCrypto', 'S6');
  registerStubCommand(deps, 'stocklite.addGlobalIndex', 'S6');
}
