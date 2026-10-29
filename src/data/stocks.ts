/**
 * 股票行情 + 搜索（移植自 MarketDataService.getStockQuotes / getAStockAuctionQuotes /
 * getUsExtendedQuotes / searchStocks / isNameBad）。
 * 市场路由：sh/sz/bj → 新浪批量；hk → 腾讯；其余 → Yahoo。
 * 已知坑：
 *  - 新浪竞价期间现价为 0，9:15–9:30 窗口内 A 股切腾讯虚拟撮合价；
 *  - 竞价时间戳前缀比对不能用带时区偏移的日期格式（Kotlin 1.17.2 热修复的 BASIC_ISO_DATE 坑）；
 *  - 新浪盘口 fields[10]/[20] 单位是股，折手除以 100；腾讯 f[10]/f[20] 是手、f[47]/[48]=涨跌停价。
 */
import type { Quote, SearchResultItem } from '../shared/types';
import { httpGetText } from '../shared/http';
import { round2, numOf, parseSinaVars, parseTencentVars, mapWithConcurrency } from './util';
import { CN_TZ, NY_TZ, isInAStockAuction, zonedTime, currentUsSession } from './marketTime';

// ── A 股涨跌停价与封单 ───────────────────────────────────────────────────────

/**
 * A 股涨跌停价（元）：主板 10%（含 ST，新规已与主板统一）、创业板/科创板 20%、北交所 30%。
 * 四舍五入到 0.01（round2）。
 */
export function cnLimitPrices(symbol: string, prevClose: number): { limitUp: number; limitDown: number } | null {
  if (!(prevClose > 0)) return null;
  const ratio = symbol.startsWith('bj') ? 0.30
    : symbol.startsWith('sz30') || symbol.startsWith('sh688') ? 0.20
    : 0.10;
  return { limitUp: round2(prevClose * (1 + ratio)), limitDown: round2(prevClose * (1 - ratio)) };
}

/**
 * 封单手数（正=涨停买一封单，负=跌停卖一封单，未封板 undefined）。
 * bidVol1Lots/askVol1Lots 统一按“手”传入（新浪盘口量为股需先除以 100）。
 */
export function cnSealLots(symbol: string, price: number, prevClose: number,
  bidVol1Lots?: number, askVol1Lots?: number): number | undefined {
  if (!(price > 0)) return undefined;
  const limits = cnLimitPrices(symbol, prevClose);
  if (!limits) return undefined;
  const eps = 1e-6;
  if (price >= limits.limitUp - eps) return bidVol1Lots !== undefined && bidVol1Lots > 0 ? Math.round(bidVol1Lots) : undefined;
  if (price <= limits.limitDown + eps) return askVol1Lots !== undefined && askVol1Lots > 0 ? -Math.round(askVol1Lots) : undefined;
  return undefined;
}

// ── 行情主体 ─────────────────────────────────────────────────────────────────

interface StockQuoteRow extends Quote {
  extra?: Quote['extra'];
}

/** A 股集合竞价批量（腾讯，50 只/请求）。只收录时间戳 ≥ 当日 9:15 的标的 */
async function getAStockAuctionQuotes(symbols: string[], now: number = Date.now()): Promise<Map<string, StockQuoteRow>> {
  const result = new Map<string, StockQuoteRow>();
  if (symbols.length === 0) return result;
  // 当天日期必须按上海时区格式化（勿用 ISO/UTC：跨年/跨日边界会造成永久比对失败）
  const today = zonedTime(CN_TZ, now).date.replace(/-/g, '');
  for (let i = 0; i < symbols.length; i += 50) {
    const chunk = symbols.slice(i, i + 50);
    let raw: string;
    try {
      raw = await httpGetText(`https://qt.gtimg.cn/q=${chunk.join(',')}`, { gbk: true, headers: { Referer: 'https://gu.qq.com' }, retries: 2 });
    } catch {
      continue;
    }
    for (const [symbol, f] of parseTencentVars(raw)) {
      // 腾讯 A 股字段（0 基）：1=名称 3=现价 4=昨收 30=时间戳yyyyMMddHHmmss 31=涨跌 32=涨跌幅%
      const price = numOf(f[3]);
      const prevClose = numOf(f[4]);
      if (!(price > 0) || !(prevClose > 0)) continue;
      const ts = f[30] ?? '';
      if (ts.length !== 14 || !ts.startsWith(today)) continue;
      const hhmmss = Number(ts.slice(8));
      if (!(hhmmss >= 91500)) continue;
      const change = numOf(f[31], price - prevClose);
      const changePct = numOf(f[32], prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0);
      const name = f[1]?.trim() || symbol;
      // 封单：f[47]/f[48]=涨停/跌停价，买一量=f[10]、卖一量=f[20]（手）
      const limitUp = numOf(f[47]);
      const limitDown = numOf(f[48]);
      let seal: number | undefined;
      if (Number.isFinite(limitUp) && price >= limitUp) {
        const v = numOf(f[10]);
        seal = v > 0 ? Math.round(v) : undefined;
      } else if (Number.isFinite(limitDown) && price <= limitDown) {
        const v = numOf(f[20]);
        seal = v > 0 ? -Math.round(v) : undefined;
      }
      // 9:25 竞价定格后价格即开盘价，按正常行情展示，不再带竞价标记
      result.set(symbol, {
        code: symbol, name, price, prevClose, change, changePct,
        extra: { sealLots: seal, isAuction: hhmmss < 92500 ? 1 : undefined },
      });
    }
  }
  return result;
}

