/**
 * 市场时间与交易日历（移植自 Kotlin MarketTimeUtil + MarketDataService 市场开市判断段）。
 * 时区计算全部走 Intl.DateTimeFormat（Node 自带 full-icu），不依赖任何第三方库。
 */
import { httpGetJson } from '../shared/http';

export const CN_TZ = 'Asia/Shanghai';
export const NY_TZ = 'America/New_York';

export interface ZonedTime {
  /** 'yyyy-MM-dd'（该时区本地日期） */
  date: string;
  /** 1=Mon..7=Sun（与 Kotlin dayOfWeek.value 对齐） */
  dow: number;
  /** 当日分钟数 hour*60+minute */
  minutes: number;
  hour: number;
  minute: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const DOW_MAP: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** 取某时区在 ms 时刻的本地日期/钟点 */
export function zonedTime(tz: string, ms: number = Date.now()): ZonedTime {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    dow: DOW_MAP[p.weekday] ?? (new Date(ms).getDay() === 0 ? 7 : new Date(ms).getDay()),
    minutes: hour * 60 + minute,
    hour,
    minute,
  };
}

/** epoch 秒 → 指定时区 'yyyy-MM-dd' */
export function dayOfTz(epochSec: number, tz: string): string {
  return zonedTime(tz, epochSec * 1000).date;
}

/** epoch 秒 → 指定时区 'HH:mm' */
export function hhmmOfTz(epochSec: number, tz: string): string {
  const z = zonedTime(tz, epochSec * 1000);
  return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}

/** epoch 毫秒 → 上海时区 'yyyy-MM-dd'（新浪/腾讯行情时间基准） */
export function dayOfShanghai(ms: number): string {
  return zonedTime(CN_TZ, ms).date;
}

/** 'yyyy-MM-dd HH:mm:ss'（上海墙上时间，即源字符串本身）→ epoch 毫秒 */
export function shanghaiWallToEpochMs(wall: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(wall.trim());
  if (!m) return NaN;
  // 上海无夏令时：UTC 时刻 = 墙上时间 - 8h
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600_000;
}

// ── A 股（MarketTimeUtil.isStockMarketOpen / refreshIntervalMs）──────────────

const CN_MORNING_START = 9 * 60 + 30;
const CN_MORNING_END = 11 * 60 + 30;
const CN_AFTERNOON_START = 13 * 60;
const CN_AFTERNOON_END = 15 * 60;

/** 仅按时间判断 A 股是否开市（周末/时段），不含节假日；需要节假日判据用 isTodayTradingDay */
export function isCnMarketOpenByTime(now: number = Date.now()): boolean {
  const z = zonedTime(CN_TZ, now);
  if (z.dow === 6 || z.dow === 7) return false;
  return (z.minutes >= CN_MORNING_START && z.minutes <= CN_MORNING_END) ||
    (z.minutes >= CN_AFTERNOON_START && z.minutes <= CN_AFTERNOON_END);
}

/** 行情刷新间隔（ms）：开市 5s，收市 60s（MarketTimeUtil.refreshIntervalMs） */
export function cnRefreshIntervalMs(now: number = Date.now()): number {
  return isCnMarketOpenByTime(now) ? 5_000 : 60_000;
}

export type MarketStatusText = '周末' | '盘前' | '早盘' | '午间休市' | '午盘' | '已收盘';

export function cnMarketStatusText(now: number = Date.now()): MarketStatusText {
  const z = zonedTime(CN_TZ, now);
  if (z.dow === 6 || z.dow === 7) return '周末';
  if (z.minutes < CN_MORNING_START) return '盘前';
  if (z.minutes <= CN_MORNING_END) return '早盘';
  if (z.minutes < CN_AFTERNOON_START) return '午间休市';
  if (z.minutes <= CN_AFTERNOON_END) return '午盘';
  return '已收盘';
}

/** A 股早盘集合竞价展示窗口：交易日 9:15–9:30（节假日判定走交易日历） */
export async function isInAStockAuction(now: number = Date.now()): Promise<boolean> {
  const z = zonedTime(CN_TZ, now);
  if (z.dow === 6 || z.dow === 7) return false;
  if (z.minutes < 9 * 60 + 15 || z.minutes >= 9 * 60 + 30) return false;
  return isTodayTradingDay('CN', CN_TZ, now);
}

