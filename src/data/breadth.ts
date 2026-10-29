/**
 * A股大盘概览/市场宽度（移植自 MarketDataService 大盘概览段，东财 push2 + 新浪复用）。
 * 各子项独立请求、独立容错、独立 StaleCache：新鲜期内不发请求；过期后请求失败
 * 沿用最近成功值（stale 3 天盖过周末/休市）；超过兜底期才缺项。
 * 已知坑：
 *  - 涨跌家数须含北证50（0.899050），漏了会比第三方 App 少约 200~300 家；
 *  - push2ex 池接口 date 必须显式传 yyyyMMdd（传空返回 rc:102 无数据）；
 *  - 两市成交额用新浪 fields[9]（东财 push2 域名部分网络直连受限）；
 *  - 同期成交额对比必须用东财 trends2 ndays=2：新浪分钟线 amount 在深证成指少计约一半。
 * 持久化快照（Kotlin 磁盘兜底）在插件侧由宿主经 snapshotStore 注入，本层不持有存储。
 */
import { httpGetText } from '../shared/http';
import { StaleCache, numOf, parseSinaVars, emGetText } from './util';
import { CN_TZ, zonedTime, hhmmOfTz } from './marketTime';

const EM_UT = 'bd1d9ddb04089700cf9c27f6f7426281';
const EM_HEADERS = { Referer: 'https://data.eastmoney.com/' };
const SINA_HEADERS = { Referer: 'http://finance.sina.com.cn' };

