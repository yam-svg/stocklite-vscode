/**
 * S1 数据源层公共小工具（S1 独占目录）。
 * 本目录所有文件不得 import 'vscode'（含 type-only 之外的运行时依赖），保证 node 自测可直跑。
 */
import * as https from 'node:https';
import { httpGetBytes, decodeBytes, type HttpOptions } from '../shared/http';

/**
 * 东财 push2 系专用 GET：node:https + 浏览器 UA + http/1.1 ALPN。
 * 2026-10-29 实测结论：push2 边缘节点对 Node 连接随机 RST，且通过率随解析到的边缘 IP 与时间窗漂移
 * （同一时刻有域名 0/6 另一域名 5/6，几分钟后互换）；UA/ALPN 均非决定因素。
 * 有效对策就是调用方跨镜像域名轮换重试（见 sectors.ts）。本函数只保证永不 reject：
 * 网络错误/超时/HTTP 非 200 一律返回 null，重试节奏由调用方决定。
 */
const EM_AGENT = new https.Agent({ keepAlive: true, ALPNProtocols: ['http/1.1'] });

export function emGetText(url: string, headers: Record<string, string> = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        agent: EM_AGENT,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ...headers,
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(res.statusCode === 200 ? body : null));
        res.on('error', () => resolve(null));
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

/**
 * 带 HTTP 状态码的 GET（对齐 Kotlin HttpUtil.getWithStatus，用于 Yahoo 429 限流检测）。
 * 与 httpGetText 不同：不重试（重试链由调用方决定，如板块分页自带重试），网络异常/超时返回 -1。
 */
export async function httpGetWithStatus(url: string, opts: HttpOptions = {}): Promise<{ status: number; body: string | null }> {
  try {
    const bytes = await httpGetBytes(url, { ...opts, retries: 0 });
    return { status: 200, body: decodeBytes(bytes, !!opts.gbk) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /HTTP (\d{3})/.exec(msg);
    return { status: m ? Number(m[1]) : -1, body: null };
  }
}

/** 四舍五入到 0.01（与 Kotlin Math.floor(v*100+0.5)/100 完全一致，涨跌停价专用） */
export function round2(v: number): number {
  return Math.floor(v * 100 + 0.5) / 100;
}

/** HALF_UP 固定小数位（净值 4 位、涨跌 2 位，对齐 Kotlin BigDecimal.setScale(HALF_UP)） */
export function roundFixed(v: number, digits: number): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** digits;
  return Math.round((v + Number.EPSILON) * f) / f;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 与 Kotlin StaleCache 同语义：
 * 新鲜期内直接返回缓存、**不发请求**；过期才 fetch；fetch 失败时 staleTtlMs 内沿用旧值。
 */
export class StaleCache<T> {
  private value: T | null = null;
  private time = 0;
  constructor(private readonly freshTtlMs: number, private readonly staleTtlMs: number) {}

  get lastSuccessTime(): number {
    return this.time;
  }

  async getOrFetch(fetch: () => Promise<T | null | undefined>): Promise<T | null> {
    const now = Date.now();
    if (this.value !== null && now - this.time < this.freshTtlMs) return this.value;
    let fresh: T | null | undefined;
    try {
      fresh = await fetch();
    } catch {
      fresh = null;
    }
    if (fresh !== null && fresh !== undefined) {
      this.value = fresh;
      this.time = now;
      return fresh;
    }
    return this.value !== null && now - this.time < this.staleTtlMs ? this.value : null;
  }
}

/** 小并发 map（对齐 Kotlin resolveImportCandidates 的 3 线程池），保持结果顺序 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** 按入参顺序整理 map 结果（契约要求：fetchQuotes 返回顺序与入参一致，失败条目缺项） */
export function orderByInput<K, V>(codes: K[], map: Map<K, V>): V[] {
  const out: V[] = [];
  for (const c of codes) {
    const v = map.get(c);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** 数值字段解析：空串/非法 → 给定默认值（对齐 Kotlin toDoubleOrNull，空串不是 0） */
export function numOf(raw: string | undefined, fallback = NaN): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** 腾讯 `v_xxx="a~b~c"` 响应展开为 symbol → 字段数组 */
export function parseTencentVars(raw: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of raw.matchAll(/v_(\w+)="([^"]*)"/g)) {
    map.set(m[1], m[2].split('~'));
  }
  return map;
}

/** 新浪 `var hq_str_xxx="a,b,c"` 响应展开为 symbol → 字段数组 */
export function parseSinaVars(raw: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of raw.matchAll(/var hq_str_([^=]+)="([^"]*)"/g)) {
    map.set(m[1].trim(), m[2].split(','));
  }
  return map;
}
