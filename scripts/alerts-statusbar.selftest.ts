/**
 * S4 自测：提醒引擎 + 状态栏格式化（node 直跑，不依赖 vscode 运行时）。
 * 运行：npx esbuild scripts/alerts-statusbar.selftest.ts --bundle --platform=node --format=cjs --outfile=out/s4-selftest.cjs && node out/s4-selftest.cjs
 * 注意：只允许 import 不依赖 vscode 的模块（engine / format / providerRef）。
 */
import {
  BreadthJumpDetector,
  RuleEvaluator,
  SealShrinkDetector,
  breadthPollDelayMs,
  isContinuousSession,
  type BreadthSample,
  type ExtendedStockAlert,
} from '../src/features/alerts/engine';
import { bindStockProvider, resolveStockProvider } from '../src/features/alerts/providerRef';
import { formatPct, formatPrice, statusText, tooltipLines, trendOf } from '../src/features/statusbar/format';
import type { Quote } from '../src/shared/types';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 北京时间 'YYYY-MM-DD HH:mm' → UTC 毫秒（无夏令时，固定 UTC+8） */
function cnTs(s: string): number {
  const [d, t] = s.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  return Date.UTC(y, mo - 1, da, h - 8, mi);
}

function alert(patch: Partial<ExtendedStockAlert>): ExtendedStockAlert {
  return { id: 'a1', code: 'sh600000', name: '测试股', type: 'priceAbove', threshold: 10, enabled: true, ...patch };
}

function quote(patch: Partial<Quote>): Quote {
  return { code: 'sh600000', name: '测试股', price: 10, prevClose: 10, ...patch };
}

