/**
 * 提醒引擎装配 —— S4 独占本目录。
 * 对照 Kotlin：StockAlertWatcherService（后台轮询）+ AlertManager（判定与通知）+ SetAlertDialog（QuickPick 等价物）。
 * 数据双通道：
 *  1) 被动——订阅 EventBus quotesUpdated（各 tab 刷新即免费喂给引擎，对应原版"面板刷新后 checkAlerts"）；
 *  2) 主动——独立后台轮询提醒标的 + 自选 A 股（对应 StockAlertWatcherService 不依赖面板开关）。
 * 两路共用同一个 RuleEvaluator 边沿触发状态，天然不会重复弹。
 * 通知 = VSCode notification + 独立状态栏警示项（error/warning 图标态，20 秒自动清除）。
 */
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { FeatureDeps } from '../../extension';
import { StateKeys } from '../../shared/config';
import { httpGetJson } from '../../shared/http';
import type { Quote, StockAlert } from '../../shared/types';
import {
  BreadthJumpDetector,
  RuleEvaluator,
  SealShrinkDetector,
  breadthPollDelayMs,
  fetchMarketBreadth,
  isThresholdAlert,
  SYSTEM_RULE_IDS,
  thresholdLabel,
  type BreadthSample,
  type ExtendedStockAlert,
  type ExtendedAlertType,
  type SealEvent,
} from './engine';
import { resolveStockProvider } from './providerRef';

/** 扩展规则降级为契约 StockAlert 后广播（S7 把 ExtendedAlertType 正式化后可删） */
const asContract = (a: ExtendedStockAlert): StockAlert => ({ ...a }) as StockAlert;

