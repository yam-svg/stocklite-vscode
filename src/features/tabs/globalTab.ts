/**
 * 全球指数 tab（S6）：目录复用 data/globalIndex.ts 的 37 条 GLOBAL_INDEXES，
 * 严禁再造一份目录（settings 侧同规则）。显示过滤读写 S5 的双轨设置键
 * indexes.hidden / indexes.enabledOptional（与设置页弹窗同一份状态）。
 * 添加命令 addGlobalIndex = MultiSelect 勾选要显示的指数；行“删除”= 从显示中隐藏。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import type { ColumnDef, Quote } from '../../shared/types';
import type { RowAction, RowVM } from '../../ui/watchlist/table/types';
import {
  GLOBAL_INDEXES, visibleGlobalIndexes, getGlobalIndexQuotes, globalRowToQuote,
  type GlobalIndexConfig,
} from '../../data/globalIndex';
import {
  makeRealDeps, createForecastStore, settleForecasts, inPreOpenWindow, generatePreOpenForecast,
  latestRecord, rehydrate, getSentiment, gapState, directionOf, sentimentTier, getStats,
  type ForecastDeps, type ForecastStore, type PreOpenForecast, type SentimentSnapshot,
} from '../../data/forecast';
import { CN_TZ, zonedTime } from '../../data/marketTime';
import { SimpleQuoteTab, pickMany, updateStockliteSetting, type HeaderCardVM, type HeaderSegVM, type TableHeaderVM } from './tabkit';

const GLOBAL_COLUMNS: ColumnDef[] = [
  { key: 'name', title: '指数', kind: 'text', width: 108, align: 'left' },
  { key: 'price', title: '现价', kind: 'price', width: 74 },
  { key: 'changePct', title: '涨跌幅', kind: 'percent', width: 64 },
  { key: 'market', title: '市场', kind: 'text', width: 40 },
  { key: 'state', title: '状态', kind: 'text', width: 58 },
];

/** 研判卡 L10n（对照 JetBrains L10n.kt 研判段；VSCode 版先落中文单语） */
const T = {
  forecast: '盘前研判',
  sentiment: '市场天气',
  awaiting: '待生成',
  bullish: '偏多',
  bearish: '偏空',
  neutral: '震荡',
  gapHigh: '高开',
  gapFlat: '平开',
  gapLow: '低开',
  gapHit: '跳空命中',
  verFinal: '终版',
  verFirst: '初版',
  tierName: (tier: string): string =>
    tier === 'freezing' ? '冰点' : tier === 'cold' ? '冷清' : tier === 'hot' ? '热烈' : tier === 'overheated' ? '过热' : '正常',
  gapStateLabel: (state: string): string => (state === 'HIGH' ? '高开' : state === 'LOW' ? '低开' : '平开'),
  gapTitle: (n: number, pct: number, hit: number): string => `近${n}次开盘跳空命中 ${pct}% (${hit}/${n})`,
  dirTitle: (n: number, pct: number, correct: number): string => `近${n}次全天方向命中率 ${pct}% (${correct}/${n})`,
  preOpenPendingTip: '交易日 8:40 生成初版（隔夜 A50/纳指、人民币、昨日情绪极值与暴跌反转），9:15 后生成终版：并入韩国/日本早盘实时涨幅',
  sentimentTipHint: '收盘后市场情绪温度计（描述性指标，五档：冰点/冷清/正常/热烈/过热），不参与预测与胜率统计',
  forecastDisclaimer: '实证：隔夜信息对开盘跳空 r≈0.2，韩日早盘实时涨幅 r≈0.75；全天方向仍为低置信倾向，不构成投资建议',
};

/** 涨跌停外的档位固定色（对照 GlobalPanel.kt updateSentimentUI） */
const tierColor = (tier: string): string =>
  tier === 'overheated' ? '#ff6b6b' : tier === 'hot' ? '#ffa657' : tier === 'cold' ? '#69c0ff' : tier === 'freezing' ? '#4d8dff' : '#888aaa';

/** Kotlin "%+.2f"：始终带正负号 */
const fmtSigned = (v: number, digits: number): string => (v >= 0 ? '+' : '') + v.toFixed(digits);

const MUTED = '#888aaa';

export class GlobalTab extends SimpleQuoteTab {
  private rateLimited = false;
  // 研判卡状态（G2）：deps/store 懒建，header 结果按 60s 节流保鲜
  private forecastDeps?: ForecastDeps;
  private forecastStore?: ForecastStore;
  private forecastStamp = 0;
  private lastForecast?: PreOpenForecast;
  private lastSentiment?: SentimentSnapshot;
  private lastInWindow = false;