// ── 全球市场时段（MarketDataService.getSessionMinutes）───────────────────────

export interface SessionMinutes { start: number; end: number; lunch?: [number, number] }

const SESSIONS: Record<string, SessionMinutes> = {
  CN: { start: 9 * 60 + 30, end: 15 * 60, lunch: [11 * 60 + 30, 13 * 60] },
  HK: { start: 9 * 60 + 30, end: 16 * 60, lunch: [12 * 60, 13 * 60] },
  JP: { start: 9 * 60, end: 15 * 60, lunch: [11 * 60 + 30, 12 * 60 + 30] },
  KR: { start: 9 * 60, end: 15 * 60 + 30 },
  US: { start: 9 * 60 + 30, end: 16 * 60 },
  UK: { start: 8 * 60, end: 16 * 60 + 30 },
  DE: { start: 9 * 60, end: 17 * 60 + 30 },
  FR: { start: 9 * 60, end: 17 * 60 + 30 },
  TW: { start: 9 * 60, end: 13 * 60 + 30 },
  IN: { start: 9 * 60 + 15, end: 15 * 60 + 30 },
  BR: { start: 10 * 60, end: 17 * 60 },
  // “更多指数”扩展市场（常规连续交易时段，含午休）
  EU: { start: 9 * 60, end: 17 * 60 + 30 },
  CH: { start: 9 * 60, end: 17 * 60 + 30 },
  NL: { start: 9 * 60, end: 17 * 60 + 30 },
  SE: { start: 9 * 60, end: 17 * 60 + 30 },
  ES: { start: 9 * 60, end: 17 * 60 + 30 },
  CA: { start: 9 * 60 + 30, end: 16 * 60 },
  AR: { start: 11 * 60, end: 17 * 60 },
  SG: { start: 9 * 60, end: 17 * 60, lunch: [12 * 60, 13 * 60] },
  MY: { start: 9 * 60, end: 17 * 60, lunch: [12 * 60 + 30, 14 * 60 + 30] },
  ID: { start: 9 * 60, end: 16 * 60, lunch: [12 * 60, 13 * 60 + 30] },
  TH: { start: 10 * 60, end: 17 * 60, lunch: [12 * 60 + 30, 14 * 60 + 30] },
  VN: { start: 9 * 60, end: 15 * 60, lunch: [11 * 60 + 30, 13 * 60] },
  SA: { start: 10 * 60, end: 15 * 60 },
  IL: { start: 10 * 60, end: 17 * 60 },
  EG: { start: 10 * 60, end: 14 * 60 + 30 },
  ZA: { start: 9 * 60, end: 17 * 60 + 30 },
};

export function getSessionMinutes(market: string): SessionMinutes {
  return SESSIONS[market] ?? { start: 9 * 60, end: 16 * 60 };
}

/** 周末是周五+周六的市场（周日开市）：沙特/以色列/埃及 */
const FRIDAY_WEEKEND_MARKETS = new Set(['SA', 'IL', 'EG']);

/**
 * 判断市场当前是否开盘（异步：含 Yahoo 交易日历节假日判据）。
 * 先看星期 → 再查当天是否交易日（缓存 30 分钟）→ 最后核对时段与午休。
 */
export async function isMarketOpenByTimezone(market: string, timezone: string, now: number = Date.now()): Promise<boolean> {
  const z = zonedTime(timezone, now);
  const weekend = FRIDAY_WEEKEND_MARKETS.has(market) ? [5, 6] : [6, 7];
  if (weekend.includes(z.dow)) return false;
  if (!(await isTodayTradingDay(market, timezone, now))) return false;
  const s = getSessionMinutes(market);
  if (z.minutes < s.start || z.minutes > s.end) return false;
  if (s.lunch && z.minutes >= s.lunch[0] && z.minutes <= s.lunch[1]) return false;
  return true;
}

// ── 交易日历（Yahoo v8 chart currentTradingPeriod 判据，缓存 30 分钟）─────────

