/**
 * 装配入口：创建公共设施、接线数据层（S7a 按 S1 申请清单 activateData(DataDeps)），再逐个激活 feature。
 * 新增 feature 不在本文件加逻辑——命令/视图注册一律在 package.json；
 * 跨模块取 provider 走 shared/registry，事件一律经 EventBus。
 */
import * as vscode from 'vscode';
import { EventBus } from './shared/events';
import { ConfigStore, SettingsKeys, StateKeys } from './shared/config';
import { registerProvider } from './shared/registry';
import { visibleGlobalIndexes } from './shared/globalIndexes';
import { activateData, bindRefresh } from './data';
import type { MarketBreadthData } from './data/breadth';
import {
  makeRealDeps, createForecastStore, runWatchTick, nextDelayMs, coldStartDelayMs,
} from './data/forecast';
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

/** tab 开关配置项联合（package.json contributes.tabs.* 的全部键） */
type TabKey = 'fund' | 'future' | 'global' | 'sector' | 'ipo' | 'us' | 'crypto';

/** 大盘概览快照的 globalState 键（对齐 Kotlin persistBreadthSnapshot 的磁盘兜底） */
const BREADTH_SNAPSHOT_KEY = 'breadthSnapshot';

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

  // ── 数据层装配：注册 8 个真实 provider（S7a）。轮询由 tab 侧自持（见 data/index.ts
  // activateData 顶部说明），此处 getTabCodes 等仍注入但调度器不启动任务，避免与 tab 双倍请求。
  // provider 注册先于 feature 激活，保证各会话首次刷新即拿到真实 provider。──
  const globalVisibility = () => ({
    hidden: config.setting<string[]>(`${SettingsKeys.indexes}.hidden`) ?? [],
    enabledOptional: config.setting<string[]>(`${SettingsKeys.indexes}.enabledOptional`) ?? [],
  });
  const getTabCodes = (tabId: string): string[] => {
    switch (tabId) {
      case 'stock': {
        const flat = config.get<string[]>(StateKeys.watchlist, []);
        const groups = config.get<{ codes?: string[] }[]>(StateKeys.stockGroups, []);
        return [...new Set([...flat, ...groups.flatMap((g) => g.codes ?? [])])];
      }
      case 'fund': return config.get<string[]>(StateKeys.funds, []);
      case 'future': return config.get<string[]>(StateKeys.futures, []);
      case 'crypto': return config.get<string[]>(StateKeys.cryptos, []);
      case 'global': {
        // 未手动圈选时回落双轨可见性目录（调度器空 codes 不请求，回落保证全球 tab 常态可轮询）
        const sel = config.get<string[]>(StateKeys.selectedGlobalIndexes, []);
        if (sel.length > 0) return sel;
        const v = globalVisibility();
        return visibleGlobalIndexes(v.hidden, v.enabledOptional).map((c) => c.symbol);
      }
      default:
        return []; // sector/ipo/us 为全量榜单型 tab，无自选键（S6 经 provider 直取全量）
    }
  };
  const { scheduler } = activateData({
    bus,
    registerProvider,
    getTabCodes,
    pollIntervalSeconds: () => config.pollIntervalSeconds(),
    getGlobalVisibility: globalVisibility,
    isTabEnabled: (tabId) => config.tabEnabled(tabId as TabKey),
    breadthSnapshotStore: {
      load: () => config.get<MarketBreadthData | null>(BREADTH_SNAPSHOT_KEY, null),
      save: (data) => { void config.set(BREADTH_SNAPSHOT_KEY, data); },
    },
    disposables: context.subscriptions,
  });
  // 标题栏刷新：refreshRequested 的 viewId（'stocklite.stock'…）去前缀后即调度器 tabId
  context.subscriptions.push(
    bus.on('refreshRequested', ({ viewId }) => {
      const tabId = viewId.replace(/^stocklite\./, '');
      if (tabId) bindRefresh(scheduler, tabId);
    }),
  );

  activateWatchlist(deps);
  activateChart(deps);
  activateTabs(deps);
  activateStatusBar(deps);
  activateAlerts(deps);
  activateSettings(deps);
  activateForecast(deps);
}

/**
 * AI 研判后台看门狗（G2，Kotlin ForecastWatcherService 的接线）：自调度 setTimeout 链
 * 驱动"结算 → 盘前窗口生成 → 天气分保鲜"，保证面板没打开时账本也在推进。
 * 开关（forecast.enabled / 全球 tab）关闭时不干活的、只留 ≤5 分钟心跳，开启后快速接上。
 * 落库直写 globalState（createForecastStore），刻意绕开 ConfigStore.set——
 * 研判保存会 emit configChanged('') 让所有 tab 重建轮询，高频落库不能惊动表格。
 */
function activateForecast(deps: FeatureDeps): void {
  const enabled = () =>
    (deps.config.setting<boolean>('forecast.enabled') ?? true) && deps.config.tabEnabled('global');
  const store = createForecastStore(deps.context.globalState);
  const fdeps = makeRealDeps();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay);
  };
  const tick = async (): Promise<void> => {
    try {
      if (enabled()) {
        await runWatchTick(fdeps, store);
        schedule(nextDelayMs());
      } else {
        schedule(Math.min(nextDelayMs(), 5 * 60_000));
      }
    } catch {
      schedule(nextDelayMs());
    }
  };
  schedule(coldStartDelayMs());
  deps.context.subscriptions.push(
    new vscode.Disposable(() => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }),
  );
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