  constructor(deps: FeatureDeps) {
    super(deps, {
      viewId: 'stocklite.global',
      tabId: 'global',
      title: '全球指数',
      columns: GLOBAL_COLUMNS,
      emptyMessage: '没有显示中的指数：点上方「＋ 选择指数」或设置页勾选',
      intervalMs: () => Math.max(15_000, deps.config.pollIntervalSeconds() * 1000),
      enabled: () => deps.config.tabEnabled('global'),
      header: () => this.buildForecastHeader(),
    });
  }

  /** 双轨可见性（单入口 visibleGlobalIndexes），与 S5 设置页共用两份设置键 */
  visibleIndexes(): GlobalIndexConfig[] {
    return visibleGlobalIndexes(
      this.deps.config.setting<string[]>('indexes.hidden') ?? [],
      this.deps.config.setting<string[]>('indexes.enabledOptional') ?? [],
    );
  }

  protected codesForView(): string[] {
    return this.visibleIndexes().map((c) => c.symbol);
  }

  protected async fetch(codes: string[]): Promise<Quote[]> {
    const configs = codes.length > 0
      ? GLOBAL_INDEXES.filter((c) => codes.includes(c.symbol))
      : this.visibleIndexes();
    const { quotes, rateLimited } = await getGlobalIndexQuotes(configs);
    this.rateLimited = rateLimited;
    return quotes.map(globalRowToQuote);
  }

  protected buildRow(symbol: string): RowVM {
    const q = this.quotes.get(symbol);
    const cfg = GLOBAL_INDEXES.find((c) => c.symbol === symbol);
    const name = q?.name ?? `${cfg?.nameCn ?? symbol} (${cfg?.nameEn ?? ''})`;
    if (!q) {
      return { key: symbol, name, cells: [{ text: name }, { text: '--' }, { text: '--' }, { text: cfg?.market ?? '--' }, { text: '--' }] };
    }
    const isOpen = q.extra?.isOpen === 1;
    const isDelayed = q.extra?.isDelayed === 1;
    const pct = q.changePct ?? 0;
    const dir = pct > 0 ? 1 : pct < 0 ? -1 : 0;
    return {
      key: symbol,
      name,
      cells: [
        { text: name },
        { text: formatPrice(q.price), dir: dir as -1 | 0 | 1 },
        { text: `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`, dir: dir as -1 | 0 | 1 },
        { text: String(q.extra?.market ?? cfg?.market ?? '') },
        { text: isOpen ? '交易中' : '休市', sub: isDelayed ? '延迟' : undefined },
      ],
    };
  }

  protected statusSuffix(count: number): string {
    return ` · 共 ${count} 条${this.rateLimited ? ' · Yahoo 限流退避中' : ''}`;
  }

  // ── 研判卡（G2）：天气卡 + 研判卡，逐段对照 GlobalPanel.kt ─────────────────

  /** header 槽入口：研判设置关 / 生成链路异常时返回 undefined（无 header，表格不受影响） */
  private async buildForecastHeader(): Promise<TableHeaderVM | undefined> {
    if ((this.deps.config.setting<boolean>('forecast.enabled') ?? true) === false) return undefined;
    await this.refreshForecast();
    const cards: HeaderCardVM[] = [];
    const weather = this.buildWeatherCard();
    if (weather) cards.push(weather);
    const fc = this.buildForecastCard();
    if (fc) cards.push(fc);
    return cards.length ? { cards } : undefined;
  }

  /** 60 秒节流的研判链路（对照 fetchBreadthAsync：结算 → 天气 → 窗口内生成 / 窗口外回读） */
  private async refreshForecast(): Promise<void> {
    const now = Date.now();
    if (now - this.forecastStamp < 60_000) return;
    this.forecastStamp = now;
    const deps = (this.forecastDeps ??= makeRealDeps());
    const store = (this.forecastStore ??= createForecastStore(this.deps.context.globalState));
    try {
      await settleForecasts(deps, store, now);
      this.lastSentiment = (await getSentiment(deps, store, now)) ?? undefined;
      this.lastInWindow = await inPreOpenWindow(deps, now);
      const gen = this.lastInWindow ? await generatePreOpenForecast(deps, store, now) : null;
      const latest = latestRecord(store.history());
      this.lastForecast = gen ?? (latest ? rehydrate(latest) : undefined);
    } catch {
      // 研判链路失败不影响表格：header 降级为上一轮缓存/无卡
    }
  }

