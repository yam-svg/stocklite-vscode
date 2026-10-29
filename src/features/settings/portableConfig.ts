/**
 * 配置导出/导入（纯逻辑，无 vscode 依赖，供 selftest 直跑）。
 * 导出格式带 "stocklite-vscode" 版本标记；导入同时接受：
 *  1. 本扩展自己的导出文件（state + settings 两段）；
 *  2. JetBrains 版 ImportExportDialog 导出的 stocklite_backup.json（version "1.2.0"），
 *     键名与其 StockliteState 对齐，字段按本仓库契约模型转换。
 */
import { GLOBAL_INDEXES } from './indexCatalog';

export const NATIVE_FORMAT_MARK = 'stocklite-vscode';
export const NATIVE_FORMAT_VERSION = 1;

export interface ConfigSnapshot {
  /** StateKeys → 值（globalState） */
  state: Record<string, unknown>;
  /** 'stocklite' 段下的点分键 → 值（contributes.configuration） */
  settings: Record<string, unknown>;
}

export interface ImportPayload extends ConfigSnapshot {
  warnings: string[];
}

export function buildExportJson(snap: ConfigSnapshot, exportedAt = new Date().toISOString()): string {
  return JSON.stringify(
    { [NATIVE_FORMAT_MARK]: NATIVE_FORMAT_VERSION, exportedAt, state: snap.state, settings: snap.settings },
    null,
    2,
  );
}

/** tradeAt（毫秒时间戳，A股语境）→ 'YYYY-MM-DD'（东八区，避免宿主时区漂移） */
function msToShanghaiDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms + 8 * 3600_000);
  return d.toISOString().slice(0, 10);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(o: Record<string, unknown>, key: string, fallback = ''): string {
  const v = o[key];
  return typeof v === 'string' ? v : fallback;
}

