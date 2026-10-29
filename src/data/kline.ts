/**
 * K 线 / 分时数据层（移植自 Kotlin ChartDataService）。
 * 路由规则与降级链与 JetBrains 版逐分支对齐：
 *  - A 股历史：腾讯 qfq 前复权分页 → 新浪日K（含今日实时 bar 追加）
 *  - 港股（含恒指科技 HSTECH）：腾讯 newfqkline（字段序 [date,open,close,high,low] 已验证）→ Yahoo
 *  - 期货 nf_/hf_：新浪期货日K/分钟线，周/月本地重采样
 *  - 加密：Bitget → Gate.io
 *  - 基金：天天基金 pingzhongdata 净值历史 → 场内 ETF K 线兜底
 *  - 全球指数：CN_SINA_MAP → Yahoo（range 上限防静默降频）
 * 已知坑：Yahoo 无 ^HSTECH/HSTECH.HK 历史；新浪分钟线不含成交额。
 */
import type { KlineBar, MinutePoint, Period } from '../shared/types';
import { httpGetText } from '../shared/http';
import { parseSinaVars, numOf } from './util';
import { CN_TZ, dayOfShanghai, zonedTime } from './marketTime';
import { normalizeFutureSymbol } from './futures';

/** 内部日 bar：date 为交易所本地 'yyyy-MM-dd'；NaN 表示数据源未提供 */
export interface BarPoint {
  day: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/** 内部分钟点：time 为交易所本地 'HH:mm' */
export interface MinuteRow {
  time: string;
  price: number;
  volume?: number;
}

interface YahooCandle {
  ts: number; // epoch 秒
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  gmtoffset: number;
}

const CN_SINA_MAP: Record<string, string> = {
  '000001.SS': 'sh000001',
  '399001.SZ': 'sz399001',
  '399006.SZ': 'sz399006',
  '000300.SS': 'sh000300',
  '000688.SS': 'sh000688',
};

// ── 新浪分钟/历史 K ──────────────────────────────────────────────────────────

async function fetchSinaKlineRaw(symbol: string, scale: number, datalen: number): Promise<{ dayStr: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=${scale}&ma=no&datalen=${datalen}`;
  try {
    const raw = await httpGetText(url, { retries: 1 });
    const arr = JSON.parse(raw) as Record<string, string>[];
    if (!Array.isArray(arr)) return [];
    return arr.map((o) => ({
      dayStr: String(o.day ?? ''),
      open: numOf(o.open),
      high: numOf(o.high),
      low: numOf(o.low),
      close: numOf(o.close),
      volume: numOf(o.volume),
    })).filter((r) => r.dayStr.length >= 10 && Number.isFinite(r.close) && r.close > 0);
  } catch {
    return [];
  }
}

/** 当日 1 分钟分时（dayStr 为上海墙上时间，直接截 'HH:mm'） */
async function fetchSinaIntraday(symbol: string): Promise<MinuteRow[]> {
  for (const scale of [1, 5]) {
    const rows = await fetchSinaKlineRaw(symbol, scale, scale === 1 ? 600 : 288);
    const today = dayOfShanghai(Date.now());
    const hits = rows.filter((r) => r.dayStr.startsWith(today)).map((r) => ({
      time: r.dayStr.slice(11, 16),
      price: r.close,
      volume: Number.isFinite(r.volume) ? r.volume : undefined,
    }));
    if (hits.length > 0) return hits;
  }
  return [];
}

/** 新浪实时行情今日 bar（日K历史收盘后不更新时的补充） */
async function fetchSinaTodayBar(symbol: string): Promise<BarPoint | null> {
  let raw: string;
  try {
    raw = await httpGetText(`http://hq.sinajs.cn/list=${symbol}`, { gbk: true, headers: { Referer: 'http://finance.sina.com.cn' }, retries: 1 });
  } catch {
    return null;
  }
  const f = parseSinaVars(raw).get(symbol);
  if (!f) return null;
  const open = numOf(f[1]);
  const close = numOf(f[3]);
  const high = numOf(f[4]);
  const low = numOf(f[5]);
  if (!(open > 0) || !(close > 0) || !(high > 0) || !(low > 0)) return null;
  return { day: dayOfShanghai(Date.now()), open, close, high, low, volume: numOf(f[8]) };
}

