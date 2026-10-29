/**
 * 加密货币行情（免费公开 REST，无需 key；移植自 MarketDataService 加密段）。
 * 主源 Bitget → 备源 Gate.io → 兜底 Binance 公开数据镜像（data-api.binance.vision）。
 * 三源可达性因用户网络而异：全败返回 OFFLINE，界面须明确提示，不得静默显示空数据。
 * K 线在 kline.ts（fetchCryptoCandles），本文件只做报价与币种搜索。
 */
import { httpGetText } from '../shared/http';
import { numOf } from './util';

export type CryptoNetStatus = 'CONNECTED' | 'DEGRADED' | 'OFFLINE';

export interface CryptoQuoteRow {
  pair: string;
  price: number;
  changePct: number;
  high24h: number;
  low24h: number;
  quoteVolume: number;
}

export interface CryptoQuoteBatch {
  quotes: Map<string, CryptoQuoteRow>;
  /** CONNECTED=全部主源；DEGRADED=至少一币降级备源；OFFLINE=三源全部不可达 */
  status: CryptoNetStatus;
  workingSource: string | null;
}

/** 用户输入 → Gate 风格交易对："btc/usdt"/"BTCUSDT"/"btc" → "BTC_USDT" */
export function normCryptoSymbol(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\//g, '_').replace(/-/g, '_');
  if (!s) return '';
  if (s.includes('_')) return s;
  for (const q of ['USDT', 'USDC', 'FDUSD', 'TUSD', 'USD', 'BTC', 'ETH']) {
    if (s.length > q.length && s.endsWith(q)) return `${s.slice(0, -q.length)}_${q}`;
  }
  return `${s}_USDT`;
}

function cryptoNum(o: any, key: string): number {
  return numOf(String(o?.[key] ?? ''));
}

async function fetchCryptoBitget(pair: string): Promise<CryptoQuoteRow | null> {
  const sym = pair.replace(/_/g, '');
  try {
    const raw = await httpGetText(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}`, { retries: 1 });
    const o = JSON.parse(raw)?.data?.[0];
    if (!o) return null;
    const price = cryptoNum(o, 'lastPr');
    const open = cryptoNum(o, 'open');
    if (!Number.isFinite(price) || price <= 0) return null;
    const pct = Number.isFinite(open) && open > 0 ? (price / open - 1) * 100 : 0;
    return { pair, price, changePct: pct, high24h: cryptoNum(o, 'high24h'), low24h: cryptoNum(o, 'low24h'), quoteVolume: cryptoNum(o, 'quoteVolume') };
  } catch {
    return null;
  }
}

async function fetchCryptoGate(pair: string): Promise<CryptoQuoteRow | null> {
  try {
    const raw = await httpGetText(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`, { retries: 1 });
    const o = JSON.parse(raw)?.[0];
    if (!o) return null;
    const price = cryptoNum(o, 'last');
    if (!Number.isFinite(price) || price <= 0) return null;
    return { pair, price, changePct: cryptoNum(o, 'change_percentage'), high24h: cryptoNum(o, 'high_24h'), low24h: cryptoNum(o, 'low_24h'), quoteVolume: cryptoNum(o, 'quote_volume') };
  } catch {
    return null;
  }
}

