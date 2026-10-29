/**
 * 装配入口（S0 产出，已冻结）：只负责创建公共设施并逐个激活 feature。
 * 新增 feature 不在本文件加逻辑——S1~S6 只改各自目录；命令/视图注册一律在 package.json（S0 已预注册完毕）。
 */
import * as vscode from 'vscode';
import { EventBus } from './shared/events';
import { ConfigStore } from './shared/config';
import { activateWatchlist } from './ui/watchlist';
import { activateChart } from './ui/chart';
import { activateTabs } from './features/tabs';
import { activateStatusBar } from './features/statusbar';
import { activateAlerts } from './features/alerts';
import { activateSettings } from './features/settings';

export interface FeatureDeps {
  context: vscode.ExtensionContext;
  bus: EventBus;
  config: ConfigStore;
}

export function activate(context: vscode.ExtensionContext): void {
  const bus = new EventBus();
  const config = new ConfigStore(context, bus);
  const deps: FeatureDeps = { context, bus, config };

  // 视图标题栏的“+/刷新”统一命令：package.json 全视图共用一条，按 viewId 广播给各 tab 会话
  context.subscriptions.push(
    vscode.commands.registerCommand('stocklite.viewAdd', (arg: unknown) => {
      bus.emit('viewAddRequested', { viewId: viewIdOf(arg) });
    }),
    vscode.commands.registerCommand('stocklite.viewRefresh', (arg: unknown) => {
      bus.emit('refreshRequested', { viewId: viewIdOf(arg) });
    }),
  );

  activateWatchlist(deps);
  activateChart(deps);
  activateTabs(deps);
  activateStatusBar(deps);
  activateAlerts(deps);
  activateSettings(deps);
}

function viewIdOf(arg: unknown): string {
  // view/title 菜单以 WebviewView（含 .viewId）为参数回调；面板标题栏场景兜底空串
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && 'viewId' in arg) return String((arg as { viewId: unknown }).viewId);
  return '';
}

export function deactivate(): void {
  // feature 资源全部经 context.subscriptions 释放，无需在此清理
}
