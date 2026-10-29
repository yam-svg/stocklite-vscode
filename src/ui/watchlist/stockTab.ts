/**
 * 自选股 tab（S2 主体）：通用行情表框架在股票场景的落地。
 * 覆盖任务书能力：持仓列（成本/数量/今日盈亏/盈亏）、行右键（图表/提醒/交易记录/删除）、
 * 三态排序、拖拽排序、分组 tab 条、工具栏（添加/批量导入/分组/刷新）、QuickPick 添加、
 * 交易记录 QuickInput 录入、批量导入（StockTextParser）。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import { SettingsKeys } from '../../shared/config';
import type { ColumnDef, Quote, QuoteProvider, TradeRecord } from '../../shared/types';
import { cellOf, formatNumber, dirOf } from './table/format';
import { nextSort, sortRows } from './table/sorting';
import type { RowAction, RowVM, SortVM, TableSnapshot, ToolbarCommand } from './table/types';
import { TableTab } from './table/framework';
import { WatchlistStore } from './store';
import { getProvider, isMock } from './providers';
import { parseStockText } from './stockTextParser';
import { effectivePosition, holdingsPnl, todayPnl, todayShanghai } from './positions';
import { looksLikeCode, promptNumber, promptText, validateDate } from './quickInputs';

const STOCK_COLUMNS: ColumnDef[] = [
  { key: 'code', title: '代码', kind: 'text', width: 66, align: 'left', sortable: true },
  { key: 'name', title: '名称', kind: 'text', width: 84, align: 'left', sortable: true },
  { key: 'price', title: '现价', kind: 'price', width: 62 },
  { key: 'changePct', title: '涨跌幅', kind: 'percent', width: 62 },
  { key: 'todayPnl', title: '今日盈亏', kind: 'number', width: 72 },
  { key: 'pnl', title: '盈亏', kind: 'number', width: 72 },
  { key: 'cost', title: '成本', kind: 'price', width: 58 },
  { key: 'qty', title: '持仓', kind: 'number', width: 58 },
  { key: 'amount', title: '成交额', kind: 'amount', width: 62 },
];

const EMPTY_MESSAGE = '暂无自选股：点上方「＋ 添加」，或「导入」粘贴文本批量导入';

function signedMoney(v: number): string {
  return `${v > 0 ? '+' : ''}${formatNumber(v, 2)}`;
}

export class StockTab {
  private readonly store: WatchlistStore;
  private readonly table: TableTab;
  private readonly quotes = new Map<string, Quote>();
  private activeGroupId = 'all';
  private sort: SortVM | null = null;
  private statusText = '等待首次刷新…';
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: FeatureDeps) {
    this.store = new WatchlistStore(deps.config);
    this.table = new TableTab('stocklite.stock', {
      buildSnapshot: () => this.buildSnapshot(),
      onToolbar: (name) => void this.onToolbar(name),
      onGroupSelect: (groupId) => {
        this.activeGroupId = groupId;
        void this.table.refresh();
      },
      onSort: (key) => {
        this.sort = nextSort(this.sort, key);
        void this.table.refresh();
      },
      onReorder: (codes) => void this.applyReorder(codes),
      onRowOpen: (code, name) => this.deps.bus.emit('openChart', { code, name }),
      onRowAction: (action, code, name) => void this.onRowAction(action, code, name),
    });
  }

  async activate(): Promise<void> {
    await this.store.seedDefaultsIfNeeded();
    this.table.register(this.deps.context);
    this.registerCommands();

    const bus = this.deps.bus;
    const sub = (d: vscode.Disposable): void => {
      this.deps.context.subscriptions.push(d);
    };
    sub(bus.on('viewAddRequested', ({ viewId }) => {
      if (viewId === 'stocklite.stock') void this.addStock();
    }));
    sub(bus.on('refreshRequested', ({ viewId }) => {
      if (viewId === 'stocklite.stock') void this.refreshQuotes();
    }));
    sub(bus.on('tradesChanged', () => void this.table.refresh()));
    sub(bus.on('configChanged', ({ key }) => {
      const settingsTouched = key === '' || key.startsWith(SettingsKeys.pollIntervalSeconds) || key.startsWith(SettingsKeys.colorUp);
      if (settingsTouched) this.restartPolling(); // 仅轮询间隔/配色变更需重建定时器
      void this.table.refresh();
    }));
    sub(bus.on('providerRegistered', ({ id }) => {
      if (id === 'stock') void this.refreshQuotes();
    }));
    // 视图关闭（插件 deactivate）时停掉定时器
    this.deps.context.subscriptions.push(new vscode.Disposable(() => this.stopPolling()));

    this.restartPolling();
    await this.refreshQuotes();
  }

  // ── 快照构建 ──────────────────────────────────────────────

  private provider(): QuoteProvider {
    return getProvider('stock');
  }

  private async buildSnapshot(): Promise<TableSnapshot> {
    const codes = this.store.effectiveCodes(this.activeGroupId);
    const groups = this.store.groups();
    const rows = codes.map((code) => this.buildRow(code));
    const model: TableSnapshot = {
      columns: STOCK_COLUMNS,
      rows: sortRows(rows, this.sort, STOCK_COLUMNS),
      groups: groups.length === 0 ? [] : [{ id: 'all', name: '全部' }, ...groups.map((g) => ({ id: g.id, name: g.name }))],
      activeGroupId: this.activeGroupId,
      sort: this.sort,
      colorUpIsRed: this.deps.config.colorUpIsRed(),
      statusText: `${this.statusText} · 共 ${codes.length} 只`,
      emptyMessage: EMPTY_MESSAGE,
    };
    return model;
  }

  private buildRow(code: string): RowVM {
    const quote = this.quotes.get(code);
    const name = quote?.name ?? code.toUpperCase();
    if (!quote) {
      // 尚无行情（首次加载或该 code 拉取失败）：占位行，保持顺序稳定
      const dash = STOCK_COLUMNS.map(() => ({ text: '--' }));
      dash[0] = { text: code };
      dash[1] = { text: name };
      return { key: code, name, cells: dash };
    }
    const pos = effectivePosition(this.store.tradesFor(code), this.store.positionFor(code));
    const pnl = holdingsPnl(quote, pos);
    const tPnl = todayPnl(quote, pos, this.store.tradesFor(code));
    const cellByIndex = STOCK_COLUMNS.map((col) => {
      switch (col.key) {
        case 'code': return { text: code };
        case 'name': return { text: name };
        case 'todayPnl':
          return pos.quantity > 0 ? { text: signedMoney(tPnl), dir: dirOf(tPnl) } : { text: '--' };
        case 'pnl':
          return pos.quantity > 0 && pos.cost > 0 ? { text: signedMoney(pnl), dir: dirOf(pnl) } : { text: '--' };
        case 'cost':
          return pos.quantity > 0 && pos.cost > 0 ? { text: formatNumber(pos.cost, priceDigitsOf(pos.cost)) } : { text: '--' };
        case 'qty':
          return pos.quantity > 0 ? { text: formatNumber(pos.quantity, 0) } : { text: '--' };
        default:
          return cellOf(col, quote);
      }
    });
    return { key: code, name, cells: cellByIndex };
  }

  // ── 轮询 ─────────────────────────────────────────────────

  private restartPolling(): void {
    this.stopPolling();
    const ms = Math.max(2, this.deps.config.pollIntervalSeconds()) * 1000;
    this.pollTimer = setInterval(() => void this.refreshQuotes(), ms);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async refreshQuotes(): Promise<void> {
    const codes = this.store.effectiveCodes('all');
    if (codes.length === 0) {
      this.statusText = `${nowText()} 已更新`;
      await this.table.refresh();
      return;
    }
    try {
      const fresh = await this.provider().fetchQuotes(codes);
      for (const q of fresh) this.quotes.set(q.code, q);
      this.statusText = `${nowText()} 已更新${isMock('stock') ? ' · Mock 数据（S1 未接入）' : ''}`;
      this.deps.bus.emit('quotesUpdated', { tabId: 'stock', quotes: fresh });
    } catch (err) {
      this.statusText = `${nowText()} 刷新失败：${err instanceof Error ? err.message : String(err)}`;
    }
    await this.table.refresh();
  }

  private async applyReorder(codes: string[]): Promise<void> {
    if (this.activeGroupId === 'all' && this.store.groups().length > 0) {
      await vscode.window.showInformationMessage('StockLite: 「全部」视图跨分组，请在具体分组内拖拽排序');
      return;
    }
    await this.store.applyOrder(this.activeGroupId, codes);
    await this.table.refresh();
  }

  // ── 工具栏与右键 ──────────────────────────────────────────

  private async onToolbar(name: ToolbarCommand): Promise<void> {
    if (name === 'add') return this.addStock();
    if (name === 'refresh') return this.refreshQuotes();
    if (name === 'batchImport') return this.batchImport();
    if (name === 'manageGroups') return this.manageGroups();
  }

  private async onRowAction(action: RowAction, code: string, name: string): Promise<void> {
    switch (action) {
      case 'openChart':
        this.deps.bus.emit('openChart', { code, name });
        break;
      case 'setAlert':
        try {
          await vscode.commands.executeCommand('stocklite.setAlert', { code, name });
        } catch {
          await vscode.window.showInformationMessage('StockLite: 提醒功能由会话 S4 提供，暂未注册');
        }
        break;
      case 'trades':
        await this.showTradeHistory(code, name);
        break;
      case 'delete':
        await this.deleteCodes([code]);
        break;
    }
  }

  // ── 添加股票（QuickPick 搜索）───────────────────────────────

  async addStock(): Promise<void> {
    const provider = this.provider();
    const pick = vscode.window.createQuickPick();
    pick.placeholder = '输入代码或名称搜索（如 600519 / 茅台 / AAPL），回车直接添加代码';
    pick.matchOnDescription = true;
    pick.onDidChangeValue((value) => {
      void (async () => {
        const kw = value.trim();
        const items: vscode.QuickPickItem[] = [];
        if (looksLikeCode(kw)) items.push({ label: `$(plus) 直接添加代码 ${kw}`, description: '不经搜索', alwaysShow: true });
        if (kw) {
          try {
            const hits = await provider.search?.(kw) ?? [];
            for (const hit of hits) {
              items.push({ label: `${hit.code}  ${hit.name}`, description: hit.market, code: hit.code } as vscode.QuickPickItem & { code: string });
            }
          } catch { /* 搜索失败仅展示直添项 */ }
        }
        pick.items = items;
      })();
    });
    const chosen = await new Promise<vscode.QuickPickItem | undefined>((resolve) => {
      pick.onDidAccept(() => resolve(pick.activeItems[0]));
      pick.onDidHide(() => resolve(undefined));
      pick.show();
    });
    pick.dispose();
    if (!chosen) return;
    const typed = (chosen as { code?: string }).code ?? extractCode(chosen.label);
    if (!typed) return;
    await this.addCodeWithCheck(typed);
  }

  private async addCodeWithCheck(code: string): Promise<void> {
    const existed = this.store.effectiveCodes('all').includes(code);
    const added = await this.store.addCode(code, this.activeGroupId);
    if (!added) {
      await vscode.window.showInformationMessage(`StockLite: ${code} 已在自选`);
      return;
    }
    // 拉一次行情确认代码有效并拿名称；失败则回滚
    try {
      const [quote] = await this.provider().fetchQuotes([code]);
      if (!quote || !Number.isFinite(quote.price)) throw new Error('无行情');
      this.quotes.set(code, quote);
    } catch {
      await this.store.removeCode(code);
      await vscode.window.showWarningMessage(`StockLite: ${code} 无法获取行情，已取消添加`);
      return;
    }
    if (existed) {
      await vscode.window.showInformationMessage(`StockLite: ${code} 已加入分组`);
    }
    await this.table.refresh();
  }

  // ── 删除 ─────────────────────────────────────────────────

  async deleteItem(): Promise<void> {
    const codes = this.store.effectiveCodes(this.activeGroupId);
    if (codes.length === 0) return;
    const picked = await vscode.window.showQuickPick(
      codes.map((c) => ({ label: `${c}  ${this.quotes.get(c)?.name ?? ''}`, code: c })),
      { canPickMany: true, placeHolder: '勾选要删除的自选股' },
    );
    if (!picked?.length) return;
    await this.deleteCodes(picked.map((p) => (p as { code: string }).code));
  }

  private async deleteCodes(codes: string[]): Promise<void> {
    for (const code of codes) {
      await this.store.removeCode(code);
      this.quotes.delete(code);
    }
    await this.table.refresh();
  }

  // ── 批量导入（Scratch 文档粘贴 → StockTextParser → 校验勾选）──

  async batchImport(): Promise<void> {
    const header = '" StockLite 批量导入\n// 粘贴股票文本（代码/名称/代码+名称混合，支持 600519 / sh600519 / 00700.HK / AAPL / 贵州茅台 等），\n// 粘贴后稍候自动解析；取消本通知或关闭编辑器即放弃。\n';
    const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: header });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    const pasted = await this.waitForPaste(doc);
    if (pasted === undefined) return;
    const tokens = parseStockText(pasted);
    if (tokens.length === 0) {
      await vscode.window.showWarningMessage('StockLite: 未从文本中解析出股票条目');
      return;
    }
    const candidates = await this.resolveCandidates(tokens);
    const items: (vscode.QuickPickItem & { tokenCode?: string })[] = candidates.map((c) => ({
      label: `${c.code ?? '???'}  ${c.displayName}`,
      description: c.status === 'ok' ? '可导入' : c.status === 'exists' ? '已在自选' : '未找到',
      picked: c.status === 'ok',
      tokenCode: c.code ?? undefined,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `解析出 ${candidates.length} 条，勾选要导入的项`,
    });
    if (!picked?.length) return;
    let addedCount = 0;
    for (const item of picked) {
      const code = item.tokenCode;
      if (!code) continue;
      if (await this.store.addCode(code, this.activeGroupId)) {
        const quote = this.quotes.get(code);
        if (!quote) {
          try {
            const [q] = await this.provider().fetchQuotes([code]);
            if (q) this.quotes.set(code, q);
          } catch { /* 行情稍后轮询补齐 */ }
        }
        addedCount++;
      }
    }
    await this.table.refresh();
    await vscode.window.showInformationMessage(`StockLite: 批量导入完成，新增 ${addedCount} 只`);
  }

  /** 等待用户在 scratch 编辑器粘贴：静默 1.2s 视为粘贴完成 */
  private waitForPaste(doc: vscode.TextDocument): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let dismissProgress: (() => void) | undefined;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        changeSub.dispose();
        closeSub.dispose();
        dismissProgress?.();
        // 关掉 scratch 编辑器；untitled 文档未保存，不会弹保存确认
        const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === doc.uri.toString());
        if (shown) void Promise.resolve(vscode.commands.executeCommand('workbench.action.closeActiveEditor')).catch(() => undefined);
        resolve(value);
      };
      const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== doc.uri.toString()) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const text = doc.getText();
          const body = text.startsWith('" StockLite 批量导入') ? text.slice(text.indexOf('\n')) : text;
          finish(body.trim() ? body : undefined);
        }, 1200);
      });
      const closeSub = vscode.workspace.onDidCloseTextDocument((d) => {
        if (d.uri.toString() === doc.uri.toString()) finish(undefined);
      });
      void Promise.resolve(vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'StockLite: 粘贴股票文本后自动解析（可取消）', cancellable: true },
        (_p, token) => new Promise<void>((r) => {
          dismissProgress = r;
          token.onCancellationRequested(() => { finish(undefined); });
        }),
      )).catch(() => undefined);
    });
  }

  private async resolveCandidates(tokens: ReturnType<typeof parseStockText>): Promise<ImportCandidate[]> {
    const provider = this.provider();
    const existing = new Set(this.store.effectiveCodes('all'));
    const codeTokens = tokens.filter((t) => t.code);
    const quotes = new Map<string, Quote>();
    if (codeTokens.length > 0) {
      try {
        for (const q of await provider.fetchQuotes([...new Set(codeTokens.map((t) => t.code!))])) {
          quotes.set(q.code, q);
        }
      } catch { /* 行情失败：带代码条目按未找到处理 */ }
    }
    const out: ImportCandidate[] = [];
    for (const token of tokens) {
      if (token.code) {
        const quote = quotes.get(token.code);
        out.push({
          code: quote ? token.code : token.code,
          displayName: quote?.name ?? token.name ?? token.code,
          status: !quote ? 'not_found' : existing.has(token.code) ? 'exists' : 'ok',
        });
        continue;
      }
      // 仅名称：搜索完全同名
      let resolved: ImportCandidate = { code: undefined, displayName: token.name ?? '', status: 'not_found' };
      if (token.name) {
        try {
          const hits = (await provider.search?.(token.name)) ?? [];
          const exact = hits.find((h) => h.name === token.name);
          if (exact) {
            resolved = { code: exact.code, displayName: exact.name, status: existing.has(exact.code) ? 'exists' : 'ok' };
          }
        } catch { /* 搜索失败按未找到 */ }
      }
      out.push(resolved);
    }
    return out;
  }

  // ── 分组管理 ─────────────────────────────────────────────

  async manageGroups(): Promise<void> {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(plus) 新建分组', id: 'create' },
        { label: '$(edit) 重命名分组', id: 'rename' },
        { label: '$(trash) 删除分组', id: 'delete' },
        { label: '$(move) 移动股票到分组', id: 'move' },
      ],
      { placeHolder: '管理分组' },
    );
    if (!action) return;
    const store = this.store;
    if (action.id === 'create') {
      const name = await promptText('新建分组', '分组名称');
      if (!name?.trim()) return;
      await store.setGroups([...store.groups(), { id: `g${Date.now().toString(36)}`, name: name.trim(), codes: [] }]);
    } else if (action.id === 'rename') {
      const group = await this.pickGroup('选择要重命名的分组');
      if (!group) return;
      const name = await promptText('重命名分组', '新名称');
      if (!name?.trim()) return;
      await store.setGroups(store.groups().map((g) => (g.id === group.id ? { ...g, name: name.trim() } : g)));
    } else if (action.id === 'delete') {
      const group = await this.pickGroup('选择要删除的分组');
      if (!group) return;
      // 组内股票回落扁平列表，避免误删自选
      const flat = store.watchlist();
      const merged = [...flat, ...group.codes.filter((c) => !flat.includes(c))];
      await store.setWatchlist(merged);
      await store.setGroups(store.groups().filter((g) => g.id !== group.id));
      if (this.activeGroupId === group.id) this.activeGroupId = 'all';
    } else if (action.id === 'move') {
      const all = store.effectiveCodes('all');
      if (all.length === 0) {
        await vscode.window.showInformationMessage('StockLite: 自选为空，没有可移动的股票');
        return;
      }
      const codePick = await vscode.window.showQuickPick(all.map((c) => ({ label: `${c}  ${this.quotes.get(c)?.name ?? ''}`, code: c })), { placeHolder: '选择股票' });
      if (!codePick) return;
      const code = (codePick as { code: string }).code;
      const groups = store.groups();
      const target = await vscode.window.showQuickPick(
        [{ label: '全部（扁平列表）', id: 'all' }, ...groups.map((g) => ({ label: g.name, id: g.id }))],
        { placeHolder: `把 ${code} 移动到…` },
      );
      if (!target) return;
      await store.removeCode(code);
      await store.addCode(code, target.id);
    }
    await this.table.refresh();
  }

  private async pickGroup(placeHolder: string): Promise<{ id: string; name: string; codes: string[] } | undefined> {
    const groups = this.store.groups();
    if (groups.length === 0) {
      await vscode.window.showInformationMessage('StockLite: 还没有分组，请先新建');
      return undefined;
    }
    return vscode.window.showQuickPick(groups.map((g) => ({ label: g.name, id: g.id, name: g.name, codes: g.codes })), { placeHolder });
  }

  // ── 交易记录（QuickInput 流程）─────────────────────────────

  async showTradeHistory(code?: string, name?: string): Promise<void> {
    if (!code) {
      const all = this.store.effectiveCodes('all');
      const pick = await vscode.window.showQuickPick(all.map((c) => ({ label: `${c}  ${this.quotes.get(c)?.name ?? ''}`, code: c })), { placeHolder: '选择股票查看交易记录' });
      if (!pick) return;
      code = (pick as { code: string }).code;
      name = this.quotes.get(code)?.name ?? code;
    }
    const store = this.store;
    const quote = this.quotes.get(code);
    const pos = effectivePosition(store.tradesFor(code), store.positionFor(code));
    type Item = vscode.QuickPickItem & { trade?: TradeRecord };
    const items: Item[] = [
      { label: '＋ 添加交易记录', id: 'add' } as Item,
      { label: pos.quantity > 0 ? `✎ 手填成本/数量（当前 ${formatNumber(pos.cost, 2)} × ${formatNumber(pos.quantity, 0)}）` : '✎ 手填成本/数量（当前无持仓）', id: 'manual' } as Item,
      { label: '', kind: vscode.QuickPickItemKind.Separator, id: 'sep' } as Item,
      ...[...store.tradesFor(code)].reverse().map((t) => ({
        label: `${t.date}  ${t.side === 'buy' ? '买入' : '卖出'} ${formatNumber(t.price, 2)} × ${formatNumber(t.quantity, 0)}`,
        description: [name, t.note, quote && t.date === todayShanghai() ? '今日' : ''].filter(Boolean).join(' · ') || undefined,
        trade: t,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `${code} ${name ?? ''} 的交易记录` });
    if (!picked) return;
    if ((picked as { id?: string }).id === 'add') {
      const record = await this.promptTradeRecord(code, name ?? code);
      if (record) {
        await store.setTrades([...store.trades(), record]);
        this.deps.bus.emit('tradesChanged', { codes: [code] });
        await this.table.refresh();
      }
      return;
    }
    if ((picked as { id?: string }).id === 'manual') {
      const cost = await promptNumber('手填成本价', '每股成本（元）', { min: 0 });
      if (cost === undefined) return;
      const quantity = await promptNumber('手填持仓数量', '股数（填 0 清除手填、恢复按交易记录推导）', { min: 0 });
      if (quantity === undefined) return;
      await store.setPosition(code, name ?? code, cost, quantity);
      await this.table.refresh();
      return;
    }
    if (picked.trade) {
      const yes = '删除';
      const confirm = await vscode.window.showWarningMessage(
        `确认删除 ${picked.trade.date} ${picked.trade.side === 'buy' ? '买入' : '卖出'} ${picked.trade.price}×${picked.trade.quantity}？`,
        { modal: true }, yes,
      );
      if (confirm === yes) {
        await store.setTrades(store.trades().filter((t) => t.id !== picked.trade!.id));
        this.deps.bus.emit('tradesChanged', { codes: [code] });
        await this.table.refresh();
      }
    }
  }

  private async promptTradeRecord(code: string, name: string): Promise<TradeRecord | undefined> {
    const sidePick = await vscode.window.showQuickPick(
      [{ label: '$(arrow-up) 买入', side: 'buy' }, { label: '$(arrow-down) 卖出', side: 'sell' }],
      { placeHolder: `${code} ${name}：买入还是卖出？` },
    ) as { side?: TradeRecord['side'] } | undefined;
    if (!sidePick?.side) return undefined;
    const price = await promptNumber('成交价', '成交单价（元）', { min: 0.000001 });
    if (price === undefined) return undefined;
    const quantity = await promptNumber('成交数量', '股数', { min: 1 });
    if (quantity === undefined) return undefined;
    const date = (await promptText('成交日期', 'YYYY-MM-DD', validateDate) ?? todayShanghai());
    const note = await promptText('备注（可留空）', '如：减仓做T');
    return {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      code, name, side: sidePick.side, price, quantity: Math.round(quantity), date,
      ...(note?.trim() ? { note: note.trim() } : {}),
    };
  }

  // ── 命令注册 ─────────────────────────────────────────────

  private registerCommands(): void {
    const reg = (id: string, fn: (...args: unknown[]) => unknown): void => {
      this.deps.context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    };
    // 只注册 package.json 已预声明的命令；“添加股票”入口 = 视图标题栏＋（viewAddRequested 事件）与工具栏按钮
    reg('stocklite.deleteItem', () => this.deleteItem());
    reg('stocklite.batchImport', () => this.batchImport());
    reg('stocklite.manageGroups', () => this.manageGroups());
    reg('stocklite.showTradeHistory', () => this.showTradeHistory());
  }
}

interface ImportCandidate {
  code?: string;
  displayName: string;
  status: 'ok' | 'exists' | 'not_found';
}

function priceDigitsOf(v: number): number {
  return Math.abs(v) >= 0.01 ? 3 : 6;
}

function nowText(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function extractCode(label: string): string | undefined {
  const m = /^[\w^.$]+(?=\s|\u3000|$)/.exec(label.replace(/^\$\(\S+\)\s*/, '').replace('直接添加代码 ', '').trim());
  return m?.[0];
}
