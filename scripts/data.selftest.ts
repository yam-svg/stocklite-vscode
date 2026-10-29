/**
 * S1 数据层自测。
 * 离线（默认）：node scripts/data-selftest.mjs && node out/data-selftest.cjs
 * 在线（真实接口连通性+字段口径抽查）：设 STOCKLITE_ONLINE=1 再跑 out/data-selftest.cjs
 * 覆盖：工具函数、交易时段/日历、A 股竞价封单涨跌停、美股时戳、基金水位线、
 * K 线重采样、全球指数三源解析与前收兜底、调度器（in-flight 合并/退避/开关）、
 * GBK 假服务器解码、provider 装配注册。数据行为以 Kotlin 版 MarketDataService 为准。
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  numOf, round2, roundFixed, sleep, StaleCache, mapWithConcurrency,
  orderByInput, parseTencentVars, parseSinaVars,
} from '../src/data/util';
import {
  zonedTime, dayOfTz, hhmmOfTz, dayOfShanghai, shanghaiWallToEpochMs,
  isCnMarketOpenByTime, cnRefreshIntervalMs, cnMarketStatusText, isInAStockAuction,
  getSessionMinutes, isMarketOpenByTimezone, setCalendarFetcherForTest, extractTradingPeriodDate,
  currentUsSession, CN_TZ, NY_TZ,
} from '../src/data/marketTime';
import {
  cnLimitPrices, cnSealLots, etToday, parseSinaUsStamp, isNameBad, inferAShareSymbol,
  getStockQuotes, searchStocks, resolveImportCandidates, getEarningsDate,
} from '../src/data/stocks';
import { normFundCode, advanceHighWaterMark, parseF10LatestNav, getFundQuotes } from '../src/data/funds';
import { resampleDaily, getHistoryBars, getIntradayRows, isAShareSymbol, type BarPoint } from '../src/data/kline';
import {
  GLOBAL_INDEXES, visibleGlobalIndexes, resolveYahooSymbol, parseSinaGlobal,
  prevCloseWithSessionCheck, parseYahooBody, getGlobalIndexQuotes,
} from '../src/data/globalIndex';
import { usSectorToQuote, getUsSectorQuotes, US_SECTOR_ETFS, type SectorQuote } from '../src/data/usMarket';
import { normCryptoSymbol, getCryptoQuotes, searchCryptos, probeCryptoNetwork } from '../src/data/cryptos';
import { normalizeFutureSymbol, parseFutureFields, getFutureQuotes, searchFutures } from '../src/data/futures';
import { sectorToQuote, getSectorQuotes, type AStockSector } from '../src/data/sectors';
import { ipoSinaSymbol, getIpoList } from '../src/data/ipos';
import { getMarketBreadth, getLimitEcosystem, getUsdcnhPct, getAshareLastBarDate } from '../src/data/breadth';
import { createDataProviders, createGlobalProvider } from '../src/data/providers';
import { PollScheduler } from '../src/data/scheduler';
import { httpGetText } from '../src/shared/http';
import type { EventBus } from '../src/shared/events';
import type { Quote, QuoteProvider } from '../src/shared/types';

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
async function checkAsync(name: string, fn: () => Promise<boolean | void>): Promise<void> {
  try {
    const r = await fn();
    check(name, r !== false);
  } catch (e) {
    check(name, false, String(e));
  }
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

// ── util ─────────────────────────────────────────────────────────────────────

function testUtil(): void {
  console.log('[util]');
  check('numOf 合法值', numOf('3.14') === 3.14);
  check('numOf 空串→NaN / 兜底值', Number.isNaN(numOf('')) && numOf('abc', -1) === -1);
  check('round2', round2(123.456) === 123.46 && round2(10.111) === 10.11);
  check('roundFixed 4 位', roundFixed(1.23456, 4) === 1.2346);
  {
    const t = parseTencentVars('v_jj012414="012414~基金名~x~1.234~y~1.234~z~-0.53~2026-10-15";v_sh600519="1~贵州茅台~600519";');
    check('parseTencentVars 键值展开', t.get('jj012414')?.[8] === '2026-10-15' && t.get('sh600519')?.[1] === '贵州茅台');
  }
  {
    const s = parseSinaVars('var hq_str_sh600519="贵州茅台,1500,1499,1501";');
    check('parseSinaVars 键值展开', s.get('sh600519')?.[3] === '1501');
  }
  check('orderByInput 保序且跳过缺项',
    JSON.stringify(orderByInput(['a', 'b', 'c'], new Map([['c', 3], ['a', 1]]))) === '[1,3]');
  {
    let inflight = 0;
    let maxInflight = 0;
    const items = [1, 2, 3, 4, 5, 6];
    mapWithConcurrency(items, 2, async (n) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await sleep(5);
      inflight--;
      return n * 10;
    }).then((rs) => {
      check('mapWithConcurrency 保序', JSON.stringify(rs) === '[10,20,30,40,50,60]');
      check('mapWithConcurrency 并发上限', maxInflight <= 2);
    });
  }
  {
    const c = new StaleCache<number>(30, 60);
    let calls = 0;
    void c.getOrFetch(async () => { calls++; return 1; }).then((v1) => {
      check('StaleCache 新鲜期内不重复请求', v1 === 1 && calls === 1);
      void c.getOrFetch(async () => { calls++; return 2; }).then((v2) => {
        check('StaleCache 新鲜期命中缓存', v2 === 1 && calls === 1);
      });
    });
  }
}

async function testStaleCacheStale(): Promise<void> {
  const c = new StaleCache<number>(20, 80);
  await c.getOrFetch(async () => 7);
  await sleep(30); // 过新鲜期
  const v = await c.getOrFetch(async () => { throw new Error('boom'); });
  check('StaleCache 失败时 staleTtl 内沿用旧值', v === 7);
  await sleep(90); // 过 staleTtl
  const v2 = await c.getOrFetch(async () => { throw new Error('boom'); });
  check('StaleCache 超过 staleTtl 返回 null', v2 === null);
}

// ── marketTime ───────────────────────────────────────────────────────────────

function testMarketTime(): void {
  console.log('[marketTime]');
  // 2026-10-16（周五）10:00 上海
  const friOpen = shanghaiWallToEpochMs('2026-10-16 10:00:00');
  const z = zonedTime(CN_TZ, friOpen);
  check('shanghaiWallToEpochMs/zonedTime 往返', z.date === '2026-10-16' && z.dow === 5 && z.minutes === 600);
  check('dayOfTz/hhmmOfTz（epoch 秒→纽约，跨回前一天）',
    dayOfTz(friOpen / 1000, NY_TZ) === '2026-10-15' && hhmmOfTz(friOpen / 1000, NY_TZ) === '22:00');
  check('dayOfShanghai', dayOfShanghai(friOpen) === '2026-10-16');
  check('shanghaiWallToEpochMs 非法串→NaN', Number.isNaN(shanghaiWallToEpochMs('2026/10/16 10:00')));

  check('A 股开市判定（周五 10:00 开）', isCnMarketOpenByTime(friOpen));
  check('A 股午休不算开市', !isCnMarketOpenByTime(shanghaiWallToEpochMs('2026-10-16 12:00:00')));
  check('周末休市', !isCnMarketOpenByTime(shanghaiWallToEpochMs('2026-10-17 10:00:00')));
  check('9:29 不算开市', !isCnMarketOpenByTime(shanghaiWallToEpochMs('2026-10-19 09:29:00')));
  check('cnRefreshIntervalMs 开市 5s/收市 60s',
    cnRefreshIntervalMs(friOpen) === 5_000 && cnRefreshIntervalMs(shanghaiWallToEpochMs('2026-10-17 10:00:00')) === 60_000);
  check('行情状态文案',
    cnMarketStatusText(shanghaiWallToEpochMs('2026-10-19 09:00:00')) === '盘前' && // 周一
    cnMarketStatusText(friOpen) === '早盘' &&
    cnMarketStatusText(shanghaiWallToEpochMs('2026-10-16 12:00:00')) === '午间休市' &&
    cnMarketStatusText(shanghaiWallToEpochMs('2026-10-16 14:00:00')) === '午盘' &&
    cnMarketStatusText(shanghaiWallToEpochMs('2026-10-16 16:00:00')) === '已收盘' &&
    cnMarketStatusText(shanghaiWallToEpochMs('2026-10-17 10:00:00')) === '周末');
  check('CN 午休时段表', JSON.stringify(getSessionMinutes('CN').lunch) === '[690,780]');

  // 美股时段（纽约）：10-16 是周五
  check('美股时段 PRE/REGULAR/POST/CLOSED',
    currentUsSession(Date.UTC(2026, 9, 16, 3, 0)) === 'CLOSED' && // 周四 23:00 EDT
    currentUsSession(Date.UTC(2026, 9, 16, 13, 0)) === 'PRE' && // 09:00 EDT
    currentUsSession(Date.UTC(2026, 9, 16, 14, 30)) === 'REGULAR' && // 10:30 EDT
    currentUsSession(Date.UTC(2026, 9, 16, 21, 0)) === 'POST' && // 17:00 EDT
    currentUsSession(Date.UTC(2026, 9, 17, 0, 30)) === 'CLOSED' && // 20:30 EDT 盘后结束
    currentUsSession(Date.UTC(2026, 9, 17, 14, 30)) === 'CLOSED'); // 周六

  const calJson = (date: string, gmtoffset: number) => ({
    chart: { result: [{ meta: { gmtoffset, currentTradingPeriod: { regular: { start: Date.parse(`${date}T09:30:00Z`) / 1000 } } } }] },
  });
  {
    const p = extractTradingPeriodDate(calJson('2026-07-15', 0));
    check('extractTradingPeriodDate', p?.date === '2026-07-15');
    check('extractTradingPeriodDate 非法→null', extractTradingPeriodDate({ foo: 1 }) === null);
  }
  {
    // 假日历注入：同一时段，交易日=开盘、节假日=休市（2026-07-15 周三）
    const noonCn = shanghaiWallToEpochMs('2026-07-15 14:00:00');
    setCalendarFetcherForTest(async () => calJson('2026-07-15', 8 * 3600));
    void isMarketOpenByTimezone('CN', CN_TZ, noonCn).then((v) => check('交易日历注入：交易日盘中=开盘', v === true));
    setCalendarFetcherForTest(async () => calJson('2026-07-14', 8 * 3600)); // 日历停在昨天 → 今天休市
    void isMarketOpenByTimezone('CN', CN_TZ, noonCn).then((v) => check('交易日历注入：节假日=休市', v === false));
    setCalendarFetcherForTest(async () => calJson('2026-07-15', 8 * 3600));
    const lunchCn = shanghaiWallToEpochMs('2026-07-15 12:00:00');
    void isMarketOpenByTimezone('CN', CN_TZ, lunchCn).then((v) => check('午休时段=休市', v === false));
    // 沙特/以色列周五六周末：2026-07-17 周五
    const fri = shanghaiWallToEpochMs('2026-07-17 15:00:00');
    setCalendarFetcherForTest(async () => calJson('2026-07-17', 3 * 3600));
    void isMarketOpenByTimezone('SA', 'Asia/Riyadh', fri).then((v) => check('沙特周五按周末休市', v === false));
    setCalendarFetcherForTest(null);
  }
}

async function testAuctionWindow(): Promise<void> {
  const calJson = (date: string) => ({
    chart: { result: [{ meta: { gmtoffset: 8 * 3600, currentTradingPeriod: { regular: { start: Date.parse(`${date}T01:30:00Z`) / 1000 } } } }] },
  });
  const inWindow = shanghaiWallToEpochMs('2026-07-15 09:20:00');
  setCalendarFetcherForTest(async () => calJson('2026-07-15'));
  check('竞价窗口 9:15–9:30 交易日命中', await isInAStockAuction(inWindow) === true);
  check('竞价窗口外 9:14 不命中', await isInAStockAuction(shanghaiWallToEpochMs('2026-07-15 09:14:00')) === false);
  check('竞价窗口外 9:30 不命中', await isInAStockAuction(shanghaiWallToEpochMs('2026-07-15 09:30:00')) === false);
  check('周末不在竞价', await isInAStockAuction(shanghaiWallToEpochMs('2026-07-18 09:20:00')) === false);
  setCalendarFetcherForTest(async () => calJson('2026-07-14')); // 节假日
  check('节假日不在竞价', await isInAStockAuction(inWindow) === false);
  setCalendarFetcherForTest(null);
}

// ── stocks ───────────────────────────────────────────────────────────────────

function testStocks(): void {
  console.log('[stocks]');
  check('主板涨跌停 ±10%', cnLimitPrices('sh600519', 100)?.limitUp === 110 && cnLimitPrices('sh600519', 100)?.limitDown === 90);
  check('创业板 ±20%', cnLimitPrices('sz300750', 100)?.limitUp === 120);
  check('科创板 ±20%', cnLimitPrices('sh688111', 100)?.limitUp === 120);
  check('北交所 ±30%', cnLimitPrices('bj430047', 100)?.limitUp === 130);
  check('round2 涨停价 12.34→13.57/11.11',
    cnLimitPrices('sh600000', 12.34)?.limitUp === 13.57 && cnLimitPrices('sh600000', 12.34)?.limitDown === 11.11);
  check('昨收非法不涨跌停', cnLimitPrices('sh600519', 0) === null);

  check('封单：涨停买一封单为正', cnSealLots('sh600519', 110, 100, 12345, 0) === 12345);
  check('封单：跌停卖一封单为负', cnSealLots('sh600519', 90, 100, 0, 888) === -888);
  check('封单：未封板 undefined', cnSealLots('sh600519', 105, 100, 12345, 888) === undefined);
  check('封单：封板无量 undefined', cnSealLots('sh600519', 110, 100, 0, 0) === undefined);
  check('封单：20cm 创业板按 20% 判板', cnSealLots('sz300750', 110, 100, 100, 0) === undefined && cnSealLots('sz300750', 120, 100, 100, 0) === 100);

  check('isNameBad：名称=代码/纯数字', isNameBad('sh600519', 'sh600519') && isNameBad('000001', 'x'));
  check('isNameBad：正常中文名', !isNameBad('贵州茅台', 'sh600519') && !isNameBad('AAPL', 'AAPL2'));
  check('isNameBad：替换符', isNameBad('贵州\ufffd\ufffd', 'sh600519'));

  check('inferAShareSymbol', inferAShareSymbol('600519') === 'sh600519' && inferAShareSymbol('510300') === 'sh510300' &&
    inferAShareSymbol('000001') === 'sz000001' && inferAShareSymbol('430047') === 'bj430047' && inferAShareSymbol('920002') === 'bj920002');

  check('etToday 用显式时刻', etToday(Date.UTC(2026, 9, 16, 14, 0)) === '2026-10-16');
  check('parseSinaUsStamp 正常', /^\d{4}-10-16$/.test(parseSinaUsStamp('Oct 16 05:13AM EDT') ?? ''));
  check('parseSinaUsStamp EST 冬令时', /^\d{4}-12-31$/.test(parseSinaUsStamp('Dec 31 07:59PM EST') ?? ''));
  check('parseSinaUsStamp 非法→null', parseSinaUsStamp('Oct 16 05:13AM') === null && parseSinaUsStamp('') === null);
  check('isAShareSymbol', isAShareSymbol('sh600519') && !isAShareSymbol('AAPL'));
}

// ── funds ────────────────────────────────────────────────────────────────────

function testFunds(): void {
  console.log('[funds]');
  check('normFundCode 提取 6 位码', normFundCode('012414(某基金)') === '012414' && normFundCode('abc') === 'abc');
  {
    const nav = parseF10LatestNav('{"ErrCode":0,"Data":{"LSJZList":[{"FSRQ":"2026-10-15","DWJZ":"1.2345","JZZZL":"-0.53"}]}}');
    check('parseF10LatestNav 正常', nav?.date === '2026-10-15' && nav?.nav === 1.2345 && nav?.changePercent === -0.53 &&
      near(nav.prevNav, 1.2345 / (1 - 0.0053), 1e-9));
    check('parseF10LatestNav ErrCode≠0 → null', parseF10LatestNav('{"ErrCode":500}') === null);
    check('parseF10LatestNav 空列表 → null', parseF10LatestNav('{"ErrCode":0,"Data":{"LSJZList":[]}}') === null);
  }
  {
    const code = 'T00001';
    const r1 = advanceHighWaterMark(code, { code, name: 't', nav: 1, changePercent: 1, date: '2026-10-15' });
    const r2 = advanceHighWaterMark(code, { code, name: 't', nav: 0.9, changePercent: -2, date: '2026-10-14' });
    check('水位线：旧日期被纠正', r1.date === '2026-10-15' && r2.date === '2026-10-15' && r2.nav === 1);
    const r3 = advanceHighWaterMark(code, { code, name: 't', nav: 0.8, changePercent: 0, date: '' });
    check('水位线：空日期也走水位', r3.date === '2026-10-15' && r3.nav === 1);
    const r4 = advanceHighWaterMark(code, { code, name: 't', nav: 1.1, changePercent: 2, date: '2026-10-16' });
    check('水位线：新日期推进', r4.nav === 1.1 &&
      advanceHighWaterMark(code, { code, name: 't', nav: 0.5, changePercent: 0, date: '2026-10-15' }).nav === 1.1);
  }
}

// ── kline 重采样 ─────────────────────────────────────────────────────────────

function bar(day: string, o: number, c: number, h: number, l: number, v: number): BarPoint {
  return { day, open: o, close: c, high: h, low: l, volume: v };
}

function testKline(): void {
  console.log('[kline]');
  // 2026-10-12（周一）..16（周五）同一 ISO 周；10-19（下周一）另一周；9 月两根归 2026-9
  const weekBars = [
    bar('2026-10-12', 10, 11, 12, 9, 100),
    bar('2026-10-13', 11, 10.5, 13, 10, 200),
    bar('2026-10-14', 10.5, 12, 14, 10, 300),
    bar('2026-10-15', 12, 11, 15, 11, 400),
    bar('2026-10-16', 11, 13, 16, 10.5, 500),
  ];
  const w = resampleDaily(weekBars, 'week', 100);
  check('周K聚合为一根', w.length === 1);
  check('周K OHLC 口径', w[0]?.open === 10 && w[0]?.close === 13 && w[0]?.high === 16 && w[0]?.low === 9 && w[0]?.day === '2026-10-16');
  check('周K成交量求和', w[0]?.volume === 1500);
  const w2 = resampleDaily([...weekBars, bar('2026-10-19', 13, 14, 14, 13, 600)], 'week', 100);
  check('跨 ISO 周分桶', w2.length === 2 && w2[1].day === '2026-10-19');
  const m = resampleDaily([bar('2026-09-30', 1, 2, 3, 0.5, 10), bar('2026-10-09', 2, 3, 4, 1, 20), bar('2026-10-12', 3, 4, 5, 2, 30)], 'month', 100);
  check('月K分桶（9 月/10 月）', m.length === 2 && m[0].day === '2026-09-30' && m[1].day === '2026-10-12' && m[1].volume === 50);
  check('day 原样截尾', resampleDaily(weekBars, 'day', 3).length === 3 && resampleDaily(weekBars, 'day', 3)[2].day === '2026-10-16');
}

// ── globalIndex ──────────────────────────────────────────────────────────────

function testGlobalIndex(): void {
  console.log('[globalIndex]');
  const optionalCount = GLOBAL_INDEXES.filter((g) => g.optional).length;
  check('指数表 37 条（20 默认 + 17 optional）', GLOBAL_INDEXES.length === 37 && optionalCount === 17);
  check('visibleGlobalIndexes 双轨',
    visibleGlobalIndexes([], []).length === 20 &&
    visibleGlobalIndexes(['^GSPC'], []).length === 19 &&
    visibleGlobalIndexes([], ['^EGX30.CA']).length === 21 &&
    visibleGlobalIndexes(['^STOXX50E'], ['^STOXX50E']).length === 21); // hidden 对 optional 无效
  check('resolveYahooSymbol ^HSTECH → HSTECH.HK', resolveYahooSymbol('^HSTECH') === 'HSTECH.HK' && resolveYahooSymbol('^GSPC') === '^GSPC');
  {
    const sina = 'var hq_str_gb_dji="DJIA,43000.5,0.75,2026-10-16,16:00:00,1";' +
      'var hq_str_rt_hkHSI="HSI,恒生指数,26000.1,25800.2,26100,25700";' +
      'var hq_str_sh000001="上证指数,3300.1,3290.0,3310.5,3320,3280";' +
      'var hq_str_gb_bad="name,0,1,2,3";';
    const m = parseSinaGlobal(sina);
    check('gb_ 价=arr[1] 涨跌=arr[2]', near(m.get('gb_dji')?.price ?? 0, 43000.5) && near(m.get('gb_dji')?.changePct ?? 0, 0.75));
    check('rt_hk 价=arr[2] 前收=arr[3]', near(m.get('rt_hkHSI')?.price ?? 0, 26000.1) && near(m.get('rt_hkHSI')?.changePct ?? 0, (26000.1 - 25800.2) / 25800.2 * 100, 1e-9));
    check('sh 指数 前收=arr[2] 价=arr[3]', near(m.get('sh000001')?.price ?? 0, 3310.5) && near(m.get('sh000001')?.changePct ?? 0, (3310.5 - 3290.0) / 3290.0 * 100, 1e-9));
    check('价格为 0 的条目丢弃', !m.has('gb_bad'));
  }
  {
    // 分钟线聚合：两天样本，day1 最后 16:00（US end=16:00 校验通过）
    const mkResult = (g: number, ts: number[], close: number[]) =>
      ({ meta: { gmtoffset: g }, timestamp: ts, indicators: { quote: [{ close }] } });
    const d1 = [Date.UTC(2026, 9, 14, 15, 0), Date.UTC(2026, 9, 14, 16, 0)];
    const d2 = [Date.UTC(2026, 9, 15, 15, 0)];
    const r = mkResult(0, [...d1, ...d2].map((x) => x / 1000), [99, 100, 101]);
    check('extractPrevCloseFromIntraday 倒数第二日收盘', prevCloseWithSessionCheck(r) === 100);
    check('prevCloseWithSessionCheck 贴收盘通过', prevCloseWithSessionCheck(r, 'US') === 100);
    const early = mkResult(0, [Date.UTC(2026, 9, 14, 14, 0), Date.UTC(2026, 9, 15, 15, 0)].map((x) => x / 1000), [99, 100, 101]);
    check('prevCloseWithSessionCheck 偏离收盘>15min 不采信', Number.isNaN(prevCloseWithSessionCheck(early, 'US')));
  }
  {
    // parseYahooBody 前收兜底链
    const p1 = parseYahooBody({ chart: { result: [{ meta: { regularMarketPrice: 101, previousClose: 100 } }] } }, 'T-PREV', undefined, Date.now());
    check('parseYahooBody previousClose 链', near(p1?.changePct ?? 0, 1, 1e-9));
    const p2 = parseYahooBody({ chart: { result: [{ meta: {}, indicators: { quote: [{ close: [100, 101, 102] }] } }] } }, 'T-SPARSE', undefined, Date.now());
    check('parseYahooBody 稀疏源前收=现价（EGX30 兜底）', p2?.price === 102 && p2?.changePct === 0);
    // 缓存链：第一次给了前收，第二次无字段 → 用缓存
    const body1 = { chart: { result: [{ meta: { regularMarketPrice: 101, previousClose: 100 } }] } };
    parseYahooBody(body1, 'T-CACHE', undefined, Date.now());
    const body2 = { chart: { result: [{ meta: { regularMarketPrice: 102 } }] } };
    const p3 = parseYahooBody(body2, 'T-CACHE', undefined, Date.now() + 1000);
    check('parseYahooBody 前收缓存 60s', near(p3?.changePct ?? 0, 2, 1e-9));
    // 分钟线优先于 meta.previousClose
    const mkTs = [Date.UTC(2026, 9, 14, 16, 0) / 1000, Date.UTC(2026, 9, 15, 15, 0) / 1000];
    const minuteBody = { chart: { result: [{ meta: { gmtoffset: 0, regularMarketPrice: 101, previousClose: 999 }, timestamp: mkTs, indicators: { quote: [{ close: [100, 101] }] } }] } };
    const p4 = parseYahooBody(minuteBody, 'T-MIN', 'US', Date.now());
    check('parseYahooBody 分钟线前收优先于 previousClose', near(p4?.changePct ?? 0, 1, 1e-9));
  }
}

// ── usMarket / cryptos / futures / sectors / ipos ────────────────────────────

function testRest(): void {
  console.log('[usMarket/cryptos/futures/sectors/ipos]');
  const sq: SectorQuote = {
    symbol: 'XLK', nameCn: '科技', price: 100, prevClose: 95, extPrice: 102,
    regularPct: (100 - 95) / 95 * 100, prePct: 2, postPct: null, lastRegularDate: '2026-10-16', extDate: '2026-10-16',
  };
  {
    const pre = usSectorToQuote(sq, 'PRE');
    check('盘前显示延伸价', pre.price === 102 && pre.prevClose === 100 && pre.changePct === 2);
    check('extra 剔除 null', pre.extra?.postPct === undefined && pre.extra?.regularPct !== undefined);
    const reg = usSectorToQuote(sq, 'REGULAR');
    check('盘中显示正式价', reg.price === 100 && reg.prevClose === 95 && Math.abs((reg.changePct ?? 0) - sq.regularPct) < 1e-9);
  }
  check('美股板块表 33 只', US_SECTOR_ETFS.length === 33);

  check('normCryptoSymbol 裸币补 USDT', normCryptoSymbol('btc') === 'BTC_USDT' && normCryptoSymbol('SOL') === 'SOL_USDT');
  check('normCryptoSymbol 斜杠/横线转下划线', normCryptoSymbol('BTC/USDT') === 'BTC_USDT' && normCryptoSymbol('WBTC-USDT') === 'WBTC_USDT');
  check('normCryptoSymbol 识别计价币后缀', normCryptoSymbol('ETHUSDC') === 'ETH_USDC' && normCryptoSymbol('SHIBBTC') === 'SHIB_BTC');
  check('normCryptoSymbol 已带下划线原样', normCryptoSymbol('PEPE_USDT') === 'PEPE_USDT' && normCryptoSymbol('') === '');

  check('normalizeFutureSymbol 前缀小写码大写', normalizeFutureSymbol('nf_rb0') === 'nf_RB0' && normalizeFutureSymbol('HF_MQ') === 'hf_MQ' && normalizeFutureSymbol('RB0') === 'nf_RB0');
  {
    // 国内 nf_ 普通合约：0=名称 8=现价 10=昨结
    const nf = parseFutureFields('nf_RB0', ['螺纹钢主力', 'x', 'y', 'z', 'a', 'b', 'c', 'd', '3456', 'e', '3450']);
    check('nf_ 字段解析（名称/现价/昨结）', nf?.name === '螺纹钢主力' && nf?.price === 3456 && nf?.preClose === 3450);
    const nfArr = new Array<string>(48).fill('x');
    nfArr[0] = '456.7'; nfArr[14] = '452.3'; nfArr[47] = '黄金指数';
    const nfIdx = parseFutureFields('nf_AU', nfArr);
    check('nf_ 指数型特判（首字段数值）', nfIdx?.price === 456.7 && nfIdx?.name === '黄金指数');
    // 外盘 hf_：0=现价 13=名称 7=昨收
    const hf = parseFutureFields('hf_NQ', ['20000', 'a', 'b', 'c', 'd', 'e', 'f', '19900', 'i', 'j', 'k', 'l', 'm', '纳斯达克100指数']);
    check('hf_ 字段解析', hf?.price === 20000 && hf?.name === '纳斯达克100指数' && hf?.preClose === 19900);
  }

  {
    const sector: AStockSector = {
      code: 'BK0475', name: '银行', price: 3500.2, changePct: 1.25, turnoverRate: 0.8,
      mainInflow: 1.2e8, upCount: 30, downCount: 10, leaderName: '某行', leaderCode: '601398', leaderMarket: 1, leaderPct: 5.5,
    };
    const q = sectorToQuote(sector, 'sector');
    check('板块 code 带 tabId 前缀', q.code === 'sector:BK0475');
    check('板块反推前收', near(q.prevClose, 3500.2 / 1.0125, 1e-9));
    check('板块 extra 扩展列', q.extra?.boardCode === 'BK0475' && q.extra?.leaderCode === '601398' && q.extra?.upCount === 30);
  }

  check('ipoSinaSymbol 后缀优先', ipoSinaSymbol('688287.SH', '688287') === 'sh688287' && ipoSinaSymbol('301111.SZ', '301111') === 'sz301111' && ipoSinaSymbol('873122.BJ', '873122') === 'bj873122');
  check('ipoSinaSymbol 无后缀首位推断', ipoSinaSymbol('', '601999') === 'sh601999' && ipoSinaSymbol('', '920002') === 'bj920002' && ipoSinaSymbol('', '001111') === 'sz001111');
}

// ── 调度器 ───────────────────────────────────────────────────────────────────

class FakeBus {
  events: { tabId: string; quotes: Quote[] }[] = [];
  on(): { dispose(): void } { return { dispose(): void { /* noop */ } }; }
  emit(name: string, payload: unknown): void {
    if (name === 'quotesUpdated') this.events.push(payload as { tabId: string; quotes: Quote[] });
  }
}

