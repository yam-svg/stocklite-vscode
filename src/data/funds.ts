/**
 * 基金行情（移植自 MarketDataService 基金段）。
 * 两级结构：腾讯 jj 批量（名称+净值+涨跌+日期）→ 东财 F10 官方净值逐只增强；
 * 外加“官方净值水位线”跨轮次纠正：腾讯/F10 均走 CDN，边缘节点偶发返回滞后快照，
 * 净值日期落后于水位线时用水位线覆盖，只进不退，杜绝面板轮询与后台监控并发时净值来回跳变。
 * 已下线接口勿再引入：fundgz.1234567.com.cn 估算接口、新浪 fund_ 接口（官方公告下线/返回空串）。
 */
import { httpGetText } from '../shared/http';
import { numOf, parseTencentVars, roundFixed } from './util';
import { dayOfShanghai } from './marketTime';

export interface FundNavRow {
  code: string;
  name: string;
  nav: number;
  changePercent: number;
  /** 净值日期 YYYY-MM-DD */
  date: string;
}

/** 提取 6 位基金代码（"012414(某基金)" → "012414"），无 6 位数字则原样保留 */
export function normFundCode(raw: string): string {
  const v = raw.trim();
  return /\d{6}/.exec(v)?.[0] ?? v;
}

// ── 官方净值水位线（Kotlin officialQuoteHighWaterMark）────────────────────────

const highWaterMark = new Map<string, FundNavRow>();

/** 读水位线→比较→写回；返回纠正后的行（node 单线程无竞态，无需 compute 原语） */
export function advanceHighWaterMark(code: string, computed: FundNavRow): FundNavRow {
  const prevBest = highWaterMark.get(code);
  if (prevBest && !(computed.date !== '' && computed.date >= prevBest.date)) {
    // 本次官方日期落后于已知最优（命中滞后 CDN 节点等）——用水位线纠正
    const corrected = { ...computed, nav: prevBest.nav, changePercent: prevBest.changePercent, date: prevBest.date };
    return corrected;
  }
  highWaterMark.set(code, computed);
  return computed;
}

/** 腾讯 jj 基金接口（GBK 批量）字段以 ~ 分隔：0=代码 1=名称 5=单位净值 6=累计净值 7=净值日涨跌% 8=净值日期 */
export async function fetchFundsTencent(codes: string[]): Promise<Map<string, FundNavRow>> {
  const result = new Map<string, FundNavRow>();
  if (codes.length === 0) return result;
  let raw: string;
  try {
    raw = await httpGetText(`https://qt.gtimg.cn/q=${codes.map((c) => `jj${c}`).join(',')}`, {
      gbk: true, headers: { Referer: 'https://gu.qq.com' }, retries: 2,
    });
  } catch {
    return result;
  }
  for (const [key, f] of parseTencentVars(raw)) {
    const code = /^jj(\d{6})$/.exec(key)?.[1];
    if (!code || f.length < 9) continue;
    const name = f[1].trim();
    if (!name) continue;
    const nav = numOf(f[5]);
    if (!(nav > 0)) continue;
    const pct = numOf(f[7], 0);
    result.set(code, {
      code, name, nav,
      changePercent: roundFixed(pct, 2),
      date: f[8].trim() || dayOfShanghai(Date.now()),
    });
  }
  return result;
}

// ── 东财 F10 官方净值（历史净值接口已迁移至 api.fund.eastmoney.com/f10/lsjz；
//    旧版 fundf10 F10DataApi.aspx 已废弃、返回空壳不再更新，勿回退）──────────────

export interface F10Nav {
  date: string;
  nav: number;
  changePercent: number;
  prevNav: number;
}

export function parseF10LatestNav(json: string): F10Nav | null {
  try {
    const root = JSON.parse(json);
    if ((root?.ErrCode ?? 0) !== 0) return null;
    const list = root?.Data?.LSJZList;
    if (!Array.isArray(list) || list.length === 0) return null;
    const first = list[0];
    const date = String(first?.FSRQ ?? '');
    const nav = numOf(String(first?.DWJZ ?? ''));
    if (!(nav > 0)) return null;
    const changePct = numOf(String(first?.JZZZL ?? ''));
    const prevNav = Number.isFinite(changePct) ? nav / (1 + changePct / 100) : NaN;
    return { date, nav, changePercent: changePct, prevNav };
  } catch {
    return null;
  }
}

export async function fetchF10Nav(code: string): Promise<F10Nav | null> {
  try {
    const raw = await httpGetText(
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1`,
      { headers: { Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` }, retries: 2 },
    );
    return parseF10LatestNav(raw);
  } catch {
    return null;
  }
}

function buildOfficialQuote(code: string, name: string, p: F10Nav): FundNavRow {
  const prevNav = Number.isFinite(p.prevNav) && p.prevNav > 0 ? p.prevNav : 0;
  const change = prevNav > 0 ? p.nav - prevNav : 0;
  const changePct = Number.isFinite(p.changePercent) ? p.changePercent : prevNav > 0 ? (change / prevNav) * 100 : 0;
  return {
    code, name,
    nav: roundFixed(p.nav, 4),
    changePercent: roundFixed(changePct, 2),
    date: p.date || dayOfShanghai(Date.now()),
  };
}

/**
 * 基金批量行情（Kotlin getFundQuotes）：腾讯批量打底 → F10 官方净值增强（日期新者胜出）→ 水位线纠正。
 * 返回 Map；调用方按输入代码整理顺序。
 */
export async function getFundQuotes(codes: string[]): Promise<Map<string, FundNavRow>> {
  const results = new Map<string, FundNavRow>();
  const unique = [...new Set(codes.map(normFundCode).filter((c) => c !== ''))];
  if (unique.length === 0) return results;

  // 第一步：腾讯批量（一次请求覆盖全部代码）
  for (const [c, q] of await fetchFundsTencent(unique)) results.set(c, q);

  // 第二步：F10 增强（东财历史净值 API 是官方涨跌权威来源）
  for (const code of unique) {
    const f10 = await fetchF10Nav(code);
    if (!f10) continue;
    const existing = results.get(code);
    if (!existing) {
      results.set(code, buildOfficialQuote(code, `基金${code}`, f10));
      continue;
    }
    if (f10.date !== '' && existing.date !== '' && f10.date < existing.date) {
      // F10 命中滞后 CDN 节点：跳过增强，不能让旧净值和新日期拼到一起
      continue;
    }
    const prevNav = Number.isFinite(f10.prevNav) && f10.prevNav > 0 ? f10.prevNav : 0;
    const changePct = Number.isFinite(f10.changePercent)
      ? f10.changePercent
      : prevNav > 0
        ? ((f10.nav - prevNav) / prevNav) * 100
        : existing.changePercent;
    results.set(code, {
      ...existing,
      nav: f10.nav > 0 ? roundFixed(f10.nav, 4) : existing.nav,
      changePercent: roundFixed(changePct, 2),
      date: existing.date > f10.date ? existing.date : (f10.date || existing.date),
    });
  }

  // 官方净值水位线：跨轮次纠正，杜绝净值新旧来回跳变
  for (const code of unique) {
    const row = results.get(code);
    if (row) results.set(code, advanceHighWaterMark(code, row));
  }
  return results;
}
