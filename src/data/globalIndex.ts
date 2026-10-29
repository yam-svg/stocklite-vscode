/**
 * 全球指数行情（移植自 MarketDataService 全球指数段 + GLOBAL_INDEXES 常量表）。
 * 三级源：腾讯港股实时（HSI/HSTECH）→ 新浪批量（A股/美股粗行情）→ Yahoo 兜底（60s 缓存 + 429 限流标志）。
 * 已知坑：
 *  - Yahoo 无 ^HSTECH 实时源，映射 HSTECH.HK 且分钟线经常提前截断（韩国综指），
 *    前收必须通过“接近官方收盘时间”校验才采信，否则退回官方字段；
 *  - EGX30 类稀疏源无任何前收，最终兜底=现价，至少保住价格；
 *  - ^N225/^KS11 新浪数据不可靠，强制 Yahoo。
 */
import type { Quote } from '../shared/types';
import { httpGetText } from '../shared/http';
import { httpGetWithStatus, numOf } from './util';
import { isMarketOpenByTimezone, getSessionMinutes } from './marketTime';

export interface GlobalIndexConfig {
  symbol: string;
  code: string;
  nameEn: string;
  nameCn: string;
  market: string;
  timezone: string;
  /** true = 小众扩展指数：设置页“更多指数”tab 管理，默认不显示 */
  optional: boolean;
}

const G = (symbol: string, code: string, nameEn: string, nameCn: string, market: string, timezone: string, optional = false): GlobalIndexConfig =>
  ({ symbol, code, nameEn, nameCn, market, timezone, optional });