function stubProvider(id: string, fetchQuotes: (codes: string[]) => Promise<Quote[]>): QuoteProvider {
  return { id, fetchQuotes, async fetchKline() { return []; } };
}

async function testScheduler(): Promise<void> {
  console.log('[scheduler]');
  {
    // in-flight 合并 + pending 补拉
    const bus = new FakeBus();
    const sched = new PollScheduler(bus as unknown as EventBus);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sched.start({
      tabId: 'x',
      provider: stubProvider('x', async () => { calls++; await gate; return [{ code: 'a', name: 'A', price: 1, prevClose: 1 }]; }),
      getCodes: () => ['a'],
      intervalMs: () => 60_000,
    });
    await sleep(30);
    check('启动即拉一轮', calls === 1 && bus.events.length === 0);
    sched.refreshNow('x');
    sched.refreshNow('x'); // 与在飞请求合并为一次补拉
    check('在飞期间 refreshNow 不并发请求', calls === 1);
    release();
    await sleep(50);
    check('完成后 pending 立即补拉', calls === 2 && bus.events.length === 2);
    sched.stopAll();
  }
  {
    // 失败退避 ×2，且不发 quotesUpdated
    const bus = new FakeBus();
    const sched = new PollScheduler(bus as unknown as EventBus);
    const times: number[] = [];
    sched.start({
      tabId: 'x',
      provider: stubProvider('x', async () => { times.push(Date.now()); throw new Error('boom'); }),
      getCodes: () => ['a'],
      intervalMs: () => 50,
    });
    await sleep(400);
    sched.stopAll();
    check('连续失败按退避降频（非固定间隔）', times.length >= 3 && times.length <= 6, `calls=${times.length}`);
    const gap0 = times[1] - times[0];
    const gap1 = times[2] - times[1];
    check('退避间隔递增（×2）', gap1 >= gap0 * 1.5, `gap0=${gap0} gap1=${gap1}`);
    check('失败轮不发 quotesUpdated', bus.events.length === 0);
  }
  {
    // enabled=false 轻轮询不发请求；codes 空不发请求
    const bus = new FakeBus();
    const sched = new PollScheduler(bus as unknown as EventBus);
    let calls = 0;
    sched.start({ tabId: 'off', provider: stubProvider('off', async () => { calls++; return []; }), getCodes: () => ['a'], intervalMs: () => 20, enabled: () => false });
    sched.start({ tabId: 'empty', provider: stubProvider('empty', async () => { calls++; return []; }), getCodes: () => [], intervalMs: () => 20 });
    await sleep(150);
    sched.stopAll();
    check('tab 关闭不发请求', calls === 0);
  }
  {
    // refreshNow 空闲时立即拉
    const bus = new FakeBus();
    const sched = new PollScheduler(bus as unknown as EventBus);
    let calls = 0;
    sched.start({ tabId: 'x', provider: stubProvider('x', async () => { calls++; return []; }), getCodes: () => ['a'], intervalMs: () => 60_000 });
    await sleep(30);
    sched.refreshNow('x');
    await sleep(20);
    sched.stopAll();
    check('空闲时 refreshNow 立即拉', calls === 2 && bus.events.length === 2);
  }
}

