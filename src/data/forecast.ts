/**
 * AI 研判移植（G2）：ForecastService.kt 的 TS 版——"两张卡两时点两目标"。
 *
 * 1) 盘后"市场天气"（SentimentSnapshot）：只用收盘后定型数据描述情绪温度
 *    （涨跌家数/涨停生态/量能环比），描述性指标、不参与结算与胜率统计。
 * 2) 盘前研判（PreOpenForecast）：交易日 8:40–9:25 生成两段——
 *    初版（8:40 起）= 隔夜外盘（A50、纳指隔夜、USDCNH）+ T-1 全部定型数据；
 *    终版（9:15 起）并入韩日早盘截面（两国已交易 75 分钟，r≈0.75）。
 *    核心输出"隐含跳空%"；全天分只做低置信倾向展示。
 * 3) 结算双账本：开盘跳空三态命中率 + 全天方向命中率分开统计；
 *    错过的日期 settled 但不回填数值、不进统计，杜绝事后诸葛式虚高胜率。
 *
 * 逐常量对照 JetBrains `service/ForecastService.kt`（434 行版）。本文件不 import 'vscode'，
 * 网络取数全部经数据层现有模块（breadth/futures/globalIndex/marketTime），自测经 deps 注入假源。
 */
import { httpGetWithStatus, numOf } from './util';
import { httpGetText } from '../shared/http';
import {
  getMarketBreadth, getLimitEcosystem, getAshareLastBarDate, getUsdcnhPct, getTencentIndexSnapshot,
} from './breadth';
import { getFutureQuotes } from './futures';
import { parseSinaGlobal } from './globalIndex';
import { CN_TZ, zonedTime, dayOfTz, isTodayTradingDay } from './marketTime';

// ── 跳空回归标定（2023-01 ~ 2026-10，n≈930-956，对次日沪深300开盘跳空的一元最小二乘）──
// 缺失一侧时直接用另一侧的一元回归系数（两者均为一元标定值，无需再重归一）
export const A50_SLOPE = 0.171;
export const NDX_SLOPE = 0.177;
export const GAP_INTERCEPT = 0.025;
export const GAP_CLAMP = 1.5;          // 隐含跳空输出限幅 ±1.5%

// ── 韩日早盘因子（2026-08~10，n≈50：两国"早场截面均值"→当日跳空 r≈0.75；
//    两国互相关 r≈0.89 高度共线取均值；标定截面≈北京 9:10，终版生成时点 9:15 与之几乎一致）──
export const ASIA_SLOPE = 0.184;       // 均值因子→跳空回归系数
export const ASIA_SCORE_FULL = 2.0;    // 早盘均值 ±2% 打分打满 ±25

export const GAP_FLAT_BAND = 0.15;     // 跳空三态阈值：|gap|<0.15% 算平开
export const DIRECTION_BAND = 20.0;    // 全天方向阈值 ±20 分，其间为震荡
export const DAY_FLAT_BAND = 0.1;      // 全天实际涨跌 ±0.1% 内算平盘

export const SETTLE_INDEX = 'sh000300';   // 结算标的：沪深300（腾讯符号）
export const MAX_RECORDS = 130;           // 约半年样本

// 上海钟点（分钟）——watcher 窗口与 Kotlin ForecastWatcherService 对齐
const T_0840 = 8 * 60 + 40;
const T_0915 = 9 * 60 + 15;
const T_0925 = 9 * 60 + 25;
const T_1500 = 15 * 60;
const T_1510 = 15 * 60 + 10;
const T_1600 = 16 * 60;
const T_2100 = 21 * 60;

// ── 数据结构（与 StockliteState/Models.kt 字段对齐，JSON 键一致便于迁移导入）──────

export interface ForecastFactor {
  name: string;
  detail: string;
  /** NaN=只做展示不计入得分（如"韩日早盘：数据缺失"）；序列化落 null */
  score: number;
}

