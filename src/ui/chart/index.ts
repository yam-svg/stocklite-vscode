/**
 * K线/分时图 + 盈亏日历 —— S3 独占本目录。
 * 入口：stocklite.openChart 命令、openChart 事件、stocklite.showPnlCalendar 命令。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import { StateKeys } from '../../shared/config';
import type { StockGroup } from '../../shared/types';
import { showChart } from './chartPanel';
import { PnlPanel } from './pnlPanel';

export function activateChart(deps: FeatureDeps): void {
  deps.context.subscriptions.push(
    vscode.commands.registerCommand('stocklite.openChart', async (code?: string, name?: string) => {
      if (!code) {
        code = await pickWatchlistCode(deps);
        if (!code) return;
      }
      showChart(deps, code, name);
    }),
    vscode.commands.registerCommand('stocklite.showPnlCalendar', () => PnlPanel.show(deps)),
    deps.bus.on('openChart', ({ code, name }) => showChart(deps, code, name)),
  );
}

/** 命令面板直接调用时的兜底：从自选/分组里挑一个代码 */
async function pickWatchlistCode(deps: FeatureDeps): Promise<string | undefined> {
  const codes = new Set<string>(deps.config.get<string[]>(StateKeys.watchlist, []));
  for (const group of deps.config.get<StockGroup[]>(StateKeys.stockGroups, [])) {
    group.codes.forEach((c) => codes.add(c));
  }
  if (codes.size === 0) {
    void vscode.window.showInformationMessage('StockLite: 还没有自选股，先在股票页添加后再看图');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick([...codes], { placeHolder: '选择要查看图表的代码' });
  return picked;
}