async function fetchSinaKlineHistory(symbol: string, scale: number, datalen: number): Promise<BarPoint[]> {
  const rows = await fetchSinaKlineRaw(symbol, scale, datalen);
  const list: BarPoint[] = rows.map((r) => ({
    day: r.dayStr.slice(0, 10),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
  // 仅日K（scale=240）追加/替换今日实时 bar；周/月K无需
  if (scale !== 240) return list;
  const todayBar = await fetchSinaTodayBar(symbol);
  if (!todayBar) return list;
  if (list.length > 0 && list[list.length - 1].day === todayBar.day) {
    return [...list.slice(0, -1), todayBar];
  }
  return [...list, todayBar];
}

// ── 腾讯历史 K（A 股 qfq 分页 / 港股）────────────────────────────────────────

const PERIOD_PARAM: Record<Period, string> = { day: 'day', week: 'week', month: 'month' };

/**
 * A 股历史 K，腾讯 qfq 前复权分页拉取。
 * 字段顺序：[date, open, close, high, low, volume, ...]（open/close 与新浪顺序不同，勿调换）
 */
async function fetchTencentAShareHistory(symbol: string, period: Period, count: number): Promise<BarPoint[]> {
  const periodParam = PERIOD_PARAM[period];
  const PAGE = 300;
  const all: BarPoint[] = [];
  let endDate = '';
  for (let guard = 0; guard < 40; guard++) {
    const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${symbol},${periodParam},,${endDate},${PAGE},qfq&_var=kline_${periodParam}qfq`;
    let raw: string;
    try {
      raw = await httpGetText(url, { retries: 1 });
    } catch {
      break;
    }
    let page: BarPoint[] = [];
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('=') + 1));
      const symObj = json.data?.[symbol];
      const bars = (symObj?.[`qfq${periodParam}`]?.length ? symObj[`qfq${periodParam}`] : symObj?.[periodParam]) as string[][] | undefined;
      if (!bars) break;
      for (const bar of bars) {
        const day = String(bar[0] ?? '');
        if (day.length < 10) continue;
        const close = numOf(bar[2]);
        if (!(close > 0)) continue;
        page.push({ day: day.slice(0, 10), open: numOf(bar[1]), close, high: numOf(bar[3]), low: numOf(bar[4]), volume: numOf(bar[5]) });
      }
    } catch {
      break;
    }
    if (page.length === 0) break;
    all.unshift(...page); // 向前翻页，插到头部
    if (all.length >= count) break; // 够用即止（Kotlin 拉全量，这里按 count 收敛请求数）
    if (page.length < PAGE) break; // 已到上市首日
    const earliest = new Date(`${page[0].day}T00:00:00+08:00`).getTime() - 86_400_000;
    endDate = new Date(earliest).toISOString().slice(0, 10);
  }
  return all.slice(-count);
}

/** 港股日内分时（腾讯 ifzqgtimg minute/query，行 "HHMM price cumVol[ cumAmount]"，量取差分） */
export async function fetchHkIntraday(code: string): Promise<MinuteRow[]> {
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query?code=hk${code}&_var=min_data`;
  let raw: string;
  try {
    raw = await httpGetText(url, { retries: 1 });
  } catch {
    return [];
  }
  try {
    const json = JSON.parse(raw.slice(raw.indexOf('=') + 1));
    const rows = json.data?.[`hk${code}`]?.data?.data as string[] | undefined;
    if (!rows) return [];
    const list: MinuteRow[] = [];
    let prevCumVol = 0;
    for (const row of rows) {
      const parts = row.split(' ');
      if (parts.length < 2) continue;
      const price = numOf(parts[1]);
      if (!(price > 0)) continue;
      const cumVol = numOf(parts[2], 0);
      const vol = Math.max(cumVol - prevCumVol, 0);
      prevCumVol = cumVol;
      if (!/^\d{4}$/.test(parts[0])) continue;
      list.push({ time: `${parts[0].slice(0, 2)}:${parts[0].slice(2, 4)}`, price, volume: vol });
    }
    return list;
  } catch {
    return [];
  }
}

/**
 * 港股历史 K（个股与指数通用，如 07709 / HSTECH）。
 * 字段顺序 [date, open, close, high, low, ...] 已用 qt.gtimg.cn 实时行情交叉验证，勿调换。
 */
export async function fetchHkHistory(code: string, period: Period, count: number): Promise<BarPoint[]> {
  const periodParam = PERIOD_PARAM[period];
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=hk${code},${periodParam},,${''},${count},qfq&_var=kline_${periodParam}qfq`;
  let raw: string;
  try {
    raw = await httpGetText(url, { retries: 1 });
  } catch {
    return [];
  }
  try {
    const json = JSON.parse(raw.slice(raw.indexOf('=') + 1));
    const bars = json.data?.[`hk${code}`]?.[periodParam] as string[][] | undefined;
    if (!bars) return [];
    const list: BarPoint[] = [];
    for (const bar of bars) {
      const day = String(bar[0] ?? '');
      if (day.length < 10) continue;
      const close = numOf(bar[2]);
      if (!(close > 0)) continue;
      list.push({ day: day.slice(0, 10), open: numOf(bar[1]), close, high: numOf(bar[3]), low: numOf(bar[4]), volume: numOf(bar[5]) });
    }
    return list.slice(-count);
  } catch {
    return [];
  }
}

// ── Yahoo ───────────────────────────────────────────────────────────────────

async function fetchYahooCandles(yahooSymbol: string, interval: string, range: string): Promise<YahooCandle[]> {
  let mapped = yahooSymbol;
  if (mapped === '^HSTECH') mapped = 'HSTECH.HK';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(mapped)}?interval=${interval}&range=${range}`;
  let json: any;
  try {
    json = JSON.parse(await httpGetText(url, { retries: 1 }));
  } catch {
    return [];
  }
  const result = json?.chart?.result?.[0];
  const timestamps: number[] | undefined = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (!timestamps || !quote?.close) return [];
  const gmtoffset = Number(result?.meta?.gmtoffset ?? 0);
  const out: YahooCandle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = Number(timestamps[i]);
    const close = quote.close[i];
    if (!(ts > 0) || close === null || close === undefined || !Number.isFinite(close)) continue;
    out.push({
      ts,
      close,
      open: Number.isFinite(quote.open?.[i]) ? quote.open[i] : NaN,
      high: Number.isFinite(quote.high?.[i]) ? quote.high[i] : NaN,
      low: Number.isFinite(quote.low?.[i]) ? quote.low[i] : NaN,
      volume: Number.isFinite(quote.volume?.[i]) ? quote.volume[i] : NaN,
      gmtoffset,
    });
  }
  return out;
}

function yahooToBars(candles: YahooCandle[], maxCount: number): BarPoint[] {
  return candles.slice(-maxCount).map((c) => {
    const day = new Date((c.ts + c.gmtoffset) * 1000).toISOString().slice(0, 10);
    return { day, open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume };
  });
}

function yahooToMinutes(candles: YahooCandle[]): MinuteRow[] {
  return candles.map((c) => ({
    time: new Date((c.ts + c.gmtoffset) * 1000).toISOString().slice(11, 16),
    price: c.close,
    volume: Number.isFinite(c.volume) ? c.volume : undefined,
  }));
}

async function fetchYahooIntraday(yahooSymbol: string): Promise<MinuteRow[]> {
  return yahooToMinutes(await fetchYahooCandles(yahooSymbol, '5m', '1d'));
}

async function fetchYahooHistory(yahooSymbol: string, interval: string, range: string, maxCount: number): Promise<BarPoint[]> {
  return yahooToBars(await fetchYahooCandles(yahooSymbol, interval, range), maxCount);
}

// ── 期货分钟/日K ─────────────────────────────────────────────────────────────

async function fetchDomesticFutureMinLine(contract: string): Promise<MinuteRow[]> {
  const url = `https://stock2.finance.sina.com.cn/futures/api/json.php/InnerFuturesNewService.getFewMinLine?symbol=${contract}&type=1`;
  let arr: Record<string, unknown>[];
  try {
    arr = JSON.parse(await httpGetText(url, { retries: 1 }));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const today = dayOfShanghai(Date.now());
  const out: MinuteRow[] = [];
  for (const o of arr) {
    const dayStr = String(o.d ?? '');
    const price = numOf(String(o.c ?? ''));
    if (!dayStr.startsWith(today) || !(price > 0)) continue;
    out.push({ time: dayStr.slice(11, 16), price, volume: numOf(String(o.v ?? ''), NaN) || undefined });
  }
  return out;
}

async function fetchDomesticFutureDailyHistory(contract: string): Promise<BarPoint[]> {
  const url = `https://stock2.finance.sina.com.cn/futures/api/json.php/InnerFuturesNewService.getDailyKLine?symbol=${contract}&datalen=2000`;
  let arr: Record<string, unknown>[];
  try {
    arr = JSON.parse(await httpGetText(url, { retries: 1 }));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: BarPoint[] = [];
  for (const o of arr) {
    const day = String(o.d ?? '');
    const close = numOf(String(o.c ?? ''));
    if (day.length < 10 || !(close > 0)) continue;
    out.push({ day: day.slice(0, 10), open: numOf(String(o.o ?? '')), close, high: numOf(String(o.h ?? '')), low: numOf(String(o.l ?? '')), volume: numOf(String(o.v ?? '')) });
  }
  return out;
}

/** 外盘分钟线行解析（两种列宽，与 Kotlin parseGlobalFutureRow 对齐） */
function parseGlobalFutureRow(values: string[], currentDate: string): { dateTime: string; price: number } {
  if (values.length >= 10) {
    const date = values[0] || currentDate;
    const price = numOf(values[5]);
    return { dateTime: values[9] || `${date} ${values[4]}`, price };
  }
  if (values.length >= 6) {
    const price = numOf(values[1]);
    return { dateTime: values[5] || `${currentDate} ${values[0]}`, price };
  }
  return { dateTime: '', price: NaN };
}

async function fetchGlobalFutureMinLine(contract: string): Promise<MinuteRow[]> {
  const url = `https://stock2.finance.sina.com.cn/futures/api/json.php/GlobalFuturesService.getGlobalFuturesMinLine?symbol=${contract}`;
  let json: any;
  try {
    json = JSON.parse(await httpGetText(url, { retries: 1 }));
  } catch {
    return [];
  }
  const rows = json?.minLine_1d as unknown[][] | undefined;
  if (!rows) return [];
  let currentDate = '';
  const all: { dateTime: string; price: number }[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const values = row.map((x) => String(x ?? ''));
    const { dateTime, price } = parseGlobalFutureRow(values, currentDate);
    if (dateTime) currentDate = dateTime.split(' ')[0] || currentDate;
    if (dateTime && Number.isFinite(price) && price > 0) all.push({ dateTime, price });
  }
  if (all.length === 0) return [];
  const latestDateKey = all[all.length - 1].dateTime.split(' ')[0];
  return all
    .filter((r) => r.dateTime.startsWith(latestDateKey))
    .map((r) => ({ time: r.dateTime.slice(11, 16), price: r.price }));
}

/** 外盘日K：新浪该接口不提供成交量（恒 0），仅日期+OHLC */
async function fetchGlobalFutureDailyHistory(contract: string): Promise<BarPoint[]> {
  const url = `https://stock2.finance.sina.com.cn/futures/api/json.php/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${contract}&datalen=2000`;
  let arr: Record<string, unknown>[];
  try {
    arr = JSON.parse(await httpGetText(url, { retries: 1 }));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: BarPoint[] = [];
  for (const o of arr) {
    const day = String(o.date ?? '');
    const close = numOf(String(o.close ?? ''));
    if (day.length < 10 || !(close > 0)) continue;
    out.push({ day: day.slice(0, 10), open: numOf(String(o.open ?? '')), close, high: numOf(String(o.high ?? '')), low: numOf(String(o.low ?? '')), volume: NaN });
  }
  return out;
}

// ── 加密 K（Bitget → Gate.io）───────────────────────────────────────────────

interface CryptoCandle { ts: number; open: number; high: number; low: number; close: number; volume: number }

async function fetchCryptoCandlesBitget(pair: string, granularity: string, limit: number): Promise<CryptoCandle[]> {
  const sym = pair.replace(/_/g, '');
  let json: any;
  try {
    json = JSON.parse(await httpGetText(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${sym}&granularity=${granularity}&limit=${limit}`, { retries: 1 }));
  } catch {
    return [];
  }
  const arr = json?.data as string[][] | undefined;
  if (!Array.isArray(arr)) return [];
  const list: CryptoCandle[] = [];
  for (const r of arr) {
    const ts = numOf(r[0]) / 1000;
    const close = numOf(r[4]);
    if (!(ts > 0) || !(close > 0)) continue;
    list.push({ ts, open: numOf(r[1]), high: numOf(r[2]), low: numOf(r[3]), close, volume: numOf(r[5]) });
  }
  return list.sort((a, b) => a.ts - b.ts);
}

async function fetchCryptoCandlesGate(pair: string, interval: string, limit: number): Promise<CryptoCandle[]> {
  let arr: string[][];
  try {
    arr = JSON.parse(await httpGetText(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=${limit}`, { retries: 1 }));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const list: CryptoCandle[] = [];
  for (const r of arr) {
    const ts = numOf(r[0]);
    const close = numOf(r[2]);
    if (!(ts > 0) || !(close > 0)) continue;
    list.push({ ts, open: numOf(r[5]), high: numOf(r[3]), low: numOf(r[4]), close, volume: numOf(r[6]) });
  }
  return list.sort((a, b) => a.ts - b.ts);
}

async function fetchCryptoCandles(pair: string, granularity: '1min' | '1day', limit: number): Promise<CryptoCandle[]> {
  const bitget = await fetchCryptoCandlesBitget(pair, granularity, limit);
  if (bitget.length > 0) return bitget;
  return fetchCryptoCandlesGate(pair, granularity === '1min' ? '1m' : '1d', limit);
}

// ── 基金净值历史 ─────────────────────────────────────────────────────────────

async function fetchFundNavHistory(code: string): Promise<BarPoint[]> {
  let raw: string;
  try {
    raw = await httpGetText(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, { retries: 1 });
  } catch {
    return [];
  }
  const m = /Data_netWorthTrend\s*=\s*(\[.*?]);/s.exec(raw);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]) as { x: number; y: number }[];
    const list: BarPoint[] = [];
    for (const o of arr) {
      if (!(o.x > 0) || !Number.isFinite(o.y) || o.y <= 0) continue;
      list.push({ day: dayOfShanghai(o.x), open: NaN, close: o.y, high: NaN, low: NaN, volume: NaN });
    }
    return list;
  } catch {
    return [];
  }
}

// ── 周/月本地重采样 ──────────────────────────────────────────────────────────

export function resampleDaily(daily: BarPoint[], period: Period, count: number): BarPoint[] {
  if (period === 'day') return daily.slice(-count);
  const buckets = new Map<string, BarPoint[]>();
  for (const p of daily) {
    const d = zonedTime(CN_TZ, new Date(`${p.day}T12:00:00+08:00`).getTime());
    let key: string;
    if (period === 'week') {
      // ISO 周编号（对齐 WeekFields.ISO）：取该周的周四归属年
      const date = new Date(`${p.day}T12:00:00Z`);
      const dayNum = (date.getUTCDay() + 6) % 7;
      date.setUTCDate(date.getUTCDate() - dayNum + 3);
      const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
      const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
      firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
      const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
      key = `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    } else {
      key = `${d.date.slice(0, 4)}-${Number(d.date.slice(5, 7))}`;
    }
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p);
    else buckets.set(key, [p]);
  }
  const out: BarPoint[] = [];
  for (const bucket of buckets.values()) {
    const sumVol = bucket.reduce((acc, b) => acc + (Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0), 0);
    const highs = bucket.map((b) => b.high).filter((v) => Number.isFinite(v));
    const lows = bucket.map((b) => b.low).filter((v) => Number.isFinite(v));
    out.push({
      day: bucket[bucket.length - 1].day,
      open: bucket[0].open,
      close: bucket[bucket.length - 1].close,
      high: highs.length ? Math.max(...highs) : NaN,
      low: lows.length ? Math.min(...lows) : NaN,
      volume: sumVol > 0 ? sumVol : NaN,
    });
  }
  return out.slice(-count);
}

// ── 路由入口 ─────────────────────────────────────────────────────────────────

export function isAShareSymbol(symbol: string): boolean {
  return symbol.startsWith('sh') || symbol.startsWith('sz') || symbol.startsWith('bj');
}

/** 历史 K 线路由（ChartDataService.getHistoryKLine 对齐） */
export async function getHistoryBars(symbol: string, period: Period, count: number): Promise<BarPoint[]> {
  // 期货：新浪日K + 本地重采样
  if (/^nf_/i.test(symbol) || /^hf_/i.test(symbol)) {
    const normalized = normalizeFutureSymbol(symbol);
    const daily = normalized.startsWith('nf_')
      ? await fetchDomesticFutureDailyHistory(normalized.slice(3))
      : await fetchGlobalFutureDailyHistory(normalized.slice(3));
    return resampleDaily(daily, period, count);
  }
  // 加密交易对（带下划线）：Bitget 日K → Gate；注意日K按 UTC 日切（币种本身属性）
  if (symbol.includes('_') && /^[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(symbol)) {
    const daily = await fetchCryptoCandles(symbol as `${string}_${string}`, '1day', 1000);
    const bars: BarPoint[] = daily.map((c) => ({ day: new Date(c.ts * 1000).toISOString().slice(0, 10), open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume }));
    return resampleDaily(bars, period, count);
  }
  // 港股 → 腾讯，兜底 Yahoo
  if (/^hk/i.test(symbol)) {
    const hkCode = symbol.replace(/^hk/i, '');
    const pts = await fetchHkHistory(hkCode, period, count);
    if (pts.length > 0) return pts;
    const interval = period === 'day' ? '1d' : period === 'week' ? '1wk' : '1mo';
    const range = period === 'day' ? '3mo' : period === 'week' ? '1y' : '5y';
    return fetchYahooHistory(`${hkCode}.HK`, interval, range, count);
  }
  // 基金（纯 6 位数字）→ 天天基金净值，兜底场内 ETF K 线
  if (/^\d{6}$/.test(symbol)) {
    const daily = await fetchFundNavHistory(symbol);
    if (daily.length > 0) return resampleDaily(daily, period, count);
    const prefixed = symbol.startsWith('6') ? `sh${symbol}` : `sz${symbol}`;
    const pts = await fetchTencentAShareHistory(prefixed, period, count);
    if (pts.length > 0) return pts;
    const scale = period === 'day' ? 240 : period === 'week' ? 1200 : 5000;
    return fetchSinaKlineHistory(prefixed, scale, count);
  }
  // A 股/北交所 → 腾讯 qfq → 新浪
  if (isAShareSymbol(symbol)) {
    const pts = await fetchTencentAShareHistory(symbol, period, count);
    if (pts.length > 0) return pts;
    const scale = period === 'day' ? 240 : period === 'week' ? 1200 : 5000;
    return fetchSinaKlineHistory(symbol, scale, count);
  }
  // A 股指数（Yahoo 风格代码）→ 新浪
  const sinaMapped = CN_SINA_MAP[symbol];
  if (sinaMapped) {
    const pts = await fetchTencentAShareHistory(sinaMapped, period, count);
    if (pts.length > 0) return pts;
    const scale = period === 'day' ? 240 : period === 'week' ? 1200 : 5000;
    return fetchSinaKlineHistory(sinaMapped, scale, count);
  }
  // 恒生科技：Yahoo 无数据（5 年日K仅 1 条），走腾讯 hkHSTECH（可完整回溯 2020-07）
  if (symbol === '^HSTECH') {
    const pts = await fetchHkHistory('HSTECH', period, count);
    if (pts.length > 0) return pts;
  }
  // 全球指数 → Yahoo。历史超长的指数超过 Yahoo 单次约 1000 条限制会静默降频，range 固定 5y/10y
  const interval = period === 'day' ? '1d' : period === 'week' ? '1wk' : '1mo';
  const range = period === 'day' ? '5y' : '10y';
  return fetchYahooHistory(symbol, interval, range, count);
}

/** 日内分线路由（ChartDataService.getStockIntraday/getGlobalIntraday 等对齐） */
export async function getIntradayRows(symbol: string): Promise<MinuteRow[]> {
  if (/^hk/i.test(symbol)) {
    const hkCode = symbol.replace(/^hk/i, '');
    const pts = await fetchHkIntraday(hkCode);
    if (pts.length > 0) return pts;
    return fetchYahooIntraday(`${hkCode}.HK`);
  }
  if (/^nf_/i.test(symbol) || /^hf_/i.test(symbol)) {
    const normalized = normalizeFutureSymbol(symbol);
    return normalized.startsWith('nf_')
      ? fetchDomesticFutureMinLine(normalized.slice(3))
      : fetchGlobalFutureMinLine(normalized.slice(3));
  }
  if (symbol.includes('_') && /^[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(symbol)) {
    const candles = await fetchCryptoCandles(symbol as `${string}_${string}`, '1min', 1000);
    const todayUtc = new Date().toISOString().slice(0, 10);
    return candles
      .filter((c) => new Date(c.ts * 1000).toISOString().slice(0, 10) === todayUtc)
      .map((c) => ({ time: new Date(c.ts * 1000).toISOString().slice(11, 16), price: c.close, volume: Number.isFinite(c.volume) ? c.volume : undefined }));
  }
  const sinaMapped = CN_SINA_MAP[symbol];
  if (sinaMapped) return fetchSinaIntraday(sinaMapped);
  // 恒生科技：Yahoo 图表接口对 ^HSTECH 直接 Not Found，改走腾讯港股分时源
  if (symbol === '^HSTECH') {
    const pts = await fetchHkIntraday('HSTECH');
    if (pts.length > 0) return pts;
  }
  if (symbol.startsWith('sh') || symbol.startsWith('sz') || symbol.startsWith('bj')) {
    return fetchSinaIntraday(symbol);
  }
  return fetchYahooIntraday(symbol);
}

// ── 契约转换（providers.ts 使用）─────────────────────────────────────────────

export function barsToKline(bars: BarPoint[]): KlineBar[] {
  return bars.map((b) => ({
    date: b.day,
    open: b.open,
    close: b.close,
    high: b.high,
    low: b.low,
    volume: Number.isFinite(b.volume) ? b.volume : undefined,
  }));
}

export function rowsToMinutes(rows: MinuteRow[]): MinutePoint[] {
  return rows.map((r) => ({ time: r.time, price: r.price, volume: r.volume }));
}
