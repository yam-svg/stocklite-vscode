/**
 * 表头三态排序（升序 → 降序 → 恢复默认序）。
 * 排序在宿主侧完成（webview 只上报点击），保证行为可自测、且导出/复制顺序一致。
 */
import type { RowVM } from './types';
import type { SortVM } from './types';
import type { ColumnDef } from '../../../shared/types';

/** 点击表头的三态转移：同列 asc→desc→取消；异列从 asc 开始 */
export function nextSort(current: SortVM | null, columnKey: string): SortVM | null {
  if (!current || current.key !== columnKey) return { key: columnKey, dir: 'asc' };
  if (current.dir === 'asc') return { key: columnKey, dir: 'desc' };
  return null;
}

/**
 * 从行模型里取该列的原始排序值：用 cells 文本反解（去千分位/%/+/万亿后缀）。
 * 框架不要求宿主额外传数值列，展示即排序依据，所见即所得。
 */
export function sortableValue(row: RowVM, columnIndex: number): number | string {
  const cell = row.cells[columnIndex];
  if (!cell) return '';
  const text = cell.text.trim();
  if (!text || text === '--') return Number.NaN;
  const stripped = text.replace(/[+,%\s]/g, '');
  const compact = /^(-?[\d.]+)(万|亿)$/.exec(stripped);
  if (compact) {
    const num = Number(compact[1]);
    if (Number.isFinite(num)) return compact[2] === '万' ? num * 1e4 : num * 1e8;
  }
  const num = Number(stripped);
  if (Number.isFinite(num) && /^-?[\d.]+$/.test(stripped)) return num;
  return text;
}

export function sortRows(rows: RowVM[], sort: SortVM | null, columns: ColumnDef[]): RowVM[] {
  if (!sort) return rows;
  const index = columns.findIndex((c) => c.key === sort.key);
  if (index < 0) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortableValue(a, index);
    const vb = sortableValue(b, index);
    // NaN（缺数据）恒排最后，不随升降序翻转
    const aNaN = typeof va === 'number' && Number.isNaN(va);
    const bNaN = typeof vb === 'number' && Number.isNaN(vb);
    if (aNaN && bNaN) return 0;
    if (aNaN) return 1;
    if (bNaN) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb), 'zh') * sign;
  });
}