export function activateAlerts(deps: FeatureDeps): void {
  const { context, bus, config } = deps;
  const evaluator = new RuleEvaluator();
  const sealDetector = new SealShrinkDetector();
  const breadthDetector = new BreadthJumpDetector();

  // ── 状态存储 ──────────────────────────────────────────────────────
  const loadAlerts = (): ExtendedStockAlert[] => config.get<ExtendedStockAlert[]>(StateKeys.alerts, []);
  const saveAlerts = (alerts: ExtendedStockAlert[]): void => {
    void config.set(StateKeys.alerts, alerts);
  };
  const ruleOf = (id: string): ExtendedStockAlert | undefined => loadAlerts().find((a) => a.id === id);
  const ruleEnabled = (id: string, type: ExtendedAlertType): boolean => {
    const r = ruleOf(id);
    return r !== undefined && r.type === type && r.enabled;
  };
  const toggleRule = (id: string, type: ExtendedAlertType): boolean => {
    const alerts = loadAlerts();
    const idx = alerts.findIndex((a) => a.id === id);
    if (idx >= 0) {
      alerts[idx] = { ...alerts[idx], enabled: !alerts[idx].enabled };
    } else {
      alerts.push({ id, code: '', name: thresholdLabel({ type } as ExtendedStockAlert), type, threshold: 0, enabled: true });
    }
    saveAlerts(alerts);
    return alerts.find((a) => a.id === id)!.enabled;
  };

  // ── 状态栏警示项（error/warning 图标态）───────────────────────────
  const flash = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200);
  flash.command = 'stocklite.setAlert';
  let flashTimer: NodeJS.Timeout | undefined;
  const showFlash = (text: string, isError: boolean): void => {
    flash.text = `${isError ? '$(error)' : '$(warning)'} ${text}`;
    flash.tooltip = 'StockLite 提醒：点击管理提醒';
    flash.show();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flash.hide(), 20_000);
  };

  const notify = (title: string, msg: string, warning: boolean, code?: string, name?: string): void => {
    const thenable = warning
      ? vscode.window.showWarningMessage(`${title} ${msg}`, '查看K线')
      : vscode.window.showInformationMessage(`${title} ${msg}`, '查看K线');
    void thenable.then((pick) => {
      if (pick === '查看K线' && code) bus.emit('openChart', { code, name });
    });
  };

  // ── 到价/涨跌幅 + 封单 共用轮询（StockAlertWatcherService 等价）──
  const isCnSymbol = (sym: string): boolean => /^(sh|sz|bj)/.test(sym);
  const watchCodes = (): string[] => {
    const flat = config.get<string[]>(StateKeys.watchlist, []);
    const groups = config.get<{ codes: string[] }[]>(StateKeys.stockGroups, []);
    return [...new Set([...flat, ...groups.flatMap((g) => g.codes ?? [])])];
  };

  /** 提醒命中统一出口：通知 + 闪烁 + 事件广播 + lastFiredAt 落盘 */
  const fireThreshold = (alert: ExtendedStockAlert, quote: Quote): void => {
    alert.lastFiredAt = Date.now();
    const isDown = alert.type === 'priceBelow' || alert.type === 'changeBelow';
    const pct = quote.changePct ?? (quote.prevClose > 0 ? ((quote.price - quote.prevClose) / quote.prevClose) * 100 : 0);
    notify('StockLite 提醒',
      `${quote.name}(${quote.code}) 现价 ${quote.price.toFixed(2)}（${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%），${thresholdLabel(alert)}`,
      isDown, quote.code, quote.name);
    showFlash(`${quote.name} ${thresholdLabel(alert)}`, isDown);
    bus.emit('alertFired', { alert: asContract(alert), quote });
    saveAlerts(loadAlerts().map((a) => (a.id === alert.id ? { ...a, lastFiredAt: alert.lastFiredAt } : a)));
  };

  let pollTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  const schedulePoll = (delayMs: number): void => {
    if (disposed) return;
    pollTimer = setTimeout(() => void poll(), delayMs);
  };

  const poll = async (): Promise<void> => {
    try {
      const alerts = loadAlerts();
      const priceAlerts = alerts.filter((a) => a.enabled && isThresholdAlert(a.type));
      const sealOn = ruleEnabled(SYSTEM_RULE_IDS.sealShrink, 'sealShrink');
      const cnWatch = sealOn ? watchCodes().filter(isCnSymbol) : [];
      const codes = [...new Set([...priceAlerts.map((a) => a.code), ...cnWatch])];
      if (codes.length > 0) {
        const fetched = await resolveStockProvider().fetchQuotes(codes).catch(() => [] as Quote[]);
        for (const alert of priceAlerts) {
          const quote = fetched.find((q) => q.code === alert.code);
          if (quote && evaluator.evaluate(alert, quote)) fireThreshold(alert, quote);
        }
        if (sealOn) {
          for (const ev of sealDetector.feed(fetched.filter((q) => isCnSymbol(q.code)))) {
            reportSeal(ev);
          }
        }
      }
    } finally {
      schedulePoll(config.pollIntervalSeconds() * 1000);
    }
  };

  const reportSeal = (ev: SealEvent): void => {
    const lots = (n: number): string => (n >= 10000 ? `${(n / 10000).toFixed(1)}万手` : `${n}手`);
    const msg = ev.dir === 'U'
      ? `${ev.name} 涨停封单锐减 ${ev.pct}%（${lots(ev.baseLots)} → ${lots(ev.curLots)}），谨防开板`
      : `${ev.name} 跌停封单锐减 ${ev.pct}%（${lots(ev.baseLots)} → ${lots(ev.curLots)}），或有翘板资金`;
    notify(`StockLite 封单预警${ev.cliff ? '（断崖抽单）' : ''}`, msg, true, ev.code, ev.name);
    showFlash(`${ev.name} 封单锐减${ev.pct}%`, true);
    bus.emit('alertFired', {
      alert: asContract(ruleOf(SYSTEM_RULE_IDS.sealShrink) ?? {
        id: SYSTEM_RULE_IDS.sealShrink, code: ev.code, name: ev.name,
        type: 'sealShrink', threshold: 0, enabled: true,
      }),
      quote: { code: ev.code, name: ev.name, price: 0, prevClose: 0, extra: { sealBaseLots: ev.baseLots, sealCurLots: ev.curLots } },
    });
  };

  // 被动通道：各 tab 的行情刷新同样喂给引擎（不额外发请求）
  context.subscriptions.push(
    bus.on('quotesUpdated', ({ quotes }) => {
      for (const alert of loadAlerts()) {
        if (!alert.enabled || !isThresholdAlert(alert.type)) continue;
        const quote = quotes.find((q) => q.code === alert.code);
        if (quote && evaluator.evaluate(alert, quote)) fireThreshold(alert, quote);
      }
    }),
  );

  // ── 大盘宽度轮询（BreadthWatcherService 等价 + 异动提醒）──────────
  let breadthTimer: NodeJS.Timeout | undefined;
  const scheduleBreadth = (): void => {
    if (disposed) return;
    breadthTimer = setTimeout(() => void breadthTick(), breadthPollDelayMs(Date.now()));
  };
  const breadthTick = async (): Promise<void> => {
    try {
      if (ruleEnabled(SYSTEM_RULE_IDS.breadthJump, 'breadthJump')) {
        const sample: BreadthSample | undefined = await fetchMarketBreadth((u) => httpGetJson(u), Date.now);
        if (sample) {
          const jump = breadthDetector.feed(sample);
          if (jump) {
            const msg = jump.dir === 'up'
              ? `两市涨家大幅增多（涨跌差 ${jump.fromDiff} → ${jump.toDiff}），市场宽度走强`
              : `两市跌家大幅增多（涨跌差 ${jump.fromDiff} → ${jump.toDiff}），市场宽度恶化`;
            notify('StockLite 大盘异动', msg, jump.dir === 'down');
            showFlash(`大盘宽度异动（${jump.dir === 'up' ? '走强' : '恶化'}）`, jump.dir === 'down');
            bus.emit('alertFired', {
              alert: asContract(ruleOf(SYSTEM_RULE_IDS.breadthJump) ?? {
                id: SYSTEM_RULE_IDS.breadthJump, code: 'market', name: 'A股大盘',
                type: 'breadthJump', threshold: 0, enabled: true,
              }),
              quote: { code: 'market', name: 'A股大盘', price: jump.toDiff, prevClose: jump.fromDiff },
            });
          }
        }
      }
    } finally {
      scheduleBreadth();
    }
  };

  // 启动：价格/封单轮询延迟 15s（同原版），宽度轮询按分档策略
  schedulePoll(15_000);
  scheduleBreadth();

  // ── stocklite.setAlert：SetAlertDialog 的 QuickPick 等价物 ────────
  context.subscriptions.push(
    vscode.commands.registerCommand('stocklite.setAlert', async (code?: string, name?: string) => {
      if (code) {
        await addAlertFlow(deps, code, name, loadAlerts, saveAlerts);
        return;
      }
      await manageAlerts(deps, loadAlerts, saveAlerts, toggleRule, ruleEnabled);
    }),
    {
      dispose: () => {
        disposed = true;
        if (pollTimer) clearTimeout(pollTimer);
        if (breadthTimer) clearTimeout(breadthTimer);
        if (flashTimer) clearTimeout(flashTimer);
      },
    },
    flash,
  );
}