// ── provider 装配（离线部分）─────────────────────────────────────────────────

function testProviders(): void {
  console.log('[providers]');
  const providers = createDataProviders();
  const ids = Object.keys(providers).sort();
  check('8 个 provider 全注册',
    JSON.stringify(ids) === JSON.stringify(['crypto', 'fund', 'future', 'global', 'ipo', 'sector', 'stock', 'us']), ids.join(','));
  check('provider 契约字段', ids.every((id) => providers[id].id === id && typeof providers[id].fetchQuotes === 'function'));
  {
    // 全球双轨：codes 为空时按可见性表返回
    const gp = createGlobalProvider(() => ({ hidden: ['^GSPC'], enabledOptional: [] }));
    check('global provider id', gp.id === 'global');
    if (gp.search) {
      void gp.search('纳指').then((rs) => check('global 本地表搜索命中纳斯达克100', rs.some((r) => r.code === '^NDX')));
      void gp.search('').then((rs) => check('global 空关键词不搜', rs.length === 0));
    }
  }
}

// ── GBK 假服务器（httpGetText 解码管线）──────────────────────────────────────

async function testGbkPipeline(): Promise<void> {
  console.log('[gbk 假服务器]');
  let gbkOk = true;
  try { new TextDecoder('gbk'); } catch { gbkOk = false; }
  if (!gbkOk) {
    console.log('  - SKIP：本机 Node 无 gbk ICU 数据');
    return;
  }
  // “var hq_str_sh600519="贵州茅台,1500,...";” 的 GBK 字节
  const gbkBody = Buffer.concat([
    Buffer.from('var hq_str_sh600519="', 'latin1'),
    Buffer.from([0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8]),
    Buffer.from(',1500,1499";', 'latin1'),
  ]);
  const srv = http.createServer((req, res) => {
    if (req.url === '/gbk') {
      res.setHeader('Content-Type', 'text/plain;charset=gbk');
      res.end(gbkBody);
    } else if (req.url === '/utf8') {
      res.end('贵州茅台-utf8');
    } else {
      res.statusCode = 404;
      res.end('nf');
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const gbkText = await httpGetText(`http://127.0.0.1:${port}/gbk`, { gbk: true });
    const vars = parseSinaVars(gbkText);
    check('httpGetText gbk:true 正确解码新浪响应', vars.get('sh600519')?.[0] === '贵州茅台');
    const utf8Text = await httpGetText(`http://127.0.0.1:${port}/utf8`);
    check('httpGetText utf-8 解码', utf8Text === '贵州茅台-utf8');
    let threw = false;
    try { await httpGetText(`http://127.0.0.1:${port}/missing`, { retries: 0 }); } catch { threw = true; }
    check('HTTP 404 抛错（retries:0）', threw);
  } finally {
    srv.close();
  }
}

// ── 在线段（STOCKLITE_ONLINE=1）──────────────────────────────────────────────

async function runOnline(): Promise<void> {
  console.log('[在线：真实接口抽查]');
  await checkAsync('A股批量行情（茅台/平安）', async () => {
    const m = await getStockQuotes(['sh600519', 'sz000001']);
    const a = m.get('sh600519');
    const b = m.get('sz000001');
    if (!a || !b) return false;
    if (!(a.price > 0) || !a.name.includes('茅台')) return false;
    if (!(b.price > 0)) return false;
    // 契约抽查：涨跌幅与前收自洽
    return near(a.changePct ?? NaN, (a.price - a.prevClose) / a.prevClose * 100, 0.05);
  });
  await checkAsync('stock provider 返回顺序与入参一致', async () => {
    const p = createDataProviders().stock;
    const qs = await p.fetchQuotes(['sz000001', 'sh600519']);
    return qs.length === 2 && qs[0].code === 'sz000001' && qs[1].code === 'sh600519';
  });
  await checkAsync('日K 升序且日期格式正确', async () => {
    const bars = await getHistoryBars('sh600519', 'day', 30);
    return bars.length > 20 && bars.every((b, i) => /^\d{4}-\d{2}-\d{2}$/.test(b.day) && (i === 0 || b.day > bars[i - 1].day));
  });
  await checkAsync('周K 日期为周内末日', async () => {
    const bars = await getHistoryBars('sh600519', 'week', 10);
    return bars.length > 5 && bars.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.day));
  });
  await checkAsync('分时曲线 HH:mm 升序', async () => {
    const rows = await getIntradayRows('sh600519');
    return rows.length > 30 && rows.every((r, i) => /^\d{2}:\d{2}$/.test(r.time) && (i === 0 || r.time >= rows[i - 1].time));
  });
  await checkAsync('期货 nf_RB0/hf_NQ', async () => {
    const m = await getFutureQuotes(['nf_RB0', 'hf_NQ']);
    return (m.get('nf_RB0')?.price ?? 0) > 0 && (m.get('hf_NQ')?.price ?? 0) > 0;
  });
  await checkAsync('基金 012414（腾讯+F10 两级）', async () => {
    const m = await getFundQuotes(['012414']);
    const row = m.get('012414');
    return !!row && row.nav > 0 && /^\d{4}-\d{2}-\d{2}$/.test(row.date);
  });
  await checkAsync('加密三源 BTC/ETH', async () => {
    const batch = await getCryptoQuotes(['BTC_USDT', 'ETH_USDT']);
    if (batch.status === 'OFFLINE') return false;
    const rows = [...batch.quotes.values()];
    return rows.length >= 1 && rows.every((r) => r.price > 0);
  });
  await checkAsync('加密连通性探测', async () => {
    const batch = await probeCryptoNetwork();
    return ['CONNECTED', 'DEGRADED'].includes(batch.status);
  });
  await checkAsync('加密搜索 btc', async () => {
    const rs = await searchCryptos('btc');
    return rs.length > 0 && rs[0].code.includes('BTC');
  });
  await checkAsync('板块行业榜（push2 分页补全）', async () => {
    // EM 边缘节点按新建连接速率限流，跑完前面整批在线检查后常处于限流窗口；
    // 整项重试 3 次、间隔 15s 跨过窗口（源码层已镜像轮换+递增退避，生产靠 60s 轮询自愈）
    for (let round = 0; round < 3; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, 15000));
      const list = await getSectorQuotes(2);
      if (list && list.length > 50 && list.some((s) => s.code.startsWith('BK'))) return true;
    }
    return false;
  });
  await checkAsync('新股列表', async () => {
    const list = await getIpoList();
    return !!list && list.length > 0 && list.every((r) => /^\d{6}$/.test(r.pureCode));
  });
  await checkAsync('美股板块 ETF ≥30 只', async () => {
    const m = await getUsSectorQuotes();
    return m.size >= 30;
  });
  await checkAsync('全球指数默认 20 条出数', async () => {
    const { quotes } = await getGlobalIndexQuotes(visibleGlobalIndexes([], []));
    return quotes.length === 20 && quotes.filter((q) => q.price > 0).length >= 15;
  });
  await checkAsync('恒生科技指数出数（Yahoo 无源特判）', async () => {
    const { quotes } = await getGlobalIndexQuotes(GLOBAL_INDEXES.filter((g) => g.symbol === '^HSTECH'));
    return (quotes[0]?.price ?? 0) > 0;
  });
  await checkAsync('大盘概览（涨跌家数含北证）', async () => {
    const b = await getMarketBreadth();
    return (b.upCount ?? 0) > 0 && (b.downCount ?? 0) > 0 && (b.upCount ?? 0) + (b.downCount ?? 0) > 4000;
  });
  await checkAsync('涨停生态', async () => {
    const eco = await getLimitEcosystem();
    return eco !== null;
  });
  await checkAsync('离岸人民币涨跌', async () => {
    const pct = await getUsdcnhPct();
    return pct === null || Number.isFinite(pct);
  });
  await checkAsync('A股最后交易日', async () => {
    const d = await getAshareLastBarDate();
    return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  });
  await checkAsync('搜索“茅台”命中 600519', async () => {
    const rs = await searchStocks('茅台');
    return rs.some((r) => r.code === 'sh600519');
  });
  await checkAsync('搜索期货“螺纹”', async () => {
    const rs = await searchFutures('螺纹');
    return rs.length > 0;
  });
  await checkAsync('导入校验三态（EXISTS/OK/NOT_FOUND）', async () => {
    const rs = await resolveImportCandidates(
      [{ raw: '600519', code: 'sh600519' }, { raw: '平安银行', name: '平安银行' }, { raw: 'XYZ999', code: 'sh999999' }],
      new Set(['sh600519']),
    );
    const byRaw = new Map(rs.map((r) => [r.raw, r]));
    return byRaw.get('600519')?.status === 'EXISTS' &&
      byRaw.get('平安银行')?.status === 'OK' && byRaw.get('平安银行')?.symbol === 'sz000001' &&
      byRaw.get('XYZ999')?.status === 'NOT_FOUND';
  });
  await checkAsync('财报日期（600519）', async () => {
    const [last, next] = await getEarningsDate('600519');
    return last !== null || next !== null;
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  testUtil();
  await testStaleCacheStale();
  await sleep(20); // 等 util 里的异步断言落地
  testMarketTime();
  await testAuctionWindow();
  testStocks();
  testFunds();
  testKline();
  testGlobalIndex();
  testRest();
  await testScheduler();
  testProviders();
  await testGbkPipeline();
  await sleep(50); // 等 providers 里的异步断言落地

  if (process.env.STOCKLITE_ONLINE === '1') {
    await runOnline();
  } else {
    console.log('[在线段跳过：设 STOCKLITE_ONLINE=1 启用]');
  }

  console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main();
