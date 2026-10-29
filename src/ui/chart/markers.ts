/**
 * 交易记录 → K线/分时 B·S 标记的纯匹配逻辑（S3，移植 Kotlin TradeMarkerUtil）。
 * 契约里 TradeRecord.date 就是 'YYYY-MM-DD'，日期对齐无需时区换算；
 * 日内定位沿用既有方案：记录没有成交时刻，按成交价反查分时曲线，
 * 容差 max(1分, 0.1%) 取首个触及点，全天未触及标在最接近点，未填价标开盘点。
 * 本文件不依赖 vscode，供 scripts/chart.selftest 直跑。
 */
import type { KlineBar, MinutePoint, TradeRecord } from '../../shared/types';

export interface TradeMarker {
  /** K线：命中的 bar 日期；日内：定位分时点的 'HH:mm' */
  timeKey: string;
  /** 毫秒时间戳，与图表数据点的 timestamp 同一算法生成 */
  timestamp: number;
  /** 标记的纵坐标（成交价；缺价时用所在 bar/点价格兜底） */
  value: number;
  side: 'buy' | 'sell';
  /** 同一位置的同向交易（可能多笔） */
  trades: TradeRecord[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 交易日 'YYYY-MM-DD' → 图表 x 轴毫秒时间戳（锚定上海 15:30，host 与 webview 必须同算法） */
export function dayTimestamp(date: string): number {
  return Date.parse(`${date}T15:30:00+08:00`);
}

/** 'YYYY-MM-DD' + 'HH:mm' → 上海时区毫秒时间戳 */
export function minuteTimestamp(day: string, hhmm: string): number {
  return Date.parse(`${day}T${hhmm}:00+08:00`);
}

function sideRank(side: string): number {
  return side === 'buy' ? 0 : 1;
}

interface Group {
  /** K线为 bar 下标，日内为分时点下标 */
  index: number;
  side: 'buy' | 'sell';
  trades: TradeRecord[];
}

/** 组间按位置升序 + 同位先买后卖（与 Kotlin 版排序要求一致） */
function groupSort<G extends Group>(groups: G[]): G[] {
  return groups.sort((a, b) => a.index - b.index || sideRank(a.side) - sideRank(b.side));
}

/**
 * K线（日/周/月）标记：
 * - 交易日精确命中 bar；非交易日（周末/节假日）顺延到其后最近一根；
 * - 晚于最后一根 bar 的交易丢弃；
 * - 同 bar 同向多笔聚合为一个标记。
 */
export function matchKlineMarkers(trades: TradeRecord[], bars: KlineBar[]): TradeMarker[] {
  if (trades.length === 0 || bars.length === 0) return [];
  const dateIndex = new Map<string, number>();
  bars.forEach((bar, i) => {
    if (!dateIndex.has(bar.date)) dateIndex.set(bar.date, i);
  });

  const groups = new Map<string, Group>();
  for (const t of trades) {
    if (!DATE_RE.test(t.date) || (t.side !== 'buy' && t.side !== 'sell')) continue;
    let idx = dateIndex.get(t.date);
    if (idx === undefined) {
      idx = bars.findIndex((b) => b.date > t.date); // 顺延到下一交易日
      if (idx < 0) continue; // 超出数据右边界，无处可标
    }
    const key = `${idx}|${t.side}`;
    let g = groups.get(key);
    if (!g) {
      g = { index: idx, side: t.side, trades: [] };
      groups.set(key, g);
    }
    g.trades.push(t);
  }

  return groupSort([...groups.values()]).map((g) => {
    const bar = bars[g.index];
    const priced = g.trades.find((t) => t.price > 0);
    return {
      timeKey: bar.date,
      timestamp: dayTimestamp(bar.date),
      value: priced ? priced.price : bar.close,
      side: g.side,
      trades: [...g.trades].sort((a, b) => a.date.localeCompare(b.date)),
    };
  });
}

/**
 * 日内（分时）标记：只标分时数据所属交易日当天（day）的交易。
 * 定位规则见文件头注释；未触及容差时标在全天价格最接近处。
 */
export function matchIntradayMarkers(trades: TradeRecord[], points: MinutePoint[], day: string): TradeMarker[] {
  if (trades.length === 0 || points.length === 0) return [];

  const groups = new Map<string, Group>();
  for (const t of trades) {
    if (t.date !== day || (t.side !== 'buy' && t.side !== 'sell')) continue;
    let idx = 0;
    if (t.price > 0) {
      const tol = Math.max(0.01, t.price * 0.001); // 容差 max(1分, 0.1%)
      idx = points.findIndex((p) => p.price > 0 && Math.abs(p.price - t.price) <= tol);
      if (idx < 0) {
        idx = 0; // 全天未触及：从首点起遍历，标在价格最接近处
        for (let i = 1; i < points.length; i++) {
          if (Math.abs(points[i].price - t.price) < Math.abs(points[idx].price - t.price)) idx = i;
        }
      }
    }
    const key = `${idx}|${t.side}`;
    let g = groups.get(key);
    if (!g) {
      g = { index: idx, side: t.side, trades: [] };
      groups.set(key, g);
    }
    g.trades.push(t);
  }

  const markers: TradeMarker[] = [];
  for (const g of groupSort([...groups.values()])) {
    const p = points[g.index];
    const timestamp = minuteTimestamp(day, p.time);
    if (Number.isNaN(timestamp)) continue;
    markers.push({
      timeKey: p.time,
      timestamp,
      value: g.trades.find((t) => t.price > 0)?.price ?? p.price,
      side: g.side,
      trades: g.trades,
    });
  }
  return markers;
}