export const GLOBAL_INDEXES: GlobalIndexConfig[] = [
  G('^GSPC', 'SPX', 'S&P 500', '标普500', 'US', 'America/New_York'),
  G('^DJI', 'DJI', 'Dow Jones', '道琼斯', 'US', 'America/New_York'),
  G('^IXIC', 'IXIC', 'NASDAQ', '纳斯达克', 'US', 'America/New_York'),
  G('^NDX', 'NDX', 'NASDAQ 100', '纳指100', 'US', 'America/New_York'),
  G('^VIX', 'VIX', 'CBOE VIX', 'VIX恐慌指数', 'US', 'America/New_York'),
  G('^FTSE', 'FTSE', 'FTSE 100', '英国富时100', 'UK', 'Europe/London'),
  G('^GDAXI', 'DAX', 'DAX', '德国DAX', 'DE', 'Europe/Berlin'),
  G('^FCHI', 'CAC40', 'CAC 40', '法国CAC40', 'FR', 'Europe/Paris'),
  G('^BVSP', 'BVSP', 'Bovespa', '巴西IBOVESPA', 'BR', 'America/Sao_Paulo'),
  G('^N225', 'N225', 'Nikkei 225', '日经225', 'JP', 'Asia/Tokyo'),
  G('^KS11', 'KOSPI', 'KOSPI', '韩国综合指数', 'KR', 'Asia/Seoul'),
  G('^TWII', 'TWII', 'TAIEX', '台湾加权指数', 'TW', 'Asia/Taipei'),
  G('^BSESN', 'SENSEX', 'SENSEX', '印度SENSEX', 'IN', 'Asia/Kolkata'),
  G('^HSI', 'HSI', 'Hang Seng', '恒生指数', 'HK', 'Asia/Hong_Kong'),
  G('^HSTECH', 'HSTECH', 'Hang Seng TECH', '恒生科技指数', 'HK', 'Asia/Hong_Kong'),
  G('000001.SS', 'SSE', 'SSE Composite', '上证指数', 'CN', 'Asia/Shanghai'),
  G('399001.SZ', 'SZSE', 'SZSE Component', '深证成指', 'CN', 'Asia/Shanghai'),
  G('399006.SZ', 'CYB', 'ChiNext', '创业板指', 'CN', 'Asia/Shanghai'),
  G('000300.SS', 'CSI300', 'CSI 300', '沪深300', 'CN', 'Asia/Shanghai'),
  G('000688.SS', 'STAR50', 'STAR 50', '科创50', 'CN', 'Asia/Shanghai'),
  // “更多指数”扩展条目（optional，默认关闭）。Yahoo 无源的市场勿加：
  // 实测无数据/已下架——意大利FTSE MIB、波兰WIG20、葡萄牙PSI20、菲律宾PSEi、土耳其BIST100、俄罗斯RTSI、墨西哥IPC
  G('^STOXX50E', 'STOXX50', 'EURO STOXX 50', '欧洲STOXX50', 'EU', 'Europe/Paris', true),
  G('^SSMI', 'SMI', 'Swiss Market', '瑞士SMI', 'CH', 'Europe/Zurich', true),
  G('^AEX', 'AEX', 'AEX Amsterdam', '荷兰AEX', 'NL', 'Europe/Amsterdam', true),
  G('^OMXSPI', 'OMX', 'OMX Stockholm 30', '瑞典OMX', 'SE', 'Europe/Stockholm', true),
  G('^IBEX', 'IBEX', 'IBEX 35', '西班牙IBEX35', 'ES', 'Europe/Madrid', true),
  G('^GSPTSE', 'TSX', 'S&P/TSX', '加拿大TSX', 'CA', 'America/Toronto', true),
  G('^MERV', 'MERV', 'MERVAL', '阿根廷Merval', 'AR', 'America/Argentina/Buenos_Aires', true),
  G('^NSEI', 'NIFTY', 'NIFTY 50', '印度Nifty50', 'IN', 'Asia/Kolkata', true),
  G('^STI', 'STI', 'Straits Times', '新加坡海峡时报', 'SG', 'Asia/Singapore', true),
  G('^KLSE', 'KLCI', 'KLSE Composite', '马来西亚KLCI', 'MY', 'Asia/Kuala_Lumpur', true),
  G('^JKSE', 'JCI', 'IDX Composite', '印尼雅加达综指', 'ID', 'Asia/Jakarta', true),
  G('^SET.BK', 'SET', 'SET Index', '泰国SET', 'TH', 'Asia/Bangkok', true),
  G('^VNINDEX.VN', 'VNINDEX', 'VN Index', '越南VNIndex', 'VN', 'Asia/Ho_Chi_Minh', true),
  G('^TASI.SR', 'TASI', 'Tadawul TASI', '沙特TASI', 'SA', 'Asia/Riyadh', true),
  G('^TA125.TA', 'TA125', 'TA-125', '以色列TA125', 'IL', 'Asia/Jerusalem', true),
  G('^J203.JO', 'TOP40', 'JSE Top 40', '南非Top40', 'ZA', 'Africa/Johannesburg', true),
  G('^EGX30.CA', 'EGX30', 'EGX 30', '埃及EGX30', 'EG', 'Africa/Cairo', true),
];

const SINA_SYMBOL_MAP: Record<string, string> = {
  '^DJI': 'gb_dji',
  '^IXIC': 'gb_ixic',
  '^NDX': 'gb_$ndx',
  '^GSPC': 'gb_$inx',
  '^N225': 'gb_nky',
  '^HSI': 'rt_hkHSI',
  '^HSTECH': 'rt_hkHSTECH',
  '000001.SS': 'sh000001',
  '399001.SZ': 'sz399001',
  '399006.SZ': 'sz399006',
  '000300.SS': 'sh000300',
  '000688.SS': 'sh000688',
};

const YAHOO_SYMBOL_MAP: Record<string, string> = { '^HSTECH': 'HSTECH.HK' };
export function resolveYahooSymbol(symbol: string): string {
  return YAHOO_SYMBOL_MAP[symbol] ?? symbol;
}

/** 强制使用 Yahoo 的指数（新浪数据不可靠） */
const GLOBAL_FORCE_YAHOO = new Set(['^N225', '^KS11']);

const TENCENT_HK_MAP: Record<string, string> = { '^HSI': 'r_hkHSI', '^HSTECH': 'r_hkHSTECH' };

