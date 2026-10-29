/**
 * 通用行情表框架的视图模型与消息协议（S2 产出，S6 各 tab 复用）。
 * 设计原则：webview 是纯渲染器——排序、格式化、分组切换全部在扩展宿主侧完成，
 * webview 只上报交互事件，保证全部业务逻辑可被 node 自测覆盖。
 */
import type { ColumnDef } from '../../../shared/types';

/** 单元格着色方向：1 涨 / -1 跌 / 0 不变（缺省不着色） */
export type CellDir = -1 | 0 | 1;

export interface CellVM {
  text: string;
  dir?: CellDir;
  /** 次要说明文字（如竞价标注），渲染为同行小字 */
  sub?: string;
}

export interface RowVM {
  /** 行唯一键（一般是代码） */
  key: string;
  /** 与 columns 一一对应 */
  cells: CellVM[];
  /** 右键菜单/双击需要的名称 */
  name: string;
}

export interface GroupVM {
  id: string;
  name: string;
}

export interface SortVM {
  key: string;
  dir: 'asc' | 'desc';
}

export interface TableSnapshot {
  columns: ColumnDef[];
  rows: RowVM[];
  /** 分组 tab 条；空数组则不渲染 */
  groups: GroupVM[];
  activeGroupId: string;
  sort: SortVM | null;
  colorUpIsRed: boolean;
  /** 底部状态行（更新时间、数据源提示、错误信息） */
  statusText: string;
  emptyMessage: string;
}

export type RowAction = 'openChart' | 'setAlert' | 'trades' | 'delete';

export type ToolbarCommand = 'add' | 'refresh' | 'batchImport' | 'manageGroups';

/** 宿主 → webview */
export interface SnapshotMessage {
  type: 'snapshot';
  model: TableSnapshot;
}

/** webview → 宿主 */
export type WebviewRequest =
  | { type: 'ready' }
  | { type: 'toolbar'; name: ToolbarCommand }
  | { type: 'selectGroup'; groupId: string }
  | { type: 'sort'; key: string }
  | { type: 'reorder'; codes: string[] }
  | { type: 'rowOpen'; code: string; name: string }
  | { type: 'rowAction'; action: RowAction; code: string; name: string };
