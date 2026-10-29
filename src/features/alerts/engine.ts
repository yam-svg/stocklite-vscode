/**
 * 提醒引擎纯逻辑 —— S4 独占本目录。
 * 不依赖 vscode，可被 scripts/alerts-statusbar.selftest.ts 用 node 直跑验证。
 *
 * 移植对照（Kotlin 原版，规则常量逐一对齐）：
 *  - RuleEvaluator        ← AlertManager.checkAlerts（ABOVE/BELOW + 触发后重置语义）
 *  - SealShrinkDetector   ← AlertManager.checkSealShrink（60s 滑窗/断崖特判/竞价排除/当日去重）
 *  - breadthPollDelayMs   ← BreadthWatcherService.nextIntervalMs（尾盘/收盘后分档轮询）
 *  - BreadthJumpDetector  ← VSCode 版新增的"大盘宽度异动"提醒（原版 breadth 仅刷快照、无告警）
 */
import type { AlertType, Quote, StockAlert } from '../../shared/types';

/** 扩展提醒类型：sealShrink/breadthJump 为全局系统规则，与到价提醒同存 StateKeys.alerts。
 * 契约的 StockAlert.type 只有 4 个到价类型，这里 Omit 后放宽（正式方案见 docs/contract-changes.md）。 */
export type ExtendedAlertType = AlertType | 'sealShrink' | 'breadthJump';
export interface ExtendedStockAlert extends Omit<StockAlert, 'type'> {
  type: ExtendedAlertType;
}

export const SYSTEM_RULE_IDS = { sealShrink: 'sys:sealShrink', breadthJump: 'sys:breadthJump' } as const;

// ── 中国时区（无夏令时，固定 UTC+8，不依赖 ICU 数据）──────────────────
const CN_OFFSET_MS = 8 * 3600_000;

export interface CnParts {
  /** 'YYYY-MM-DD'（北京时间） */
  date: string;
  /** 当日分钟数 0..1439（北京时间） */
  minutes: number;
  /** 星期，getUTCDay 语义：0=周日 6=周六 */
  day: number;
}

export function cnParts(ts: number): CnParts {
  const d = new Date(ts + CN_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    day: d.getUTCDay(),
  };
}

export function cnDate(ts: number): string {
  return cnParts(ts).date;
}

/** A 股连续竞价时段 9:30–11:30、13:00–14:57（含开盘边界；收盘竞价 14:57 起剔除） */
export function isContinuousSession(ts: number): boolean {
  const m = cnParts(ts).minutes;
  return (m >= 570 && m < 690) || (m >= 780 && m < 897);
}

// ── 到价/涨跌幅提醒 ─────────────────────────────────────────────────
// 触发语义：条件由假变真的边沿触发一次；复位需价格回落越过滞回带
// （对应 Kotlin triggered=true 等待调用方"价格回退后重置"的语义），
// 滞回带避免阈值临界抖动反复弹通知。
const PRICE_REARM_RATIO = 0.998; // 价格类：需回到阈值 0.2% 以外
const PCT_REARM_GAP = 0.2;       // 涨跌幅类：需回摆 0.2 个百分点

export class RuleEvaluator {
  private readonly armed = new Map<string, boolean>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 单轮评估。返回 true 表示本轮首次触发（调用方负责通知与 lastFiredAt 落盘）。 */
  evaluate(alert: ExtendedStockAlert, quote: Quote): boolean {
    if (!alert.enabled || !isThresholdAlert(alert.type)) {
      this.armed.delete(alert.id);
      return false;
    }
    const pct = quote.changePct
      ?? (quote.prevClose > 0 ? ((quote.price - quote.prevClose) / quote.prevClose) * 100 : Number.NaN);
    const value = alert.type === 'changeAbove' || alert.type === 'changeBelow' ? pct : quote.price;
    if (!Number.isFinite(value)) return false;

    const cond =
      alert.type === 'priceAbove' ? value >= alert.threshold :
      alert.type === 'priceBelow' ? value <= alert.threshold :
      alert.type === 'changeAbove' ? value >= alert.threshold :
      /* changeBelow */ value <= alert.threshold;

    if (!cond) {
      // 未触发：检查是否已回到滞回带之外完成再武装
      if (!this.armed.has(alert.id) || this.isRearmable(alert, value)) this.armed.set(alert.id, true);
      return false;
    }
    let armed = this.armed.get(alert.id);
    if (armed === undefined) {
      // 窗口重载恢复：条件仍成立且"北京时间当日"已触发过 → 视作未武装，避免重启重复弹
      armed = alert.lastFiredAt === undefined || cnDate(alert.lastFiredAt) !== cnDate(this.now());
    }
    if (!armed) return false;
    this.armed.set(alert.id, false);
    return true;
  }

  private isRearmable(alert: ExtendedStockAlert, value: number): boolean {
    switch (alert.type) {
      case 'priceAbove': return value <= alert.threshold * PRICE_REARM_RATIO;
      case 'priceBelow': return value >= alert.threshold * (2 - PRICE_REARM_RATIO);
      case 'changeAbove': return value <= alert.threshold - PCT_REARM_GAP;
      /* changeBelow */ return value >= alert.threshold + PCT_REARM_GAP;
      default: return true;
    }
  }
}

