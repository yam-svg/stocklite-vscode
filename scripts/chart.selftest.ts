/**
 * S3 图表逻辑自测：B/S 标记匹配（K线/日内）+ 盈亏回放/组合聚合。
 * 直跑方式：node scripts/chart.selftest.mjs（esbuild 打包本文件后 node 执行）。
 */
import { dayTimestamp, matchIntradayMarkers, matchKlineMarkers, minuteTimestamp } from '../src/ui/chart/markers';
import { calcStockDayRows, mergePortfolio } from '../src/ui/chart/pnl';
import type { KlineBar, MinutePoint, Position, TradeRecord } from '../src/shared/types';

let passed = 0;
let failed = 0;

function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

function approx(a: number, b: number, name: string, eps = 1e-6): void {
  ok(Math.abs(a - b) < eps, `${name}（期望 ${b}，实际 ${a}）`);
}

function trade(p: Partial<TradeRecord> & Pick<TradeRecord, 'side' | 'date'>): TradeRecord {
  return { id: Math.random().toString(36).slice(2), code: 'sh600000', name: '测试', price: 10, quantity: 100, ...p };
}

function bar(date: string, close: number): KlineBar {
  return { date, open: close, close, high: close, low: close, volume: 1000 };
}

// ── K线标记 ──
{
  const bars = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02'].map((d) => bar(d, 10));
  const markers = matchKlineMarkers(
    [
      trade({ side: 'buy', date: '2026-10-27', price: 10 }),
      trade({ side: 'buy', date: '2026-10-27', price: 10.2 }),
      trade({ side: 'sell', date: '2026-10-27', price: 11 }),
      trade({ side: 'buy', date: '2026-10-31', price: 10 }), // 周六 → 顺延 11-02
      trade({ side: 'sell', date: '2026-11-10', price: 10 }), // 超出右边界 → 丢弃
    ],
    bars,
  );
  ok(markers.length === 3, 'K线：右边界外丢弃、同日同向聚合');
  ok(markers[0].timeKey === '2026-10-27' && markers[0].side === 'buy', 'K线：精确命中');
  ok(markers[1].side === 'sell' && markers[1].timeKey === '2026-10-27', 'K线：同 bar 先买后卖');
  ok(markers[0].trades.length === 2, 'K线：同向多笔聚合为一枚标记');
  ok(markers[2].timeKey === '2026-11-02', 'K线：非交易日顺延到下一根 bar');
  approx(markers[0].timestamp, dayTimestamp('2026-10-27'), 'K线：时间戳与 dayTimestamp 一致');
  approx(markers[0].value, 10, 'K线：标记价位取首笔有价交易');

  const zeroPrice = matchKlineMarkers([trade({ side: 'buy', date: '2026-10-28', price: 0 })], bars);
  approx(zeroPrice[0].value, 10, 'K线：缺价交易用所在 bar 收盘价兜底');

  const sorted = matchKlineMarkers(
    [trade({ side: 'sell', date: '2026-10-29' }), trade({ side: 'buy', date: '2026-10-26' })],
    bars,
  );
  ok(sorted[0].timeKey === '2026-10-26' && sorted[1].timeKey === '2026-10-29', 'K线：标记按 bar 升序');
}

// ── 日内标记 ──
{
  const points: MinutePoint[] = [];
  for (let i = 0; i <= 30; i++) {
    const total = 9 * 60 + 30 + i; // 09:30 起逐分钟到 10:00
    const time = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    points.push({ time, price: 10 + i * 0.02 }); // 10.00 → 10.60 单边上行
  }
  const day = '2026-10-29';
  const markers = matchIntradayMarkers(
    [
      trade({ side: 'buy', date: day, price: 10.2 }),
      trade({ side: 'sell', date: '2026-10-28', price: 10.4 }), // 非当日 → 过滤
      trade({ side: 'buy', date: day, price: 20 }), // 全天未触及 → 最接近点（尾盘）
      trade({ side: 'sell', date: day, price: 0 }), // 未填价 → 开盘点
    ],
    points,
    day,
  );
  ok(markers.length === 3, '日内：非当日交易被过滤');
  ok(markers[0].timeKey === '09:30' && markers[0].side === 'sell', '日内：未填价标在开盘点');
  const touch = markers.find((m) => m.side === 'buy' && m.timeKey === '09:40');
  ok(!!touch && Math.abs(touch.value - 10.2) <= Math.max(0.01, 10.2 * 0.001), '日内：容差内首个触及点');
  const far = markers.find((m) => m.side === 'buy' && m.timeKey === '10:00');
  ok(!!far, '日内：未触及标在全天最接近处（尾盘最高价）');
  approx(markers[0].timestamp, minuteTimestamp(day, '09:30'), '日内：时间戳与 minuteTimestamp 一致');
  ok(markers.every((m) => !Number.isNaN(m.timestamp)), '日内：时间戳无 NaN');
}

