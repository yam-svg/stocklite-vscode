/**
 * 模块间事件总线（S0 产出，已冻结）——跨 feature 通信的唯一通道。
 * feature 之间禁止直接 import 彼此的实现；新增事件请在 docs/contract-changes.md 提案。
 */
import type { Disposable } from 'vscode';
import type { Quote, StockAlert } from './types';

export interface AppEvents {
  /** 某 tab 的行情刷新完成 */
  'quotesUpdated': { tabId: string; quotes: Quote[] };
  /** globalState 配置变更 */
  'configChanged': { key: string };
  /** 请求打开 K 线/分时图（图表会话订阅） */
  'openChart': { code: string; name?: string };
  /** 成交记录变化，K 线 B/S 标记与持仓列需刷新 */
  'tradesChanged': { codes: string[] };
  /** 提醒命中（状态栏/通知会话订阅） */
  'alertFired': { alert: StockAlert; quote: Quote };
  /** 数据源注册完成（S1 注册真实 provider 后广播） */
  'providerRegistered': { id: string };
  /** 视图标题栏“+”按钮点击（package.json 统一注册 stocklite.viewAdd，按 viewId 路由到各 tab 会话） */
  'viewAddRequested': { viewId: string };
  /** 视图标题栏刷新按钮点击 */
  'refreshRequested': { viewId: string };
}

export type AppEventName = keyof AppEvents;

export class EventBus {
  private readonly handlers = new Map<AppEventName, Set<(payload: never) => void>>();

  on<K extends AppEventName>(name: K, handler: (payload: AppEvents[K]) => void): Disposable {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as (payload: never) => void);
    return {
      dispose: () => {
        set!.delete(handler as (payload: never) => void);
      },
    };
  }

  emit<K extends AppEventName>(name: K, payload: AppEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (p: AppEvents[K]) => void)(payload);
      } catch (err) {
        console.error(`[StockLite] 事件 ${name} 处理失败`, err);
      }
    }
  }
}