export function isThresholdAlert(t: ExtendedAlertType): t is AlertType {
  return t === 'priceAbove' || t === 'priceBelow' || t === 'changeAbove' || t === 'changeBelow';
}

export function thresholdLabel(alert: ExtendedStockAlert): string {
  switch (alert.type) {
    case 'priceAbove': return `价格 ≥ ${alert.threshold}`;
    case 'priceBelow': return `价格 ≤ ${alert.threshold}`;
    case 'changeAbove': return `涨幅 ≥ ${alert.threshold}%`;
    case 'changeBelow': return `跌幅 ≤ ${alert.threshold}%`;
    case 'sealShrink': return '涨停封单锐减 / 跌停翘板前兆';
    case 'breadthJump': return '大盘涨跌家数异动';
  }
}

// ── 封单锐减监测（涨停开板 / 跌停翘板前兆）────────────────────────────
// 判定规则与 AlertManager 完全一致：60 秒滑窗、≥4 采样、窗口峰值为基线，
// 当前值较基线累计减少 ≥50% 且下降步数 ≥2；断崖特判（基线 ≥1 万手且单步撤 ≥50%）
// 只需 2 采样；未封板视作"锐减到 0"事件；封→开反向不沿用旧基线；
// 集合竞价时段（9:15–9:25 / 14:57–15:00）是试盘假单，不采样并清空历史；
// 同一股票同一方向每天最多提醒一次。
const SEAL_WINDOW_MS = 60_000;
const SEAL_MIN_SAMPLES = 4;
const SEAL_MIN_BASE_LOTS = 1000;
const SEAL_DROP_RATIO = 0.5;
const SEAL_MIN_DROPS = 2;
const SEAL_CLIFF_BASE_LOTS = 10_000;

export interface SealEvent {
  code: string;
  name: string;
  dir: 'U' | 'D';
  baseLots: number;
  curLots: number;
  pct: number;
  cliff: boolean;
}

interface SealSample { ts: number; lots: number }

export class SealShrinkDetector {
  private readonly history = new Map<string, SealSample[]>();
  private readonly notified = new Set<string>();
  private trackDate = '';

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 每轮行情刷新调用一次。约定 quote.extra.sealLots 为**带符号手数**：
   * 涨停封板为正、跌停封板为负、未封板缺省/0（键名提案见 docs/contract-changes.md）。
   */
  feed(quotes: Quote[]): SealEvent[] {
    const events: SealEvent[] = [];
    const ts = this.now();
    if (!isContinuousSession(ts)) {
      this.history.clear();
      return events;
    }
    const today = cnDate(ts);
    if (today !== this.trackDate) {
      this.history.clear();
      this.notified.clear();
      this.trackDate = today;
    }
    for (const q of quotes) {
      const raw = q.extra?.sealLots;
      const lots = typeof raw === 'number' && raw !== 0 ? raw : undefined;
      if (lots === undefined) {
        // 当前未封板：若刚有封板历史，按"封单归零"评估一次（开板/翘板事件）后清空
        for (const d of ['U', 'D'] as const) {
          const key = q.code + d;
          const dq = this.history.get(key);
          if (dq?.length) {
            const ev = this.evaluate(key, q.name, Math.max(...dq.map((s) => s.lots)), 0, today, SEAL_MIN_DROPS, false);
            if (ev) events.push(ev);
          }
          this.history.delete(key);
        }
        continue;
      }
      const dir: 'U' | 'D' = lots > 0 ? 'U' : 'D';
      const key = q.code + dir;
      // 涨跌方向切换（开板后反向封板）不沿用旧基线
      this.history.delete(q.code + (dir === 'U' ? 'D' : 'U'));
      const dq = this.history.get(key) ?? [];
      dq.push({ ts, lots: Math.abs(lots) });
      while (dq.length > 1 && ts - dq[0].ts > SEAL_WINDOW_MS) dq.shift();
      this.history.set(key, dq);
      if (dq.length < 2) continue;
      let drops = 0;
      let maxStepDrop = 0;
      for (let i = 1; i < dq.length; i++) {
        if (dq[i].lots < dq[i - 1].lots) drops++;
        maxStepDrop = Math.max(maxStepDrop, dq[i - 1].lots - dq[i].lots);
      }
      const base = Math.max(...dq.map((s) => s.lots));
      const cliff = base >= SEAL_CLIFF_BASE_LOTS && maxStepDrop >= base * SEAL_DROP_RATIO;
      if (dq.length >= SEAL_MIN_SAMPLES || cliff) {
        // 断崖抽单跳过趋势确认（drops 视为达标）
        const ev = this.evaluate(key, q.name, base, dq[dq.length - 1].lots, today,
          cliff ? SEAL_MIN_DROPS : drops, cliff);
        if (ev) events.push(ev);
      }
    }
    return events;
  }

