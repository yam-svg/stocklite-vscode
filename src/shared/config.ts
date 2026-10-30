/**
 * 配置存储（S0 产出，已冻结）。
 * 持久数据一律走 globalState（StateKeys 注册表），用户偏好走 contributes.configuration（SettingsKeys）。
 * 键名与 JetBrains 版 StockliteState 字段对齐，S5 的“导入配置”负责迁移。
 */
import * as vscode from 'vscode';
import type { EventBus } from './events';

export const StateKeys = {
  /** StockGroup[] */
  stockGroups: 'stockGroups',
  /** 自选股代码顺序（无分组时的扁平列表），string[] */
  watchlist: 'watchlist',
  /** TradeRecord[] */
  trades: 'tradeRecords',
  /** Position[]（用户手填覆盖） */
  positions: 'positions',
  /** StockAlert[] */
  alerts: 'alerts',
  funds: 'funds',
  futures: 'futures',
  cryptos: 'cryptos',
  /** 自选的全球指数代码（显示过滤在 settings 会话，双轨可见性走 SettingsKeys） */
  selectedGlobalIndexes: 'selectedGlobalIndexes',
  /** 首启引导是否已展示。判据用本键是否已写入，勿用“数据为空”（播种也会写数据） */
  onboarded: 'onboarded',
  /** 反馈匿名设备号（S7a 自 S5 裸键上收；键名与 JetBrains 版 StockliteState 字段对齐） */
  feedbackDeviceId: 'feedbackDeviceId',
  /** 反馈邮箱持久化（同上，用户填写后随配置导出） */
  feedbackEmail: 'feedbackEmail',
} as const;

export const SettingsKeys = {
  pollIntervalSeconds: 'pollIntervalSeconds',
  colorUp: 'colorUp',
  tabs: 'tabs',
  statusBar: 'statusBar',
  indexes: 'indexes',
} as const;

export class ConfigStore {
  private readonly memento: vscode.Memento;

  constructor(context: vscode.ExtensionContext, private readonly bus: EventBus) {
    this.memento = context.globalState;
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('stocklite')) {
          this.bus.emit('configChanged', { key: '' });
        }
      }),
    );
  }

  get<T>(key: string, fallback: T): T {
    return this.memento.get<T>(key, fallback);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.memento.update(key, value);
    this.bus.emit('configChanged', { key });
  }

  /** 读 contributes.configuration 项，section 省略为 'stocklite' */
  setting<T>(id: string, section = 'stocklite'): T | undefined {
    return vscode.workspace.getConfiguration(section).get<T>(id);
  }

  pollIntervalSeconds(): number {
    return Math.max(2, this.setting<number>(SettingsKeys.pollIntervalSeconds) ?? 5);
  }

  colorUpIsRed(): boolean {
    return (this.setting<string>(SettingsKeys.colorUp) ?? 'red') === 'red';
  }

  tabEnabled(tab: 'fund' | 'future' | 'global' | 'sector' | 'ipo' | 'us' | 'crypto'): boolean {
    return this.setting<boolean>(`${SettingsKeys.tabs}.${tab}`, 'stocklite') ?? false;
  }
}
