/**
 * 批量导入的词法解析（移植自 JetBrains 版 util/StockTextParser.kt，规则保持一致）：
 * 把一大段粘贴文本拆成「代码 / 名称 / 代码+名称」候选条目，不发网络请求；
 * 代码/名称是否真实存在由 resolveImportCandidates 用行情/搜索接口校验。
 *
 * 解析规则：
 * - 先按行切分，行内再按 ，、; ；/ | 等分隔符切成段；空格不作为段分隔符，
 *   以便「贵州茅台 600519」这类"名称+代码"留在同一段内配对。
 * - 段内按 后缀式(.SH) → 带前缀 → 裸6位 → 裸5位 → 全大写美股 ticker 的顺序提取代码，
 *   已提取部分从工作文本移除避免重复匹配；再取连续中文片段作为名称候选。
 * - 代码与名称按出现顺序配对；多出的各自独立成条。
 * - 相同代码或相同名称只保留第一次出现。
 */

export interface ParsedStockToken {
  /** 原始段文本，用于导入预览展示 */
  raw: string;
  /** 补全前缀后的完整代码 */
  code?: string;
  name?: string;
}

/** 单次导入条目上限，防止误粘贴超大文本导致海量网络校验 */
export const MAX_ENTRIES = 300;

const RE_SUFFIX = /(?<![\d.])(\d{5,6})\.(sh|sz|bj|hk)\b/gi;
const RE_PREFIXED = /\b(sh|sz|bj|hk)\s?(\d{4,6})\b/gi;
const RE_BARE6 = /(?<![\d.])(\d{6})(?![\d.])/g;
const RE_BARE5 = /(?<![\d.])(\d{5})(?![\d.])/g;
const RE_US = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?)(?![A-Za-z0-9])/g;
const RE_CJK = /[一-龥]{2,}/g;
/** 行内段分隔符（不含空格） */
const SEGMENT_SPLIT = /[，,、;；/|]+/;

/** RegExp 带 g 标志时 exec 有状态，每次调用重新构造以保证可重入 */
function re(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

interface CodeHit {
  index: number;
  len: number;
  code: string;
}

function collect(pattern: RegExp, work: string, resolve: (m: RegExpExecArray) => string | undefined): CodeHit[] {
  const rx = re(pattern);
  const hits: CodeHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(work)) !== null) {
    const code = resolve(m);
    if (code) hits.push({ index: m.index, len: m[0].length, code });
  }
  return hits;
}

function normalizeCode(prefix: string | null, digits: string): string | undefined {
  if (prefix === 'hk') return digits.length >= 4 && digits.length <= 6 ? `hk${digits.slice(-5).padStart(5, '0')}` : undefined;
  if (prefix === 'sh' || prefix === 'sz' || prefix === 'bj') return digits.length === 6 ? `${prefix}${digits}` : undefined;
  if (digits.length === 6) {
    if (digits[0] === '6' || digits[0] === '5') return `sh${digits}`;
    if (['43', '83', '87', '88', '92'].includes(digits.slice(0, 2))) return `bj${digits}`;
    return `sz${digits}`;
  }
  if (digits.length === 5) return `hk${digits}`;
  return undefined;
}

function removeRanges(text: string, hits: CodeHit[]): string {
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    out += text.slice(cursor, hit.index);
    cursor = hit.index + hit.len;
  }
  return out + text.slice(cursor);
}

function parseSegment(segment: string): ParsedStockToken[] {
  const trimmed = segment.trim();
  if (!trimmed) return [];

  const codes: string[] = [];
  let work = trimmed;

  // 后缀式与带前缀都要在提取后从工作文本移除，否则裸代码正则会二次命中同一串数字
  // 注意 RE_SUFFIX 捕获组顺序是 [1]=数字 [2]=前缀，与 RE_PREFIXED 相反
  const suffixHits = collect(RE_SUFFIX, work, (m) => normalizeCode(m[2].toLowerCase(), m[1]));
  suffixHits.forEach((hit) => codes.push(hit.code));
  work = removeRanges(work, suffixHits);

  const prefixedHits = collect(RE_PREFIXED, work, (m) => normalizeCode(m[1].toLowerCase(), m[2]));
  prefixedHits.forEach((hit) => codes.push(hit.code));
  work = removeRanges(work, prefixedHits);

  collect(RE_BARE6, work, (m) => normalizeCode(null, m[1])).forEach((hit) => codes.push(hit.code));
  work = work.replace(re(RE_BARE6), ' ');
  collect(RE_BARE5, work, (m) => normalizeCode(null, m[1])).forEach((hit) => codes.push(hit.code));
  work = work.replace(re(RE_BARE5), ' ');
  collect(RE_US, work, (m) => m[1]).forEach((hit) => codes.push(hit.code));

  const names = trimmed.match(re(RE_CJK)) ?? [];

  const tokens: ParsedStockToken[] = [];
  const pairCount = Math.min(codes.length, names.length);
  for (let i = 0; i < pairCount; i++) tokens.push({ raw: trimmed, code: codes[i], name: names[i] });
  for (let i = pairCount; i < codes.length; i++) tokens.push({ raw: trimmed, code: codes[i] });
  if (codes.length === 0) names.forEach((name) => tokens.push({ raw: trimmed, name }));
  return tokens;
}

export function parseStockText(text: string): ParsedStockToken[] {
  const result = new Map<string, ParsedStockToken>();
  for (const line of text.split(/\r?\n/)) {
    for (const seg of line.split(SEGMENT_SPLIT)) {
      for (const token of parseSegment(seg)) {
        if (result.size >= MAX_ENTRIES) return [...result.values()];
        const key = token.code ?? `name:${token.name ?? ''}`;
        if (!result.has(key)) result.set(key, token);
      }
    }
  }
  return [...result.values()];
}