/** 新浪 gb_ 批量取美股盘前/盘后价；延伸时间戳非当天（ET）视为陈旧数据丢弃 */
async function getUsExtendedQuotes(symbols: string[], session: 'PRE' | 'POST'): Promise<Map<string, { price: number; changePct: number }>> {
  const result = new Map<string, { price: number; changePct: number }>();
  if (session !== 'PRE' && session !== 'POST') return result;
  const codeToSym = new Map<string, string>();
  for (const s of symbols) codeToSym.set(`gb_${s.toLowerCase()}`, s);
  const keys = [...codeToSym.keys()];
  for (let i = 0; i < keys.length; i += 30) {
    const chunk = keys.slice(i, i + 30);
    let raw: string;
    try {
      raw = await httpGetText(`http://hq.sinajs.cn/list=${chunk.join(',')}`, { gbk: true, headers: { Referer: 'http://finance.sina.com.cn' }, retries: 2 });
    } catch {
      continue;
    }
    for (const m of raw.matchAll(/var hq_str_gb_([^=]+)="([^"]*)"/g)) {
      const sym = codeToSym.get(`gb_${m[1].toLowerCase()}`);
      if (!sym) continue;
      const f = m[2].split(',');
      if (f.length < 27) continue;
      const close = numOf(f[1]);
      const ext = numOf(f[21]);
      if (!(close > 0) || !(ext > 0)) continue;
      if (parseSinaUsStamp(f[24] ?? '') !== etToday()) continue;
      result.set(sym, { price: ext, changePct: ((ext - close) / close) * 100 });
    }
  }
  return result;
}

/** 纽约时区今天 'yyyy-MM-dd' */
export function etToday(now: number = Date.now()): string {
  return zonedTime(NY_TZ, now).date;
}

/**
 * 新浪美股时段戳（"Oct 16 05:13AM EDT"，EDT/EST 随夏令时切换）→ 纽约日期。
 * 跨年场景（1 月解析到 12 月戳）自动回退年份。
 */
