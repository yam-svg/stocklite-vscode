/**
 * 股票 tab 专用单元格映射（集合竞价标注 + 封单手数），纯函数、node 可直测。
 * 语义逐条对照 JetBrains 1.18.0 StockPanel.kt / L10n.kt：
 *  - 竞价：数据层（data/stocks.ts）仅在 9:15–9:25 打 extra.isAuction=1，9:25 定格后
 *    价格即开盘价、按正常行情展示不再带标记（标注时机与 Kotlin 一致）。Kotlin 把
 *    "竞价"渲染为涨跌幅列同行灰色小字；VSCode 版按移植任务书落在价格单元格 sub 小字，
 *    呈现位置不同、语义与时机相同。
 *  - 封单：extra.sealLots 带符号手数（正=涨停买一封单，负=跌停卖一封单），仅涨跌停
 *    价位附近有值。Kotlin 同为涨跌幅同行小字且受 enableSealLots（默认开）控制；
 *    VSCode 版改为独立"封单手数"列（见 stockTab STOCK_COLUMNS），列内文案与数值缩写
 *    格式逐字对齐 L10n.sealText/lotsText（封2.3万手 / 封1.23亿手 / 封850手）。
 *    enableSealLots 开关在 S5 设置页冻结期内无法接入，行为=Kotlin 默认值（常开），
 *    已按 G1 在 docs/contract-changes.md 备案申请设置键。
 */
import type { ColumnDef, Quote } from '../../shared/types';
import { cellOf } from './table/format';
import type { CellVM } from './table/types';

/** 集合竞价小字文案（Kotlin L10n.lblAuction 中文项） */
export const AUCTION_SUB = '竞价';

/**
 * 竞价标注：extra.isAuction 为 1/'1' 时返回同行小字文案，否则 undefined。
 * 时机判据（9:25 定格后不带）由数据层负责，这里只做呈现映射，勿在此重复时间判断。
 */
export function auctionSubOf(q: Quote): string | undefined {
  return Number(q.extra?.isAuction) > 0 ? AUCTION_SUB : undefined;
}

/** 价格单元格 = 常规价格渲染 + 竞价小字（现价 12.34 竞价 / 无竞价时与原 cellOf 全等） */
export function priceCellOf(col: ColumnDef, q: Quote): CellVM {
  const cell = cellOf(col, q);
  const sub = auctionSubOf(q);
  return sub ? { ...cell, sub } : cell;
}

/** 手数数值缩写（对照 L10n.lotsText 中文项，取绝对值）：1.23亿 / 2.3万 / 850 */
export function lotsText(lots: number): string {
  const a = Math.abs(Math.round(lots));
  if (a >= 1_0000_0000) return `${(a / 1e8).toFixed(2)}亿`;
  if (a >= 1_0000) return `${(a / 1e4).toFixed(1)}万`;
  return String(a);
}

/** 封单文案（对照 L10n.sealText 中文项）：封2.3万手（正负仅表方向，文案不含符号） */
export function sealText(lots: number): string {
  return `封${lotsText(lots)}手`;
}

/**
 * 封单手数列单元格：有封单（非零有限值）时显示"封X手"并按方向着色
 * （涨停正→红/涨色，跌停负→绿/跌色，与价格列随涨跌着色一致）；其余一律 '--'。
 */
export function sealCellOf(q: Quote): CellVM {
  const lots = Number(q.extra?.sealLots);
  if (!Number.isFinite(lots) || lots === 0) return { text: '--' };
  return { text: sealText(lots), dir: lots > 0 ? 1 : -1 };
}
