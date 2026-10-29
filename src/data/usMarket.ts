/**
 * 美股板块 ETF 行情（移植自 MarketDataService 美股板块段）。
 * 主源新浪 gb_ 批量（单次请求、国内直连），缺漏逐个 Yahoo v8 chart 兜底。
 * 延伸涨跌幅：新浪口径基线用 f[1]（盘前=昨收、盘后=今收），时间戳非当天的陈旧延伸数据直接丢弃；
 * Yahoo 口径用 meta.fulldayPrice 对比 regularMarketPrice，休市时两者相同视为无延伸数据。
 */
import { httpGetText } from '../shared/http';
import type { Quote } from '../shared/types';
import { numOf } from './util';
import { currentUsSession, dayOfTz, type UsSession } from './marketTime';
import { etToday, parseSinaUsStamp } from './stocks';

/** 板块 ETF 定义：symbol → 中文名 */
export const US_SECTOR_ETFS: [string, string][] = [
  // ── 科技/AI ──
  ['XLK', '科技'],
  ['AIQ', 'AI算力'],
  ['BOTZ', 'AI/机器人'],
  ['ROBO', '机器人'],
  ['SOXX', '半导体'],
  ['SKYY', '云计算'],
  ['DTCR', '数据中心'],
  ['HACK', '网络安全'],
  // ── 工业/航天/国防 ──
  ['XLI', '工业'],
  ['ITA', '军工'],
  ['UFO', '商业航天/卫星'],
  ['DRIV', '自动驾驶'],
  // ── 能源/新能源 ──
  ['XLE', '能源'],
  ['XOP', '油气'],
  ['USO', '石油'],
  ['UNG', '天然气'],
  ['ICLN', '新能源'],
  ['TAN', '光伏'],
  ['NLR', '核电'],
  ['GRID', '电网'],
  // ── 金属/材料 ──
  ['XLB', '材料'],
  ['GLD', '黄金'],
  ['COPX', '铜/有色'],
  ['LIT', '锂电池'],
  // ── 医疗/生物 ──
  ['XLV', '医疗'],
  ['XBI', '生物科技'],
  // ── 金融/消费 ──
  ['XLF', '金融'],
  ['KBE', '银行'],
  ['XLY', '消费(可选)'],
  ['XLP', '消费(必需)'],
  // ── 其他 ──
  ['XLU', '公用事业'],
  ['XLRE', '房地产'],
  ['XLC', '通信'],
];

export interface SectorQuote {
  symbol: string;
  nameCn: string;
  /** 最近正式价（盘前=昨收、盘中实时、盘后=今收） */
  price: number;
  prevClose: number;
  /** 延伸时段最新价（仅盘前/盘后且当日戳有效时有值） */
  extPrice: number | null;
  /** 常规时段涨跌幅% */
  regularPct: number;
  prePct: number | null;
  postPct: number | null;
  /** 最近一个正式交易日 yyyy-MM-dd */
  lastRegularDate: string | null;
  /** 延伸时段数据日期 */
  extDate: string | null;
}

const NY_TZ = 'America/New_York';