  /** 研判行可见性（forecastVisible）：窗口内恒显；窗口外仅当日研判可见 */
  private forecastVisible(f: PreOpenForecast | undefined): boolean {
    return this.lastInWindow || (!!f && f.date === zonedTime(CN_TZ, Date.now()).date);
  }

  private buildForecastCard(): HeaderCardVM | undefined {
    if (!this.forecastVisible(this.lastForecast)) return undefined;
    const f = this.lastForecast;
    if (!f) {
      return {
        segments: [{ text: `${T.forecast} ${T.awaiting}` }],
        detail: [[{ text: T.preOpenPendingTip, hex: MUTED }]],
      };
    }
    const store = this.forecastStore;
    const stats = store ? getStats(store.history()) : undefined;
    const segments: HeaderSegVM[] = [{ text: `${T.forecast}(${f.date.slice(5)} ${f.generatedAt})` }];
    segments.push({ text: `·${f.finalized ? T.verFinal : T.verFirst}`, hex: MUTED });
    const gs = gapState(f.gapPct);
    if (gs !== 'NAN') {
      segments.push({
        text: `${T.gapStateLabel(gs)}${fmtSigned(f.gapPct, 2)}%`,
        ...(gs === 'HIGH' ? { dir: 1 as const } : gs === 'LOW' ? { dir: -1 as const } : { hex: MUTED }),
        bold: true,
      });
    }
    const dir = directionOf(f.score);
    segments.push({
      text: dir === 'BULL' ? T.bullish : dir === 'BEAR' ? T.bearish : T.neutral,
      ...(dir === 'BULL' ? { dir: 1 as const } : dir === 'BEAR' ? { dir: -1 as const } : { hex: MUTED }),
      bold: true,
    });
    if (stats && stats.gapSample >= 5 && Number.isFinite(stats.gapHitRate)) {
      segments.push({ text: `· ${T.gapHit} ${Math.trunc(stats.gapHitRate)}%`, hex: MUTED });
    }
    // 悬停详情：头部行 + 因子明细 + 跳空账本近5次 + 方向统计 + 免责（对照 toolTipText 拼装）
    const detail: HeaderSegVM[][] = [[
      { text: `${T.forecast} ${f.date}（隐含跳空 ${gs === 'NAN' ? '--' : `${fmtSigned(f.gapPct, 2)}%`}，全天倾向 ${fmtSigned(f.score, 0)}，-100~+100）`, bold: true },
    ]];
    for (const factor of f.factors) {
      detail.push(Number.isFinite(factor.score)
        ? [{ text: `· ${factor.name}：${factor.detail || '数据缺失'}　` }, { text: fmtSigned(factor.score, 1), dir: factor.score >= 0 ? 1 : -1, bold: true }]
        : [{ text: `· ${factor.name}：${factor.detail || '数据缺失'}` }]);
    }
    if (store) {
      const gapSettled = store.history().filter(
        (r) => r.kind === 'PRE' && r.settled && Number.isFinite(r.gapPct) && Number.isFinite(r.openPct),
      );
      if (gapSettled.length >= 3) {
        const recent = gapSettled.slice(-20);
        const hit = recent.filter((r) => r.openHit).length;
        detail.push([{ text: T.gapTitle(recent.length, Math.trunc((hit * 100) / recent.length), hit), bold: true }]);
        for (const r of recent.slice(-5).reverse()) {
          detail.push([
            { text: `· ${r.date.slice(5)} ${T.gapStateLabel(gapState(r.gapPct))}${fmtSigned(r.gapPct, 2)} → ${T.gapStateLabel(gapState(r.openPct))}${fmtSigned(r.openPct, 2)} ` },
            { text: r.openHit ? '✅' : '❌', dir: r.openHit ? 1 : -1, bold: true },
          ]);
        }
      }
      if (stats && stats.dirSample >= 5 && Number.isFinite(stats.dirHitRate)) {
        detail.push([{ text: T.dirTitle(stats.dirSample, Math.trunc(stats.dirHitRate), stats.dirHits) }]);
      }
    }
    detail.push([{ text: T.forecastDisclaimer, hex: MUTED }]);
    return { segments, detail };
  }

