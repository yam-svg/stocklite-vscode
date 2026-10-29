/**
 * 状态栏格式化纯函数 —— S4 独占本目录（与 alerts 保持目录自包含，互不 import）。
 * 不依赖 vscode，供 index.ts 与 scripts/alerts-statusbar.selftest.ts 共用。
 */
import type { Quote } from '../../shared/types';

export type Trend = 'up' | 'down' | 'flat';

export function pctOf(q: Quote): number {
  return q.changePct ?? (q.prevClose > 0 ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0);
}

export function trendOf(q: Quote): Trend {
  const p = pctOf(q);
  return p > 0.005 ? 'up' : p < -0.005 ? 'down' : 'flat';
}

export function formatPrice(v: number): string {
  return v >= 1000 ? v.toFixed(1) : v.toFixed(2);
}

export function formatPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** 单只标的的状态栏文本：`↑ 名称 价格 +x.xx%` 形式（codicon 箭头按涨跌） */
export function statusText(q: Quote): string {
  const icon = trendOf(q) === 'up' ? '$(arrow-small-up)' : trendOf(q) === 'down' ? '$(arrow-small-down)' : '$(dash)';
  return `${icon} ${q.name} ${formatPrice(q.price)} ${formatPct(pctOf(q))}`;
}

/** hover 明细（Markdown tooltip） */
export function tooltipLines(q: Quote): string[] {
  const lines = [
    `${q.name}（${q.code}）`,
    `现价 ${formatPrice(q.price)}  涨跌 ${q.change !== undefined ? (q.change >= 0 ? '+' : '') + q.change.toFixed(2) : ''} ${formatPct(pctOf(q))}`,
  ];
  if (q.amount !== undefined && q.amount > 0) lines.push(`成交额 ${(q.amount / 1e8).toFixed(2)} 亿`);
  if (q.time) lines.push(`行情时间 ${q.time}`);
  return lines;
}
