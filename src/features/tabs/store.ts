/**
 * 可选 tab 的简单列表仓库（S6）：基金/期货/加密自选、美股 ETF 显示清单。
 * 持久化走 ConfigStore(globalState)：有注册键的用 StateKeys，没有的用独立字面量键
 * （与 S2 的 SEEDED_KEY 同一做法，S7 上收注册表时一并处理，见 contract-changes.md 提案）。
 * 播种判据：专用布尔键，绝不判“数据是否为空”（S2 沿用的 JetBrains 版教训：
 * 播种本身写数据、用户删掉示例后还会被复活）。
 */
import type { ConfigStore } from '../../shared/config';

/** 期货首用播种标记（判据模式照搬 S2 watchlistDefaultsSeeded，独立键互不干扰） */
export const FUTURES_SEEDED_KEY = 'futuresDefaultsSeeded';
/** 加密首用播种标记（对齐 Kotlin CryptoPanel.cryptoDefaultsSeeded） */
export const CRYPTO_SEEDED_KEY = 'cryptoDefaultsSeeded';
/** 美股板块 ETF 显示清单（未写入=33 只全显；首次删改后显式落盘） */
export const US_ETF_LIST_KEY = 'usEtfWatchlist';

/** 内置默认期货（对齐 Kotlin 期货内置默认：纳斯达克100 + 布伦特原油） */
export const FUTURE_SEEDS = ['hf_NQ', 'hf_OIL'];
/** 内置默认加密币（对齐 Kotlin CryptoPanel 播种：主流六币 USDT 计价） */
export const CRYPTO_SEEDS = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'BNB_USDT', 'XRP_USDT', 'DOGE_USDT'];

/** 代码列表型自选的通用仓库（列表语义：顺序即展示顺序，可拖拽重排） */
export class TabListStore {
  constructor(
    private readonly config: ConfigStore,
    private readonly stateKey: string,
    private readonly opts: { seedKey?: string; seedCodes?: string[] } = {},
  ) {}

  async seedDefaultsIfNeeded(): Promise<void> {
    const { seedKey, seedCodes } = this.opts;
    if (!seedKey) return;
    if (this.config.get<boolean>(seedKey, false)) return;
    await this.config.set(seedKey, true);
    if (this.list().length === 0 && (seedCodes?.length ?? 0) > 0) await this.setList(seedCodes!);
  }

  list(): string[] {
    return this.config.get<string[]>(this.stateKey, []);
  }

  setList(codes: string[]): Promise<void> {
    return this.config.set(this.stateKey, [...codes]);
  }

  async add(code: string): Promise<boolean> {
    const list = this.list();
    if (list.includes(code)) return false;
    await this.setList([...list, code]);
    return true;
  }

  async remove(code: string): Promise<void> {
    await this.setList(this.list().filter((c) => c !== code));
  }

  includes(code: string): boolean {
    return this.list().includes(code);
  }

  /** 拖拽重排：视图内代码按新序回填，视图外代码保持原相对顺序附在尾部 */
  async applyOrder(viewCodes: string[]): Promise<void> {
    const current = this.list();
    const known = new Set(current);
    const ordered = viewCodes.filter((c) => known.has(c));
    const rest = current.filter((c) => !viewCodes.includes(c));
    await this.setList([...ordered, ...rest]);
  }
}

/**
 * 美股 ETF 显示清单：globalState 未写入时=全部（fallback 传目录全量），
 * 之后一律以落盘值为准——用户删空也保持空，不会被“fallback=全部”复活。
 */
export function usEtfDisplayList(config: ConfigStore, allSymbols: string[]): string[] {
  return config.get<string[]>(US_ETF_LIST_KEY, allSymbols);
}
