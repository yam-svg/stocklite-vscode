/**
 * 8 个 tab 的 QuoteProvider 装配（S1）。
 * 契约要点：fetchQuotes 批量、顺序与入参一致（失败条目缺项）；fetchKline 升序；不 import vscode。
 * providerId 与 TabDescriptor.providerId 对齐：stock/fund/future/global/sector/ipo/us/crypto。
 */
import type { Period, Quote, QuoteProvider, SearchResultItem } from '../shared/types';
import { getStockQuotes, searchStocks, searchFunds } from './stocks';
import { getFundQuotes } from './funds';
import { getFutureQuotes, searchFutures } from './futures';
import { getGlobalIndexQuotes, globalRowToQuote, GLOBAL_INDEXES, visibleGlobalIndexes, type GlobalIndexConfig } from './globalIndex';
import { getSectorQuotes, sectorToQuote } from './sectors';
import { getIpoList } from './ipos';
import { getUsSectorQuotes, usSectorToQuote, US_SECTOR_ETFS } from './usMarket';
import { getCryptoQuotes, probeCryptoNetwork, searchCryptos, normCryptoSymbol, type CryptoNetStatus } from './cryptos';
import { getHistoryBars, getIntradayRows, barsToKline, rowsToMinutes } from './kline';
import { currentUsSession } from './marketTime';
import { orderByInput } from './util';

const klineImpl = async (code: string, period: Period, count: number) => barsToKline(await getHistoryBars(code, period, count));
const minuteImpl = async (code: string) => rowsToMinutes(await getIntradayRows(code));

// ── 股票（A股/港股/美股 + 竞价/延伸时段，全部在 getStockQuotes 内部路由）──────

const stockProvider: QuoteProvider = {
  id: 'stock',
  async fetchQuotes(codes) {
    const map = await getStockQuotes(codes);
    return orderByInput(codes, map);
  },
  fetchKline: klineImpl,
  fetchMinute: minuteImpl,
  search: (kw) => searchStocks(kw),
};

// ── 基金（净值即现价；prevClose 由官方涨跌反推）───────────────────────────────

const fundProvider: QuoteProvider = {
  id: 'fund',
  async fetchQuotes(codes) {
    const rows = await getFundQuotes(codes);
    const map = new Map<string, Quote>();
    for (const [code, r] of rows) {
      const prevNav = Number.isFinite(r.changePercent) && r.changePercent !== -100
        ? r.nav / (1 + r.changePercent / 100)
        : r.nav;
      map.set(code, {
        code, name: r.name,
        price: r.nav, prevClose: prevNav,
        change: r.nav - prevNav, changePct: r.changePercent,
        time: r.date,
        extra: { navDate: r.date },
      });
    }
    return orderByInput(codes.map(normalizeFundKey), map);
  },
  fetchKline: klineImpl,
  search: (kw) => searchFunds(kw),
};

function normalizeFundKey(code: string): string {
  return /\d{6}/.exec(code.trim())?.[0] ?? code.trim();
}

// ── 期货（nf_/hf_，字段解析在 futures.ts）─────────────────────────────────────

const futureProvider: QuoteProvider = {
  id: 'future',
  async fetchQuotes(codes) {
    const map = await getFutureQuotes(codes);
    // 键是规范化 symbol，按入参规范化后对齐顺序
    return orderByInput(codes.map(normalizeFutureKey), map);
  },
  fetchKline: klineImpl,
  fetchMinute: minuteImpl,
  search: (kw) => searchFutures(kw),
};

function normalizeFutureKey(code: string): string {
  const v = code.trim();
  if (/^(nf_|hf_)/i.test(v)) return `${v.slice(0, 2).toLowerCase()}_${v.slice(3).toUpperCase()}`;
  return `nf_${v.toUpperCase()}`;
}

// ── 全球指数（腾讯港股/新浪/Yahoo 三源，60s Yahoo 缓存在 globalIndex.ts 内部）──

export interface GlobalVisibility {
  hidden: string[];
  enabledOptional: string[];
}