export interface SentimentSnapshot {
  date: string;
  score: number;
  factors: ForecastFactor[];
}

/** 结算记录（ForecastRecordData 的 TS 版）；JSON 中 NaN 落 null，load 侧还原回 NaN */
export interface ForecastRecord {
  date: string;
  score: number;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL' | '';
  generatedAt: string;
  actualPct: number;
  settled: boolean;
  correct: boolean;
  kind: 'PRE' | '';
  gapPct: number;
  openPct: number;
  openHit: boolean;
  factorsJson: string;
  finalized: boolean;
}

export interface PreOpenForecast {
  date: string;
  generatedAt: string;
  gapPct: number;
  score: number;
  factors: ForecastFactor[];
  finalized: boolean;
}

export interface ForecastStats {
  gapSample: number;
  gapHits: number;
  gapHitRate: number;
  dirSample: number;
  dirHits: number;
  dirHitRate: number;
}

/** globalState 存储面（vscode.Memento 的投影，node 自测用 Map 实现） */
export interface ForecastMemento {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): void;
}

/** globalState 键——与 JetBrains StockliteState 字段名对齐，为迁移导入留门 */
export const FORECAST_HISTORY_KEY = 'forecastHistory';
export const SENTIMENT_JSON_KEY = 'sentimentJson';
export const SENTIMENT_DATE_KEY = 'sentimentDate';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** 记录序列化面：NaN → null（globalState 走 JSON，Kotlin org.json 同样禁止 NaN） */
function recordToJsonable(r: ForecastRecord): Record<string, unknown> {
  return {
    ...r,
    actualPct: Number.isFinite(r.actualPct) ? r.actualPct : null,
    gapPct: Number.isFinite(r.gapPct) ? r.gapPct : null,
    openPct: Number.isFinite(r.openPct) ? r.openPct : null,
  };
}

function recordFromJsonable(o: any): ForecastRecord {
  return {
    date: String(o?.date ?? ''),
    score: numOf(String(o?.score ?? '')),
    direction: (o?.direction ?? '') as ForecastRecord['direction'],
    generatedAt: String(o?.generatedAt ?? ''),
    actualPct: num(o?.actualPct),
    settled: o?.settled === true,
    correct: o?.correct === true,
    kind: (o?.kind ?? '') as ForecastRecord['kind'],
    gapPct: num(o?.gapPct),
    openPct: num(o?.openPct),
    openHit: o?.openHit === true,
    factorsJson: String(o?.factorsJson ?? ''),
    finalized: o?.finalized === true,
  };
}

export interface ForecastStore {
  history(): ForecastRecord[];
  /** 全量覆盖写（调用方负责同日去重）；超 MAX_RECORDS 自动裁旧 */
  replaceHistory(records: ForecastRecord[]): void;
  sentiment(): SentimentSnapshot | null;
  saveSentiment(s: SentimentSnapshot): void;
}

export function createForecastStore(m: ForecastMemento): ForecastStore {
  return {
    history: () => {
      const raw = m.get<unknown[]>(FORECAST_HISTORY_KEY, []);
      return Array.isArray(raw) ? raw.map(recordFromJsonable) : [];
    },
    replaceHistory: (records) => {
      m.update(FORECAST_HISTORY_KEY, records.slice(-MAX_RECORDS).map(recordToJsonable));
    },
    sentiment: () => {
      const json = m.get<string>(SENTIMENT_JSON_KEY, '');
      if (!json) return null;
      try {
        const o = JSON.parse(json);
        const factors = Array.isArray(o?.factors)
          ? (o.factors as any[]).map((f: any) => ({ name: String(f?.n ?? ''), detail: String(f?.d ?? ''), score: num(f?.s) }))
          : parseFactorsJson(String(o?.factors ?? ''));   // 兼容存成字符串的旧写法
        const s: SentimentSnapshot = { date: String(o?.date ?? ''), score: num(o?.score), factors };
        return s.date ? s : null;
      } catch {
        return null;
      }
    },
    saveSentiment: (s) => {
      const o = { date: s.date, score: Number.isFinite(s.score) ? s.score : null, factors: JSON.parse(factorsToJson(s.factors)) };
      m.update(SENTIMENT_JSON_KEY, JSON.stringify(o));
      m.update(SENTIMENT_DATE_KEY, s.date);
    },
  };
}