// ── 提醒管理 QuickPick 流程 ──────────────────────────────────────────
interface MenuItem extends vscode.QuickPickItem {
  itemId: string;
}

const TYPE_CHOICES: { type: ExtendedAlertType; label: string; desc: string }[] = [
  { type: 'priceAbove', label: '价格上破提醒', desc: '价格 ≥ 目标价时通知' },
  { type: 'priceBelow', label: '价格下破提醒', desc: '价格 ≤ 目标价时通知' },
  { type: 'changeAbove', label: '涨幅提醒', desc: '当日涨跌幅 ≥ 阈值(%)时通知' },
  { type: 'changeBelow', label: '跌幅提醒', desc: '当日涨跌幅 ≤ 阈值(%)时通知' },
];

async function manageAlerts(
  deps: FeatureDeps,
  loadAlerts: () => ExtendedStockAlert[],
  saveAlerts: (a: ExtendedStockAlert[]) => void,
  toggleRule: (id: string, type: ExtendedAlertType) => boolean,
  ruleEnabled: (id: string, type: ExtendedAlertType) => boolean,
): Promise<void> {
  const sealOn = ruleEnabled(SYSTEM_RULE_IDS.sealShrink, 'sealShrink');
  const breadthOn = ruleEnabled(SYSTEM_RULE_IDS.breadthJump, 'breadthJump');
  const own = loadAlerts().filter((a) => isThresholdAlert(a.type));
  const items: MenuItem[] = [
    { itemId: 'add', label: '$(add) 新建到价/涨跌幅提醒', description: '自选股或手动输入代码' },
    { itemId: SYSTEM_RULE_IDS.sealShrink, label: '$(zap) 封单锐减提醒', description: sealOn ? '已开启（涨停开板/跌停翘板前兆）' : '已关闭', picked: sealOn },
    { itemId: SYSTEM_RULE_IDS.breadthJump, label: '$(dashboard) 大盘宽度异动提醒', description: breadthOn ? '已开启（涨跌家数突变）' : '已关闭', picked: breadthOn },
    ...own.map((a) => ({
      itemId: a.id,
      label: `${a.enabled ? '$(bell)' : '$(bell-slash)'} ${a.name}  ${thresholdLabel(a)}`,
      description: a.code,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'StockLite 提醒管理', placeHolder: '选择要操作的项目' });
  if (!pick) return;
  if (pick.itemId === 'add') {
    await addAlertFlow(deps, undefined, undefined, loadAlerts, saveAlerts);
    return;
  }
  if (pick.itemId === SYSTEM_RULE_IDS.sealShrink || pick.itemId === SYSTEM_RULE_IDS.breadthJump) {
    const type: ExtendedAlertType = pick.itemId === SYSTEM_RULE_IDS.sealShrink ? 'sealShrink' : 'breadthJump';
    const on = toggleRule(pick.itemId, type);
    void vscode.window.showInformationMessage(
      `StockLite: ${thresholdLabel({ type } as ExtendedStockAlert)} 已${on ? '开启' : '关闭'}`,
    );
    return;
  }
  const target = loadAlerts().find((a) => a.id === pick.itemId);
  if (!target) return;
  const action = await vscode.window.showQuickPick(
    [
      { itemId: 'toggle', label: target.enabled ? '$(bell-slash) 停用' : '$(bell) 启用' },
      { itemId: 'edit', label: '$(edit) 修改阈值' },
      { itemId: 'delete', label: '$(trash) 删除', description: `${target.code} ${thresholdLabel(target)}` },
    ],
    { title: `${target.name}（${target.code}）`, placeHolder: thresholdLabel(target) },
  );
  if (!action) return;
  const alerts = loadAlerts();
  if (action.itemId === 'toggle') {
    saveAlerts(alerts.map((a) => (a.id === target.id ? { ...a, enabled: !a.enabled } : a)));
  } else if (action.itemId === 'delete') {
    saveAlerts(alerts.filter((a) => a.id !== target.id));
  } else if (action.itemId === 'edit') {
    const input = await vscode.window.showInputBox({
      title: `${target.name} 修改阈值（${thresholdLabel(target)}）`,
      value: String(target.threshold),
      validateInput: (v) => validateThreshold(v, target.type),
    });
    if (input !== undefined) {
      saveAlerts(alerts.map((a) => (a.id === target.id
        ? { ...a, threshold: normalizeThreshold(target.type, Number(input.trim())), lastFiredAt: undefined }
        : a)));
    }
  }
}

function validateThreshold(v: string, type: ExtendedAlertType): string | undefined {
  const n = Number(v.trim());
  if (!Number.isFinite(n)) return '请输入数字';
  if (type.startsWith('price') ? n <= 0 : n === 0) return type.startsWith('price') ? '价格须为正数' : '阈值不能为 0';
  return undefined;
}

/** 涨跌幅阈值符号约定：涨幅提醒存正数、跌幅提醒存负数（用户输入 3 或 -3 均可） */
function normalizeThreshold(type: ExtendedAlertType, n: number): number {
  if (type === 'changeAbove') return Math.abs(n);
  if (type === 'changeBelow') return -Math.abs(n);
  return n;
}

async function addAlertFlow(
  deps: FeatureDeps,
  presetCode: string | undefined,
  presetName: string | undefined,
  loadAlerts: () => ExtendedStockAlert[],
  saveAlerts: (a: ExtendedStockAlert[]) => void,
): Promise<void> {
  let code = presetCode;
  let name = presetName;
  if (!code) {
    const flat = deps.config.get<string[]>(StateKeys.watchlist, []);
    const groups = deps.config.get<{ codes: string[] }[]>(StateKeys.stockGroups, []);
    const codes = [...new Set([...flat, ...groups.flatMap((g) => g.codes ?? [])])];
    if (codes.length > 0) {
      const quotes = await resolveStockProvider().fetchQuotes(codes).catch(() => [] as Quote[]);
      const picked = await vscode.window.showQuickPick(
        codes.map((c) => ({ itemId: c, label: quoteLabel(c, quotes) })),
        { title: 'StockLite 设置提醒：选择标的', placeHolder: '选择自选股（Esc 后手动输入代码）' },
      );
      if (picked) {
        code = picked.itemId;
        name = quotes.find((q) => q.code === code)?.name;
      }
    }
    if (!code) {
      const manual = await vscode.window.showInputBox({
        title: 'StockLite 设置提醒：输入代码',
        placeHolder: '如 600519 或 600519 贵州茅台',
        validateInput: (v) => (v.trim().length >= 4 ? undefined : '代码太短'),
      });
      if (!manual) return;
      const parts = manual.trim().split(/\s+/);
      code = parts[0];
      name = parts.slice(1).join(' ') || undefined;
    }
  }

  // 拉一次现价做阈值默认值展示
  const quote = (await resolveStockProvider().fetchQuotes([code]).catch(() => [] as Quote[]))[0];
  if (!name) name = quote?.name ?? code.toUpperCase();

  const typePick = await vscode.window.showQuickPick(
    TYPE_CHOICES.map((t) => ({
      itemId: t.type,
      label: t.label,
      description: `${t.desc}${quote ? `（现价 ${quote.price.toFixed(2)}，涨跌幅 ${formatPct(quote.changePct ?? pctOf(quote))}）` : ''}`,
    })),
    { title: `${name}（${code}）`, placeHolder: '选择提醒类型' },
  );
  if (!typePick) return;
  const type = typePick.itemId as ExtendedAlertType;
  const typeLabel = TYPE_CHOICES.find((t) => t.type === type)?.label ?? '提醒';

  const input = await vscode.window.showInputBox({
    title: `${name} ${typeLabel}`,
    prompt: type.startsWith('price')
      ? '目标价格（元）'
      : '涨跌幅阈值（百分数，如 3 表示 3%）',
    value: quote && type.startsWith('price') ? quote.price.toFixed(2) : undefined,
    validateInput: (v) => validateThreshold(v, type),
  });
  if (input === undefined) return;

  const threshold = normalizeThreshold(type, Number(input.trim()));
  const alerts = loadAlerts().filter((a) => !(a.code === code && a.type === type)); // 同标的同类型：覆盖旧阈值
  alerts.push({ id: randomUUID(), code, name, type, threshold, enabled: true });
  saveAlerts(alerts);
  void vscode.window.showInformationMessage(`StockLite: 已设置 ${name} ${typeLabel}（${threshold}）`);
}

function quoteLabel(code: string, quotes: Quote[]): string {
  const q = quotes.find((x) => x.code === code);
  return q ? `${q.name}  ${code}` : code;
}

function pctOf(q: Quote): number {
  return q.prevClose > 0 ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0;
}

function formatPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