export function createGlobalProvider(getVisibility?: () => GlobalVisibility): QuoteProvider {
  const visibleConfigs = (): GlobalIndexConfig[] => {
    const v = getVisibility?.();
    return v ? visibleGlobalIndexes(v.hidden, v.enabledOptional) : GLOBAL_INDEXES.filter((c) => !c.optional);
  };
  return {
    id: 'global',
    async fetchQuotes(codes) {
      const wanted = codes.length > 0
        ? GLOBAL_INDEXES.filter((c) => codes.includes(c.symbol))
        : visibleConfigs();
      const { quotes } = await getGlobalIndexQuotes(wanted);
      const map = new Map(quotes.map((row) => [row.config.symbol, globalRowToQuote(row)]));
      const ordered = orderByInput(wanted.map((c) => c.symbol), map);
      // 入参含表外代码时（用户手输 Yahoo symbol）也保底走一次 Yahoo
      const unknown = codes.filter((c) => !GLOBAL_INDEXES.some((g) => g.symbol === c));
      if (unknown.length > 0) {
        const extraConfigs = unknown.map((sym) => ({ symbol: sym, code: sym.replace(/^\^/, ''), nameEn: sym, nameCn: sym, market: '', timezone: 'UTC', optional: true }));
        const { quotes: extra } = await getGlobalIndexQuotes(extraConfigs);
        ordered.push(...extra.map(globalRowToQuote));
      }
      return ordered;
    },
    fetchKline: klineImpl,
    fetchMinute: minuteImpl,
    async search(keyword: string): Promise<SearchResultItem[]> {
      const kw = keyword.trim().toLowerCase();
      if (!kw) return [];
      return GLOBAL_INDEXES
        .filter((c) => c.nameCn.includes(keyword.trim()) || c.nameEn.toLowerCase().includes(kw) || c.code.toLowerCase().includes(kw) || c.symbol.toLowerCase().includes(kw))
        .slice(0, 20)
        .map((c) => ({ code: c.symbol, name: `${c.nameCn} (${c.nameEn})`, market: 'global' }));
    },
  };
}

// ── A股板块（全量榜单型 tab：codes 为空返回默认分类全量；前缀 r:/c: 选地域/概念）──

const sectorProvider: QuoteProvider = {
  id: 'sector',
  async fetchQuotes(codes) {
    const cats = new Map<1 | 2 | 3, string[]>();
    const push = (cat: 1 | 2 | 3, bk: string) => {
      const arr = cats.get(cat) ?? [];
      if (bk) arr.push(bk);
      cats.set(cat, arr);
    };
    if (codes.length === 0) push(2, '');
    for (const c of codes) {
      if (c.startsWith('r:')) push(1, c.slice(2));
      else if (c.startsWith('c:')) push(3, c.slice(2));
      else push(2, c);
    }
    const out: Quote[] = [];
    for (const [cat, wantedBk] of cats) {
      const list = await getSectorQuotes(cat);
      if (!list) continue;
      const filtered = wantedBk.length > 0 ? list.filter((s) => wantedBk.includes(s.code)) : list;
      out.push(...filtered.map((s) => sectorToQuote(s, 'sector')));
    }
    return out;
  },
  // 板块自身无历史 K 线源；领涨股走势图由 UI 用 extra.leaderCode 走 stock provider
  async fetchKline() {
    return [];
  },
  async search(keyword: string): Promise<SearchResultItem[]> {
    const list = await getSectorQuotes(2);
    return (list ?? [])
      .filter((s) => s.name.includes(keyword.trim()))
      .slice(0, 20)
      .map((s) => ({ code: s.code, name: s.name, market: 'sector' }));
  },
};

// ── 新股（申购日历 + 次新表现；已上市条目并流新浪现价）────────────────────────

const ipoProvider: QuoteProvider = {
  id: 'ipo',
  async fetchQuotes(codes) {
    const list = await getIpoList();
    if (!list) return [];
    const wanted = codes.length > 0
      ? list.filter((r) => codes.some((c) => {
        const k = c.trim().toLowerCase();
        return r.sinaSymbol.toLowerCase() === k || r.pureCode === k || r.applyCode.toLowerCase() === k;
      }))
      : list;
    const listedSymbols = wanted.filter((r) => r.listed).map((r) => r.sinaSymbol);
    const quotes = listedSymbols.length > 0 ? await getStockQuotes(listedSymbols) : new Map<string, Quote>();
    return wanted.map((r) => {
      const q = quotes.get(r.sinaSymbol);
      const price = q?.price ?? r.issuePrice ?? 0;
      return {
        code: r.sinaSymbol,
        name: r.name,
        price,
        prevClose: q?.prevClose ?? r.issuePrice ?? price,
        change: q?.change,
        changePct: q?.changePct,
        time: q?.time,
        extra: {
          applyCode: r.applyCode,
          applyDate: r.applyDate,
          listingDate: r.listingDate ?? undefined,
          issuePrice: r.issuePrice ?? undefined,
          issuePe: r.issuePe ?? undefined,
          industryPe: r.industryPe ?? undefined,
          maxApplyQty: r.maxApplyQty ?? undefined,
          raiseFunds: r.raiseFunds ?? undefined,
          firstDayChangePct: r.firstDayChangePct ?? undefined,
          listed: r.listed ? 1 : 0,
          isBeijing: r.isBeijing ? 1 : 0,
        },
      } satisfies Quote;
    });
  },
  fetchKline: klineImpl,
  fetchMinute: minuteImpl,
  async search(keyword: string): Promise<SearchResultItem[]> {
    const list = await getIpoList();
    const kw = keyword.trim();
    return (list ?? [])
      .filter((r) => r.name.includes(kw) || r.pureCode.includes(kw) || r.applyCode.includes(kw))
      .slice(0, 20)
      .map((r) => ({ code: r.sinaSymbol, name: r.name, market: 'ipo' }));
  },
};