/** 新浪 gb_ 批量（30/批）。字段 0 基：1=最近正式价 21=盘前/盘后最新价 24=延伸戳 25=正式盘戳 26=昨收 */
async function getUsSectorQuotesViaSina(session: UsSession, now: number): Promise<Map<string, SectorQuote>> {
  const result = new Map<string, SectorQuote>();
  const codes = US_SECTOR_ETFS.map(([sym]) => `gb_${sym.toLowerCase()}`);
  for (let i = 0; i < codes.length; i += 30) {
    const chunk = codes.slice(i, i + 30);
    let raw: string;
    try {
      raw = await httpGetText(`http://hq.sinajs.cn/list=${chunk.join(',')}`, {
        gbk: true, headers: { Referer: 'http://finance.sina.com.cn' }, retries: 2,
      });
    } catch {
      continue;
    }
    for (const m of raw.matchAll(/var hq_str_gb_([^=]+)="([^"]*)"/g)) {
      const symbol = m[1].toUpperCase();
      const f = m[2].split(',');
      if (f.length < 27) continue;
      const price = numOf(f[1]);
      if (!(price > 0)) continue;
      const prev = numOf(f[26]);
      if (!(prev > 0)) continue;
      const nameCn = US_SECTOR_ETFS.find(([s]) => s === symbol)?.[1] ?? symbol;
      const lastRegularDate = parseSinaUsStamp(f[25] ?? '');
      const extDate = f.length > 24 ? parseSinaUsStamp(f[24] ?? '') : null;
      const extPrice = numOf(f[21] ?? '');
      const extPct = (session === 'PRE' || session === 'POST') && extPrice > 0 && extDate === etToday(now)
        ? ((extPrice - price) / price) * 100
        : null;
      result.set(symbol, {
        symbol, nameCn,
        price, prevClose: prev,
        extPrice: extPct !== null ? extPrice : null,
        regularPct: ((price - prev) / prev) * 100,
        prePct: session === 'PRE' ? extPct : null,
        postPct: session === 'POST' ? extPct : null,
        lastRegularDate,
        extDate,
      });
    }
  }
  return result;
}

async function getUsSectorQuoteViaYahoo(symbol: string, nameCn: string, session: UsSession): Promise<SectorQuote | null> {
  let raw: string;
  try {
    raw = await httpGetText(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`,
      { retries: 1 },
    );
  } catch {
    return null;
  }
  try {
    const meta = JSON.parse(raw)?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const pick = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : NaN;
    };
    const prevClose = pick(meta.chartPreviousClose) || pick(meta.regularMarketPreviousClose) || pick(meta.previousClose);
    if (!(prevClose > 0)) return null;
    const regularPrice = pick(meta.regularMarketPrice) || prevClose;
    const regularPct = ((regularPrice - prevClose) / prevClose) * 100;
    let extPct: number | null = null;
    let extPrice: number | null = null;
    if (session === 'PRE' || session === 'POST') {
      const fd = pick(meta.fulldayPrice);
      if (fd > 0 && fd !== regularPrice) {
        extPct = ((fd - regularPrice) / regularPrice) * 100;
        extPrice = fd;
      }
    }
    const rmt = Number(meta.regularMarketTime);
    const lastRegularDate = Number.isFinite(rmt) && rmt > 0 ? dayOfTz(rmt, NY_TZ) : null;
    return {
      symbol, nameCn,
      price: regularPrice, prevClose, extPrice,
      regularPct,
      prePct: session === 'PRE' ? extPct : null,
      postPct: session === 'POST' ? extPct : null,
      lastRegularDate,
      extDate: null,
    };
  } catch {
    return null;
  }
}

/** 美股板块 ETF 行情：新浪批量打底，缺漏逐个 Yahoo 兜底 */
export async function getUsSectorQuotes(now: number = Date.now()): Promise<Map<string, SectorQuote>> {
  const session = currentUsSession(now);
  const result = await getUsSectorQuotesViaSina(session, now);
  for (const [symbol, nameCn] of US_SECTOR_ETFS) {
    if (result.has(symbol)) continue;
    const q = await getUsSectorQuoteViaYahoo(symbol, nameCn, session);
    if (q) result.set(symbol, q);
  }
  return result;
}

/** 转通用 Quote：盘前/盘后有延伸数据时展示延伸价与延伸涨跌，否则展示正式价 */
export function usSectorToQuote(q: SectorQuote, session: UsSession): Quote {
  const pct = session === 'PRE' ? q.prePct : session === 'POST' ? q.postPct : null;
  const showExt = pct !== null && q.extPrice !== null;
  return {
    code: q.symbol,
    name: `${q.nameCn} (${q.symbol})`,
    price: showExt ? (q.extPrice as number) : q.price,
    prevClose: showExt ? q.price : q.prevClose,
    changePct: pct ?? q.regularPct,
    extra: {
      regularPct: q.regularPct,
      prePct: q.prePct ?? undefined,
      postPct: q.postPct ?? undefined,
      lastRegularDate: q.lastRegularDate ?? undefined,
      extDate: q.extDate ?? undefined,
    },
  };
}
