/**
 * 持仓推导与盈亏计算（纯函数）。
 * 公式对齐 JetBrains 版 MarketTimeUtil.calcTodayPnl / calcRealizedPnl：
 *  - 持仓成本 = 加权平均成本法回放成交记录（SELL 不减成本）；
 *  - 今日盈亏（精确模式）= 昨收基准 × 今日操作前仓位 + 今日 BUY 逐笔 (现价-买价)×量；
 *  - 无今日记录时 = 涨跌额 × 持仓数量。
 * 与 Swing 版差异：StockliteState 的 snapshotQty 手工快照机制不移植——
 * 仓位一律由成交记录推导（或用户手填覆盖），今日建仓自然被精确模式覆盖。
 */
import type { Position, Quote, TradeRecord } from '../../shared/types';

/** 'YYYY-MM-DD'（上海时区）——交易记录日期与时区判定统一入口 */
export function todayShanghai(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** 回放成交记录推导当前持仓（加权平均成本法）；无有效持仓返回 quantity=0 */
export function derivePosition(records: TradeRecord[]): { cost: number; quantity: number } {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let qty = 0;
  let cost = 0;
  for (const r of sorted) {
    if (r.side === 'buy') {
      const newQty = qty + r.quantity;
      cost = newQty > 0 ? (cost * qty + r.price * r.quantity) / newQty : r.price;
      qty = newQty;
    } else {
      qty = Math.max(0, qty - r.quantity);
      if (qty === 0) cost = 0;
    }
  }
  return { cost, quantity: qty };
}

/** 已实现盈亏：每次 SELL (卖价-当时成本)×量 累计 */
export function realizedPnl(records: TradeRecord[]): number {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let qty = 0;
  let cost = 0;
  let realized = 0;
  for (const r of sorted) {
    if (r.side === 'buy') {
      const newQty = qty + r.quantity;
      cost = newQty > 0 ? (cost * qty + r.price * r.quantity) / newQty : r.price;
      qty = newQty;
    } else {
      const actual = Math.min(r.quantity, qty);
      if (actual > 0) realized += (r.price - cost) * actual;
      qty = Math.max(0, qty - r.quantity);
    }
  }
  return realized;
}

/** 用户手填覆盖优先，否则按成交记录推导 */
export function effectivePosition(records: TradeRecord[], override?: Position): { cost: number; quantity: number } {
  if (override && override.quantity > 0) return { cost: override.cost, quantity: override.quantity };
  return derivePosition(records);
}

export function holdingsPnl(quote: Quote | undefined, pos: { cost: number; quantity: number }): number {
  if (!quote || pos.quantity <= 0 || pos.cost <= 0) return 0;
  return (quote.price - pos.cost) * pos.quantity;
}

/** 今日盈亏：有今日 BUY 记录时按买入价逐笔精确算，其余按昨收基准 */
export function todayPnl(
  quote: Quote | undefined,
  pos: { cost: number; quantity: number },
  records: TradeRecord[],
  today = todayShanghai(),
): number {
  if (!quote || pos.quantity <= 0) return 0;
  const change = typeof quote.change === 'number' ? quote.change : quote.price - quote.prevClose;
  const todayRecords = records.filter((r) => r.date === today);
  if (todayRecords.length > 0) {
    const netBuy = todayRecords.filter((r) => r.side === 'buy').reduce((s, r) => s + r.quantity, 0);
    const netSell = todayRecords.filter((r) => r.side === 'sell').reduce((s, r) => s + r.quantity, 0);
    const historyQty = Math.max(0, pos.quantity - netBuy + netSell);
    const todayBuyPnl = todayRecords
      .filter((r) => r.side === 'buy')
      .reduce((s, r) => s + (quote.price - r.price) * r.quantity, 0);
    return change * historyQty + todayBuyPnl;
  }
  return change * pos.quantity;
}
