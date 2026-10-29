/**
 * HTTP 公共设施（S0 产出，已冻结）。
 * 数据源会话（S1）统一经此发起请求：超时、重试退避、GBK 解码、请求头都在这里。
 * 已知坑（详见 JetBrains 仓库 docs/vscode-port-plan.md §3-S1）：
 *  - 新浪 hq.sinajs.cn 是 GBK 编码且必须带 Referer；
 *  - 东财 push2 随机断连是常态，retries 至少给 2；
 *  - 腾讯 qt.gtimg.cn 响应同样需要按 GBK 解码。
 */

export interface HttpOptions {
  timeoutMs?: number;
  /** 失败重试次数（不含首次），默认 2 */
  retries?: number;
  headers?: Record<string, string>;
  /** 响应按 GBK 解码（新浪/腾讯行情接口） */
  gbk?: boolean;
}

const DEFAULT_TIMEOUT = 8000;

export async function httpGetBytes(url: string, opts: HttpOptions = {}): Promise<Uint8Array> {
  const retries = opts.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'StockLite/1.0', ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(200 * 2 ** attempt); // 200ms, 400ms, 800ms...
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`请求失败: ${url}`);
}

export async function httpGetText(url: string, opts: HttpOptions = {}): Promise<string> {
  const bytes = await httpGetBytes(url, opts);
  return decodeBytes(bytes, !!opts.gbk);
}

export async function httpGetJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  return JSON.parse(await httpGetText(url, opts)) as T;
}

export function decodeBytes(bytes: Uint8Array, gbk: boolean): string {
  if (!gbk) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    // 个别 Node 构建无 gbk ICU 数据，降级 utf-8 并保留原始错误线索
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