function num(o: Record<string, unknown>, key: string, fallback = 0): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** JetBrains 备份 JSON → 本扩展的 state/settings 快照（迁移导入） */
export function normalizeJetbrains(root: Record<string, unknown>): ImportPayload {
  const warnings: string[] = [];
  const state: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};

  // ── 股票：stocks 同时派生 watchlist（顺序）与 positions（成本/数量） ──
  const stocks = asArray(root.stocks) as Record<string, unknown>[];
  if (stocks.length > 0) {
    const sorted = [...stocks].sort((a, b) => num(a, 'sortOrder') - num(b, 'sortOrder'));
    state.watchlist = sorted.map((s) => str(s, 'symbol')).filter(Boolean);
    // 迁移用户已有真实数据，置位 S2 的播种判据（ui/watchlist SEEDED_KEY），防止示例股票再混入
    state.watchlistDefaultsSeeded = true;
    const positions = sorted
      .filter((s) => num(s, 'quantity') > 0)
      .map((s) => ({ code: str(s, 'symbol'), name: str(s, 'name'), cost: num(s, 'costPrice'), quantity: num(s, 'quantity') }));
    if (positions.length > 0) state.positions = positions;
  }
  const stockGroups = asArray(root.stockGroups) as Record<string, unknown>[];
  if (stockGroups.length > 0) {
    state.stockGroups = stockGroups.map((g) => ({ id: str(g, 'id'), name: str(g, 'name'), codes: [] as string[] }));
  }

  // ── 交易记录：BUY/SELL → side；ADJUST 无对应语义，跳过并提示 ──
  const trades = asArray(root.tradeRecords) as Record<string, unknown>[];
  if (trades.length > 0) {
    const mapped: Record<string, unknown>[] = [];
    for (const r of trades) {
      const side = str(r, 'tradeType').toLowerCase();
      if (side !== 'buy' && side !== 'sell') {
        warnings.push(`跳过 ${str(r, 'symbol', '?')} 的 ${str(r, 'tradeType') || '未知'} 类型交易记录`);
        continue;
      }
      const date = msToShanghaiDate(num(r, 'tradeAt'));
      if (!date) continue;
      mapped.push({
        id: str(r, 'id'), code: str(r, 'symbol'), name: str(r, 'stockName'),
        side, price: num(r, 'price'), quantity: num(r, 'quantity'), date, note: str(r, 'note') || undefined,
      });
    }
    if (mapped.length > 0) state.tradeRecords = mapped;
  }

  // ── 提醒：ABOVE/BELOW → priceAbove/priceBelow ──
  const alerts = asArray(root.priceAlerts) as Record<string, unknown>[];
  if (alerts.length > 0) {
    const typeMap: Record<string, string> = { ABOVE: 'priceAbove', BELOW: 'priceBelow' };
    const mapped: Record<string, unknown>[] = [];
    for (const a of alerts) {
      const type = typeMap[str(a, 'alertType', 'ABOVE').toUpperCase()];
      if (!type) {
        warnings.push(`跳过不支持的提醒类型 ${str(a, 'alertType')}`);
        continue;
      }
      mapped.push({
        id: str(a, 'id'), code: str(a, 'symbol'), name: str(a, 'name'),
        type, threshold: num(a, 'targetPrice'), enabled: a.enabled !== false,
      });
    }
    if (mapped.length > 0) state.alerts = mapped;
  }

  // ── 各品种列表：JetBrains 数据对象整段透传，S6 的 provider 适配层自行解读 ──
  for (const key of ['funds', 'futures', 'cryptos'] as const) {
    if (asArray(root[key]).length > 0) state[key] = asArray(root[key]);
  }

  // ── 全球指数双轨（目录外的 id 过滤掉，避免污染配置） ──
  const known = new Set(GLOBAL_INDEXES.map((i) => i.symbol));
  const jbHidden = asArray(root.hiddenGlobalIndexes).filter((s): s is string => known.has(String(s))).map(String);
  const jbEnabled = asArray(root.enabledOptionalIndexes).filter((s): s is string => known.has(String(s))).map(String);
  if (jbHidden.length > 0) settings['indexes.hidden'] = jbHidden;
  if (jbEnabled.length > 0) settings['indexes.enabledOptional'] = jbEnabled;

  // ── 设置段映射 ──
  const jbSettings = (root.settings ?? {}) as Record<string, unknown>;
  if (typeof jbSettings.colorScheme === 'string') {
    settings.colorUp = jbSettings.colorScheme === 'GREEN_UP' ? 'green' : 'red';
  }
  if (typeof jbSettings.refreshIntervalStock === 'number') {
    settings.pollIntervalSeconds = Math.max(2, jbSettings.refreshIntervalStock);
  }
  const panelKeys: Record<string, string> = {
    enableFundPanel: 'tabs.fund', enableFuturePanel: 'tabs.future', enableGlobalPanel: 'tabs.global',
    enableSectorPanel: 'tabs.sector', enableIpoPanel: 'tabs.ipo', enableUsMarketPanel: 'tabs.us',
    enableCryptoPanel: 'tabs.crypto',
  };
  for (const [jbKey, settingKey] of Object.entries(panelKeys)) {
    if (typeof jbSettings[jbKey] === 'boolean') settings[settingKey] = jbSettings[jbKey];
  }
  if (typeof jbSettings.enablePortfolioStatusBar === 'boolean') {
    settings['statusBar.enabled'] = jbSettings.enablePortfolioStatusBar;
  }

  return { state, settings, warnings };
}

/** 解析导入文本：自动识别原生/JetBrains 格式；非法内容抛错（调用方负责提示） */
export function parseImportJson(text: string): ImportPayload {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('JSON 顶层必须是对象');
  }
  const obj = root as Record<string, unknown>;
  if (obj[NATIVE_FORMAT_MARK] === NATIVE_FORMAT_VERSION) {
    const state = (obj.state && typeof obj.state === 'object' ? obj.state : {}) as Record<string, unknown>;
    const settings = (obj.settings && typeof obj.settings === 'object' ? obj.settings : {}) as Record<string, unknown>;
    return { state, settings, warnings: [] };
  }
  // JetBrains 版导出没有格式标记，靠 stocks/version 等特征识别
  if ('stocks' in obj || 'funds' in obj || 'settings' in obj) {
    return normalizeJetbrains(obj);
  }
  throw new Error('无法识别的配置文件：缺少 stocklite 数据段');
}