export function parseSinaUsStamp(stamp: string): string | null {
  const m = /([A-Z][a-z]{2}) (\d{1,2}) (\d{1,2}):(\d{2})(AM|PM)\s*(?:EDT|EST)/.exec(stamp);
  if (!m) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.indexOf(m[1]) + 1;
  if (month <= 0) return null;
  const day = Number(m[2]);
  const min = Number(m[4]);
  let hour = Number(m[3]);
  if (m[5] === 'AM' && hour === 12) hour = 0;
  else if (m[5] === 'PM' && hour !== 12) hour += 12;
  if (!(day >= 1 && day <= 31) || !(min >= 0 && min <= 59) || !(hour >= 0 && hour <= 23)) return null;
  const nowNy = zonedTime(NY_TZ);
  let year = Number(nowNy.date.slice(0, 4));
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (dateStr > addDays(nowNy.date, 2)) {
    year -= 1;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return dateStr;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 股票批量行情。返回 map 键为原始入参 symbol；失败的条目缺项。
 * A 股竞价窗口（交易日 9:15–9:30）优先腾讯竞价源，取不到的回退新浪。
 */
export async function getStockQuotes(symbols: string[], now: number = Date.now()): Promise<Map<string, StockQuoteRow>> {
  const result = new Map<string, StockQuoteRow>();
  if (symbols.length === 0) return result;

  const aShares = symbols.filter((s) => /^(sh|sz|bj)/i.test(s));
  const hkShares = symbols.filter((s) => /^hk/i.test(s));
  const usShares = symbols.filter((s) => !/^(sh|sz|bj|hk)/i.test(s));

  // 1) A 股竞价窗口
  let aViaSina = aShares;
  if (aShares.length > 0 && (await isInAStockAuction(now))) {
    const auction = await getAStockAuctionQuotes(aShares, now);
    for (const [k, v] of auction) result.set(k, v);
    aViaSina = aShares.filter((s) => !auction.has(s));
  }

  // 2) A 股新浪批量（GBK + Referer）
  if (aViaSina.length > 0) {
    let raw = '';
    try {
      raw = await httpGetText(`http://hq.sinajs.cn/list=${aViaSina.join(',')}`, {
        gbk: true, headers: { Referer: 'http://finance.sina.com.cn' }, retries: 2,
      });
    } catch { /* 整批失败按缺项处理 */ }
    for (const [symbol, fields] of parseSinaVars(raw)) {
      if (fields.length < 4) continue;
      const name = fields[0]?.trim();
      if (!name) continue;
      const prevClose = numOf(fields[2]);
      const price = numOf(fields[3]);
      if (!Number.isFinite(prevClose) || !Number.isFinite(price)) continue;
      const change = price !== 0 ? price - prevClose : 0;
      const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
      // 封单量一档：买一量=fields[10]、卖一量=fields[20]，新浪单位为股，折手除以 100
      const bidLots = fields.length > 21 ? numOf(fields[10]) / 100 : undefined;
      const askLots = fields.length > 21 ? numOf(fields[20]) / 100 : undefined;
      const seal = cnSealLots(symbol, price, prevClose,
        bidLots !== undefined && Number.isFinite(bidLots) ? bidLots : undefined,
        askLots !== undefined && Number.isFinite(askLots) ? askLots : undefined);
      result.set(symbol, {
        code: symbol, name,
        price: price !== 0 ? price : prevClose,
        prevClose, change, changePct,
        volume: numOf(fields[8], NaN) || undefined,
        amount: numOf(fields[9], NaN) || undefined,
        time: fields.length > 31 ? `${fields[31]}` : undefined,
        extra: { sealLots: seal },
      });
    }
  }

  // 3) 港股腾讯（r_hk 前缀，批量 30 只/请求；Kotlin 逐只，此处合并请求不改语义）
  for (let i = 0; i < hkShares.length; i += 30) {
    const chunk = hkShares.slice(i, i + 30);
    const query = chunk.map((s) => `r_hk${s.replace(/^hk/i, '')}`).join(',');
    let raw: string;
    try {
      raw = await httpGetText(`https://qt.gtimg.cn/q=${query}`, { gbk: true, headers: { Referer: 'https://gu.qq.com' }, retries: 2 });
    } catch {
      continue;
    }
    for (const m of raw.matchAll(/v_r_hk(\w+)="([^"]*)"/g)) {
      const sym = chunk.find((s) => s.replace(/^hk/i, '').toUpperCase() === m[1].toUpperCase());
      if (!sym || result.has(sym)) continue;
      const f = m[2].split('~');
      const price = numOf(f[3]);
      const prev = numOf(f[4]);
      if (!(price > 0) || !(prev > 0)) continue;
      const name = f[1]?.trim() || sym;
      result.set(sym, {
        code: sym, name, price, prevClose: prev,
        change: price - prev,
        changePct: prev > 0 ? ((price - prev) / prev) * 100 : 0,
      });
    }
  }

  // 4) 美股/其他 → Yahoo v8 chart（meta.regularMarketPrice）
  const yahooRows = await mapWithConcurrency(usShares, 4, async (sym): Promise<[string, StockQuoteRow] | null> => {
    try {
      const raw = await httpGetText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`, { retries: 1 });
      const meta = JSON.parse(raw)?.chart?.result?.[0]?.meta;
      if (!meta) return null;
      const price = Number(meta.regularMarketPrice);
      if (!Number.isFinite(price) || price <= 0) return null;
      let prevClose = Number(meta.chartPreviousClose);
      if (!Number.isFinite(prevClose) || prevClose <= 0) prevClose = Number(meta.regularMarketPreviousClose);
      if (!Number.isFinite(prevClose) || prevClose <= 0) prevClose = price;
      const name = (typeof meta.shortName === 'string' && meta.shortName) || sym;
      return [sym, {
        code: sym, name, price, prevClose,
        change: price - prevClose,
        changePct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      }];
    } catch {
      return null;
    }
  });
  for (const row of yahooRows) if (row) result.set(row[0], row[1]);

  // 5) 美股盘前/盘后延伸：Yahoo meta 从不提供 pre/post 字段，盘前/盘后窗口用新浪 gb_ 补充
  const usSession = currentUsSession(now);
  if (usShares.length > 0 && (usSession === 'PRE' || usSession === 'POST')) {
    const ext = await getUsExtendedQuotes(usShares, usSession);
    for (const [sym, pair] of ext) {
      const q = result.get(sym);
      if (!q) continue;
      result.set(sym, {
        ...q,
        extra: {
          ...q.extra,
          extendedPrice: pair.price,
          extendedChangePercent: pair.changePct,
          extendedSession: usSession === 'PRE' ? 'PRE_MARKET' : 'POST_MARKET',
        },
      });
    }
  }

  return result;
}

// ── 搜索 ─────────────────────────────────────────────────────────────────────

/** 判断搜索结果的名称是否“看起来有问题”（代码/乱码/空），需要用行情接口纠正（Kotlin isNameBad） */
export function isNameBad(name: string, symbol: string): boolean {
  const n = name.trim();
  if (!n || n === symbol) return true;
  if (/^(sh|sz|bj|hk)\d{5,6}$/.test(n)) return true;
  if (/^\d{5,6}$/.test(n)) return true;
  if ([...n].some((ch) => ch === '�' || ch.codePointAt(0)! < 0x20)) return true;
  const cjk = [...n].filter((ch) => (ch >= '一' && ch <= '鿿') || (ch >= '぀' && ch <= 'ヿ')).length;
  const latin = [...n].filter((ch) => /[a-zA-Z0-9]/.test(ch)).length;
  const meaningful = cjk + latin;
  if (meaningful < n.length / 2 && n.length > 2) return true;
  return false;
}

/** 纯 6 位代码 → 带市场前缀 symbol（43/83/87/88/92=北交所） */
export function inferAShareSymbol(code6: string): string {
  if (code6.startsWith('6') || code6.startsWith('5')) return `sh${code6}`;
  if (/^(43|83|87|88|92)/.test(code6)) return `bj${code6}`;
  return `sz${code6}`;
}

/**
 * 股票搜索三通道（Kotlin searchStocks）：
 * 1. 新浪 suggest3（A 股+港股，GBK 最快）；2. 东财 suggest（美股全库）；3. 行情接口纠正坏名称。
 */
export async function searchStocks(keyword: string): Promise<SearchResultItem[]> {
  if (!keyword.trim()) return [];
  const results: SearchResultItem[] = [];

  // 1. 新浪
  try {
    const raw = await httpGetText(`https://suggest3.sinajs.cn/suggest/key=${encodeURIComponent(keyword)}`, { gbk: true, retries: 1 });
    const payload = /"([^"]+)"/.exec(raw)?.[1] ?? '';
    for (const item of payload.split(';').filter(Boolean)) {
      const parts = item.split(',');
      const symbol = (parts[3] || parts[2] || '').trim();
      const name = (parts[0] || '').trim();
      if (!symbol || !name) continue;
      if (/^(sh|sz|bj)/.test(symbol)) results.push({ code: symbol, name, market: 'stock' });
      else if (/^\d{6}$/.test(symbol)) results.push({ code: inferAShareSymbol(symbol), name, market: 'stock' });
      else if (/^\d{5}$/.test(symbol)) results.push({ code: `hk${symbol}`, name, market: 'stock' });
      else if (/^[Hh][Kk]\d{4,5}$/.test(symbol)) results.push({ code: `hk${symbol.slice(-5).padStart(5, '0')}`, name, market: 'stock' });
    }
  } catch { /* 通道失败不阻塞 */ }

  // 2. 东财美股（中文关键词、疑似美股 ticker 或新浪无结果时）
  const looksLikeChinese = [...keyword].some((ch) => ch >= '一' && ch <= '鿿');
  const looksLikeUsTicker = /^[A-Za-z][A-Za-z0-9.\-]{0,8}$/.test(keyword);
  if (looksLikeChinese || looksLikeUsTicker || results.length === 0) {
    try {
      const raw = await httpGetText(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8`, { retries: 1 });
      const data = JSON.parse(raw)?.QuotationCodeTable?.Data ?? [];
      for (const o of data) {
        if (o?.Classify !== 'UsStock') continue;
        const sym = String(o.Code ?? '');
        if (!sym) continue;
        const name = String(o.Name ?? sym);
        if (!results.some((r) => r.code === sym)) results.push({ code: sym, name, market: 'stock' });
      }
    } catch { /* 通道失败不阻塞 */ }
  }

  // 3. 行情名称补全：搜索 API 有时返回代码而非真实名称
  const enriched = dedupeByCode(results).slice(0, 15);
  const needFix = enriched.filter((r) => isNameBad(r.name, r.code));
  if (needFix.length > 0) {
    const quotes = await getStockQuotes(needFix.map((r) => r.code));
    for (let i = 0; i < enriched.length; i++) {
      const q = quotes.get(enriched[i].code);
      if (q && q.name.trim() && isNameBad(enriched[i].name, enriched[i].code)) {
        enriched[i] = { ...enriched[i], name: q.name };
      }
    }
  }
  return enriched;
}

function dedupeByCode(items: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const it of items) {
    if (seen.has(it.code)) continue;
    seen.add(it.code);
    out.push(it);
  }
  return out;
}

/** 基金搜索（东财 FundSearchAPI，Kotlin searchFunds） */
export async function searchFunds(keyword: string): Promise<SearchResultItem[]> {
  if (!keyword.trim()) return [];
  try {
    const raw = await httpGetText(`https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(keyword)}`, { retries: 1 });
    const data = (JSON.parse(raw)?.Datas ?? []) as { CODE?: string; NAME?: string }[];
    const out: SearchResultItem[] = [];
    for (const o of data) {
      if (!o?.CODE || !o?.NAME) continue;
      out.push({ code: String(o.CODE), name: String(o.NAME), market: 'fund' });
      if (out.length >= 15) break;
    }
    return out;
  } catch {
    return [];
  }
}

// ── 财报日期（东财 RPT_LICO_FN_CPD，含历史与预约披露）─────────────────────────

/**
 * A 股最近财报公告日期（Kotlin getEarningsDate）。
 * @param pureCode 纯 6 位代码（不含 sh/sz 前缀）
 * @returns [最近一次历史公告日, 下次预约公告日|null]，接口失败均为 null
 */
export async function getEarningsDate(pureCode: string): Promise<[string | null, string | null]> {
  try {
    const enc = encodeURIComponent(`(SECURITY_CODE="${pureCode}")`);
    const raw = await httpGetText(
      'https://datacenter-web.eastmoney.com/api/data/v1/get' +
      `?reportName=RPT_LICO_FN_CPD&columns=SECURITY_CODE,NOTICE_DATE&filter=${enc}` +
      '&sortColumns=NOTICE_DATE&sortTypes=-1&pageNumber=1&pageSize=10&source=WEB',
      { retries: 1 },
    );
    const items = JSON.parse(raw)?.result?.data;
    if (!Array.isArray(items)) return [null, null];
    const today = zonedTime(CN_TZ).date;
    let lastDate: string | null = null;
    let nextDate: string | null = null;
    for (const o of items) {
      const date = String(o?.NOTICE_DATE ?? '').slice(0, 10);
      if (!date) continue;
      if (date >= today && (nextDate === null || date < nextDate)) nextDate = date;
      if (date < today && (lastDate === null || date > lastDate)) lastDate = date;
    }
    return [lastDate, nextDate];
  } catch {
    return [null, null];
  }
}

// ── 批量导入校验（配合导入对话框；Kotlin resolveImportCandidates）──────────────

export interface ImportToken {
  /** 原始文本行 */
  raw: string;
  code?: string;
  name?: string;
}

export type ImportStatus = 'OK' | 'EXISTS' | 'AMBIGUOUS' | 'NOT_FOUND';

export interface ImportCandidate {
  raw: string;
  symbol: string;
  name: string;
  status: ImportStatus;
  price: number;
  nameCorrected?: boolean;
  /** AMBIGUOUS 时的其余候选代码 */
  alternates?: string[];
}

/**
 * 批量校验导入候选：
 * - 带代码条目：getStockQuotes 批量确认存在性并取规范名称/现价；
 * - 仅名称条目：3 并发 searchStocks 取完全同名结果；多个不同代码命中 → AMBIGUOUS；
 * - 已在自选（existingSymbols）→ EXISTS；文本内重复 symbol 只保留第一条，其余标 EXISTS；
 * - 最后统一为已确认条目回填现价（默认成本用）。
 */
export async function resolveImportCandidates(
  tokens: ImportToken[],
  existingSymbols: Set<string>,
  progress?: (done: number, total: number) => void,
): Promise<ImportCandidate[]> {
  if (tokens.length === 0) return [];
  const results = new Array<ImportCandidate | undefined>(tokens.length).fill(undefined);
  let done = 0;
  const bump = () => progress?.(++done, tokens.length);

  // 1. 带代码条目：批量行情确认
  const codeTokens = tokens.map((t, i) => [i, t] as const).filter(([, t]) => t.code);
  if (codeTokens.length > 0) {
    const quotes = await getStockQuotes([...new Set(codeTokens.map(([, t]) => t.code as string))]);
    for (const [idx, tok] of codeTokens) {
      const sym = tok.code as string;
      const q = quotes.get(sym);
      if (!q) {
        results[idx] = { raw: tok.raw, symbol: '', name: tok.name ?? sym, status: 'NOT_FOUND', price: 0 };
      } else if (existingSymbols.has(sym)) {
        results[idx] = { raw: tok.raw, symbol: sym, name: q.name, status: 'EXISTS', price: q.price };
      } else {
        results[idx] = {
          raw: tok.raw, symbol: sym, name: q.name, status: 'OK', price: q.price,
          nameCorrected: !!(tok.name?.trim()) && tok.name.trim() !== q.name,
        };
      }
      bump();
    }
  }

  // 2. 仅名称条目：3 并发搜索完全同名结果
  const nameTokens = tokens.map((t, i) => [i, t] as const).filter(([, t]) => !t.code && t.name?.trim());
  if (nameTokens.length > 0) {
    const resolved = await mapWithConcurrency(nameTokens, 3, ([, tok]) => resolveImportByName(tok as ImportToken, existingSymbols));
    resolved.forEach((cand, j) => {
      results[nameTokens[j][0]] = cand;
      bump();
    });
  }

  // 3. 解析后 symbol 仍重复：保留第一条，其余标 EXISTS
  const seen = new Set<string>();
  for (let i = 0; i < results.length; i++) {
    const c = results[i];
    if (!c || (c.status !== 'OK' && c.status !== 'AMBIGUOUS')) continue;
    if (!seen.add(c.symbol)) results[i] = { ...c, status: 'EXISTS' };
  }

  // 4. 已确认但缺现价的条目（名称搜索路径）统一补价
  const needPrice = results.filter((c): c is ImportCandidate => !!c && (c.status === 'OK' || c.status === 'AMBIGUOUS') && !(c.price > 0));
  if (needPrice.length > 0) {
    const quotes = await getStockQuotes([...new Set(needPrice.map((c) => c.symbol))]);
    for (let i = 0; i < results.length; i++) {
      const c = results[i];
      const p = c ? quotes.get(c.symbol)?.price : undefined;
      if (c && p !== undefined && p > 0) results[i] = { ...c, price: p };
    }
  }
  return results.filter((c): c is ImportCandidate => c !== undefined);
}

/** 仅名称条目 → 搜索结果中完全同名的第一条；多个不同代码同名 → AMBIGUOUS */
async function resolveImportByName(tok: ImportToken, existingSymbols: Set<string>): Promise<ImportCandidate> {
  const name = (tok.name as string).trim();
  const results = await searchStocks(name).catch(() => [] as SearchResultItem[]);
  const exact = results.filter((r) => r.name.trim() === name);
  const pick = exact[0];
  if (!pick) return { raw: tok.raw, symbol: '', name, status: 'NOT_FOUND', price: 0 };
  const distinct = [...new Set(exact.map((r) => r.code))];
  const status: ImportStatus = existingSymbols.has(pick.code) ? 'EXISTS' : distinct.length > 1 ? 'AMBIGUOUS' : 'OK';
  return { raw: tok.raw, symbol: pick.code, name: pick.name, status, price: 0, alternates: distinct.slice(1) };
}
