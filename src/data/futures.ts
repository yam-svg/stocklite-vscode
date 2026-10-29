/**
 * 期货/外汇行情与搜索（移植自 MarketDataService 期货段 + 本地合约兜底表）。
 * 数据源：新浪 hq.sinajs.cn（GBK，https），nf_=国内期货 hf_=外盘期货。
 * 内置默认持仓播种（hf_NQ/hf_OIL）属 S6 tab 层，此处只做数据。
 */
import type { Quote, SearchResultItem } from '../shared/types';
import { httpGetText } from '../shared/http';
import { parseSinaVars, numOf, orderByInput } from './util';

/** 规范化期货代码：nf_/hf_ 前缀小写、代码大写；无前缀按国内期货补 nf_（Kotlin normFutureSymbol） */
export function normalizeFutureSymbol(raw: string): string {
  const v = raw.trim();
  if (/^nf_/i.test(v) || /^hf_/i.test(v)) {
    const prefix = v.slice(0, v.indexOf('_')).toLowerCase();
    const body = v.slice(v.indexOf('_') + 1).toUpperCase();
    return `${prefix}_${body}`;
  }
  return `nf_${v.toUpperCase()}`;
}

interface FutureFields { name: string; price: number; preClose: number }

/** 字段容错解析：按候选下标顺序取第一个 >0 的值（Kotlin first(...) 语义） */
function firstPositive(f: string[], ...idxs: number[]): number {
  for (const i of idxs) {
    const v = numOf(f[i]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/** 国内 nf_ / 外盘 hf_ 两套字段布局（含指数型合约特判），解析失败返回 null */
export function parseFutureFields(symbol: string, f: string[]): FutureFields | null {
  try {
    if (symbol.startsWith('nf_')) {
      const firstNum = numOf(f[0]);
      const isIndex = Number.isFinite(firstNum) && firstNum > 0;
      const name = isIndex
        ? (f[47] || f[46] || symbol)
        : (f[0]?.trim() || symbol);
      const price = isIndex ? firstPositive(f, 0, 3, 2, 14, 13) : firstPositive(f, 8, 6, 3, 2, 1);
      const preClose = isIndex ? firstPositive(f, 14, 15, 2, 13, 3) : firstPositive(f, 10, 2, 7, 27, 9, 3);
      return { name: name.trim(), price, preClose };
    }
    const name = f[13] ?? symbol;
    const price = numOf(f[0], 0);
    const preClose = firstPositive(f, 7, 2, 8);
    return { name: name.trim(), price, preClose };
  } catch {
    return null;
  }
}

export async function getFutureQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const unique = [...new Set(symbols.map(normalizeFutureSymbol))].filter((s) => s.length > 3);
  const result = new Map<string, Quote>();
  if (unique.length === 0) return result;
  let raw: string;
  try {
    raw = await httpGetText(`https://hq.sinajs.cn/list=${unique.join(',')}`, {
      gbk: true, headers: { Referer: 'https://finance.sina.com.cn' }, retries: 2,
    });
  } catch {
    return result;
  }
  for (const [symbol, f] of parseSinaVars(raw)) {
    if (f.length < 4) continue;
    const norm = normalizeFutureSymbol(symbol);
    const parsed = parseFutureFields(norm, f);
    if (!parsed || !(parsed.price > 0)) continue;
    const change = parsed.preClose > 0 ? parsed.price - parsed.preClose : 0;
    const pct = parsed.preClose > 0 ? (change / parsed.preClose) * 100 : 0;
    result.set(norm, {
      code: norm,
      name: parsed.name || norm,
      price: parsed.price,
      prevClose: parsed.preClose || parsed.price,
      change,
      changePct: pct,
    });
  }
  return result;
}

/** 期货 QuoteProvider 用：保持入参顺序 */
export async function fetchFutureQuotes(codes: string[]): Promise<Quote[]> {
  const map = await getFutureQuotes(codes);
  return orderByInput(codes.map(normalizeFutureSymbol), map);
}

// ── 搜索：新浪联想 + 编码直查 + 本地兜底表（Kotlin searchFutures 三通道合并）──

const LOCAL_FUTURES: { symbol: string; name: string; aliases: string[] }[] = [
  { symbol: 'nf_IF0', name: '沪深300股指连续', aliases: ['IF', 'CSI300'] },
  { symbol: 'nf_IH0', name: '上证50股指连续', aliases: ['IH', 'SSE50'] },
  { symbol: 'nf_IC0', name: '中证500股指连续', aliases: ['IC', 'CSI500'] },
  { symbol: 'nf_IM0', name: '中证1000股指连续', aliases: ['IM', 'CSI1000'] },
  { symbol: 'nf_RB0', name: '螺纹钢连续', aliases: ['RB', 'SHFE'] },
  { symbol: 'nf_HC0', name: '热轧卷板连续', aliases: ['HC'] },
  { symbol: 'nf_I0', name: '铁矿石连续', aliases: ['I', 'DCE'] },
  { symbol: 'nf_JM0', name: '焦煤连续', aliases: ['JM'] },
  { symbol: 'nf_J0', name: '焦炭连续', aliases: ['J'] },
  { symbol: 'nf_M0', name: '豆粕连续', aliases: ['M'] },
  { symbol: 'nf_Y0', name: '豆油连续', aliases: ['Y'] },
  { symbol: 'nf_P0', name: '棕榈油连续', aliases: ['P'] },
  { symbol: 'nf_AU0', name: '沪金连续', aliases: ['AU', '黄金'] },
  { symbol: 'nf_AG0', name: '沪银连续', aliases: ['AG', '白银'] },
  { symbol: 'nf_CU0', name: '沪铜连续', aliases: ['CU'] },
  { symbol: 'nf_AL0', name: '沪铝连续', aliases: ['AL'] },
  { symbol: 'nf_ZN0', name: '沪锌连续', aliases: ['ZN'] },
  { symbol: 'nf_SC0', name: '原油连续', aliases: ['SC', 'INE', '原油'] },
  { symbol: 'nf_SR0', name: '白糖连续', aliases: ['SR'] },
  { symbol: 'nf_CF0', name: '棉花连续', aliases: ['CF'] },
  { symbol: 'hf_ES', name: '标普500期货', aliases: ['S&P', 'ES'] },
  { symbol: 'hf_NQ', name: '纳斯达克100期货', aliases: ['NASDAQ', 'NQ'] },
  { symbol: 'hf_YM', name: '道琼斯期货', aliases: ['Dow', 'YM'] },
  { symbol: 'hf_CL', name: '纽约原油期货', aliases: ['WTI', 'CL'] },
  { symbol: 'hf_OIL', name: '布伦特原油期货', aliases: ['Brent'] },
  { symbol: 'hf_GC', name: '纽约黄金期货', aliases: ['Gold', 'GC', '黄金'] },
  { symbol: 'hf_SI', name: '纽约白银期货', aliases: ['Silver', 'SI'] },
  { symbol: 'hf_HG', name: '纽约铜期货', aliases: ['Copper', 'HG'] },
  { symbol: 'hf_NK225', name: '日经225期货', aliases: ['Nikkei'] },
  { symbol: 'hf_HSI', name: '恒生指数期货', aliases: ['HSI', 'Hang Seng'] },
  { symbol: 'hf_CHA50CFD', name: '富时中国A50期货', aliases: ['A50', 'FTSE', '富时'] },
  { symbol: 'hf_MCA', name: 'MSCI中国A50指数', aliases: ['MSCI', 'A50'] },
];

export async function searchFutures(keyword: string): Promise<SearchResultItem[]> {
  if (!keyword.trim()) return [];
  const trimmed = keyword.trim().toLowerCase();
  const out: SearchResultItem[] = [];
  const seen = new Set<string>();
  const push = (symbol: string, name: string) => {
    if (!seen.has(symbol)) {
      seen.add(symbol);
      out.push({ code: symbol, name, market: 'future' });
    }
  };

  // 通道 1：新浪联想。88/87=国内期货；86=外盘期货（漏掉 86 会导致 A50 等外盘品种完全搜不到）
  try {
    const raw = await httpGetText(`https://suggest3.sinajs.cn/suggest/key=${encodeURIComponent(trimmed)}`, { gbk: true, retries: 1 });
    const m = /"([^"]*)"/.exec(raw);
    const payload = m?.[1] ?? '';
    for (const row of payload.split(';').filter(Boolean)) {
      const parts = row.split(',');
      if (parts.length < 5) continue;
      const type = parts[1].trim();
      if (type !== '88' && type !== '87' && type !== '86') continue;
      const code = (parts[2] || parts[3]).trim();
      if (!code) continue;
      const symbol = type === '86' && !/^hf_/i.test(code)
        ? normalizeFutureSymbol(`hf_${code}`)
        : normalizeFutureSymbol(code);
      const name = (parts[4]?.trim() || parts[0]?.trim() || symbol).trim();
      push(symbol, name);
    }
  } catch { /* 网络失败走本地兜底 */ }

  // 通道 2：编码直查（IF2609 / cha50cfd / hf_GC 这类联想无结果的合约代码，有真实行情才算命中）
  const kwRaw = keyword.trim();
  if (/^(nf_|hf_)?[A-Za-z][A-Za-z0-9]{0,15}$/i.test(kwRaw)) {
    const candidates = kwRaw.includes('_')
      ? [normalizeFutureSymbol(kwRaw)]
      : [normalizeFutureSymbol(`nf_${kwRaw}`), normalizeFutureSymbol(`hf_${kwRaw}`)];
    try {
      const quotes = await getFutureQuotes(candidates);
      for (const [sym, q] of quotes) if (q.price > 0) push(sym, q.name);
    } catch { /* 直查失败不影响其余通道 */ }
  }

  // 通道 3：本地兜底表
  for (const c of LOCAL_FUTURES) {
    if (
      c.symbol.toLowerCase().includes(trimmed) ||
      c.name.toLowerCase().includes(trimmed) ||
      c.aliases.some((a) => a.toLowerCase().includes(trimmed))
    ) {
      push(c.symbol, c.name);
    }
  }
  return out.slice(0, 80);
}
