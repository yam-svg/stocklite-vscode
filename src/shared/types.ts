/**
 * 全局类型契约（S0 产出，已冻结）。
 * 后续会话不得修改本文件；不够用时在 docs/contract-changes.md 追加需求，由 S7 统一落实。
 */

export type Period = 'day' | 'week' | 'month';

export interface Quote {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  /** 涨跌额，缺省时由 price - prevClose 推算 */
  change?: number;
  /** 涨跌幅（百分数，如 1.23 表示 +1.23%），缺省时由涨跌额/前收推算 */
  changePct?: number;
  /** 行情时间，ISO 或 'HH:mm' */
  time?: string;
  volume?: number;
  /** 成交额（元） */
  amount?: number;
  /** 品种特有字段：封单手数、盘口、竞价标注等 */
  extra?: Record<string, string | number | undefined>;
}

export interface KlineBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume?: number;
}

export interface MinutePoint {
  /** 'HH:mm' */
  time: string;
  price: number;
  /** 均价线 */
  avgPrice?: number;
  volume?: number;
}

export interface SearchResultItem {
  code: string;
  name: string;
  /** 市场前缀或品种标识（stock/fund/future/...） */
  market?: string;
}

export interface QuoteProvider {
  id: string;
  /** 必须支持批量；返回顺序与入参一致，失败的条目可缺项 */
  fetchQuotes(codes: string[]): Promise<Quote[]>;
  fetchKline(code: string, period: Period, count: number): Promise<KlineBar[]>;
  fetchMinute?(code: string): Promise<MinutePoint[]>;
  search?(keyword: string): Promise<SearchResultItem[]>;
}

export type ColumnKind = 'text' | 'price' | 'percent' | 'amount' | 'number';

export interface ColumnDef {
  key: string;
  title: string;
  kind: ColumnKind;
  width?: number;
  align?: 'left' | 'right';
  sortable?: boolean;
  /** 列内容取自 quote.extra[key] 时的单位换算等提示，由渲染层解释 */
  renderHint?: string;
}

export interface TabDescriptor {
  id: string;
  title: string;
  providerId: string;
  columns: ColumnDef[];
  /** package.json 已预注册的“添加”命令 id */
  addCommand: string;
  optional?: boolean;
}

export type TradeSide = 'buy' | 'sell';

export interface TradeRecord {
  id: string;
  code: string;
  name: string;
  side: TradeSide;
  price: number;
  quantity: number;
  /** 'YYYY-MM-DD'；无时刻信息——日内分时定位按成交价反查（容差 max(1分, 0.1%)） */
  date: string;
  note?: string;
}

/** 持仓：按成交记录推导，或用户手填成本/数量覆盖 */
export interface Position {
  code: string;
  name: string;
  cost: number;
  quantity: number;
}

export type AlertType = 'priceAbove' | 'priceBelow' | 'changeAbove' | 'changeBelow';

export interface StockAlert {
  id: string;
  code: string;
  name: string;
  type: AlertType;
  /** 价格（元）或涨跌幅（百分数），由 type 决定 */
  threshold: number;
  enabled: boolean;
  /** 上次触发时间戳，提醒引擎用于去抖 */
  lastFiredAt?: number;
}

export interface StockGroup {
  id: string;
  name: string;
  codes: string[];
}