/** 双轨可见性（Kotlin visibleGlobalIndexes）：optional 默认隐藏需 enabled 命中；默认项需不在 hidden */
export function visibleGlobalIndexes(hidden: Iterable<string>, enabledOptional: Iterable<string>): GlobalIndexConfig[] {
  const hiddenSet = new Set(hidden);
  const enabledSet = new Set(enabledOptional);
  return GLOBAL_INDEXES.filter((it) => (it.optional ? enabledSet.has(it.symbol) : !hiddenSet.has(it.symbol)));
}

/** 新浪全球行情解析（Kotlin parseSinaData）：gb_ 延迟 15 分钟；rt_hk 港股实时；sh/sz A 股实时 */
export function parseSinaGlobal(text: string): Map<string, { price: number; changePct: number }> {
  const result = new Map<string, { price: number; changePct: number }>();
  for (const m of text.matchAll(/var hq_str_(.*?)="([^"]*)"/g)) {
    const symbol = m[1];
    const arr = m[2].split(',');
    let price = NaN;
    let changePct = 0;
    if (symbol.startsWith('gb_')) {
      price = numOf(arr[1]);
      changePct = numOf(arr[2], 0);
    } else if (symbol.startsWith('rt_hk')) {
      price = numOf(arr[2]);
      const prev = numOf(arr[3], 0);
      if (Number.isFinite(price) && prev > 0) changePct = ((price - prev) / prev) * 100;
    } else if (/^(sh|sz|bj)/.test(symbol)) {
      const prev = numOf(arr[2], 0);
      price = numOf(arr[3]);
      if (Number.isFinite(price) && prev > 0) changePct = ((price - prev) / prev) * 100;
    }
    if (Number.isFinite(price) && price > 0) result.set(symbol, { price, changePct });
  }
  return result;
}

async function fetchTencentHkQuote(symbol: string): Promise<{ price: number; changePct: number; prevClose: number } | null> {
  const tSym = TENCENT_HK_MAP[symbol];
  if (!tSym) return null;
  let raw: string;
  try {
    raw = await httpGetText(`https://qt.gtimg.cn/q=${tSym}`, { gbk: true, headers: { Referer: 'https://gu.qq.com' }, retries: 2 });
  } catch {
    return null;
  }
  const f = /v_[^=]+="([^"]*)"/.exec(raw)?.[1]?.split('~');
  if (!f) return null;
  const price = numOf(f[3]);
  const prev = numOf(f[4]);
  if (!(price > 0) || !(prev > 0)) return null;
  const tPct = numOf(f[32], NaN);
  return { price, changePct: Number.isFinite(tPct) ? tPct : ((price - prev) / prev) * 100, prevClose: prev };
}

// ── Yahoo 行情（带 429 状态、60s 新鲜缓存、前收缓存与稀疏源兜底）──────────────

const yahooQuoteCache = new Map<string, { price: number; pct: number; time: number }>();
const YAHOO_QUOTE_FRESH_TTL = 60_000;
const globalPrevCloseCache = new Map<string, { value: number; time: number }>();
const GLOBAL_PREV_CLOSE_TTL = 60_000;

/** 按 (ts+gmtoffset) 平移后的市场本地日聚合分钟收盘：日→最后收盘、日→最后样本的当日分钟数 */
function groupMinuteCloses(result: any): { dayClose: Map<string, number>; dayLastMinute: Map<string, number> } | null {
  const gmtOffset = Number(result?.meta?.gmtoffset ?? 0);
  const timestamps: number[] | undefined = result?.timestamp;
  const closes: (number | null)[] | undefined = result?.indicators?.quote?.[0]?.close;
  if (!timestamps || !closes) return null;
  const dayClose = new Map<string, number>();
  const dayLastMinute = new Map<string, number>();
  for (let i = 0; i < Math.min(timestamps.length, closes.length); i++) {
    const ts = Number(timestamps[i]);
    const close = closes[i];
    if (!(ts > 0) || close === null || close === undefined || !Number.isFinite(close) || close <= 0) continue;
    const zdt = new Date((ts + gmtOffset) * 1000).toISOString();
    const day = zdt.slice(0, 10);
    dayClose.set(day, close);
    dayLastMinute.set(day, Number(zdt.slice(11, 13)) * 60 + Number(zdt.slice(14, 16)));
  }
  return { dayClose, dayLastMinute };
}

