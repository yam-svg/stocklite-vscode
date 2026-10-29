/**
 * 新股日历（移植自 MarketDataService 新股段，东财 RPTA_APP_IPOAPPLY）。
 * 一次返回两类行：申购日历（未上市、申购日在近 7 天及未来）与新股/次新股表现（上市 90 天内）。
 * 行情（现价/涨幅）不在本层：sinaSymbol 直接喂 stocks.getStockQuotes 与走势图路由。
 */
import { httpGetText } from '../shared/http';
import { StaleCache, numOf } from './util';
import { zonedTime } from './marketTime';

export interface IpoInfo {
  /** 纯 6 位代码 */
  pureCode: string;
  /** sh/sz/bj 前缀，可直接走行情/走势图 */
  sinaSymbol: string;
  name: string;
  /** 申购代码（多数与代码相同，科创板等可能不同） */
  applyCode: string;
  /** 申购日 yyyy-MM-dd，空串=未公告 */
  applyDate: string;
  /** 上市日，null=尚未公告 */
  listingDate: string | null;
  issuePrice: number | null;
  /** 发行市盈率（已公布用实际，未公布用预测） */
  issuePe: number | null;
  industryPe: number | null;
  /** 顶格申购上限（股） */
  maxApplyQty: number | null;
  /** 募资额（亿元） */
  raiseFunds: number | null;
  /** 上市首日收盘涨幅% */
  firstDayChangePct: number | null;
  listed: boolean;
  isBeijing: boolean;
}

function optJsonNum(o: any, key: string): number | null {
  if (o == null || o[key] === null || o[key] === undefined) return null;
  const v = Number(o[key]);
  return Number.isFinite(v) ? v : null;
}

/** SECUCODE 后缀（688287.SH）→ 新浪 symbol；无后缀时按代码首位推断 */
export function ipoSinaSymbol(secuCode: string, pure: string): string {
  switch (secuCode.split('.').pop()?.toUpperCase() ?? '') {
    case 'SH': return `sh${pure}`;
    case 'SZ': return `sz${pure}`;
    case 'BJ': return `bj${pure}`;
  }
  if (pure.startsWith('6') || pure.startsWith('5')) return `sh${pure}`;
  if (['43', '83', '87', '88', '92'].some((p) => pure.startsWith(p))) return `bj${pure}`;
  return `sz${pure}`;
}

async function fetchIpoList(now: number = Date.now()): Promise<IpoInfo[] | null> {
  const enc = encodeURIComponent('(IS_VALID="1")');
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    '?reportName=RPTA_APP_IPOAPPLY&columns=' +
    'SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,APPLY_CODE,APPLY_DATE,LISTING_DATE,' +
    'ISSUE_PRICE,PREDICT_ISSUE_PRICE,AFTER_ISSUE_PE,PREDICT_ISSUE_PE,PREDICT_PE,' +
    'INDUSTRY_PE,ONLINE_APPLY_UPPER,DEC_SUMFINA,PREDICT_RAISE_FUNDS,LD_CLOSE_CHANGE,IS_BEIJING' +
    `&filter=${enc}&sortColumns=APPLY_DATE&sortTypes=-1&pageNumber=1&pageSize=100&source=WEB&client=WEB`;
  let raw: string;
  try {
    raw = await httpGetText(url, { retries: 2 });
  } catch {
    return null;
  }
  try {
    const items = JSON.parse(raw)?.result?.data;
    if (!Array.isArray(items)) return null;
    const recentFrom = zonedTime('Asia/Shanghai', now - 90 * 86_400_000).date; // 次新股窗口
    const applyFrom = zonedTime('Asia/Shanghai', now - 7 * 86_400_000).date;   // 申购日历回看窗口
    const list: IpoInfo[] = [];
    for (const o of items) {
      const pure = String(o?.SECURITY_CODE ?? '');
      if (pure.length !== 6) continue;
      const applyDate = String(o?.APPLY_DATE ?? '').slice(0, 10);
      const listing = String(o?.LISTING_DATE ?? '').slice(0, 10) || null;
      const keep = (listing !== null && listing >= recentFrom) ||
        (listing === null && applyDate !== '' && applyDate >= applyFrom);
      if (!keep) continue;
      const predictPrice = optJsonNum(o, 'PREDICT_ISSUE_PRICE');
      const afterPe = optJsonNum(o, 'AFTER_ISSUE_PE');
      const predictPe = optJsonNum(o, 'PREDICT_ISSUE_PE');
      const predictPe2 = optJsonNum(o, 'PREDICT_PE');
      const raiseActual = optJsonNum(o, 'DEC_SUMFINA');
      const raisePredict = optJsonNum(o, 'PREDICT_RAISE_FUNDS');
      const maxApply = optJsonNum(o, 'ONLINE_APPLY_UPPER');
      list.push({
        pureCode: pure,
        sinaSymbol: ipoSinaSymbol(String(o?.SECUCODE ?? ''), pure),
        name: String(o?.SECURITY_NAME_ABBR ?? pure),
        applyCode: String(o?.APPLY_CODE ?? '') || pure,
        applyDate,
        listingDate: listing,
        issuePrice: optJsonNum(o, 'ISSUE_PRICE') ?? predictPrice,
        issuePe: afterPe ?? (predictPe !== null && predictPe > 0 ? predictPe : null) ?? (predictPe2 !== null && predictPe2 > 0 ? predictPe2 : null),
        industryPe: optJsonNum(o, 'INDUSTRY_PE'),
        maxApplyQty: maxApply !== null ? Math.trunc(maxApply) : null,
        raiseFunds: raiseActual !== null && raiseActual > 0 ? raiseActual : raisePredict !== null && raisePredict > 0 ? raisePredict : null,
        firstDayChangePct: optJsonNum(o, 'LD_CLOSE_CHANGE'),
        listed: listing !== null,
        isBeijing: Math.trunc(numOf(String(o?.IS_BEIJING ?? ''), 0)) === 1,
      });
    }
    return list.sort((a, b) => a.applyDate.localeCompare(b.applyDate));
  } catch {
    return null;
  }
}

const ipoListCache = new StaleCache<IpoInfo[]>(10 * 60_000, 2 * 60 * 60_000);

/** 新股日历；null 表示接口不可用（stale 也过期），调用方保留旧数据并提示 */
export function getIpoList(now: number = Date.now()): Promise<IpoInfo[] | null> {
  return ipoListCache.getOrFetch(() => fetchIpoList(now));
}