/** 涨跌家数（沪深北合计）：上证(1.000001)+深证综指(0.399106)+北证50(0.899050) 的 f113/f114/f115 求和 */
async function fetchAdvanceDecline(): Promise<{ up: number; down: number; flat: number } | null> {
  async function fetchOne(secid: string): Promise<{ up: number; down: number; flat: number } | null> {
    try {
      // push2 走 emGetText：Node 默认 ALPN 带 h2 会被东财重置连接（详见 util.ts 注释），重试由 StaleCache 60s 轮询兜底
      const raw = await emGetText(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&ut=${EM_UT}&fields=f113,f114,f115`,
        EM_HEADERS,
      );
      if (!raw) return null;
      const d = JSON.parse(raw)?.data;
      const up = Math.trunc(numOf(String(d?.f113 ?? '')));
      if (!Number.isFinite(up)) return null;
      return { up, down: Math.trunc(numOf(String(d?.f114 ?? ''), 0)), flat: Math.trunc(numOf(String(d?.f115 ?? ''), 0)) };
    } catch {
      return null;
    }
  }
  const sh = await fetchOne('1.000001');
  if (!sh) return null;
  const sz = await fetchOne('0.399106');
  if (!sz) return null;
  const bj = (await fetchOne('0.899050')) ?? { up: 0, down: 0, flat: 0 };
  return { up: sh.up + sz.up + bj.up, down: sh.down + sz.down + bj.down, flat: sh.flat + sz.flat + bj.flat };
}

function shanghaiPoolDate(daysBack: number, now: number): string {
  return zonedTime(CN_TZ, now - daysBack * 86_400_000).date.replace(/-/g, '');
}

/** 涨停/跌停家数（push2ex 池 tc）。今日无数据回退最近可用交易日（最多往前找 5 天） */
async function fetchLimitCounts(now: number = Date.now()): Promise<{ limitUp: number; limitDown: number } | null> {
  async function fetchTc(url: string): Promise<number | null> {
    try {
      const raw = await httpGetText(url, { retries: 2 });
      const tc = Math.trunc(numOf(String(JSON.parse(raw)?.data?.tc ?? '')));
      return Number.isFinite(tc) ? tc : null;
    } catch {
      return null;
    }
  }
  for (let daysBack = 0; daysBack <= 4; daysBack++) {
    const date = shanghaiPoolDate(daysBack, now);
    const zt = await fetchTc(`https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt:asc&date=${date}`);
    const dt = await fetchTc(`https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fund:asc&date=${date}`);
    if (zt !== null && dt !== null) return { limitUp: zt, limitDown: dt };
  }
  return null;
}

/** 两市成交额：新浪 sh000001+sz399001 字段 9（元）之和；收盘后保持当日收盘值 */
async function fetchTotalTurnover(): Promise<number | null> {
  let raw: string;
  try {
    raw = await httpGetText('http://hq.sinajs.cn/list=sh000001,sz399001', { gbk: true, headers: SINA_HEADERS, retries: 2 });
  } catch {
    return null;
  }
  let sum = 0;
  let count = 0;
  for (const f of parseSinaVars(raw).values()) {
    const turnover = numOf(f[9] ?? '');
    if (!(turnover > 0)) continue;
    sum += turnover;
    count++;
  }
  return count === 0 ? null : sum;
}

/**
 * 上一交易日“同期”两市成交额（东财 trends2 ndays=2，较早日期=上一交易日，天然跳过周末节假日）。
 * 盘中截至当前分钟累计；休市/盘前取整日。返回 [累计(元), 上一交易日]；任一指数缺失返回 null。
 */
async function fetchPrevDaySameTimeTurnover(now: number = Date.now()): Promise<[number, string] | null> {
  const today = zonedTime(CN_TZ, now).date;
  let total = 0;
  let prevDayStr = '';
  for (const secid of ['1.000001', '0.399001']) {
    let trends: string[] | null = null;
    try {
      const raw = await httpGetText(
        `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1&fields2=f51,f57&ndays=2&iscr=0`,
        { headers: { Referer: 'https://quote.eastmoney.com/' }, retries: 2 },
      );
      const t = JSON.parse(raw)?.data?.trends;
      if (Array.isArray(t) && t.length > 0) trends = t.map(String);
    } catch { /* 落入下方 return null */ }
    if (!trends) return null;
    const dates = [...new Set(trends.map((r) => (r.length >= 10 ? r.slice(0, 10) : '')).filter((d) => d !== ''))];
    const lastDataDay = dates.reduce((a, b) => (a > b ? a : b), '');
    const prevDay = dates.filter((d) => d < lastDataDay).reduce((a, b) => (a > b ? a : b), '');
    if (!prevDay) return null;
    // 走势含当日数据 = 今日是交易日，截至当前分钟；否则休市/盘前，取整日
    const cutoff = lastDataDay === today ? hhmmOfTz(Math.floor(now / 1000), CN_TZ) : '23:59';
    let sum = 0;
    for (const row of trends) {
      if (row.length < 20 || !row.startsWith(prevDay)) continue;
      if (row.slice(11, 16) > cutoff) continue;
      sum += numOf(row.slice(row.indexOf(',') + 1), 0);
    }
    if (sum <= 0) return null;
    total += sum;
    prevDayStr = prevDay;
  }
  return total > 0 && prevDayStr ? [total, prevDayStr] : null;
}

/** 大/中/小盘代理：沪深300 / 中证500 / 中证1000 涨跌幅% */
async function fetchCapTierPct(): Promise<[number, number, number] | null> {
  let raw: string;
  try {
    raw = await httpGetText('http://hq.sinajs.cn/list=sh000300,sh000905,sh000852', { gbk: true, headers: SINA_HEADERS, retries: 2 });
  } catch {
    return null;
  }
  const quotes = parseSinaVars(raw);
  const pctOf = (sym: string): number | null => {
    const f = quotes.get(sym);
    if (!f) return null;
    const prev = numOf(f[2] ?? '', 0);
    const price = numOf(f[3] ?? '');
    if (!Number.isFinite(price) || !(prev > 0)) return null;
    return ((price - prev) / prev) * 100;
  };
  const large = pctOf('sh000300');
  const mid = pctOf('sh000905');
  const small = pctOf('sh000852');
  if (large === null || mid === null || small === null) return null;
  return [large, mid, small];
}

export interface SectorPct {
  name: string;
  pct: number;
}

/** 领涨/领跌行业板块 TOP6（过滤成分股 <5 的冷门板块，避免单票噪声） */
async function fetchSectorLeaders(): Promise<{ top: SectorPct[]; bottom: SectorPct[] } | null> {
  async function fetchTop(descending: boolean): Promise<SectorPct[] | null> {
    const po = descending ? 1 : 0;
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=30&po=${po}&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f14,f3,f104,f105`;
    let raw: string | null = null;
    // push2 走 emGetText 绕开 ALPN-h2 重置；常规限流则间隔重试一次再放弃
    for (let attempt = 0; attempt < 2 && raw === null; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
      raw = await emGetText(url, EM_HEADERS);
    }
    if (raw === null) return null;
    try {
      const diff = JSON.parse(raw)?.data?.diff;
      if (!Array.isArray(diff)) return null;
      const out: SectorPct[] = [];
      for (const o of diff) {
        const name = String(o?.f14 ?? '');
        const pct = numOf(String(o?.f3 ?? ''));
        const cons = Math.trunc(numOf(String(o?.f104 ?? ''), 0)) + Math.trunc(numOf(String(o?.f105 ?? ''), 0));
        if (!name || !Number.isFinite(pct) || cons < 5) continue;
        out.push({ name, pct });
        if (out.length >= 6) break;
      }
      return out;
    } catch {
      return null;
    }
  }
  const top = await fetchTop(true);
  if (!top) return null;
  const bottom = await fetchTop(false);
  if (!bottom || top.length === 0 || bottom.length === 0) return null;
  return { top, bottom };
}

/** 主力资金净流入（沪深两市合计，元），负数为净流出 */
async function fetchMainCapitalFlow(): Promise<number | null> {
  try {
    const raw = await emGetText(
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=f62',
      EM_HEADERS,
    );
    if (!raw) return null;
    const diff = JSON.parse(raw)?.data?.diff;
    if (!Array.isArray(diff)) return null;
    let sum = 0;
    for (const o of diff) sum += numOf(String(o?.f62 ?? ''), 0);
    return sum;
  } catch {
    return null;
  }
}

// ── 股指期货龙虎榜持仓（龙虎榜每日结算后更新一次，10 分钟缓存足够）──────────────

const INDEX_FUTURES_VARIETIES: [string, string][] = [['IH', '上证50'], ['IF', '沪深300'], ['IC', '中证500'], ['IM', '中证1000']];

export interface VarietyNetChange {
  code: string;
  name: string;
  /** 净加空 = Δ空 − Δ多 */
  netAddShort: number;
}

export interface IndexFuturesPosition {
  tradeDate: string; // MM-dd
  citicLong: number;
  citicShort: number;
  citicLongChange: number;
  citicShortChange: number;
  mainForceLong: number;
  mainForceShort: number;
  mainForceLongChange: number;
  mainForceShortChange: number;
  citicByVariety: VarietyNetChange[];
  mainForceByVariety: VarietyNetChange[];
}

/** 最近一个已披露龙虎榜数据的交易日 yyyy-MM-dd */
async function fetchLatestFuturesTradeDate(): Promise<string | null> {
  const filter = encodeURIComponent('(MEMBER_NAME_ABBR="本日合计")(TYPE="2")(TRADE_CODE="IF")');
  try {
    const raw = await httpGetText(
      'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_FUTU_DAILYPOSITION' +
      `&columns=TRADE_DATE&filter=${filter}&sortColumns=TRADE_DATE&sortTypes=-1&pageNumber=1&pageSize=1&source=WEB&client=WEB`,
      { retries: 2 },
    );
    const s = String(JSON.parse(raw)?.result?.data?.[0]?.TRADE_DATE ?? '');
    return s.length >= 10 ? s.slice(0, 10) : null;
  } catch {
    return null;
  }
}

interface FuturesAgg {
  long: number; short: number; dLong: number; dShort: number;
  byVariety: Map<string, number[]>;
}

/** 按会员名聚合指定交易日持仓：覆盖四大期指全部合约月份（东财“品种合计”口径） */
async function fetchFuturesAgg(memberName: string, type: string, date: string): Promise<FuturesAgg | null> {
  const filter = encodeURIComponent(`(MEMBER_NAME_ABBR="${memberName}")(TYPE="${type}")(TRADE_DATE='${date}')`);
  try {
    const raw = await httpGetText(
      'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_FUTU_DAILYPOSITION' +
      `&columns=TRADE_CODE,LONG_POSITION,SHORT_POSITION,LP_CHANGE,SP_CHANGE&filter=${filter}&pageNumber=1&pageSize=200&source=WEB&client=WEB`,
      { retries: 2 },
    );
    const arr = JSON.parse(raw)?.result?.data;
    if (!Array.isArray(arr)) return null;
    const byVariety = new Map<string, number[]>();
    for (const o of arr) {
      const variety = String(o?.TRADE_CODE ?? '');
      if (!INDEX_FUTURES_VARIETIES.some(([c]) => c === variety)) continue;
      const acc = byVariety.get(variety) ?? [0, 0, 0, 0];
      acc[0] += numOf(String(o?.LONG_POSITION ?? ''), 0);
      acc[1] += numOf(String(o?.SHORT_POSITION ?? ''), 0);
      acc[2] += numOf(String(o?.LP_CHANGE ?? ''), 0);
      acc[3] += numOf(String(o?.SP_CHANGE ?? ''), 0);
      byVariety.set(variety, acc);
    }
    if (byVariety.size === 0) return null;
    let long = 0, short = 0, dLong = 0, dShort = 0;
    for (const v of byVariety.values()) { long += v[0]; short += v[1]; dLong += v[2]; dShort += v[3]; }
    return { long, short, dLong, dShort, byVariety };
  } catch {
    return null;
  }
}

let futuresPositionCache: IndexFuturesPosition | null = null;
let futuresPositionCacheTime = 0;
const FUTURES_POSITION_CACHE_TTL = 10 * 60_000;

/** 中信期货(代客)与前20会员合计的多空持仓；日期取最近已披露交易日，不做“待收盘”猜测 */
export async function fetchIndexFuturesPosition(): Promise<IndexFuturesPosition | null> {
  const now = Date.now();
  if (futuresPositionCache && now - futuresPositionCacheTime < FUTURES_POSITION_CACHE_TTL) return futuresPositionCache;
  const date = await fetchLatestFuturesTradeDate();
  if (!date) return futuresPositionCache;
  const citic = await fetchFuturesAgg('中信期货(代客)', '0', date);
  if (!citic) return futuresPositionCache;
  const total = await fetchFuturesAgg('本日合计', '2', date);
  if (!total) return futuresPositionCache;
  const varieties = (agg: FuturesAgg): VarietyNetChange[] =>
    INDEX_FUTURES_VARIETIES.flatMap(([code, name]) => {
      const v = agg.byVariety.get(code);
      return v ? [{ code, name, netAddShort: v[3] - v[2] }] : [];
    });
  const result: IndexFuturesPosition = {
    tradeDate: date.slice(5),
    citicLong: citic.long, citicShort: citic.short,
    citicLongChange: citic.dLong, citicShortChange: citic.dShort,
    mainForceLong: total.long, mainForceShort: total.short,
    mainForceLongChange: total.dLong, mainForceShortChange: total.dShort,
    citicByVariety: varieties(citic),
    mainForceByVariety: varieties(total),
  };
  futuresPositionCache = result;
  futuresPositionCacheTime = now;
  return result;
}

// ── 大盘概览装配 ─────────────────────────────────────────────────────────────

export interface MarketBreadthData {
  upCount?: number;
  downCount?: number;
  flatCount?: number;
  limitUpCount?: number;
  limitDownCount?: number;
  totalTurnover?: number;
  /** 同期对比不随快照持久化：累计口径与钟点相关，旧值只会误导 */
  prevTurnoverSameTime?: number;
  prevTurnoverDate?: string;
  largeCapPct?: number;
  midCapPct?: number;
  smallCapPct?: number;
  topSectors: SectorPct[];
  bottomSectors: SectorPct[];
  mainNetInflow?: number;
  futuresPosition: IndexFuturesPosition | null;
}

export const BREADTH_STALE_TTL_MS = 3 * 24 * 60 * 60_000;

const BREADTH_FRESH = 60_000;
const advDecCache = new StaleCache<{ up: number; down: number; flat: number }>(BREADTH_FRESH, BREADTH_STALE_TTL_MS);
const limitsCache = new StaleCache<{ limitUp: number; limitDown: number }>(BREADTH_FRESH, BREADTH_STALE_TTL_MS);
const turnoverCache = new StaleCache<number>(BREADTH_FRESH, BREADTH_STALE_TTL_MS);
// 同期成交额是随钟点增长的累计值，取不到就宁可不显示对比，沿用窗口只给 10 分钟
const prevTurnoverCache = new StaleCache<[number, string]>(BREADTH_FRESH, 10 * 60_000);
const capTierCache = new StaleCache<[number, number, number]>(BREADTH_FRESH, BREADTH_STALE_TTL_MS);
const flowCache = new StaleCache<number>(BREADTH_FRESH, BREADTH_STALE_TTL_MS);
// 板块龙虎榜（clist/get）接口脆弱易限流，新鲜度放宽到 120 秒进一步降频
const sectorLeadersCache = new StaleCache<{ top: SectorPct[]; bottom: SectorPct[] }>(2 * 60_000, 5 * 60_000);

/** 各子项最后成功获取时间（0=从未成功），供界面标注数据新鲜度 */
export function getBreadthDataTimes(): Record<string, number> {
  return {
    advDec: advDecCache.lastSuccessTime,
    limits: limitsCache.lastSuccessTime,
    turnover: turnoverCache.lastSuccessTime,
    capTier: capTierCache.lastSuccessTime,
    flow: flowCache.lastSuccessTime,
    sector: sectorLeadersCache.lastSuccessTime,
    futures: futuresPositionCacheTime,
  };
}

export interface BreadthSnapshotStore {
  load(): MarketBreadthData | null;
  save(data: MarketBreadthData): void;
}

/**
 * A股大盘概览（Kotlin getMarketBreadth）。snapshotStore 对应 Kotlin 的磁盘快照持久化：
 * 内存缓存在宿主重启后清空，若恰逢收盘后实时接口也无数据，靠宿主注入的快照兜底最后一层。
 * prevTurnoverSameTime/Date 不进快照（口径与钟点相关）。
 */
export async function getMarketBreadth(now: number = Date.now(), snapshotStore?: BreadthSnapshotStore): Promise<MarketBreadthData> {
  const breadth = await advDecCache.getOrFetch(() => fetchAdvanceDecline());
  const limits = await limitsCache.getOrFetch(() => fetchLimitCounts(now));
  const turnover = await turnoverCache.getOrFetch(() => fetchTotalTurnover());
  const prevTurn = await prevTurnoverCache.getOrFetch(() => fetchPrevDaySameTimeTurnover(now));
  const capTier = await capTierCache.getOrFetch(() => fetchCapTierPct());
  const sectors = await sectorLeadersCache.getOrFetch(() => fetchSectorLeaders());
  const flow = await flowCache.getOrFetch(() => fetchMainCapitalFlow());
  const futuresPosition = await fetchIndexFuturesPosition();

  const persisted = snapshotStore?.load() ?? null;
  const result: MarketBreadthData = {
    upCount: breadth?.up ?? persisted?.upCount,
    downCount: breadth?.down ?? persisted?.downCount,
    flatCount: breadth?.flat ?? persisted?.flatCount,
    limitUpCount: limits?.limitUp ?? persisted?.limitUpCount,
    limitDownCount: limits?.limitDown ?? persisted?.limitDownCount,
    totalTurnover: turnover ?? persisted?.totalTurnover,
    prevTurnoverSameTime: prevTurn?.[0],
    prevTurnoverDate: prevTurn?.[1],
    largeCapPct: capTier?.[0] ?? persisted?.largeCapPct,
    midCapPct: capTier?.[1] ?? persisted?.midCapPct,
    smallCapPct: capTier?.[2] ?? persisted?.smallCapPct,
    topSectors: sectors?.top ?? persisted?.topSectors ?? [],
    bottomSectors: sectors?.bottom ?? persisted?.bottomSectors ?? [],
    mainNetInflow: flow ?? persisted?.mainNetInflow,
    futuresPosition,
  };
  snapshotStore?.save(result);
  return result;
}

// ── 涨停生态（连板/炸板池，预测机制与面板共用）───────────────────────────────

export interface LimitEcosystem {
  /** 数据真实归属日 yyyy-MM-dd（池自身日期，非“今天”） */
  date: string;
  ztCount: number;
  dtCount: number;
  zbCount: number;
  maxLianban: number;
}

const limitEcoCache = new StaleCache<LimitEcosystem | null>(2 * 60_000, BREADTH_STALE_TTL_MS);

/**
 * 涨停生态明细。池接口历史 date 不可靠（恒返回最近一日），语义定义为
 * “最近一个有涨停数据的交易日”：盘前当日池未生成自动落到 T-1，tc=0 继续前移。
 */
export function getLimitEcosystem(now: number = Date.now()): Promise<LimitEcosystem | null> {
  return limitEcoCache.getOrFetch(async () => {
    for (let daysBack = 0; daysBack <= 4; daysBack++) {
      const date = shanghaiPoolDate(daysBack, now);
      const { tc: ztTc, pool } = await fetchPoolData(
        `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=320&sort=lbc:desc&date=${date}`);
      if (ztTc <= 0) continue;
      const { tc: zbTc } = await fetchPoolData(
        `https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=320&sort=fbt:asc&date=${date}`);
      const { tc: dtTc } = await fetchPoolData(
        `https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=320&sort=fund:asc&date=${date}`);
      let maxLbc = 0;
      for (const o of pool ?? []) maxLbc = Math.max(maxLbc, Math.trunc(numOf(String(o?.lbc ?? ''), 0)));
      // 日期标签用回溯命中的池自身日期：bar 日期盘中恒为今天，池未生成时（实测早盘 10 点前当日池 tc=0）
      // 会把 T-1 池数据标成今天造成归属错位；池日期才是数据真实归属
      const label = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      return { date: label, ztCount: ztTc, dtCount: dtTc, zbCount: zbTc, maxLianban: maxLbc };
    }
    return null;
  });
}

async function fetchPoolData(url: string): Promise<{ tc: number; pool: any[] | null }> {
  try {
    const raw = await httpGetText(url, { retries: 2 });
    const data = JSON.parse(raw)?.data;
    if (!data) return { tc: 0, pool: null };
    return { tc: Math.trunc(numOf(String(data.tc ?? ''), 0)), pool: Array.isArray(data.pool) ? data.pool : null };
  } catch {
    return { tc: 0, pool: null };
  }
}

/** 新浪上证指数数据日期 f[30]（形如 2026-10-16）= 行情快照实际归属交易日 */
export async function getAshareLastBarDate(): Promise<string | null> {
  try {
    const raw = await httpGetText('https://hq.sinajs.cn/list=sh000001', { gbk: true, headers: SINA_HEADERS, retries: 2 });
    const f = [...parseSinaVars(raw).values()][0];
    const d = f?.[30] ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  } catch {
    return null;
  }
}

/** 离岸人民币当日涨跌%：正=人民币贬值（利空）、负=升值（利好）。f[10] 直给，缺失用 f[1]/f[3] 自算 */
export async function getUsdcnhPct(): Promise<number | null> {
  try {
    const raw = await httpGetText('https://hq.sinajs.cn/list=fx_susdcnh', { gbk: true, headers: SINA_HEADERS, retries: 2 });
    const f = [...parseSinaVars(raw).values()][0];
    if (!f) return null;
    const direct = numOf(f[10] ?? '');
    if (Number.isFinite(direct)) return direct;
    const price = numOf(f[1] ?? '');
    const prev = numOf(f[3] ?? '');
    if (!Number.isFinite(price) || !Number.isFinite(prev) || prev <= 0) return null;
    return ((price - prev) / prev) * 100;
  } catch {
    return null;
  }
}

/**
 * 腾讯指数快照 [现价, 昨收, 今开]。盘前研判结算用；
 * 盘前今开为 0（尚未开盘），调用方据此保持未结算，不会拿旧数据凑数。
 */
export async function getTencentIndexSnapshot(symbol: string): Promise<[number, number, number] | null> {
  try {
    const raw = await httpGetText(`https://qt.gtimg.cn/q=${symbol}`, { gbk: true, headers: { Referer: 'https://gu.qq.com' }, retries: 2 });
    const f = [...parseTencentFields(raw)][0]?.[1];
    if (!f) return null;
    const price = numOf(f[3] ?? '');
    const prev = numOf(f[4] ?? '');
    if (!(price > 0) || !(prev > 0)) return null;
    return [price, prev, numOf(f[5] ?? '', 0)];
  } catch {
    return null;
  }
}

function parseTencentFields(raw: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of raw.matchAll(/v_(\w+)="([^"]*)"/g)) map.set(m[1], m[2].split('~'));
  return map;
}