  private evaluate(key: string, name: string, base: number, cur: number, today: string,
                   drops: number, cliff: boolean): SealEvent | undefined {
    if (drops < SEAL_MIN_DROPS) return undefined;
    if (base < SEAL_MIN_BASE_LOTS) return undefined;
    if (cur > base * (1 - SEAL_DROP_RATIO)) return undefined;
    const dedupe = `${today}|${key}`;
    if (this.notified.has(dedupe)) return undefined;
    this.notified.add(dedupe);
    return {
      code: key.slice(0, -1),
      name,
      dir: key.endsWith('U') ? 'U' : 'D',
      baseLots: base,
      curLots: cur,
      pct: Math.floor(((base - cur) * 100) / base),
      cliff,
    };
  }
}

// ── 大盘宽度（涨跌家数）───────────────────────────────────────────────
export interface BreadthSample { ts: number; up: number; down: number; flat: number }

/**
 * 轮询间隔（毫秒）；连续竞价期 60s（异动监测），
 * 其余按 BreadthWatcherService 原版策略：14:50–15:10 30s / 15:10–16:30 2min / 16:30–21:00 10min，
 * 周末与 21:00–次日 9:30 每小时醒一次再检查。
 */
export function breadthPollDelayMs(ts: number): number {
  const { minutes, day } = cnParts(ts);
  if (day === 0 || day === 6) return 3_600_000;
  if (isContinuousSession(ts)) return 60_000;
  if (minutes >= 890 && minutes < 910) return 30_000;   // 14:50–15:10
  if (minutes >= 910 && minutes < 990) return 120_000;  // 15:10–16:30
  if (minutes >= 990 && minutes < 1260) return 600_000; // 16:30–21:00
  return 3_600_000;
}

// 异动判定（VSCode 版新增启发式，非 Kotlin 原版规则）：
// 10 分钟内涨跌家数差从"温和区"（|diff| ≤ WEAK）冲入"极端区"（|diff| ≥ STRONG）
// 视为宽度异动；两方向各自每天最多一次，两次异动通知间隔 ≥30 分钟。
const BREADTH_STRONG_DIFF = 800;
const BREADTH_WEAK_DIFF = 400;
const BREADTH_MAX_GAP_MS = 10 * 60_000;
const BREADTH_COOLDOWN_MS = 30 * 60_000;

export interface BreadthJumpEvent {
  dir: 'up' | 'down';
  fromDiff: number;
  toDiff: number;
  sample: BreadthSample;
}

export class BreadthJumpDetector {
  private prev: BreadthSample | undefined;
  private readonly notified = new Set<string>();
  private lastFired = 0;

  constructor(private readonly now: () => number = Date.now) {}

  feed(sample: BreadthSample): BreadthJumpEvent | undefined {
    const ts = this.now();
    const today = cnDate(ts);
    const diff = sample.up - sample.down;
    let event: BreadthJumpEvent | undefined;
    if (
      this.prev && ts - this.prev.ts <= BREADTH_MAX_GAP_MS && ts - this.lastFired >= BREADTH_COOLDOWN_MS
    ) {
      const prevDiff = this.prev.up - this.prev.down;
      if (diff >= BREADTH_STRONG_DIFF && prevDiff <= BREADTH_WEAK_DIFF && !this.notified.has(`${today}|up`)) {
        event = { dir: 'up', fromDiff: prevDiff, toDiff: diff, sample };
      } else if (diff <= -BREADTH_STRONG_DIFF && prevDiff >= -BREADTH_WEAK_DIFF && !this.notified.has(`${today}|down`)) {
        event = { dir: 'down', fromDiff: prevDiff, toDiff: diff, sample };
      }
      if (event) {
        this.notified.add(`${today}|${event.dir}`);
        this.lastFired = ts;
      }
    }
    this.prev = sample;
    return event;
  }
}

// ── 涨跌家数拉取（东财 push2，S1 若已移植可在 S7 去重）────────────────
// 沪(sh 1.000001) + 深(sz 0.399106) + 北证 50(0.899050) 三市求和；
// 北证缺失不少约 200~300 家（Kotlin 注释原话），取不到不影响沪深。
const EM_UT = 'bd1d9ddb04089700cf9c27f6f7426281';

interface EmUpDownResponse {
  data?: { f113?: number; f114?: number; f115?: number };
}

export async function fetchMarketBreadth(
  httpJson: <T>(url: string) => Promise<T>,
  now: () => number = Date.now,
): Promise<BreadthSample | undefined> {
  const fetchOne = async (secid: string): Promise<[number, number, number] | undefined> => {
    try {
      const r = await httpJson<EmUpDownResponse>(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&ut=${EM_UT}&fields=f113,f114,f115`,
      );
      const { f113, f114, f115 } = r.data ?? {};
      return typeof f113 === 'number' && typeof f114 === 'number' ? [f113, f114, f115 ?? 0] : undefined;
    } catch {
      return undefined;
    }
  };
  const sh = await fetchOne('1.000001');
  const sz = await fetchOne('0.399106');
  if (!sh || !sz) return undefined;
  const bj = (await fetchOne('0.899050')) ?? [0, 0, 0];
  return { ts: now(), up: sh[0] + sz[0] + bj[0], down: sh[1] + sz[1] + bj[1], flat: sh[2] + sz[2] + bj[2] };
}
