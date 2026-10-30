/**
 * G2 研判自测（node 直跑，vscode 依赖经桩替换）：ForecastService.kt 移植的逐常量对照。
 * 覆盖：情绪五档/跳空三态/方向阈值分档、gap 回归公式（全量/单侧/缺项/限幅）、
 * 天气分六因子打分与封板率、两段卡生成锁（初版锁/终版锁/同日唯一/130 条裁剪）、
 * T-1 极值与暴跌反转、汇率极值、结算双账本（盘前只结跳空/盘后全结/错过日期结而不统计）、
 * 双账本统计过滤、watcher 调度表、Yahoo 早盘解析（休市旧数据防护）、因子 JSON NaN 往返、
 * tabkit header 槽模板注入与锚点降级。
 */
import {
  sentimentTier, gapState, directionOf, impliedGapPct, computeSentiment, getSentiment,
  inPreOpenWindow, generatePreOpenForecast, latestRecord, rehydrate, settleForecasts, getStats,
  factorsToJson, parseFactorsJson, parseYahooMorning, createForecastStore,
  makeRealDeps, runWatchTick, nextDelayMs, coldStartDelayMs,
  A50_SLOPE, NDX_SLOPE, ASIA_SLOPE, GAP_INTERCEPT, MAX_RECORDS,
  type ForecastDeps, type ForecastRecord, type ForecastMemento,
} from '../src/data/forecast';
import { renderTableHtml } from '../src/ui/watchlist/table/webviewHtml';
import { withHeaderSlot } from '../src/features/tabs/tabkit';

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
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

/** 北京时间钟点工厂（2026-10-29=周四、10-31=周六） */
const bj = (day: number, h: number, m = 0): number => Date.UTC(2026, 9, day, h - 8, m);
const THU_0900 = bj(29, 9);
const THU_0916 = bj(29, 9, 16);
const THU_0926 = bj(29, 9, 26);
const THU_1000 = bj(29, 10);
const THU_1200 = bj(29, 12);
const THU_1530 = bj(29, 15, 30);
const THU_1630 = bj(29, 16, 30);
const THU_2130 = bj(29, 21, 30);
const SAT_0900 = bj(31, 9);
const TODAY = '2026-10-29';

const fakeDeps = (over: Partial<ForecastDeps> = {}): ForecastDeps => ({
  breadth: async () => ({}),
  limitEco: async () => null,
  ashareLastBarDate: async () => TODAY,
  a50ChangePct: async () => null,
  usdcnhPct: async () => null,
  ndxOvernightPct: async () => null,
  asiaMorningAvgPct: async () => null,
  settleSnapshot: async () => null,
  isTodayTradingDay: async () => true,
  ...over,
});

/** 内存版 Memento：update 走 JSON 往返，模拟 globalState 的 NaN→null 序列化 */
const fakeMemento = (): ForecastMemento => {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string, d: T): T => (data.has(k) ? (data.get(k) as T) : d),
    update: (k, v) => { data.set(k, JSON.parse(JSON.stringify(v ?? null))); },
  };
};

const rec = (over: Partial<ForecastRecord> = {}): ForecastRecord => ({
  date: TODAY, score: 30, direction: 'BULL', generatedAt: '09:00', actualPct: NaN,
  settled: false, correct: false, kind: 'PRE', gapPct: 0.5, openPct: NaN, openHit: false,
  factorsJson: '[]', finalized: true, ...over,
});

const busyEco = { ztCount: 150, dtCount: 80, zbCount: 0, maxLianban: 7 };
const busyBreadth = { upCount: 3500, downCount: 500, totalTurnover: 2.1e12, prevTurnoverSameTime: 1.4e12 };
const iceBreadth = { upCount: 500, downCount: 3500, totalTurnover: 7e11, prevTurnoverSameTime: 1.4e12 };