async function main(): Promise<void> {
  console.log('[时段判定]');
  check('连续竞价 10:00', isContinuousSession(cnTs('2026-10-29 10:00')));
  check('开盘竞价 09:20 排除', !isContinuousSession(cnTs('2026-10-29 09:20')));
  check('午间休市 12:00 排除', !isContinuousSession(cnTs('2026-10-29 12:00')));
  check('收盘竞价 14:58 排除', !isContinuousSession(cnTs('2026-10-29 14:58')));

  console.log('[宽度轮询分档（BreadthWatcherService 策略）]');
  check('盘中 10:00 → 60s', breadthPollDelayMs(cnTs('2026-10-29 10:00')) === 60_000);
  check('尾盘 15:00 → 30s', breadthPollDelayMs(cnTs('2026-10-29 15:00')) === 30_000);
  check('收盘后 16:00 → 2min', breadthPollDelayMs(cnTs('2026-10-29 16:00')) === 120_000);
  check('夜间 20:00 → 10min', breadthPollDelayMs(cnTs('2026-10-29 20:00')) === 600_000);
  check('周六 10:00 → 1h', breadthPollDelayMs(cnTs('2026-10-31 10:00')) === 3_600_000);
  check('深夜 23:00 → 1h', breadthPollDelayMs(cnTs('2026-10-29 23:00')) === 3_600_000);

  console.log('[到价/涨跌幅：边沿触发 + 滞回再武装]');
  {
    let clock = cnTs('2026-10-29 10:00');
    const ev = new RuleEvaluator(() => clock);
    const a = alert({ type: 'priceAbove', threshold: 10 });
    check('未达阈值不触发', !ev.evaluate(a, quote({ price: 9 })));
    check('上破触发', ev.evaluate(a, quote({ price: 10.5 })));
    check('条件保持成立不重复触发', !ev.evaluate(a, quote({ price: 10.6 })));
    check('回到阈值下但滞回带内不武装', !ev.evaluate(a, quote({ price: 9.99 })));
    check('滞回带内回升不触发', !ev.evaluate(a, quote({ price: 10.2 })));
    check('回落越带再武装', !ev.evaluate(a, quote({ price: 9.9 })));
    check('再上破再次触发', ev.evaluate(a, quote({ price: 10.1 })));
  }
  {
    const ev = new RuleEvaluator();
    const a = alert({ type: 'priceBelow', threshold: 10 });
    check('价格下破触发', ev.evaluate(a, quote({ price: 9.9 })));
    check('回到带内不重复', !ev.evaluate(a, quote({ price: 9.99 })));
    check('回升越带再武装后再下破触发', ev.evaluate(a, quote({ price: 10.03 })) === false && ev.evaluate(a, quote({ price: 9.9 })));
  }
  {
    const ev = new RuleEvaluator();
    const up = alert({ id: 'c1', type: 'changeAbove', threshold: 3 });
    check('涨幅未达阈值', !ev.evaluate(up, quote({ price: 10.2, changePct: 2 })));
    check('涨幅达标触发', ev.evaluate(up, quote({ price: 10.35, changePct: 3.5 })));
    check('涨幅保持不重复', !ev.evaluate(up, quote({ price: 10.4, changePct: 4 })));
    const down = alert({ id: 'c2', type: 'changeBelow', threshold: -3 });
    check('跌幅未达标', !ev.evaluate(down, quote({ price: 9.8, changePct: -2 })));
    check('跌幅达标触发', ev.evaluate(down, quote({ price: 9.65, changePct: -3.5 })));
  }
  {
    check('禁用状态不触发', !new RuleEvaluator().evaluate(alert({ enabled: false }), quote({ price: 99 })));
    const ev = new RuleEvaluator();
    check('changePct 缺省由价格/前收推算', ev.evaluate(alert({ type: 'changeAbove', threshold: 3 }), quote({ price: 10.4, prevClose: 10 })));
  }
  {
    // 窗口重载抑制：当日已触发且条件仍成立 → 首轮不重复弹；隔日则重新计
    let clock = cnTs('2026-10-29 10:00');
    const firedToday = alert({ lastFiredAt: cnTs('2026-10-29 09:40') });
    check('当日已触发且条件成立：重启后静默', !new RuleEvaluator(() => clock).evaluate(firedToday, quote({ price: 10.5 })));
    const firedYesterday = alert({ lastFiredAt: cnTs('2026-10-28 09:40') });
    check('昨日触发今日仍成立：重新触发', new RuleEvaluator(() => clock).evaluate(firedYesterday, quote({ price: 10.5 })));
    clock = cnTs('2026-10-30 10:00');
    const ev2 = new RuleEvaluator(() => clock);
    check('跨日：条件先假再真可再次触发', !ev2.evaluate(firedToday, quote({ price: 9 })) && ev2.evaluate(firedToday, quote({ price: 10.5 })));
  }

  console.log('[封单锐减（AlertManager.checkSealShrink 移植）]');
  {
    const base = cnTs('2026-10-29 10:00');
    let clock = base;
    const det = new SealShrinkDetector(() => clock);
    const seal = (lots: number): Quote => quote({ extra: { sealLots: lots } });
    clock = base;
    check('采样1无事件', det.feed([seal(2000)]).length === 0);
    clock = base + 5_000;
    check('采样2无事件', det.feed([seal(1500)]).length === 0);
    clock = base + 10_000;
    check('采样3无事件', det.feed([seal(1200)]).length === 0);
    clock = base + 15_000;
    const evs = det.feed([seal(900)]);
    check('4 采样降 55% 触发', evs.length === 1 && evs[0].dir === 'U' && evs[0].pct >= 50, JSON.stringify(evs[0]));
    clock = base + 20_000;
    check('当日同向去重', det.feed([seal(500)]).length === 0);
  }
  {
    const base = cnTs('2026-10-29 10:00');
    let clock = base;
    const det = new SealShrinkDetector(() => clock);
    clock = base;
    det.feed([quote({ extra: { sealLots: -20000 } })]);
    clock = base + 5_000;
    const evs = det.feed([quote({ extra: { sealLots: -9000 } })]);
    check('断崖特判：2 采样大额抽单触发且 dir=D', evs.length === 1 && evs[0].cliff && evs[0].dir === 'D', JSON.stringify(evs[0]));
  }
  {
    const base = cnTs('2026-10-29 10:00');
    let clock = base;
    const det = new SealShrinkDetector(() => clock);
    const seal = (lots: number): Quote => quote({ extra: { sealLots: lots } });
    for (const [i, lots] of [800, 600, 400, 100].entries()) {
      clock = base + i * 5_000;
      det.feed([seal(lots)]);
    }
    clock = base + 20_000;
    check('基线 <1000 手不触发', det.feed([seal(50)]).length === 0);
  }
  {
    const base = cnTs('2026-10-29 10:00');
    let clock = base;
    const det = new SealShrinkDetector(() => clock);
    clock = base;
    det.feed([quote({ extra: { sealLots: 2000 } })]);
    clock = base + 5_000;
    det.feed([quote({ extra: { sealLots: 1800 } })]);
    clock = base + 10_000;
    const evs = det.feed([quote({})]); // 开板：封单归零事件
    check('封板→开板按锐减到 0 评估', evs.length === 1 && evs[0].curLots === 0, JSON.stringify(evs[0]));
    check('归零后历史清空', det.feed([quote({})]).length === 0);
  }
  {
    // 集合竞价时段不采样、清空历史，避免污染正盘基线
    const det = new SealShrinkDetector(() => cnTs('2026-10-29 09:20'));
    check('竞价时段采样直接丢弃', det.feed([quote({ extra: { sealLots: 20000 } })]).length === 0);
  }
  {
    // 60s 滑窗：超出窗口的采样被裁剪，不足 4 点不触发趋势告警
    const base = cnTs('2026-10-29 10:00');
    let clock = base;
    const det = new SealShrinkDetector(() => clock);
    const seal = (lots: number): Quote => quote({ extra: { sealLots: lots } });
    clock = base;
    det.feed([seal(2000)]);
    clock = base + 5_000;
    det.feed([seal(1900)]);
    clock = base + 10_000;
    det.feed([seal(1800)]);
    clock = base + 70_000;
    check('窗口裁剪后不足 4 点不触发', det.feed([seal(900)]).length === 0);
  }
  {
    // 方向切换（开板后反向封板）不沿用旧基线
    const base = cnTs('2026-10-29 10:00');
    let clock = base;
    const det = new SealShrinkDetector(() => clock);
    clock = base;
    det.feed([quote({ extra: { sealLots: 3000 } })]);
    clock = base + 5_000;
    det.feed([quote({ extra: { sealLots: -2500 } })]); // U→D 切换
    clock = base + 10_000;
    det.feed([quote({ extra: { sealLots: -1200 } })]);
    clock = base + 15_000;
    const evs = det.feed([quote({ extra: { sealLots: -1100 } })]);
    check('反向封板以新方向为基线（无 U 事件）', evs.every((e) => e.dir === 'D'), JSON.stringify(evs));
  }

  console.log('[大盘宽度异动]');
  {
    let clock = cnTs('2026-10-29 10:00');
    const det = new BreadthJumpDetector(() => clock);
    const s = (up: number, down: number): BreadthSample => ({ ts: clock, up, down, flat: 0 });
    det.feed(s(2000, 1700)); // diff=300 温和区
    clock += 5 * 60_000;
    const jump = det.feed(s(2600, 1600)); // diff=1000 极端区
    check('涨跌差由温和冲入极端触发', jump?.dir === 'up' && jump.fromDiff === 300 && jump.toDiff === 1000, JSON.stringify(jump));
    clock += 2 * 60_000;
    check('前值仍在极端区不再触发', det.feed(s(2700, 1700)) === undefined);
    clock += 35 * 60_000;
    det.feed(s(2000, 1800)); // 回到温和区（冷却也已解除）
    clock += 2 * 60_000;
    check('同方向当日去重', det.feed(s(2600, 1600)) === undefined);
    clock += 60 * 60_000;
    det.feed(s(2100, 1900)); // diff=200 温和
    clock += 2 * 60_000;
    const jump2 = det.feed(s(1600, 2500)); // diff=-900 极端下跌
    check('下跌方向可触发', jump2?.dir === 'down', JSON.stringify(jump2));
  }
  {
    let clock = cnTs('2026-10-29 10:00');
    const det = new BreadthJumpDetector(() => clock);
    const s = (up: number, down: number): BreadthSample => ({ ts: clock, up, down, flat: 0 });
    det.feed(s(2000, 1700));
    clock += 30 * 60_000; // 间隔超 10 分钟
    check('采样间隔过大不比较', det.feed(s(2600, 1600)) === undefined);
  }

  console.log('[状态栏格式化]');
  check('formatPct 正值带 +', formatPct(1.234) === '+1.23%');
  check('formatPct 负值', formatPct(-2.5) === '-2.50%');
  check('formatPrice 大额一位小数', formatPrice(1680.123) === '1680.1');
  check('formatPrice 常规两位', formatPrice(9.876) === '9.88');
  check('trendOf 平盘阈值', trendOf(quote({ price: 10, prevClose: 10, changePct: 0.001 })) === 'flat');
  {
    const up = quote({ price: 10.5, prevClose: 10 });
    check('上涨文本带上箭头与百分比', statusText(up) === '$(arrow-small-up) 测试股 10.50 +5.00%', statusText(up));
    const dn = quote({ price: 9.5, prevClose: 10 });
    check('下跌文本带下箭头', statusText(dn).startsWith('$(arrow-small-down)'));
    const tip = tooltipLines(quote({ price: 10.5, prevClose: 10, change: 0.5, changePct: 5, amount: 2.3e8, time: '14:59' }));
    check('tooltip 含成交额与时间', tip.some((l) => l.includes('2.30 亿')) && tip.some((l) => l.includes('14:59')));
  }

  console.log('[providerRef 垫片]');
  {
    const before = resolveStockProvider();
    check('未绑定回落 mockProvider', before.id === 'mock:stock');
    const fake = { ...before, id: 'real:stock' };
    bindStockProvider(fake);
    check('绑定后返回注入 provider', resolveStockProvider().id === 'real:stock');
    bindStockProvider(before);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
