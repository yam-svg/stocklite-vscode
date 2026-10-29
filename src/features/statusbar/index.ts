/**
 * 状态栏行情轮播 —— S4 独占本目录。
 * 行为：按配置的代码列表（留空自动取自选股 + 已选全球指数）轮播现价/涨跌幅，
 * 涨跌着色跟随红涨绿跌设置，hover 显示明细，点击弹 QuickPick 操作菜单
 * （看图表/设提醒/暂停轮播/固定当前/管理轮播列表/打开设置）。
 * 数据双通道：自身定时轮询 + 订阅 quotesUpdated 即时刷新（后者零请求、更实时）。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import { SettingsKeys, StateKeys } from '../../shared/config';
import type { Quote } from '../../shared/types';
import { formatPrice, formatPct, pctOf, statusText, tooltipLines, trendOf } from './format';
import { resolveStockProvider } from './providerRef';

const MAX_AUTO_CODES = 8;

export function activateStatusBar(deps: FeatureDeps): void {
  const { context, bus, config } = deps;
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = 'stocklite.statusBarClick';

  let codes: string[] = [];
  let quotes = new Map<string, Quote>();
  let index = 0;
  let paused = false;
  let pinned = false;
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  let visible = false;

  const cfg = () => vscode.workspace.getConfiguration('stocklite');

  const refreshCodes = (): void => {
    const manual = config.setting<string[]>(`${SettingsKeys.statusBar}.codes`) ?? [];
    if (manual.length > 0) {
      codes = [...manual];
    } else {
      const watch = config.get<string[]>(StateKeys.watchlist, []);
      const groups = config.get<{ codes: string[] }[]>(StateKeys.stockGroups, []);
      const globals = config.get<string[]>(StateKeys.selectedGlobalIndexes, []);
      codes = [...new Set([...watch, ...groups.flatMap((g) => g.codes ?? []), ...globals])].slice(0, MAX_AUTO_CODES);
    }
    index = index % Math.max(codes.length, 1);
  };

  const render = (): void => {
    const q = codes.length > 0 ? quotes.get(codes[index]) : undefined;
    if (!q) {
      item.text = '$(pulse) StockLite';
      item.color = undefined;
      item.tooltip = codes.length === 0
        ? 'StockLite：点击添加轮播品种（或配置 stocklite.statusBar.codes）'
        : 'StockLite：行情获取中…';
      return;
    }
    item.text = statusText(q);
    const up = trendOf(q) === 'up';
    const flat = trendOf(q) === 'flat';
    if (flat) {
      item.color = undefined;
    } else {
      const redIsUp = config.colorUpIsRed();
      const isRed = up === redIsUp;
      item.color = new vscode.ThemeColor(isRed ? 'charts.red' : 'charts.green');
    }
    const tip = new vscode.MarkdownString(tooltipLines(q).join('  \n'));
    tip.appendMarkdown('\n\n*点击打开操作菜单*');
    item.tooltip = tip;
  };

  const syncVisibility = (): void => {
    visible = config.setting<boolean>(`${SettingsKeys.statusBar}.enabled`) ?? true;
    if (visible) item.show();
    else item.hide();
  };

  const scheduleNext = (): void => {
    if (disposed || !visible) return;
    timer = setTimeout(() => void tick(), config.pollIntervalSeconds() * 1000);
  };

  const tick = async (): Promise<void> => {
    try {
      if (visible && codes.length > 0) {
        const fetched = await resolveStockProvider().fetchQuotes(codes).catch(() => [] as Quote[]);
        for (const q of fetched) quotes.set(q.code, q);
        if (!paused && !pinned && codes.length > 0) index = (index + 1) % codes.length;
        render();
      }
    } finally {
      scheduleNext();
    }
  };

  const restartLoop = (): void => {
    if (timer) clearTimeout(timer);
    scheduleNext();
  };

  refreshCodes();
  syncVisibility();
  render();
  scheduleNext();

  context.subscriptions.push(
    item,
    { dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    } },
    bus.on('configChanged', ({ key }) => {
      if (key === '' || key.startsWith('statusBar') || key === StateKeys.watchlist
        || key === StateKeys.selectedGlobalIndexes || key === StateKeys.stockGroups) {
        refreshCodes();
        syncVisibility();
        restartLoop();
        render();
      }
    }),
    // 被动通道：tab 刷新即刻更新快照，无需等下一轮
    bus.on('quotesUpdated', ({ quotes: qs }) => {
      let hit = false;
      for (const q of qs) {
        if (codes.includes(q.code)) {
          quotes.set(q.code, q);
          hit = true;
        }
      }
      if (hit) render();
    }),
    vscode.commands.registerCommand('stocklite.statusBarClick', () => void showMenu()),
  );

  interface MenuItem extends vscode.QuickPickItem {
    itemId: string;
  }

  const current = (): Quote | undefined => (codes.length > 0 ? quotes.get(codes[index]) : undefined);

  const showMenu = async (): Promise<void> => {
    const q = current();
    const items: MenuItem[] = [];
    if (q) {
      items.push({ itemId: 'chart', label: '$(graph) 打开K线/分时', description: `${q.name} ${formatPrice(q.price)} ${formatPct(pctOf(q))}` });
      items.push({ itemId: 'alert', label: '$(bell) 设置提醒', description: q.name });
    }
    items.push(
      { itemId: 'toggle-pause', label: paused ? '$(play) 继续轮播' : '$(pause) 暂停轮播' },
      { itemId: 'toggle-pin', label: pinned ? '$(close) 取消固定（恢复轮播）' : '$(pin) 固定当前行情' },
      { itemId: 'manage', label: '$(list-unordered) 管理轮播列表', description: `当前 ${codes.length} 项${codes.length === 0 ? '（自动：自选股/全球指数）' : ''}` },
      { itemId: 'refresh', label: '$(sync) 立即刷新' },
      { itemId: 'settings', label: '$(gear) 状态栏设置…', description: '启用开关 / 轮播间隔 / 涨跌配色' },
    );
    const pick = await vscode.window.showQuickPick(items, { title: 'StockLite 状态栏', placeHolder: '选择操作' });
    if (!pick) return;
    switch (pick.itemId) {
      case 'chart':
        if (q) bus.emit('openChart', { code: q.code, name: q.name });
        break;
      case 'alert':
        if (q) await vscode.commands.executeCommand('stocklite.setAlert', q.code, q.name);
        break;
      case 'toggle-pause':
        paused = !paused;
        render();
        break;
      case 'toggle-pin':
        pinned = !pinned;
        render();
        break;
      case 'refresh':
        await tick();
        break;
      case 'settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'stocklite.statusBar');
        break;
      case 'manage':
        await manageList();
        break;
      default:
        break;
    }
  };

  const manageList = async (): Promise<void> => {
    const action = await vscode.window.showQuickPick(
      [
        { itemId: 'add', label: '$(add) 添加代码' },
        ...(codes.length > 0 ? [{ itemId: 'remove', label: '$(trash) 移除代码' }] : []),
        ...(codes.length > 0 ? [{ itemId: 'clear', label: '$(close-all) 清空（回到自动模式）' }] : []),
      ],
      { title: `轮播列表（${codes.length} 项）`, placeHolder: '选择操作' },
    );
    if (!action) return;
    if (action.itemId === 'add') {
      const input = await vscode.window.showInputBox({
        title: '添加轮播代码',
        placeHolder: '如 sh600519（与自选股代码一致）',
        validateInput: (v) => (v.trim().length >= 4 ? undefined : '代码太短'),
      });
      if (!input) return;
      const next = [...new Set([...codes, input.trim()])];
      await cfg().update('statusBar.codes', next, vscode.ConfigurationTarget.Global);
    } else if (action.itemId === 'remove') {
      const picked = await vscode.window.showQuickPick(
        codes.map((c) => ({ label: c, description: quotes.get(c)?.name })),
        { title: '移除轮播代码', placeHolder: '选择要移除的代码' },
      );
      if (!picked) return;
      await cfg().update('statusBar.codes', codes.filter((c) => c !== picked.label), vscode.ConfigurationTarget.Global);
    } else if (action.itemId === 'clear') {
      await cfg().update('statusBar.codes', [], vscode.ConfigurationTarget.Global);
    }
  };
}