/** 分钟线倒数第二个交易日收盘 = 前收（无会话校验的简化版，自测直接喂样本用） */
export function extractPrevCloseFromIntraday(result: any): number {
  const grouped = groupMinuteCloses(result);
  if (!grouped) return NaN;
  const days = [...grouped.dayClose.keys()];
  if (days.length < 2) return NaN;
  return grouped.dayClose.get(days[days.length - 2]) ?? NaN;
}

/**
 * 前收提取 + “接近官方收盘时间”校验（Kotlin extractPrevCloseFromIntraday 完整形态）。
 * 韩国等市场 Yahoo 分钟线经常提前截断（实际 15:30 收盘数据止于 14:59），
 * 最后样本与官方收盘偏差 >15 分钟时不采信，返回 NaN 让调用方退官方字段。
 */
export function prevCloseWithSessionCheck(result: any, market?: string): number {
  const grouped = groupMinuteCloses(result);
  if (!grouped) return NaN;
  const days = [...grouped.dayClose.keys()];
  if (days.length < 2) return NaN;
  const prevDay = days[days.length - 2];
  const prevClose = grouped.dayClose.get(prevDay);
  if (prevClose === undefined) return NaN;
  if (!market) return prevClose;
  const lastMinute = grouped.dayLastMinute.get(prevDay);
  if (lastMinute === undefined) return NaN;
  if (getSessionMinutes(market).end - lastMinute > 15) return NaN;
  return prevClose;
}

/** 解析 Yahoo chart 响应为 (price, changePct)（Kotlin parseYahooBody，含前收兜底链） */
export function parseYahooBody(raw: unknown, symbol: string, market?: string, now: number = Date.now()): { price: number; changePct: number } | null {
  try {
    const result = (raw as any)?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;
    const closesArr: (number | null)[] | undefined = result?.indicators?.quote?.[0]?.close;
    const closes = closesArr ?? [];

    const marketPrice = Number(meta.regularMarketPrice);
    let latestClose: number | undefined;
    for (const c of closes) {
      if (Number.isFinite(c as number) && (c as number) > 0) latestClose = c as number;
    }
    const price = Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : latestClose;
    if (price === undefined) return null;

    // 前收：分钟线校验通过才采信，否则依次退 Yahoo 官方字段（previousClose 是页面展示口径）
    let prevClose = prevCloseWithSessionCheck(result, market);
    if (!Number.isFinite(prevClose) || prevClose <= 0) prevClose = Number(meta.previousClose);
    if (!Number.isFinite(prevClose) || prevClose <= 0) prevClose = Number(meta.chartPreviousClose);
    if (!Number.isFinite(prevClose) || prevClose <= 0) prevClose = Number(meta.regularMarketPreviousClose);
    if (!Number.isFinite(prevClose) || prevClose <= 0) {
      const cached = globalPrevCloseCache.get(symbol);
      if (cached && now - cached.time < GLOBAL_PREV_CLOSE_TTL) prevClose = cached.value;
      // 最终兜底：无分钟线、无官方前收的稀疏源（如埃及EGX30）以前收=现价显示
      else prevClose = latestClose ?? price;
    }
    globalPrevCloseCache.set(symbol, { value: prevClose, time: now });
    const pct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    return { price, changePct: pct };
  } catch {
    return null;
  }
}

export interface GlobalIndexQuoteRow {
  config: GlobalIndexConfig;
  price: number;
  changePct: number;
  isOpen: boolean;
  /** 取值来源是否为延迟源（gb_/Yahoo 约 15 分钟延迟） */
  isDelayed: boolean;
}

export interface GlobalQuoteResult {
  quotes: GlobalIndexQuoteRow[];
  /** Yahoo 本轮出现 429，调用方应自适应退避 */
  rateLimited: boolean;
}

/**
 * 全球指数批量行情（Kotlin getGlobalIndexQuotes）。
 * Yahoo 类指数自带 60s 缓存，面板 5s 刷新不会重复打接口。
 */