// ── 美股板块 ETF（新浪批量 + Yahoo 兜底；codes 为空返回全部 33 只）────────────

const usProvider: QuoteProvider = {
  id: 'us',
  async fetchQuotes(codes) {
    const session = currentUsSession();
    const all = await getUsSectorQuotes();
    const wanted = codes.length > 0 ? codes.map((c) => c.trim().toUpperCase()) : US_SECTOR_ETFS.map(([s]) => s);
    const out: Quote[] = [];
    for (const sym of wanted) {
      const q = all.get(sym);
      if (q) out.push(usSectorToQuote(q, session));
    }
    return out;
  },
  fetchKline: klineImpl,
  fetchMinute: minuteImpl,
  async search(keyword: string): Promise<SearchResultItem[]> {
    const kw = keyword.trim().toUpperCase();
    if (!kw) return [];
    return US_SECTOR_ETFS
      .filter(([sym, cn]) => sym.includes(kw) || cn.includes(keyword.trim()))
      .slice(0, 20)
      .map(([sym, cn]) => ({ code: sym, name: `${cn} (${sym})`, market: 'us' }));
  },
};

// ── 加密货币（三源降级；连通状态供界面徽章，Kotlin 网络状态提示为用户显式要求）──

let lastCryptoStatus: { status: CryptoNetStatus; source: string | null } = { status: 'OFFLINE', source: null };

export function getCryptoNetStatus(): { status: CryptoNetStatus; source: string | null } {
  return lastCryptoStatus;
}

const cryptoProvider: QuoteProvider = {
  id: 'crypto',
  async fetchQuotes(codes) {
    const batch = await getCryptoQuotes(codes);
    lastCryptoStatus = { status: batch.status, source: batch.workingSource };
    const out: Quote[] = [];
    for (const raw of codes) {
      const pair = normCryptoSymbol(raw);
      const q = pair ? batch.quotes.get(pair) : undefined;
      if (!q) continue;
      const prevClose = Number.isFinite(q.changePct) ? q.price / (1 + q.changePct / 100) : q.price;
      out.push({
        code: raw.trim(), name: q.pair.replace('_', '/'),
        price: q.price, prevClose,
        change: q.price - prevClose, changePct: q.changePct,
        amount: Number.isFinite(q.quoteVolume) ? q.quoteVolume : undefined,
        extra: {
          high24h: q.high24h, low24h: q.low24h,
          netStatus: batch.status,
          netSource: batch.workingSource ?? '',
        },
      });
    }
    return out;
  },
  fetchKline: klineImpl,
  fetchMinute: minuteImpl,
  async search(keyword: string): Promise<SearchResultItem[]> {
    const hits = await searchCryptos(keyword);
    return hits.map((h) => ({ code: h.code, name: h.name, market: 'crypto' }));
  },
};

export function createDataProviders(getGlobalVisibility?: () => GlobalVisibility): Record<string, QuoteProvider> {
  const providers: QuoteProvider[] = [
    stockProvider, fundProvider, futureProvider, createGlobalProvider(getGlobalVisibility),
    sectorProvider, ipoProvider, usProvider, cryptoProvider,
  ];
  return Object.fromEntries(providers.map((p) => [p.id, p]));
}

/** 空自选时的加密面板连通性探测（透传 cryptos.probeCryptoNetwork，并同步状态徽章缓存） */
export async function probeCryptoStatus(): Promise<{ status: CryptoNetStatus; source: string | null }> {
  const batch = await probeCryptoNetwork();
  lastCryptoStatus = { status: batch.status, source: batch.workingSource };
  return lastCryptoStatus;
}