// ── 因子 JSON（org.json 兼容：NaN 落 null，parse 缺省回 NaN）──────────────────

export function factorsToJson(factors: ForecastFactor[]): string {
  return JSON.stringify(factors.map((f) => ({
    n: f.name,
    d: f.detail,
    s: Number.isFinite(f.score) ? f.score : null,
  })));
}

export function parseFactorsJson(json: string): ForecastFactor[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.map((o: any) => ({ name: String(o?.n ?? ''), detail: String(o?.d ?? ''), score: num(o?.s) }));
  } catch {
    return [];
  }
}

// ── 分档纯函数 ─────────────────────────────────────────────────────────────

/** 情绪五档：≥50 过热 / ≥20 热烈 / >-20 正常 / >-50 冷清 / 其余冰点 */
export function sentimentTier(score: number): 'overheated' | 'hot' | 'normal' | 'cold' | 'freezing' {
  if (score >= 50) return 'overheated';
  if (score >= 20) return 'hot';
  if (score > -20) return 'normal';
  if (score > -50) return 'cold';
  return 'freezing';
}

/** 跳空三态；NaN 原样返回 'NAN' */
export function gapState(gapPct: number): 'HIGH' | 'FLAT' | 'LOW' | 'NAN' {
  if (!Number.isFinite(gapPct)) return 'NAN';
  if (gapPct >= GAP_FLAT_BAND) return 'HIGH';
  if (gapPct <= -GAP_FLAT_BAND) return 'LOW';
  return 'FLAT';
}

/** 全天方向：±20 分以内震荡 */
export function directionOf(score: number): 'BULL' | 'BEAR' | 'NEUTRAL' {
  if (score >= DIRECTION_BAND) return 'BULL';
  if (score <= -DIRECTION_BAND) return 'BEAR';
  return 'NEUTRAL';
}