async function fetchCryptoBinance(pair: string): Promise<CryptoQuoteRow | null> {
  const sym = pair.replace(/_/g, '');
  try {
    const raw = await httpGetText(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${sym}`, { retries: 1 });
    const o = JSON.parse(raw);
    const price = cryptoNum(o, 'lastPrice');
    if (!Number.isFinite(price) || price <= 0) return null;
    return { pair, price, changePct: cryptoNum(o, 'priceChangePercent'), high24h: cryptoNum(o, 'highPrice'), low24h: cryptoNum(o, 'lowPrice'), quoteVolume: cryptoNum(o, 'quoteVolume') };
  } catch {
    return null;
  }
}

/** 逐币拉取：主源失败自动降级，单币三源全失败仅该行缺数据；全缺 → OFFLINE */
export async function getCryptoQuotes(symbols: string[]): Promise<CryptoQuoteBatch> {
  const quotes = new Map<string, CryptoQuoteRow>();
  let usedFallback = false;
  let lastWorkingSource: string | null = null;
  for (const raw of symbols) {
    const pair = normCryptoSymbol(raw);
    if (!pair) continue;
    const b = await fetchCryptoBitget(pair);
    if (b) { quotes.set(pair, b); lastWorkingSource = 'Bitget'; continue; }
    const g = await fetchCryptoGate(pair);
    if (g) { quotes.set(pair, g); usedFallback = true; lastWorkingSource = 'Gate.io'; continue; }
    const v = await fetchCryptoBinance(pair);
    if (v) { quotes.set(pair, v); usedFallback = true; lastWorkingSource = 'Binance镜像'; }
  }
  const status: CryptoNetStatus = quotes.size === 0 ? 'OFFLINE' : usedFallback ? 'DEGRADED' : 'CONNECTED';
  return { quotes, status, workingSource: lastWorkingSource };
}

/** 空自选时的连通性探测（也用作首次进入面板的即时反馈） */
export function probeCryptoNetwork(): Promise<CryptoQuoteBatch> {
  return getCryptoQuotes(['BTC_USDT']);
}

// ── 币种搜索：Gate.io 全量交易对表本地缓存 24h，避免每次搜索打网络 ──────────────

interface CryptoPairInfo {
  symbol: string;
  base: string;
  quote: string;
  quoteVolume: number;
}

let cryptoPairCache: CryptoPairInfo[] | null = null;
let cryptoPairCacheAt = 0;
const CRYPTO_PAIR_TTL = 24 * 60 * 60_000;

async function loadCryptoPairs(): Promise<CryptoPairInfo[] | null> {
  if (cryptoPairCache && Date.now() - cryptoPairCacheAt < CRYPTO_PAIR_TTL) return cryptoPairCache;
  let raw: string;
  try {
    raw = await httpGetText('https://api.gateio.ws/api/v4/spot/currency_pairs', { retries: 1 });
  } catch {
    return null;
  }
  try {
    const arr = JSON.parse(raw);
    const list: CryptoPairInfo[] = [];
    for (const o of Array.isArray(arr) ? arr : []) {
      if (String(o?.disable) === 'true') continue;
      const id = String(o?.id ?? '');
      if (!id.includes('_')) continue;
      list.push({ symbol: id, base: String(o?.base ?? '').toUpperCase(), quote: String(o?.quote ?? '').toUpperCase(), quoteVolume: numOf(String(o?.quote_volume ?? ''), 0) });
    }
    if (list.length === 0) return null;
    cryptoPairCache = list;
    cryptoPairCacheAt = Date.now();
    return list;
  } catch {
    return null;
  }
}

/** 搜索网络全部不可达时的常见币兜底表（仅 USDT 交易对） */
const CRYPTO_FALLBACK: [string, string][] = [
  ['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['SOL', 'Solana'], ['BNB', 'BNB'], ['XRP', 'XRP'],
  ['DOGE', 'Dogecoin'], ['ADA', 'Cardano'], ['TON', 'Toncoin'], ['TRX', 'TRON'], ['AVAX', 'Avalanche'],
  ['DOT', 'Polkadot'], ['LINK', 'Chainlink'], ['MATIC', 'Polygon'], ['SHIB', 'Shiba Inu'],
  ['LTC', 'Litecoin'], ['BCH', 'Bitcoin Cash'], ['UNI', 'Uniswap'], ['NEAR', 'NEAR'],
  ['APT', 'Aptos'], ['ETC', 'Ethereum Classic'], ['XLM', 'Stellar'], ['SUI', 'Sui'],
  ['PEPE', 'Pepe'], ['ATOM', 'Cosmos'], ['FIL', 'Filecoin'], ['ARB', 'Arbitrum'],
  ['OP', 'Optimism'], ['INJ', 'Injective'], ['AAVE', 'Aave'], ['DOGS', 'Dogs'],
];

/**
 * 按币代码/交易对搜索。命中顺序：交易对精确 → 基础币 → 前缀；
 * 同币多交易对时 USDT 计价优先、再按 24h 成交额降序。
 * 交易对表拉不到时退本地兜底表（空列表也可能意味着网络不可达，由调用方提示）。
 */
export async function searchCryptos(keyword: string): Promise<{ code: string; name: string }[]> {
  const kw = keyword.trim().toUpperCase().replace(/\//g, '_').replace(/-/g, '_');
  if (!kw) return [];
  const baseKw = kw.split('_')[0];
  const pairs = await loadCryptoPairs();
  if (pairs) {
    const hits = pairs.filter((p) => p.symbol === kw || p.base === baseKw || p.symbol.startsWith(`${baseKw}_`));
    const seen = new Set<string>();
    return hits
      .sort((a, b) =>
        (Number(b.symbol === kw) - Number(a.symbol === kw))
        || (Number(b.quote === 'USDT') - Number(a.quote === 'USDT'))
        || (b.quoteVolume - a.quoteVolume))
      .filter((p) => (seen.has(p.symbol) ? false : (seen.add(p.symbol), true)))
      .slice(0, 20)
      .map((p) => ({ code: p.symbol, name: `${p.base}/${p.quote}` }));
  }
  return CRYPTO_FALLBACK
    .filter(([sym]) => sym === baseKw || sym.startsWith(baseKw))
    .slice(0, 20)
    .map(([sym, en]) => ({ code: `${sym}_USDT`, name: `${sym}/USDT · ${en}` }));
}
