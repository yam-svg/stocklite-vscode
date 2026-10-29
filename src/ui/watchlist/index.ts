/**
 * 自选股 tab + 通用行情表框架 —— S2 独占本目录。
 * 通用框架在 table/ 子目录（TableTab + 纯渲染 webview 模板），S6 各 tab 直接复用；
 * 自选股业务在 stockTab.ts / store.ts / positions.ts / stockTextParser.ts。
 * S0 的占位视图与桩命令由本实现接管（同名 viewId/命令在此注册即覆盖占位）。
 */
import type { FeatureDeps } from '../../extension';
import { StockTab } from './stockTab';

export { TableTab } from './table/framework';
export type { TableTabHandlers } from './table/framework';
export type { TableSnapshot, RowVM, CellVM, GroupVM, SortVM, RowAction, ToolbarCommand } from './table/types';

export function activateWatchlist(deps: FeatureDeps): void {
  void new StockTab(deps).activate();
}