function clampUnit(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

// ── 数据依赖注入面（自测用假源覆盖休市/缺失分支）─────────────────────────────

export interface ForecastDeps {
  breadth: (now: number) => Promise<{ upCount?: number; downCount?: number; totalTurnover?: number; prevTurnoverSameTime?: number }>;
  limitEco: (now: number) => Promise<{ ztCount: number; dtCount: number; zbCount: number; maxLianban: number } | null>;
  ashareLastBarDate: () => Promise<string | null>;
  a50ChangePct: () => Promise<number | null>;
  usdcnhPct: () => Promise<number | null>;
  ndxOvernightPct: () => Promise<number | null>;
  asiaMorningAvgPct: (now: number) => Promise<number | null>;
  settleSnapshot: () => Promise<[number, number, number] | null>;
  isTodayTradingDay: (now: number) => Promise<boolean>;
}

/** 真实数据源装配：全部复用 S1 数据层，无新建网络代码 */
export function makeRealDeps(): ForecastDeps {
  return {
    breadth: (now) => getMarketBreadth(now),
    limitEco: (now) => getLimitEcosystem(now),
    ashareLastBarDate: () => getAshareLastBarDate(),
    a50ChangePct: async () => {
      const q = await getFutureQuotes(['hf_CHA50CFD']);
      const pct = q.get('hf_CHA50CFD')?.changePct;
      return pct !== undefined && Number.isFinite(pct) ? pct : null;
    },
    usdcnhPct: () => getUsdcnhPct(),
    ndxOvernightPct: () => ndxOvernightPct(),
    asiaMorningAvgPct: (now) => asiaMorningAvgPct(now),
    settleSnapshot: () => getTencentIndexSnapshot(SETTLE_INDEX),
    isTodayTradingDay: (now) => isTodayTradingDay('CN', CN_TZ, now),
  };
}

/**
 * 纳指100最近一个美股交易日涨跌%（新浪 gb_$ndx f[2]，同 Kotlin getNdxOvernightPct）。
 * 盘前取到即隔夜收盘涨跌。美股收盘=北京凌晨，纽约"今天"的 gb_ 报价即该收盘值。
 */
export async function ndxOvernightPct(): Promise<number | null> {
  const raw = await httpGetText('https://hq.sinajs.cn/list=gb_%24ndx', {
    gbk: true, headers: { Referer: 'https://finance.sina.com.cn' }, retries: 2,
  }).catch(() => '');
  const v = parseSinaGlobal(raw).get('gb_$ndx');
  return v && Number.isFinite(v.changePct) ? v.changePct : null;
}

/**
 * 韩日当日早盘涨幅均值（KOSPI、日经，取到哪个算哪个；全缺返回 null）。
 * 统一 Yahoo 5 分钟线：最新价 vs meta.chartPreviousClose，且要求最后一根 bar
 * 在当地时区属于"今天"——防止对方休市时把昨日走势当成今日早盘误用（同 Kotlin yahooMorningPct）。
 */
export async function yahooMorningPct(symbol: string, zone: string, now: number = Date.now()): Promise<number | null> {
  try {
    const { status, body } = await httpGetWithStatus(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`,
    );
    if (status !== 200 || !body) return null;
    return parseYahooMorning(body, zone, now);
  } catch {
    return null;
  }
}

/** 解析 Yahoo 5m chart JSON 为早盘涨幅%（含休市旧数据防护）；无有效数据返回 null */
export function parseYahooMorning(body: string, zone: string, now: number): number | null {
  try {
    const result = JSON.parse(body)?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;
    let prev = numOf(String(meta.chartPreviousClose ?? ''));
    if (!Number.isFinite(prev) || prev <= 0) prev = numOf(String(meta.previousClose ?? ''));
    const ts: unknown[] | undefined = result?.timestamp;
    const closes: (number | null)[] | undefined = result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(ts) || !Array.isArray(closes)) return null;
    let lastClose = NaN;
    let lastTs = 0;
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c !== null && c !== undefined && Number.isFinite(c)) { lastClose = c; lastTs = Number(ts[i] ?? 0); break; }
    }
    if (!Number.isFinite(lastClose) || !Number.isFinite(prev) || prev <= 0 || !(lastTs > 0)) return null;
    // 新鲜度校验：最后一根 bar 必须是当地时区的今天（休市/停牌时 Yahoo 会返回旧数据）
    if (dayOfTz(lastTs, zone) !== zonedTime(zone, now).date) return null;
    const pct = ((lastClose - prev) / prev) * 100;
    return Number.isFinite(pct) ? pct : null;
  } catch {
    return null;
  }
}

export async function asiaMorningAvgPct(now: number = Date.now()): Promise<number | null> {
  const vals = (await Promise.all([
    yahooMorningPct('^KS11', 'Asia/Seoul', now),
    yahooMorningPct('^N225', 'Asia/Tokyo', now),
  ])).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ── 一、盘后"市场天气"情绪分 ─────────────────────────────────────────────────

/**
 * 实时计算市场天气分。各因子独立容错，取不到的因子跳过（得分向 0 收缩=不确定）。
 * 盘前调用时所有输入天然是 T-1 定型数据，同一函数同时服务天气卡与研判的 T-1 因子。
 */
export async function computeSentiment(deps: ForecastDeps, now: number = Date.now()): Promise<SentimentSnapshot | null> {
  const [breadth, eco, date] = await Promise.all([
    deps.breadth(now).catch(() => null),
    deps.limitEco(now).catch(() => null),
    deps.ashareLastBarDate(),
  ]);
  if (!date) return null;
  const factors: ForecastFactor[] = [];

  // 涨跌家数差：±3000 家打满 ±25 分
  const up = breadth?.upCount;
  const down = breadth?.downCount;
  if (up !== undefined && down !== undefined && Number.isFinite(up) && Number.isFinite(down)) {
    const diff = up - down;
    factors.push({ name: '涨跌家数', detail: `上涨 ${up} / 下跌 ${down}`, score: clampUnit(diff / 3000) * 25 });
  }
  // 涨停家数（赚钱效应广度）：150 家打满 +20
  if (eco) factors.push({ name: '涨停家数', detail: `涨停 ${eco.ztCount} 家`, score: (Math.min(eco.ztCount, 150) / 150) * 20 });
  // 跌停家数（亏钱效应）：80 家打满 -20
  if (eco) factors.push({ name: '跌停家数', detail: `跌停 ${eco.dtCount} 家`, score: -(Math.min(eco.dtCount, 80) / 80) * 20 });
  // 连板高度（情绪梯队/周期位置）：7 板打满 +15
  if (eco && eco.maxLianban > 0) factors.push({ name: '连板高度', detail: `最高 ${eco.maxLianban} 连板`, score: (Math.min(eco.maxLianban, 7) / 7) * 15 });
  // 封板率：以 0.7 为中性轴，±10 分（zt+zb=0 视为无触板数据，跳过）
  if (eco && eco.ztCount + eco.zbCount > 0) {
    const r = eco.ztCount / (eco.ztCount + eco.zbCount);
    if (Number.isFinite(r)) factors.push({ name: '封板率', detail: `${(r * 100).toFixed(0)}%`, score: clampUnit((r - 0.7) / 0.3) * 10 });
  }
  // 两市量能环比：放量/缩量 ±15（+50% 打满）
  const turnover = breadth?.totalTurnover;
  const prevTurn = breadth?.prevTurnoverSameTime;
  if (turnover !== undefined && prevTurn !== undefined && turnover > 0 && prevTurn > 0) {
    const ratio = turnover / prevTurn - 1;
    factors.push({
      name: '量能环比',
      detail: `${fmtPct(ratio * 100, 1, true)}，成交 ${(turnover / 1e12).toFixed(2)}万亿`,
      score: clampUnit(ratio / 0.5) * 15,
    });
  }

  if (factors.length === 0) return null;
  const score = clampScore(factors.filter((f) => Number.isFinite(f.score)).reduce((a, f) => a + f.score, 0));
  return { date, score, factors };
}

function clampScore(v: number): number {
  return Math.max(-100, Math.min(100, v));
}

function fmtPct(v: number, digits: number, signed: boolean): string {
  const s = v.toFixed(digits);
  return (signed ? (v >= 0 ? '+' : '') : '') + s + '%';
}

/** 计算并持久化天气快照；数据源全挂时回退持久化快照（同 Kotlin getSentiment） */
export async function getSentiment(deps: ForecastDeps, store: ForecastStore, now: number = Date.now()): Promise<SentimentSnapshot | null> {
  const live = await computeSentiment(deps, now);
  if (live) store.saveSentiment(live);
  return live ?? store.sentiment();
}

// ── 二、盘前研判 ────────────────────────────────────────────────────────────

/** 当前是否处于盘前研判生成窗口（交易日 8:40–9:25） */
export async function inPreOpenWindow(deps: ForecastDeps, now: number = Date.now()): Promise<boolean> {
  const z = zonedTime(CN_TZ, now);
  if (z.dow > 5) return false;
  if (z.minutes < T_0840 || z.minutes > T_0925) return false;
  return deps.isTodayTradingDay(now);
}

/** 隐含跳空%：各侧独立进公式（缺一侧即该项不进），终版并入韩日早盘，输出限幅 ±1.5% */
export function impliedGapPct(a50: number | null, ndx: number | null, asia: number | null, finalized: boolean): number {
  let gap = GAP_INTERCEPT;
  if (a50 !== null) gap += A50_SLOPE * a50;
  if (ndx !== null) gap += NDX_SLOPE * ndx;
  if (finalized && asia !== null) gap += ASIA_SLOPE * asia;
  return Math.max(-GAP_CLAMP, Math.min(GAP_CLAMP, gap));
}

/**
 * 生成当日盘前研判：8:40 后首次调用产出隔夜初版并锁定，9:15 后重新生成并入
 * 韩日早盘因子的终版，终版当日锁定不再更新（避免面板反复刷新导致数字跳变）。
 * 非交易日/主力预测源全缺时返回 null。
 */
export async function generatePreOpenForecast(
  deps: ForecastDeps, store: ForecastStore, now: number = Date.now(),
): Promise<PreOpenForecast | null> {
  const z = zonedTime(CN_TZ, now);
  const today = z.date;
  // 两段式：8:40 起先生成"隔夜初版"；9:15 后重新生成并入韩日早盘因子的"终版"，此后当日锁定
  const finalizeNow = z.minutes >= T_0915;
  const existing = store.history().find((r) => r.kind === 'PRE' && r.date === today);
  if (existing && (existing.finalized || !finalizeNow)) return rehydrate(existing);

  // ── 隔夜信息 + （终版）韩日早盘截面 ──
  const [a50, ndx, cnh, asiaRaw] = await Promise.all([
    deps.a50ChangePct().catch(() => null),
    deps.ndxOvernightPct().catch(() => null),
    deps.usdcnhPct().catch(() => null),
    finalizeNow ? deps.asiaMorningAvgPct(now).catch(() => null) : Promise.resolve(null),
  ]);
  const a50v = a50 !== null && Number.isFinite(a50) ? a50 : null;
  const ndxv = ndx !== null && Number.isFinite(ndx) ? ndx : null;
  const asia = finalizeNow && asiaRaw !== null && Number.isFinite(asiaRaw) ? asiaRaw : null;
  if (a50v === null && ndxv === null && asia === null) return null;   // 主力预测源全缺，宁可不给

  const factors: ForecastFactor[] = [];
  // A50 隔夜：±1.5% 打满 ±35 分
  if (a50v !== null) factors.push({ name: 'A50期货', detail: fmtPct(a50v, 2, false), score: clampUnit(a50v / 1.5) * 35 });
  // 纳指隔夜：±1.5% 打满 ±20 分
  if (ndxv !== null) factors.push({ name: '纳指隔夜', detail: fmtPct(ndxv, 2, false), score: clampUnit(ndxv / 1.5) * 20 });

  let gap = impliedGapPct(a50v, ndxv, asia, finalizeNow);
  if (finalizeNow) {
    // 韩日早盘是终版核心增量，取不到也明示"数据缺失"（gap 退化为隔夜口径）
    if (asia === null) {
      factors.push({ name: '韩日早盘', detail: '数据缺失', score: NaN });
    } else {
      factors.push({ name: '韩日早盘', detail: `早场均值 ${fmtPct(asia, 2, true)}`, score: clampUnit(asia / ASIA_SCORE_FULL) * 25 });
    }
  }

  // ── T-1 定型数据 ──
  // 情绪极值反转：过热（高潮次日退潮）-12 / 冰点（否极泰来）+12
  const t1 = await computeSentiment(deps, now).catch(() => null);
  if (t1) {
    const tier = sentimentTier(t1.score);
    if (tier === 'overheated') factors.push({ name: 'T-1情绪过热', detail: `${t1.score.toFixed(0)} 分`, score: -12 });
    else if (tier === 'freezing') factors.push({ name: 'T-1情绪冰点', detail: `${t1.score.toFixed(0)} 分`, score: 12 });
  }
  // 暴跌反转：T-1 沪深300 ≤ -1.5% 时短线均值回归 +8
  const snap = await deps.settleSnapshot().catch(() => null);
  const t1IdxPct = snap ? ((snap[0] - snap[1]) / snap[1]) * 100 : null;
  if (t1IdxPct !== null && Number.isFinite(t1IdxPct) && t1IdxPct <= -1.5) {
    factors.push({ name: 'T-1大跌', detail: fmtPct(t1IdxPct, 2, false), score: 8 });
  }
  // 汇率极值：贬值 ≥0.3% -6 / 升值 ≥0.3% +4
  if (cnh !== null && Number.isFinite(cnh)) {
    if (cnh >= 0.3) factors.push({ name: '人民币贬值', detail: fmtPct(cnh, 2, false), score: -6 });
    else if (cnh <= -0.3) factors.push({ name: '人民币升值', detail: fmtPct(cnh, 2, false), score: 4 });
  }

  // NaN 分值的因子（如"韩日早盘：数据缺失"）只做展示、不计入得分
  const score = clampScore(factors.filter((f) => Number.isFinite(f.score)).reduce((a, f) => a + f.score, 0));
  const generatedAt = `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
  const forecast: PreOpenForecast = { date: today, generatedAt, gapPct: gap, score, factors, finalized: finalizeNow };

  // ── 落库（同日唯一：终版覆盖隔夜初版；超量裁旧）──
  const factorsJson = factorsToJson(factors);
  const records = store.history().filter((r) => !(r.kind === 'PRE' && r.date === today));
  records.push({
    date: today,
    score,
    direction: directionOf(score),
    generatedAt,
    actualPct: NaN,
    settled: false,
    correct: false,
    kind: 'PRE',
    gapPct: gap,
    openPct: NaN,
    openHit: false,
    factorsJson,
    finalized: finalizeNow,
  });
  store.replaceHistory(records);
  return forecast;
}

/** 最近一条盘前研判（面板 chip 用） */
export function latestRecord(history: ForecastRecord[]): ForecastRecord | null {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].kind === 'PRE') return history[i];
  return null;
}

/** 把持久化记录还原为展示对象（面板在非生成窗口读最近一条时用） */
export function rehydrate(r: ForecastRecord): PreOpenForecast {
  return { date: r.date, generatedAt: r.generatedAt, gapPct: r.gapPct, score: r.score, factors: parseFactorsJson(r.factorsJson), finalized: r.finalized };
}

/**
 * 结算未到终态的记录，跳空与全天方向分两段（同 Kotlin settleForecasts）：
 * 开盘跳空今开出数即结；15:00 前只写 openPct/openHit 保持未结算，15:00 后轮次用收盘价
 * 定 actualPct/correct 并置 settled。错过的历史日期 settled 但不回填数值——宁缺毋假。
 */
export async function settleForecasts(deps: ForecastDeps, store: ForecastStore, now: number = Date.now()): Promise<void> {
  const history = store.history();
  const pending = history.filter((r) => !r.settled);
  if (pending.length === 0) return;
  const barDate = await deps.ashareLastBarDate();
  if (!barDate) return;
  const snap = await deps.settleSnapshot();
  const afterClose = zonedTime(CN_TZ, now).minutes >= T_1500;
  let touched = false;
  for (const r of pending) {
    if (r.date > barDate) continue;   // 研判日期还没到（理论上不会发生，防御）
    if (r.date === barDate && snap) {
      const openPct = snap[2] > 0 ? ((snap[2] - snap[1]) / snap[1]) * 100 : NaN;
      if (!Number.isFinite(openPct)) continue;   // 尚未开盘，等开盘后再结
      r.openPct = openPct;
      touched = true;                  // Kotlin 里 r 是 state 活对象改即持久；此处必须显式标脏，盘前跳空结算才不会丢
      if (Number.isFinite(r.gapPct)) r.openHit = gapState(r.gapPct) === gapState(openPct);
      if (!afterClose) continue;       // 方向用收盘价判定，未到收盘本轮只结跳空
      r.actualPct = ((snap[0] - snap[1]) / snap[1]) * 100;
      const flat = Math.abs(r.actualPct) <= DAY_FLAT_BAND;
      r.correct = r.direction === 'BULL' ? r.actualPct > DAY_FLAT_BAND
        : r.direction === 'BEAR' ? r.actualPct < -DAY_FLAT_BAND
          : flat;
      r.settled = true;
    } else {
      r.settled = true;   // 错过的历史日期：结而不统计（已结出的跳空数值仍进跳空账本）
      touched = true;
    }
  }
  if (touched) store.replaceHistory(history);
}

/**
 * 双账本统计：跳空三态命中率 与 全天方向命中率（仅新版盘前研判的 BULL/BEAR 进方向样本；
 * 旧版盘后预测 kind='' 属另一实验排除在外；方向样本要求已结出收盘涨跌，防"结而不统计"按未命中计）
 */
export function getStats(history: ForecastRecord[]): ForecastStats {
  const settled = history.filter((r) => r.settled);
  const gapRecs = settled.filter((r) => r.kind === 'PRE' && Number.isFinite(r.gapPct) && Number.isFinite(r.openPct));
  const dirRecs = settled.filter((r) => r.kind === 'PRE' && (r.direction === 'BULL' || r.direction === 'BEAR') && Number.isFinite(r.actualPct));
  const gapHits = gapRecs.filter((r) => r.openHit).length;
  const dirHits = dirRecs.filter((r) => r.correct).length;
  return {
    gapSample: gapRecs.length,
    gapHits,
    gapHitRate: gapRecs.length === 0 ? NaN : (gapHits * 100) / gapRecs.length,
    dirSample: dirRecs.length,
    dirHits,
    dirHitRate: dirRecs.length === 0 ? NaN : (dirHits * 100) / dirRecs.length,
  };
}

// ── 三、watcher 调度（ForecastWatcherService.kt 的纯时间部分）──────────────────

/** 轮询间隔（上海时间，工作日）：窗口分钟段 → 毫秒 */
export function nextDelayMs(now: number = Date.now()): number {
  const z = zonedTime(CN_TZ, now);
  if (z.dow === 6 || z.dow === 7) return 60 * 60_000;
  const t = z.minutes;
  if (t >= T_0840 && t <= T_0925) return 60_000;
  if (t > T_0925 && t < T_1510) return 5 * 60_000;
  if (t >= T_1510 && t < T_1600) return 2 * 60_000;
  if (t >= T_1600 && t < T_2100) return 15 * 60_000;
  return 60 * 60_000;
}

/** 冷启动延时：研判窗口内 3 秒后立即干活；收盘窗口 5 秒；其余 25 秒 */
export function coldStartDelayMs(now: number = Date.now()): number {
  const z = zonedTime(CN_TZ, now);
  if (z.dow <= 5 && z.minutes >= T_0840 && z.minutes <= T_0925) return 3_000;
  if (z.dow <= 5 && z.minutes >= T_1500 && z.minutes < T_1600) return 5_000;
  return 25_000;
}

/** 一轮后台轮询：结算 →（窗口内）研判生成 →（盘后/收盘窗口）天气分保鲜。异常由调用方吞掉 */
export async function runWatchTick(deps: ForecastDeps, store: ForecastStore, now: number = Date.now()): Promise<void> {
  await settleForecasts(deps, store, now);
  if (await inPreOpenWindow(deps, now)) await generatePreOpenForecast(deps, store, now);
  const t = zonedTime(CN_TZ, now).minutes;
  // 天气分：盘后/收盘窗口刷新即可，盘中面板自己会带出来
  if (t >= T_1500 || t < T_0840) await getSentiment(deps, store, now);
}
