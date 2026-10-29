/**
 * 自选股数据仓库（S2）：自选列表 / 分组 / 交易记录 / 持仓覆盖的读写封装。
 * 持久化全部走 ConfigStore(globalState)，键名用 shared StateKeys。
 * 首启播种判据：专用布尔键，绝不判“数据是否为空”（JetBrains 版踩过的坑：播种本身写数据，
 * 且删除示例后会被复活——seeds 置位后不再播种）。
 */
import type { ConfigStore } from '../../shared/config';
import { StateKeys } from '../../shared/config';
import type { Position, StockGroup, TradeRecord } from '../../shared/types';

/** 播种标记独立于业务数据键；S5 导出/导入配置时需带上此键（见 contract-changes.md） */
export const SEEDED_KEY = 'watchlistDefaultsSeeded';

/** 首启示例自选（对齐 JetBrains 版 seedDefaults：茅台/东财/沪深300ETF） */
const DEFAULT_CODES = ['sh600519', 'sz300059', 'sh510300'];

export class WatchlistStore {
  constructor(private readonly config: ConfigStore) {}

  async seedDefaultsIfNeeded(): Promise<void> {
    if (this.config.get<boolean>(SEEDED_KEY, false)) return;
    await this.config.set(SEEDED_KEY, true);
    if (this.watchlist().length === 0) await this.setWatchlist(DEFAULT_CODES);
  }

  watchlist(): string[] {
    return this.config.get<string[]>(StateKeys.watchlist, []);
  }

  setWatchlist(codes: string[]): Promise<void> {
    return this.config.set(StateKeys.watchlist, [...codes]);
  }

  groups(): StockGroup[] {
    return this.config.get<StockGroup[]>(StateKeys.stockGroups, []);
  }

  setGroups(groups: StockGroup[]): Promise<void> {
    return this.config.set(StateKeys.stockGroups, groups.map((g) => ({ ...g })));
  }

  /** 'all' 虚拟分组的代码顺序：扁平自选在前，之后依次并入各分组（去重） */
  effectiveCodes(groupId: string): string[] {
    if (groupId !== 'all') {
      return this.groups().find((g) => g.id === groupId)?.codes ?? [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const code of [...this.watchlist(), ...this.groups().flatMap((g) => g.codes)]) {
      if (!seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }
    return out;
  }

  /** 添加到 all 时落到扁平列表；指定分组则落分组 */
  async addCode(code: string, groupId: string): Promise<boolean> {
    if (groupId === 'all') {
      const list = this.watchlist();
      if (list.includes(code)) return false;
      await this.setWatchlist([...list, code]);
      return true;
    }
    const groups = this.groups();
    const g = groups.find((x) => x.id === groupId);
    if (!g || g.codes.includes(code)) return false;
    g.codes = [...g.codes, code];
    await this.setGroups(groups);
    return true;
  }

  /** 从所有出现位置移除 */
  async removeCode(code: string): Promise<void> {
    await this.setWatchlist(this.watchlist().filter((c) => c !== code));
    const groups = this.groups();
    let dirty = false;
    for (const g of groups) {
      if (g.codes.includes(code)) {
        g.codes = g.codes.filter((c) => c !== code);
        dirty = true;
      }
    }
    if (dirty) await this.setGroups(groups);
  }

  /** 拖拽重排：codes 为当前视图全部代码的新顺序，逐个桶内按新序回填 */
  async applyOrder(groupId: string, codes: string[]): Promise<void> {
    if (groupId === 'all') {
      await this.setWatchlist(codes.filter((c) => this.watchlist().includes(c)));
    } else {
      const groups = this.groups();
      const g = groups.find((x) => x.id === groupId);
      if (!g) return;
      await this.setGroups(groups.map((x) => (x.id === groupId ? { ...x, codes } : x)));
    }
  }

  trades(): TradeRecord[] {
    return this.config.get<TradeRecord[]>(StateKeys.trades, []);
  }

  tradesFor(code: string): TradeRecord[] {
    return this.trades().filter((t) => t.code === code);
  }

  setTrades(trades: TradeRecord[]): Promise<void> {
    return this.config.set(StateKeys.trades, trades);
  }

  positions(): Position[] {
    return this.config.get<Position[]>(StateKeys.positions, []);
  }

  positionFor(code: string): Position | undefined {
    return this.positions().find((p) => p.code === code);
  }

  async setPosition(code: string, name: string, cost: number, quantity: number): Promise<void> {
    const rest = this.positions().filter((p) => p.code !== code);
    if (quantity > 0 && cost >= 0) rest.push({ code, name, cost, quantity });
    await this.config.set(StateKeys.positions, rest);
  }
}