  private buildWeatherCard(): HeaderCardVM | undefined {
    const snap = this.lastSentiment;
    if (!snap || !Number.isFinite(snap.score)) return { segments: [{ text: `${T.sentiment} --` }], detail: [] };
    const tier = sentimentTier(snap.score);
    const detail: HeaderSegVM[][] = [[
      { text: `${T.sentiment} ${snap.date}（得分 ${fmtSigned(snap.score, 0)}，-100~+100）`, bold: true },
    ]];
    for (const factor of snap.factors) {
      detail.push(Number.isFinite(factor.score)
        ? [{ text: `· ${factor.name}：${factor.detail || '数据缺失'}　` },
           { text: fmtSigned(factor.score, 1), hex: factor.score >= 0 ? '#ffa657' : '#69c0ff', bold: true }]
        : [{ text: `· ${factor.name}：${factor.detail || '数据缺失'}` }]);
    }
    detail.push([{ text: T.sentimentTipHint, hex: MUTED }]);
    return {
      segments: [
        { text: T.sentiment },
        { text: `${T.tierName(tier)} ${fmtSigned(snap.score, 0)}`, hex: tierColor(tier), bold: true },
      ],
      detail,
    };
  }

  // ── 显示过滤（双轨写回）───────────────────────────────────

  /** addGlobalIndex 命令与「＋」入口：勾选当前显示集合，确认后落盘 */
  async pickIndexes(): Promise<void> {
    const hidden = new Set(this.deps.config.setting<string[]>('indexes.hidden') ?? []);
    const enabled = new Set(this.deps.config.setting<string[]>('indexes.enabledOptional') ?? []);
    const main = GLOBAL_INDEXES.filter((c) => !c.optional);
    const more = GLOBAL_INDEXES.filter((c) => c.optional);
    const items: vscode.QuickPickItem[] = [
      { label: '常用指数', kind: vscode.QuickPickItemKind.Separator },
      ...main.map((c) => ({ label: c.nameCn, description: `${c.nameEn} · ${c.symbol}`, picked: !hidden.has(c.symbol) })),
      { label: '更多指数（默认隐藏，勾选启用）', kind: vscode.QuickPickItemKind.Separator },
      ...more.map((c) => ({ label: c.nameCn, description: `${c.nameEn} · ${c.symbol}`, picked: enabled.has(c.symbol) })),
    ];
    const picked = await pickMany(items, '勾选要显示的全球指数（与设置页“全球指数”弹窗同状态）');
    if (!picked) return;
    await this.applyVisibility(new Set(picked.map((p) => (p.description ?? '').split(' · ').pop() ?? '')));
  }

  /** 双轨落盘：常用未勾选 → hidden；更多勾选 → enabledOptional（配置变更自动触发刷新） */
  private async applyVisibility(shownSymbols: Set<string>): Promise<void> {
    const newHidden = GLOBAL_INDEXES.filter((c) => !c.optional && !shownSymbols.has(c.symbol)).map((c) => c.symbol);
    const newEnabled = GLOBAL_INDEXES.filter((c) => c.optional && shownSymbols.has(c.symbol)).map((c) => c.symbol);
    await updateStockliteSetting('indexes.hidden', newHidden);
    await updateStockliteSetting('indexes.enabledOptional', newEnabled);
  }

  protected async onAdd(): Promise<void> {
    return this.pickIndexes();
  }

  protected async unsupported(name: 'batchImport' | 'manageGroups'): Promise<void> {
    void name;
    await vscode.window.showInformationMessage('StockLite: 全球指数页用「＋ 选择指数」管理显示，无导入/分组');
  }

  protected async deleteCode(symbol: string): Promise<void> {
    const cfg = GLOBAL_INDEXES.find((c) => c.symbol === symbol);
    if (!cfg) return;
    const shown = new Set(this.visibleIndexes().map((c) => c.symbol));
    shown.delete(symbol);
    await this.applyVisibility(shown);
    await vscode.window.showInformationMessage(`StockLite: 已隐藏 ${cfg.nameCn}，可在「＋ 选择指数」恢复`);
  }

  protected async onRowAction(action: RowAction, code: string, name: string): Promise<void> {
    // 全球指数在图表侧 Yahoo 源按 symbol 取数（S1 kline 通用实现），提醒沿用通用流程
    if (action === 'trades') {
      await vscode.window.showInformationMessage('StockLite: 交易记录仅自选股 tab 支持');
      return;
    }
    return super.onRowAction(action, code, name);
  }
}

function formatPrice(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '--';
  const digits = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 2 : 4;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
