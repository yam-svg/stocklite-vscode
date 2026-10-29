/**
 * 单元格取值与格式化（纯函数，可 node 直跑自测）。
 * 数值列的原始值从 Quote 字段或 quote.extra[key] 读取，列定义只声明 kind。
 */
import type { Quote, ColumnDef, ColumnKind } from '../../../shared/types';
import type { CellVM, CellDir } from './types';

/** 涨跌幅优先取 provider 给的值，缺省按 (price-prevClose)/prevClose 推算 */
export function changePctOf(q: Quote): number {
  if (typeof q.changePct === 'number' && Number.isFinite(q.changePct)) return q.changePct;
  const diff = typeof q.change === 'number' ? q.change : q.price - q.prevClose;
  return q.prevClose ? (diff / q.prevClose) * 100 : 0;
}

export function changeOf(q: Quote): number {
  if (typeof q.change === 'number' && Number.isFinite(q.change)) return q.change;
  return q.price - q.prevClose;
}

export function dirOf(value: number): CellDir {
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 1 : -1;
}

/** 小数位数：价格按量级给 2~4 位（加密货币单价小数位多） */
function priceDigits(v: number): number {
  const abs = Math.abs(v);
  if (abs >= 1000) return 2;
  if (abs >= 1) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

export function formatNumber(v: number, digits: number): string {
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 成交额/市值等大额：万 / 亿 单位缩写 */
export function formatCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return formatNumber(v, abs >= 100 ? 0 : 2);
}

/** 列的原始排序值：无法转数字时返回 NaN，由排序层降级为字符串比较 */
export function rawValueOf(col: ColumnDef, q: Quote): number | string {
  if (col.key === 'name') return q.name;
  if (col.key === 'code') return q.code;
  const fromExtra = q.extra?.[col.key];
  const source = fromExtra !== undefined ? fromExtra : rawField(col.key, q);
  if (typeof source === 'number') return source;
  if (typeof source === 'string') {
    const num = Number(source);
    return Number.isFinite(num) ? num : source;
  }
  return '';
}

function rawField(key: string, q: Quote): number | string | undefined {
  switch (key) {
    case 'price': return q.price;
    case 'prevClose': return q.prevClose;
    case 'change': return changeOf(q);
    case 'changePct': return changePctOf(q);
    case 'volume': return q.volume;
    case 'amount': return q.amount;
    case 'time': return q.time ?? '';
    default: return undefined;
  }
}

export function formatCell(value: number | string, kind: ColumnKind): string {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '--';
  switch (kind) {
    case 'price': return formatNumber(value, priceDigits(value));
    case 'percent': return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
    case 'amount': return formatCompact(value);
    case 'number': return formatCompact(value);
    case 'text':
    default: return String(value);
  }
}

/** 单元格着色规则：涨跌额/涨跌幅/金额类跟随自身正负，价格跟随当日涨跌 */
export function cellOf(col: ColumnDef, q: Quote): CellVM {
  const raw = rawValueOf(col, q);
  const text = typeof raw === 'number' ? formatCell(raw, col.kind) : raw;
  const colorable = col.kind === 'percent' || col.kind === 'price' || col.kind === 'amount' || col.kind === 'number';
  if (!colorable || typeof raw !== 'number') return { text };
  if (col.kind === 'price') return { text, dir: dirOf(changePctOf(q)) };
  return { text, dir: dirOf(raw) };
}