// ── 盈亏回放 ──
{
  const bars = [bar('2026-10-26', 10), bar('2026-10-27', 11), bar('2026-10-28', 12)];
  const rows = calcStockDayRows([trade({ side: 'buy', date: '2026-10-26', price: 10, quantity: 100 })], undefined, bars);
  ok(rows.length === 3, '盈亏：交易日从首笔交易开始');
  approx(rows[0].cumPnl, 0, '盈亏：建仓日浮盈为 0');
  approx(rows[1].cumPnl, 100, '盈亏：浮盈 =（收盘−成本）×持仓');
  approx(rows[1].dayPct, 10, '盈亏：当日收益率分母=上一日市值');
  approx(rows[2].cumPnl, 200, '盈亏：累计浮盈');

  const withSell = calcStockDayRows(
    [
      trade({ side: 'buy', date: '2026-10-26', price: 10, quantity: 100 }),
      trade({ side: 'sell', date: '2026-10-27', price: 11, quantity: 50 }),
    ],
    undefined,
    bars,
  );
  approx(withSell[1].cumPnl, 100, '盈亏：卖出日 = 已实现50 + 浮盈50');
  approx(withSell[2].cumPnl, 150, '盈亏：剩余半仓浮盈进入累计');

  const avgCost = calcStockDayRows(
    [
      trade({ side: 'buy', date: '2026-10-26', price: 10, quantity: 100 }),
      trade({ side: 'buy', date: '2026-10-27', price: 12, quantity: 100 }),
    ],
    undefined,
    bars,
  );
  approx(avgCost[2].cumPnl, 200, '盈亏：摊薄成本 (10+12)/2=11，两仓位浮盈 (12-11)*200');

  const overSell = calcStockDayRows(
    [
      trade({ side: 'buy', date: '2026-10-26', price: 10, quantity: 100 }),
      trade({ side: 'sell', date: '2026-10-27', price: 11, quantity: 500 }),
    ],
    undefined,
    bars,
  );
  approx(overSell[1].cumPnl, 100, '盈亏：超卖按持仓量截断计已实现 (11-10)*100');
  approx(overSell[2].cumPnl, 100, '盈亏：清仓后累计不再变化（持仓不为负）');

  const position: Position = { code: 'sh600000', name: '测试', cost: 10, quantity: 100 };
  const manual = calcStockDayRows([], position, bars);
  approx(manual[2].cumPnl, 200, '盈亏：手动持仓合成建仓生效');
  ok(calcStockDayRows([], undefined, bars).length === 0, '盈亏：无交易无持仓 → 空');
}

// ── 组合聚合 ──
{
  const rowsA = calcStockDayRows([trade({ code: 'a', side: 'buy', date: '2026-10-26', price: 10 })], undefined, [
    bar('2026-10-26', 10), bar('2026-10-27', 11), bar('2026-10-28', 12),
  ]);
  const rowsB = calcStockDayRows([trade({ code: 'b', side: 'buy', date: '2026-10-27', price: 20 })], undefined, [
    bar('2026-10-27', 20), bar('2026-10-28', 21),
  ]);
  const merged = mergePortfolio([
    { code: 'a', name: 'A', rows: rowsA },
    { code: 'b', name: 'B', rows: rowsB },
  ]);
  ok(merged.dates.join(',') === '2026-10-26,2026-10-27,2026-10-28', '组合：日期并集升序');
  approx(merged.dayByDate['2026-10-27'], 100, '组合：当日盈亏求和（A+100、B 建仓日 0 不计明细）');
  approx(merged.cum[2], 300, '组合：末日累计 = A浮盈200 + B浮盈100');
  ok(!!merged.details['2026-10-27'] && merged.details['2026-10-27'].length === 1, '组合：零盈亏日不进明细');
}

console.log(`chart.selftest: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