const MARKET_CALENDAR_SYMBOL: Record<string, string> = {
  US: '^GSPC', UK: '^FTSE', DE: '^GDAXI', FR: '^FCHI',
  JP: '^N225', KR: '^KS11', TW: '^TWII', IN: '^BSESN',
  HK: '^HSI', CN: '000001.SS', BR: '^BVSP',
  EU: '^STOXX50E', CH: '^SSMI', NL: '^AEX', SE: '^OMXSPI', ES: '^IBEX',
  CA: '^GSPTSE', AR: '^MERV', SG: '^STI', MY: '^KLSE', ID: '^JKSE',
  TH: '^SET.BK', VN: '^VNINDEX.VN', SA: '^TASI.SR', IL: '^TA125.TA',
  ZA: '^J203.JO', EG: '^EGX30.CA',
};

const marketTradingDayCache = new Map<string, { value: boolean; time: number }>();
const MARKET_CALENDAR_CACHE_TTL = 30 * 60_000;

/** 交易日历注入点：自测用假实现覆盖休市分支；返回 Yahoo chart 接口原始 JSON */
export type CalendarFetcher = (yahooSymbol: string) => Promise<unknown | null>;
let calendarFetcher: CalendarFetcher | null = null;
export function setCalendarFetcherForTest(fetcher: CalendarFetcher | null): void {
  calendarFetcher = fetcher;
  marketTradingDayCache.clear();
}

/** 从 Yahoo chart 响应提取 currentTradingPeriod 归属日（'yyyy-MM-dd'，市场本地）；解析失败 null */
export function extractTradingPeriodDate(json: unknown): { date: string; gmtoffset: number } | null {
  try {
    const result = (json as any)?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;
    const gmtoffset = Number(meta.gmtoffset ?? 0);
    const regularStart = Number(meta?.currentTradingPeriod?.regular?.start ?? -1);
    if (!(regularStart > 0)) return null;
    // Kotlin: Instant.ofEpochSecond(regularStart + gmtOffset).atZone(UTC).toLocalDate()
    const date = new Date((regularStart + gmtoffset) * 1000).toISOString().slice(0, 10);
    return { date, gmtoffset };
  } catch {
    return null;
  }
}

/**
 * 判断某市场“今天”是否为交易日（含节假日）。
 * 用 Yahoo v8 chart 的 currentTradingPeriod：其日期不是市场本地“今天”即休市。
 * 请求失败/无代表标的退回“只看星期”；同市场共用结果并缓存 30 分钟。
 */
export async function isTodayTradingDay(market: string, timezone: string, now: number = Date.now()): Promise<boolean> {
  const weekdayFallback = ![6, 7].includes(zonedTime(timezone, now).dow);
  const hit = marketTradingDayCache.get(market);
  if (hit && now - hit.time < MARKET_CALENDAR_CACHE_TTL) return hit.value;

  const symbol = MARKET_CALENDAR_SYMBOL[market];
  if (!symbol) return weekdayFallback;

  let json: unknown | null = null;
  try {
    json = calendarFetcher
      ? await calendarFetcher(symbol)
      : await httpGetJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`, { retries: 1 });
  } catch {
    json = null;
  }
  if (!json) return hit ? hit.value : weekdayFallback;

  const period = extractTradingPeriodDate(json);
  const isTradingDay = period ? period.date === zonedTime(timezone, now).date : weekdayFallback;
  marketTradingDayCache.set(market, { value: isTradingDay, time: now });
  return isTradingDay;
}

// ── 美股时段（MarketDataService.currentUsSession）────────────────────────────

export type UsSession = 'PRE' | 'REGULAR' | 'POST' | 'CLOSED';

export function currentUsSession(now: number = Date.now()): UsSession {
  const z = zonedTime(NY_TZ, now);
  if (z.dow === 6 || z.dow === 7) return 'CLOSED';
  const t = z.minutes;
  if (t >= 4 * 60 && t < 9 * 60 + 30) return 'PRE';
  if (t >= 9 * 60 + 30 && t < 16 * 60) return 'REGULAR';
  if (t >= 16 * 60 && t < 20 * 60) return 'POST';
  return 'CLOSED';
}