export async function getGlobalIndexQuotes(visible: GlobalIndexConfig[], now: number = Date.now()): Promise<GlobalQuoteResult> {
  const quoteMap = new Map<string, { price: number; changePct: number }>();
  const delayMap = new Map<string, boolean>();
  let yahooRateLimited = false;

  // 1. 腾讯港股实时（HSI/HSTECH）
  for (const sym of ['^HSI', '^HSTECH']) {
    const hk = await fetchTencentHkQuote(sym);
    const key = SINA_SYMBOL_MAP[sym];
    if (hk && key) {
      quoteMap.set(key, { price: hk.price, changePct: hk.changePct });
      delayMap.set(key, false);
    }
  }

  // 2. 新浪批量（沪深/港股兜底为实时；gb_ 海外标明延迟≥15 分钟）
  try {
    const raw = await httpGetText(`http://hq.sinajs.cn/list=${Object.values(SINA_SYMBOL_MAP).join(',')}`, {
      gbk: true, headers: { Referer: 'http://finance.sina.com.cn' }, retries: 2,
    });
    for (const [key, v] of parseSinaGlobal(raw)) {
      if (!quoteMap.has(key)) {
        quoteMap.set(key, v);
        delayMap.set(key, key.startsWith('gb_'));
      }
    }
  } catch { /* 整源失败退 Yahoo */ }

  // 3. Yahoo 兜底（强制 Yahoo + 新浪无数据），60s 新鲜缓存
  for (const item of visible) {
    const sinaKey = SINA_SYMBOL_MAP[item.symbol];
    if (!GLOBAL_FORCE_YAHOO.has(item.symbol) && sinaKey && quoteMap.has(sinaKey)) continue;

    const cached = yahooQuoteCache.get(item.symbol);
    const putYahoo = (body: { price: number; changePct: number }) => {
      if (sinaKey) {
        quoteMap.set(sinaKey, body);
        delayMap.set(sinaKey, true);
      }
      quoteMap.set(item.symbol, body);
      delayMap.set(item.symbol, true);
    };
    if (cached && now - cached.time < YAHOO_QUOTE_FRESH_TTL) {
      putYahoo({ price: cached.price, changePct: cached.pct });
      continue;
    }
    const { status, body } = await httpGetWithStatus(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(resolveYahooSymbol(item.symbol))}?interval=1m&range=5d`,
    );
    if (status === 429) {
      yahooRateLimited = true;
      continue;
    }
    if (body) {
      const parsed = parseYahooBody(JSON.parse(body), item.symbol, item.market, now);
      if (parsed) {
        yahooQuoteCache.set(item.symbol, { price: parsed.price, pct: parsed.changePct, time: now });
        putYahoo(parsed);
      }
    }
  }

  const quotes: GlobalIndexQuoteRow[] = [];
  for (const item of visible) {
    const sinaKey = SINA_SYMBOL_MAP[item.symbol];
    const got = (sinaKey ? quoteMap.get(sinaKey) : undefined) ?? quoteMap.get(item.symbol);
    const isDelayed = sinaKey ? delayMap.get(sinaKey) ?? true : delayMap.get(item.symbol) ?? true;
    quotes.push({
      config: item,
      price: got?.price ?? 0,
      changePct: got?.changePct ?? 0,
      isOpen: await isMarketOpenByTimezone(item.market, item.timezone, now),
      isDelayed,
    });
  }
  return { quotes, rateLimited: yahooRateLimited };
}

/** 转成通用 Quote（extra 携带 market/isOpen/isDelayed 供 UI 渲染开盘状态与延迟角标） */
export function globalRowToQuote(row: GlobalIndexQuoteRow): Quote {
  return {
    code: row.config.symbol,
    name: `${row.config.nameCn} (${row.config.nameEn})`,
    price: row.price,
    prevClose: row.changePct !== 0 ? row.price / (1 + row.changePct / 100) : row.price,
    changePct: row.changePct,
    extra: {
      market: row.config.market,
      isOpen: row.isOpen ? 1 : 0,
      isDelayed: row.isDelayed ? 1 : 0,
      indexCode: row.config.code,
    },
  };
}
