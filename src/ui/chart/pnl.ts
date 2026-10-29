/**
 * 持仓盈亏回放与组合聚合（S3，移植 Kotlin PnlChartService）。
 * 逐日盈亏 = 截至当日累计已实现盈亏 + (当日收盘 − 当时成本) × 当时持仓量；
 * 手动录入、从未记过交易的持仓，按成本价合成一笔建仓使走势/日历有效。
 * 本文件不依赖 vscode，供 scripts/chart.selftest 直跑。
 */
import type { KlineBar, Position, TradeRecord } from '../../shared/types';

/** 单只股票单日回放明细（对应 Kotlin DayRow） */
export interface DayRow {
  date: string;
  /** 累计盈亏（已实现 + 未实现） */
  cumPnl: number;
  /** 当日盈亏 */
  dayPnl: number;
  /** 当日收益率%，分母取上一交易日收盘市值（首日取 市值−当日盈亏 ≈ 成本口径） */
  dayPct: number;
}

export interface StockPnl {
  code: string;
  name: string;
  rows: DayRow[];
}

export interface DayStockDetail {
  name: string;
  pnl: number;
  pct: number;
}

export interface PortfolioPnl {
  /** 全部有数据的交易日，升序 */
  dates: string[];
  /** 与 dates 对齐的组合累计盈亏（各股 cumPnl 按日求和） */
  cum: number[];
  /** 日期 → 组合当日盈亏（月历热图输入） */
  dayByDate: Record<string, number>;
  /** 日期 → 各股当日盈亏明细（日历点击展开） */
  details: Record<string, DayStockDetail[]>;
}

/** 无交易记录的手动持仓 → 按成本价合成建仓（日期取 K 线首日，效果等同 Kotlin createdAt=0 分支） */
export function effectiveTrades(trades: TradeRecord[], position: Position | undefined, bars: KlineBar[]): TradeRecord[] {
  if (trades.length > 0 || !position || position.quantity <= 0 || position.cost <= 0 || bars.length === 0) {
    return trades;
  }
  const synthetic: TradeRecord = {
    id: `synthetic:${position.code}`,
    code: position.code,
    name: position.name,
    side: 'buy',
    price: position.cost,
    quantity: position.quantity,
    date: bars[0].date,
    note: '手动持仓合成',
  };
  return [synthetic];
}

/**
 * 按时间顺序回放交易记录计算单只股票的逐日明细。
 * date 为 'YYYY-MM-DD'，字典序即时间序；同一天多笔按录入顺序回放（与 Kotlin tradeAt 排序等价）。
 */
export function calcStockDayRows(
  trades: TradeRecord[],
  position: Position | undefined,
  bars: KlineBar[],
): DayRow[] {
  const effective = effectiveTrades(trades, position, bars);
  if (effective.length === 0 || bars.length === 0) return [];

  const sorted = [...effective].sort((a, b) => a.date.localeCompare(b.date));
  const firstTradeDate = sorted[0].date;

  let tradeIdx = 0;
  let qty = 0;
  let cost = 0;
  let realized = 0;
  let prevCum = 0;
  let prevMkt = 0;
  let hasPrev = false;
  const result: DayRow[] = [];

  for (const bar of [...bars].sort((a, b) => a.date.localeCompare(b.date))) {
    if (bar.date < firstTradeDate) continue;

    // 回放截至当日的所有交易
    while (tradeIdx < sorted.length && sorted[tradeIdx].date <= bar.date) {
      const r = sorted[tradeIdx];
      if (r.side === 'buy') {
        const newQty = qty + r.quantity;
        cost = newQty > 0 ? (cost * qty + r.price * r.quantity) / newQty : r.price;
        qty = newQty;
      } else {
        const actualSell = Math.min(r.quantity, qty);
        if (actualSell > 0) realized += (r.price - cost) * actualSell;
        qty = Math.max(qty - r.quantity, 0);
      }
      tradeIdx++;
    }

    const unrealized = qty > 0 && cost > 0 ? (bar.close - cost) * qty : 0;
    const cum = realized + unrealized;
    const mkt = qty > 0 ? bar.close * qty : 0;
    const dayPnl = cum - prevCum;
    const denom = hasPrev && prevMkt > 0 ? prevMkt : mkt - dayPnl;
    const dayPct = denom > 0 ? (dayPnl / denom) * 100 : 0;
    result.push({ date: bar.date, cumPnl: cum, dayPnl, dayPct });
    prevCum = cum;
    prevMkt = mkt;
    hasPrev = true;
  }
  return result;
}

/** 组合聚合：累计曲线按日求和、月历热图取当日盈亏、明细保留各股当日贡献 */
export function mergePortfolio(stocks: StockPnl[]): PortfolioPnl {
  const cumByDate = new Map<string, number>();
  const dayByDate = new Map<string, number>();
  const details = new Map<string, DayStockDetail[]>();

  for (const stock of stocks) {
    for (const row of stock.rows) {
      cumByDate.set(row.date, (cumByDate.get(row.date) ?? 0) + row.cumPnl);
      dayByDate.set(row.date, (dayByDate.get(row.date) ?? 0) + row.dayPnl);
      if (Math.abs(row.dayPnl) > 1e-9 || Math.abs(row.dayPct) > 1e-9) {
        const list = details.get(row.date) ?? [];
        list.push({ name: stock.name || stock.code, pnl: row.dayPnl, pct: row.dayPct });
        details.set(row.date, list);
      }
    }
  }

  const dates = [...cumByDate.keys()].sort();
  return {
    dates,
    cum: dates.map((d) => cumByDate.get(d) ?? 0),
    dayByDate: Object.fromEntries(dayByDate),
    details: Object.fromEntries(details),
  };
}