async function main(): Promise<void> {
  console.log('[分档纯函数]');
  {
    check('情绪五档边界（50 过热/20 热烈/-20 冷清/-50 冰点）',
      sentimentTier(50) === 'overheated' && sentimentTier(49.9) === 'hot'
      && sentimentTier(20) === 'hot' && sentimentTier(19.9) === 'normal'
      && sentimentTier(-20) === 'cold' && sentimentTier(-49.9) === 'cold'
      && sentimentTier(-50) === 'freezing');
    check('跳空三态含 NaN（±0.15 阈值含边界）',
      gapState(0.15) === 'HIGH' && gapState(0.14) === 'FLAT'
      && gapState(-0.15) === 'LOW' && gapState(-0.14) === 'FLAT' && gapState(NaN) === 'NAN');
    check('方向阈值 ±20 分', directionOf(20) === 'BULL' && directionOf(-20) === 'BEAR' && directionOf(19.9) === 'NEUTRAL');
  }

  console.log('[gap 回归公式]');
  {
    check('全量：0.025+0.171+0.177+0.184=0.557', near(impliedGapPct(1, 1, 1, true), GAP_INTERCEPT + A50_SLOPE + NDX_SLOPE + ASIA_SLOPE, 1e-12) && near(impliedGapPct(1, 1, 1, true), 0.557));
    check('初版并入 asia 参数被忽略（finalized=false）', near(impliedGapPct(1, 1, 1, false), 0.373));
    check('单侧缺项直接用一元系数', near(impliedGapPct(1, null, null, false), 0.196) && near(impliedGapPct(null, 1, null, true), 0.202));
    check('全缺只剩截距', near(impliedGapPct(null, null, null, true), GAP_INTERCEPT));
    check('限幅 ±1.5', impliedGapPct(10, 10, 10, true) === 1.5 && impliedGapPct(-10, -10, -10, true) === -1.5);
  }

  console.log('[市场天气分]');
  {
    const fullDeps = fakeDeps({ breadth: async () => busyBreadth, limitEco: async () => busyEco });
    const snap = await computeSentiment(fullDeps);
    const byName = Object.fromEntries((snap?.factors ?? []).map((f) => [f.name, f]));
    check('六因子齐全且总分 65', snap !== null && snap.factors.length === 6 && near(snap.score, 65), `score=${snap?.score}`);
    check('涨跌家数 25 分+文案', near(byName['涨跌家数'].score, 25) && byName['涨跌家数'].detail === '上涨 3500 / 下跌 500');
    check('涨停 20 / 跌停 -20 / 连板 15', near(byName['涨停家数'].score, 20) && near(byName['跌停家数'].score, -20) && near(byName['连板高度'].score, 15));
    check('封板率 100% 得 10 分', near(byName['封板率'].score, 10) && byName['封板率'].detail === '100%');
    check('量能环比 +50% 打满 15 分+万亿文案', near(byName['量能环比'].score, 15) && byName['量能环比'].detail === '+50.0%，成交 2.10万亿');
    const noSeal = await computeSentiment(fakeDeps({
      breadth: async () => ({}),
      limitEco: async () => ({ ztCount: 0, dtCount: 5, zbCount: 0, maxLianban: 0 }),
    }));
    check('封板率 zt+zb=0 跳过（无该因子）', noSeal !== null && !noSeal.factors.some((f) => f.name === '封板率') && noSeal.factors.length === 2);
    check('全源缺失返回 null', await computeSentiment(fakeDeps()) === null);
    check('barDate 缺失返回 null', await computeSentiment(fakeDeps({ ashareLastBarDate: async () => null })) === null);
  }

  console.log('[天气分持久化回退]');
  {
    const store = createForecastStore(fakeMemento());
    store.saveSentiment({ date: '2026-10-28', score: 42, factors: [{ name: 'x', detail: 'y', score: 42 }] });
    const dead = fakeDeps({
      breadth: async () => { throw new Error('down'); },
      limitEco: async () => { throw new Error('down'); },
      ashareLastBarDate: async () => null,
    });
    const got = await getSentiment(dead, store);
    check('实时链路全挂回退持久化快照', got !== null && got.score === 42 && got.date === '2026-10-28');
    await getSentiment(fakeDeps({ breadth: async () => busyBreadth, limitEco: async () => busyEco }), store);
    check('live 结果落库并读回一致', store.sentiment()?.score === 65 && store.sentiment()?.factors.length === 6);
  }

  console.log('[盘前研判生成]');
  {
    const store = createForecastStore(fakeMemento());
    check('主力源全缺返回 null', await generatePreOpenForecast(fakeDeps(), store, THU_0900) === null);
  }
  {
    const store = createForecastStore(fakeMemento());
    let asiaCalls = 0;
    const deps = fakeDeps({ a50ChangePct: async () => 1, asiaMorningAvgPct: async () => { asiaCalls++; return 0.5; } });
    const fc = await generatePreOpenForecast(deps, store, THU_0900);
    check('初版：9:00 不取韩日早盘', fc !== null && fc.finalized === false && asiaCalls === 0);
    check('初版 gap=0.196、因子 A50 23.33 分+文案', fc !== null && near(fc.gapPct, 0.196) && near(fc.factors[0].score, 35 / 1.5, 1e-6) && fc.factors[0].detail === '1.00%');
    check('落库 kind=PRE 同日一条、NaN 字段落 null', (() => {
      const h = store.history();
      return h.length === 1 && h[0].kind === 'PRE' && !Number.isFinite(h[0].actualPct) && !Number.isFinite(h[0].openPct);
    })());
    const again = await generatePreOpenForecast(deps, store, bj(29, 9, 10));
    check('9:10 未到终版时点：直接回读初版（不重生成）', again?.generatedAt === fc?.generatedAt && store.history().length === 1);
  }
  {
    const store = createForecastStore(fakeMemento());
    let a50Calls = 0;
    const deps = fakeDeps({
      a50ChangePct: async () => { a50Calls++; return 1; },
      ndxOvernightPct: async () => 1,
      asiaMorningAvgPct: async () => 1,
    });
    await generatePreOpenForecast(deps, store, THU_0900);
    const callsAfterFirst = a50Calls;
    const fin = await generatePreOpenForecast(deps, store, THU_0916);
    check('9:16 终版：回源并入韩日早盘', fin !== null && fin.finalized === true && a50Calls === callsAfterFirst + 1);
    check('终版 gap 含 ASIA_SLOPE=0.557', fin !== null && near(fin.gapPct, 0.557));
    check('终版因子含韩日早盘（早场均值 +1.00%，12.5 分）',
      fin !== null && fin.factors.some((f) => f.name === '韩日早盘' && f.detail === '早场均值 +1.00%' && near(f.score, 12.5)));
    const after = await generatePreOpenForecast(deps, store, bj(29, 9, 20));
    check('终版锁定：9:20 再调不回源、同日仅一条',
      a50Calls === callsAfterFirst + 1 && after?.finalized === true && store.history().filter((r) => r.kind === 'PRE' && r.date === TODAY).length === 1);
  }
  {
    const store = createForecastStore(fakeMemento());
    const deps = fakeDeps({ a50ChangePct: async () => 1, asiaMorningAvgPct: async () => null });
    const fin = await generatePreOpenForecast(deps, store, THU_0916);
    const asiaFactor = fin?.factors.find((f) => f.name === '韩日早盘');
    check('终版缺数据：明示"数据缺失"且分值 NaN', asiaFactor !== undefined && asiaFactor.detail === '数据缺失' && !Number.isFinite(asiaFactor.score));
    check('缺数据 gap 退化隔夜口径=0.196', fin !== null && near(fin.gapPct, 0.196));
    check('展示型 NaN 因子不进得分', fin !== null && near(fin.score, 35 / 1.5, 1e-6));
  }
  {
    // T-1 过热 -12 / 大跌 +8 / 贬值 -6 三因子联合
    const store = createForecastStore(fakeMemento());
    const deps = fakeDeps({
      a50ChangePct: async () => 1,
      breadth: async () => busyBreadth,
      limitEco: async () => busyEco,
      settleSnapshot: async () => [4000, 4100, 4050],
      usdcnhPct: async () => 0.5,
    });
    const fc = await generatePreOpenForecast(deps, store, THU_0900);
    check('过热 65 分→T-1情绪过热 -12', fc !== null && fc.factors.some((f) => f.name === 'T-1情绪过热' && f.score === -12));
    check('T-1大跌 -2.44%→+8', fc !== null && fc.factors.some((f) => f.name === 'T-1大跌' && f.detail === '-2.44%' && f.score === 8));
    check('贬值 0.5%→-6', fc !== null && fc.factors.some((f) => f.name === '人民币贬值' && f.score === -6));
    check('总分=23.33-12+8-6', fc !== null && near(fc.score, 35 / 1.5 - 12 + 8 - 6, 1e-6));
  }
  {
    const store = createForecastStore(fakeMemento());
    const deps = fakeDeps({
      a50ChangePct: async () => 0.1,
      breadth: async () => iceBreadth,
      limitEco: async () => ({ ztCount: 0, dtCount: 80, zbCount: 0, maxLianban: 0 }),
      usdcnhPct: async () => -0.3,
    });
    const fc = await generatePreOpenForecast(deps, store, THU_0900);
    check('冰点 -60→T-1情绪冰点 +12', fc !== null && fc.factors.some((f) => f.name === 'T-1情绪冰点' && f.score === 12));
    check('升值 -0.3%→+4（含边界）', fc !== null && fc.factors.some((f) => f.name === '人民币升值' && f.score === 4));
  }
  {
    const at = await generatePreOpenForecast(fakeDeps({ a50ChangePct: async () => 1, settleSnapshot: async () => [9850, 10000, 9900] }), createForecastStore(fakeMemento()), THU_0900);
    check('T-1 大跌边界 -1.5% 触发', at !== null && at.factors.some((f) => f.name === 'T-1大跌'));
    const above = await generatePreOpenForecast(fakeDeps({ a50ChangePct: async () => 1, settleSnapshot: async () => [9851, 10000, 9900] }), createForecastStore(fakeMemento()), THU_0900);
    check('-1.49% 不触发', above !== null && !above.factors.some((f) => f.name === 'T-1大跌'));
    const cnhEdge = await generatePreOpenForecast(fakeDeps({ a50ChangePct: async () => 1, usdcnhPct: async () => 0.29 }), createForecastStore(fakeMemento()), THU_0900);
    check('汇率 0.29% 不触发', cnhEdge !== null && !cnhEdge.factors.some((f) => f.name === '人民币贬值'));
  }
  {
    // 130 条裁剪 + 同日唯一
    const store = createForecastStore(fakeMemento());
    const many: ForecastRecord[] = [];
    for (let i = 0; i < MAX_RECORDS; i++) many.push(rec({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), settled: true }));
    store.replaceHistory(many);
    await generatePreOpenForecast(fakeDeps({ a50ChangePct: async () => 1 }), store, THU_0900);
    const h = store.history();
    check('超 130 条裁旧（首日右移、末条=今日 PRE）', h.length === MAX_RECORDS && h[0].date === '2026-01-02' && h[h.length - 1].date === TODAY);
  }

  console.log('[结算与双账本]');
  {
    const store = createForecastStore(fakeMemento());
    store.replaceHistory([rec({ gapPct: 0.5 })]);
    await settleForecasts(fakeDeps({ settleSnapshot: async () => [4100, 4000, 4020] }), store, THU_1000);
    const r = store.history()[0];
    check('盘前只结跳空（openHit=true，settled=false）', r.settled === false && r.openHit === true && near(r.openPct, 0.5) && !Number.isFinite(r.actualPct));
  }
  {
    const store = createForecastStore(fakeMemento());
    store.replaceHistory([rec({ gapPct: 0.5, direction: 'BULL' })]);
    await settleForecasts(fakeDeps({ settleSnapshot: async () => [4100, 4000, 4020] }), store, THU_1530);
    const r = store.history()[0];
    check('盘后全结：actualPct=2.5、BULL 判对、settled', r.settled === true && near(r.actualPct, 2.5) && r.correct === true);
  }
  {
    const store = createForecastStore(fakeMemento());
    store.replaceHistory([rec({ gapPct: -0.5, direction: 'BEAR' })]);
    await settleForecasts(fakeDeps({ settleSnapshot: async () => [4100, 4000, 4020] }), store, THU_1530);
    const r = store.history()[0];
    check('BEAR 遇 +2.5%：跳空判错+方向判错', r.openHit === false && r.correct === false && r.settled === true);
    const flat = createForecastStore(fakeMemento());
    flat.replaceHistory([rec({ gapPct: 0.2, direction: 'NEUTRAL' })]);
    await settleForecasts(fakeDeps({ settleSnapshot: async () => [4002, 4000, 4010] }), flat, THU_1530);
    check('NEUTRAL 遇 ±0.1% 平盘判对', flat.history()[0].correct === true && flat.history()[0].settled === true);
  }
  {
    const store = createForecastStore(fakeMemento());
    store.replaceHistory([rec()]);
    await settleForecasts(fakeDeps({ settleSnapshot: async () => [4100, 4000, 0] }), store, THU_1000);
    const r = store.history()[0];
    check('未开盘（open=0）保持原状不结算', r.settled === false && !Number.isFinite(r.openPct));
  }
  {
    const store = createForecastStore(fakeMemento());
    store.replaceHistory([rec({ date: '2026-10-27' }), rec({ date: '2026-11-02' })]);
    await settleForecasts(fakeDeps({ settleSnapshot: async () => [4100, 4000, 4020] }), store, THU_1530);
    const [missed, future] = store.history();
    check('错过的日期结而不统计（settled=true 无数值）', missed.settled === true && !Number.isFinite(missed.actualPct) && !Number.isFinite(missed.openPct));
    check('未来日期跳过不结', future.settled === false);
  }
  {
    const rows: ForecastRecord[] = [
      rec({ date: 'd1', settled: true, gapPct: 0.5, openPct: 0.4, openHit: true, direction: 'BULL', actualPct: 2.5, correct: true }),
      rec({ date: 'd2', settled: true, gapPct: -0.5, openPct: 0.4, openHit: false, direction: 'BEAR', actualPct: 2.5, correct: false }),
      rec({ date: 'd3', settled: true, gapPct: 0.2, openPct: 0.1, openHit: false, direction: 'NEUTRAL', actualPct: 0.02, correct: true }),
      rec({ date: 'd4', settled: true, kind: '', gapPct: 0.5, openPct: 0.5, openHit: true, direction: 'BULL', actualPct: 2.5, correct: true }),
      rec({ date: 'd5', settled: true, gapPct: NaN, openPct: 0.5, openHit: true, direction: 'BULL', actualPct: NaN, correct: false }),
    ];
    const s = getStats(rows);
    check('跳空账本：旧版 kind 与 NaN 数值排除', s.gapSample === 3 && s.gapHits === 1 && near(s.gapHitRate, 100 / 3));
    check('方向账本：仅 BULL/BEAR 且已出收盘值', s.dirSample === 2 && s.dirHits === 1 && near(s.dirHitRate, 50));
    const empty = getStats([]);
    check('空样本命中率 NaN', Number.isNaN(empty.gapHitRate) && Number.isNaN(empty.dirHitRate));
  }

  console.log('[窗口与调度表]');
  {
    check('窗口内=工作日 8:40–9:25 且交易日', await inPreOpenWindow(fakeDeps(), THU_0900) === true
      && await inPreOpenWindow(fakeDeps(), bj(29, 8, 39)) === false
      && await inPreOpenWindow(fakeDeps(), THU_0926) === false
      && await inPreOpenWindow(fakeDeps(), SAT_0900) === false
      && await inPreOpenWindow(fakeDeps({ isTodayTradingDay: async () => false }), THU_0900) === false);
    check('nextDelay：窗口 60s/盘中 5min/15:10-16 2min/16-21 15min/其余 1h',
      nextDelayMs(THU_0900) === 60_000 && nextDelayMs(THU_0926) === 300_000
      && nextDelayMs(bj(29, 15, 10)) === 120_000 && nextDelayMs(THU_1630) === 900_000
      && nextDelayMs(THU_2130) === 3_600_000 && nextDelayMs(SAT_0900) === 3_600_000);
    check('coldStart：窗口 3s/收盘窗 5s/其余 25s',
      coldStartDelayMs(THU_0900) === 3_000 && coldStartDelayMs(THU_1530) === 5_000 && coldStartDelayMs(THU_1200) === 25_000);
  }

  console.log('[Yahoo 早盘解析]');
  {
    const now = bj(29, 9, 20); // 东京 10:20
    const mkBody = (prev: number, prevFallback: number, tsSec: number, closes: (number | null)[]): string =>
      JSON.stringify({ chart: { result: [{ meta: { chartPreviousClose: prev, previousClose: prevFallback }, timestamp: [tsSec], indicators: { quote: [{ close: closes }] } }] } });
    const freshTs = Date.UTC(2026, 9, 29, 0, 5) / 1000; // 东京今天 09:05
    check('有效数据 pct=+1%', near(parseYahooMorning(mkBody(50000, 49000, freshTs, [50500]), 'Asia/Tokyo', now) ?? NaN, 1));
    const staleTs = Date.UTC(2026, 9, 28, 0, 5) / 1000;
    check('休市旧数据防护（bar 非当地今天→null）', parseYahooMorning(mkBody(50000, 49000, staleTs, [50500]), 'Asia/Tokyo', now) === null);
    check('chartPreviousClose 缺失回落 previousClose', near(parseYahooMorning(mkBody(0, 50000, freshTs, [50500]), 'Asia/Tokyo', now) ?? NaN, 1));
    check('全 null 收盘价→null', parseYahooMorning(mkBody(50000, 49000, freshTs, [null, null]), 'Asia/Tokyo', now) === null);
  }

  console.log('[因子 JSON 与回读]');
  {
    const json = factorsToJson([{ name: '韩日早盘', detail: '数据缺失', score: NaN }, { name: 'A50期货', detail: '1.00%', score: 1.5 }]);
    const back = parseFactorsJson(json);
    check('NaN 落 null、回读还原 NaN', json.includes('null') && !Number.isFinite(back[0].score) && back[1].score === 1.5);
    check('空串/坏 JSON 返回空数组', parseFactorsJson('').length === 0 && parseFactorsJson('{bad').length === 0);
    const r = rec({ factorsJson: json });
    const fc = rehydrate(r);
    check('rehydrate 透传字段并解析因子', fc.date === r.date && fc.gapPct === r.gapPct && fc.factors.length === 2);
    check('latestRecord 取最后一条 PRE', latestRecord([rec({ kind: '' }), rec({ date: 'x' })])?.date === 'x');
  }

  console.log('[watcher 一轮与 header 槽]');
  {
    const store = createForecastStore(fakeMemento());
    await runWatchTick(fakeDeps({ breadth: async () => busyBreadth, limitEco: async () => busyEco }), store, THU_1630);
    check('盘后轮次持久化天气分', store.sentiment()?.score === 65);
    const idle = createForecastStore(fakeMemento());
    await runWatchTick(fakeDeps(), idle, THU_1200);
    check('盘中轮次不动天气分', idle.sentiment() === null);
    check('makeRealDeps 装配齐 9 个数据源', Object.keys(makeRealDeps()).length === 9);
  }
  {
    const base = renderTableHtml('TESTNONCE');
    const html = withHeaderSlot(base, 'TESTNONCE');
    const listeners = (html.match(/window\.addEventListener\('message'/g) ?? []).length;
    check('header 槽注入容器/样式/脚本（消息监听器 1→2）',
      html.includes('id="fc-header"') && html.includes('.fc-card') && listeners === 2 && html.length > base.length);
    check('锚点缺失时原样返回（降级不产半残页）', withHeaderSlot('<html><body></body></html>', 'x') === '<html><body></body></html>');
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
