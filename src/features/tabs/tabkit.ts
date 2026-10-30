/**
 * S6 七个可选 tab 的公共底座：SimpleQuoteTab（ListTab 的通用装配）+ 共享小件。
 * 设计对齐 S2：webview 纯渲染，排序/格式化/网络全在宿主侧；各 tab 只实现
 * codesForView()/fetch() 两个抽象点 + 按需覆写 buildRow/工具栏/右键行为。
 * 数据取数直接 import S1 的 src/data 模块（S7 契约落地后可切 shared registry）。
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { FeatureDeps } from '../../extension';
import type { ColumnDef, Quote, SearchResultItem } from '../../shared/types';
import { cellOf } from '../../ui/watchlist/table/format';
import { nextSort, sortRows } from '../../ui/watchlist/table/sorting';
import { TableTab, type TableTabHandlers } from '../../ui/watchlist/table/framework';
import { renderTableHtml } from '../../ui/watchlist/table/webviewHtml';
import type { GroupVM, RowAction, RowVM, SortVM, TableSnapshot, ToolbarCommand, WebviewRequest } from '../../ui/watchlist/table/types';

export function nowText(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** 写 contributes.configuration（与 S5 settingsPanel 同一落点：全局作用域） */
export async function updateStockliteSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('stocklite').update(key, value, vscode.ConfigurationTarget.Global);
}

/** @types/vscode 旧版 executeCommand 返回 Thenable 无 .catch——统一 Promise.resolve 包 */
export async function runSetAlert(code: string, name: string): Promise<void> {
  try {
    await Promise.resolve(vscode.commands.executeCommand('stocklite.setAlert', { code, name }));
  } catch {
    await vscode.window.showInformationMessage('StockLite: 提醒功能由会话 S4 提供，暂未注册');
  }
}

/**
 * “搜索 + 直接添加”QuickPick（S2 添加股票流程的泛化版）：
 * 无空格输入给“直接添加”项，同时拉搜索结果；返回选中代码，取消返回 undefined。
 */
export async function pickToAdd(placeholder: string, search: (kw: string) => Promise<SearchResultItem[]>): Promise<string | undefined> {
  const pick = vscode.window.createQuickPick();
  pick.placeholder = placeholder;
  pick.matchOnDescription = true;
  pick.onDidChangeValue((value) => {
    void (async () => {
      const kw = value.trim();
      const items: vscode.QuickPickItem[] = [];
      if (kw && !/\s/.test(kw)) items.push({ label: `$(plus) 直接添加 ${kw}`, description: '不经搜索', alwaysShow: true });
      if (kw) {
        try {
          for (const hit of await search(kw)) {
            items.push({ label: `${hit.code}  ${hit.name}`, description: hit.market } as vscode.QuickPickItem & { code?: string } & Record<string, unknown>);
            (items[items.length - 1] as { code?: string }).code = hit.code;
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
  if (!chosen) return undefined;
  const typed = (chosen as { code?: string }).code;
  if (typed) return typed;
  const m = /^\S+/.exec(chosen.label.replace(/^\$\(\S+\)\s*/, '').replace('直接添加 ', '').trim());
  return m?.[0];
}

/** 多选清单 QuickPick：返回 undefined=取消，空数组=清空选择 */
export async function pickMany(items: vscode.QuickPickItem[], placeHolder: string): Promise<vscode.QuickPickItem[] | undefined> {
  return vscode.window.showQuickPick(items, { canPickMany: true, placeHolder, matchOnDescription: true });
}

// ── 可选 header 槽（G2 研判卡）─────────────────────────────────────────────
// 表格上方的一行小卡片：结构化 VM、webview 纯渲染（textContent，禁 innerHTML）。
// webview 模板归 S2/G1 文件，不直接改；HeaderTableTab 以"输出字符串组合注入"方式
// 在 renderTableHtml 的产物上挂 #fc-header 容器与渲染脚本，锚点缺失自动降级无 header。
// 协议转正提案（TableSnapshot.header + webview 原生渲染）见 docs/contract-changes.md。

export interface HeaderSegVM {
  text: string;
  /** 涨跌语义色：1=涨色 -1=跌色（跟随红涨绿跌设置）；与 hex 二选一 */
  dir?: -1 | 0 | 1;
  /** 十六进制固定色（#rgb/#rrggbb），如情绪档位色 */
  hex?: string;
  bold?: boolean;
}

export interface HeaderCardVM {
  /** 卡片主行：一段一个 span 横排 */
  segments: HeaderSegVM[];
  /** 悬停详情：每行一段，整体拼成 title 提示 */
  detail: HeaderSegVM[][];
}

export interface TableHeaderVM {
  cards: HeaderCardVM[];
}

export interface QuoteTabSnapshot extends TableSnapshot {
  header?: TableHeaderVM;
}

/** 在 renderTableHtml 产物上注入 header 槽；锚点缺失（模板被改）时原样返回 */
export function withHeaderSlot(html: string, nonce: string): string {
  const css = `
  #fc-header { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 6px 0; }
  #fc-header:empty { display: none; }
  .fc-card { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--vscode-panel-border);
             border-radius: 3px; padding: 2px 7px; font-size: 10px; cursor: default; white-space: nowrap; }
  .fc-b { font-weight: 600; }
`;
  const div = '<div id="fc-header"></div>';
  const js = `<script nonce="${nonce}">
(function () {
  var STYLE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
  function mk(s) {
    var el = document.createElement('span');
    el.textContent = s.text;
    if (s.dir === 1) el.classList.add('up');
    else if (s.dir === -1) el.classList.add('down');
    if (s.hex && STYLE.test(s.hex)) el.style.color = s.hex;
    if (s.bold) el.classList.add('fc-b');
    return el;
  }
  window.addEventListener('message', function (e) {
    var bar = document.getElementById('fc-header');
    if (!bar || !e.data || e.data.type !== 'snapshot') return;
    var header = e.data.model && e.data.model.header;
    bar.textContent = '';
    if (!header || !Array.isArray(header.cards)) return;
    header.cards.forEach(function (c) {
      var card = document.createElement('div');
      card.className = 'fc-card';
      (c.segments || []).forEach(function (s) { card.appendChild(mk(s)); });
      var tips = (c.detail || []).map(function (line) {
        return (line || []).map(function (s) { return s.text; }).join(' ');
      }).filter(function (t) { return t; }).join('\\n');
      if (tips) card.title = tips;
      bar.appendChild(card);
    });
  });
})();
</script>`;
  let out = html;
  if (!out.includes('</style>') || !out.includes('<div id="groups"></div>') || !out.includes('</body>')) {
    return out;   // 模板锚点变化：宁可不显示 header，也不产出半残页面
  }
  out = out.replace('</style>', css + '</style>');
  out = out.replace('<div id="groups"></div>', div + '\n  <div id="groups"></div>');
  out = out.replace('</body>', js + '\n</body>');
  return out;
}

/** SimpleQuoteTab 需要的宿主面（TableTab / HeaderTableTab 都满足；框架类保持不动） */
export interface TableHost {
  register(context: vscode.ExtensionContext): void;
  refresh(): Promise<void>;
}

/**
 * 带 header 槽的表格宿主：镜像 framework.ts TableTab 的装配逻辑（同一消息协议），
 * 仅把 html 装配换成 withHeaderSlot 版本。框架字段全 private、无法继承覆写，
 * 故独立实现；消息分发直接复用同一 handlers 对象。
 */
class HeaderTableTab implements TableHost {
  private view: vscode.WebviewView | undefined;
  private disposed = false;

  constructor(readonly viewId: string, private readonly handlers: TableTabHandlers) {}

  register(context: vscode.ExtensionContext): void {
    const provider: vscode.WebviewViewProvider = {
      resolveWebviewView: (view: vscode.WebviewView): void => {
        this.view = view;
        view.webview.options = { enableScripts: true };
        const nonce = randomBytes(16).toString('base64');
        view.webview.html = withHeaderSlot(renderTableHtml(nonce), nonce);
        view.webview.onDidReceiveMessage((msg: WebviewRequest) => this.onMessage(msg), undefined, context.subscriptions);
        view.onDidChangeVisibility(() => {
          if (view.visible) void this.refresh();
        }, undefined, context.subscriptions);
        void this.refresh();
      },
    };
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(this.viewId, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      { dispose: () => { this.disposed = true; this.view = undefined; } },
    );
  }

  async refresh(): Promise<void> {
    if (!this.view || this.disposed) return;
    try {
      const model = await this.handlers.buildSnapshot();
      if (this.disposed || !this.view) return;
      await this.view.webview.postMessage({ type: 'snapshot', model });
    } catch (err) {
      console.error(`[StockLite] 视图 ${this.viewId} 渲染失败`, err);
    }
  }

  private onMessage(msg: WebviewRequest): void {
    switch (msg.type) {
      case 'ready':
        void this.refresh();
        break;
      case 'toolbar':
        this.handlers.onToolbar(msg.name);
        break;
      case 'selectGroup':
        this.handlers.onGroupSelect(msg.groupId);
        break;
      case 'sort':
        this.handlers.onSort(msg.key);
        break;
      case 'reorder':
        this.handlers.onReorder(msg.codes);
        break;
      case 'rowOpen':
        this.handlers.onRowOpen(msg.code, msg.name);
        break;
      case 'rowAction':
        this.handlers.onRowAction(msg.action, msg.code, msg.name);
        break;
    }
  }
}

export interface TabKitOptions {
  /** package.json 预注册的 viewId（stocklite.xxx） */
  viewId: string;
  /** quotesUpdated 事件携带的 tabId（与 S1 调度器/描述符的 providerId 对齐） */
  tabId: string;
  /** 中文名：提示文案与状态行使用 */
  title: string;
  columns: ColumnDef[];
  emptyMessage: string;
  /** 轮询间隔（毫秒），按 S1 调度器同档位取值 */
  intervalMs(): number;
  /** tab 开关：关闭时不发网络请求（缺省=常开） */
  enabled?(): boolean;
  /** 表格上方卡片行（缺省=无 header，走原 TableTab 路径，公共行为零变化） */
  header?(): TableHeaderVM | undefined | Promise<TableHeaderVM | undefined>;
}

/**
 * 通用行情表 tab 底座：视图注册、事件订阅（viewAdd/refresh/configChanged）、
 * 轮询、三态排序、快照构建与默认右键/工具栏行为。
 */
export abstract class SimpleQuoteTab {
  protected readonly table: TableHost;
  protected quotes = new Map<string, Quote>();
  protected sort: SortVM | null = null;
  protected statusText = '等待首次刷新…';
  protected activeGroup = '';
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(protected readonly deps: FeatureDeps, protected readonly opts: TabKitOptions) {
    const handlers: TableTabHandlers = {
      buildSnapshot: () => this.snapshotForView(),
      onToolbar: (name) => void this.onToolbar(name),
      onGroupSelect: (groupId) => {
        this.onGroupSelect(groupId);
        void this.table.refresh();
      },
      onSort: (key) => {
        this.sort = nextSort(this.sort, key);
        void this.table.refresh();
      },
      onReorder: (codes) => void this.onReorder(codes),
      onRowOpen: (code, name) => this.onRowOpen(code, name),
      onRowAction: (action, code, name) => void this.onRowAction(action, code, name),
    };
    this.table = opts.header ? new HeaderTableTab(opts.viewId, handlers) : new TableTab(opts.viewId, handlers);
  }

  // ── 子类必须实现的两个取数点 ────────────────────────────────
  /** 当前视图要展示的行键（一般是代码） */
  protected abstract codesForView(): string[];
  /** 拉取行情并写入 this.quotes（键=行键），返回本轮拿到的 Quote 列表 */
  protected abstract fetch(codes: string[]): Promise<Quote[]>;

  // ── 生命周期 ──────────────────────────────────────────────
  async activate(): Promise<void> {
    await this.seedDefaults();
    this.table.register(this.deps.context);
    const sub = (d: vscode.Disposable): void => {
      this.deps.context.subscriptions.push(d);
    };
    const bus = this.deps.bus;
    sub(bus.on('viewAddRequested', ({ viewId }) => {
      if (viewId === this.opts.viewId) void this.onToolbar('add');
    }));
    sub(bus.on('refreshRequested', ({ viewId }) => {
      if (viewId === this.opts.viewId) void this.refreshQuotes();
    }));
    sub(bus.on('configChanged', ({ key }) => {
      // key ''=contributes.configuration 变更（含 tab 开关/轮询间隔/指数过滤）→ 重建定时器并重新取数
      if (key === '') {
        this.restartPolling();
        void this.refreshQuotes();
      } else {
        void this.table.refresh();
      }
    }));
    sub(new vscode.Disposable(() => this.stopPolling()));
    this.restartPolling();
    await this.refreshQuotes();
  }

  protected async seedDefaults(): Promise<void> {}

  // ── 轮询与刷新 ────────────────────────────────────────────
  protected enabled(): boolean {
    return this.opts.enabled ? this.opts.enabled() : true;
  }

  private restartPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.refreshQuotes(), Math.max(2000, this.opts.intervalMs()));
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  protected async refreshQuotes(): Promise<void> {
    if (!this.enabled()) {
      this.statusText = `${nowText()} 已更新`;
      await this.table.refresh();
      return;
    }
    try {
      const fresh = await this.fetch(this.codesForView());
      for (const q of fresh) this.quotes.set(q.code, q);
      this.statusText = `${nowText()} 已更新`;
      this.deps.bus.emit('quotesUpdated', { tabId: this.opts.tabId, quotes: fresh });
    } catch (err) {
      this.statusText = `${nowText()} 刷新失败：${err instanceof Error ? err.message : String(err)}`;
    }
    await this.table.refresh();
  }

  // ── 快照 ─────────────────────────────────────────────────
  protected columnsForView(): ColumnDef[] {
    return this.opts.columns;
  }

  /**
   * 快照总装配：配了 header 的 tab 额外算一份 header VM 并挂到快照上
   * （webview 不认识该字段时安全忽略）；其余 tab 走同步原路径、零开销。
   */
  protected snapshotForView(): TableSnapshot | Promise<TableSnapshot> {
    const snap = this.buildSnapshot();
    if (!this.opts.header) return snap;
    return Promise.resolve(this.opts.header()).then(
      (header) => (header ? ({ ...snap, header } as QuoteTabSnapshot) : snap),
    );
  }

  protected buildSnapshot(): TableSnapshot {
    const columns = this.columnsForView();
    const codes = this.codesForView();
    return {
      columns,
      rows: sortRows(codes.map((c) => this.buildRow(c)), this.sort, columns),
      groups: this.groupVms(),
      activeGroupId: this.activeGroupId(),
      sort: this.sort,
      colorUpIsRed: this.deps.config.colorUpIsRed(),
      statusText: `${this.statusText}${this.statusSuffix(codes.length)}`,
      emptyMessage: this.opts.emptyMessage,
    };
  }

  protected statusSuffix(count: number): string {
    return ` · 共 ${count} 条`;
  }

  protected buildRow(code: string): RowVM {
    const quote = this.quotes.get(code);
    const name = quote?.name ?? code.toUpperCase();
    const columns = this.columnsForView();
    if (!quote) {
      const cells = columns.map((c) => ({ text: c.key === 'code' ? code : c.key === 'name' ? name : '--' }));
      return { key: code, name, cells };
    }
    return { key: code, name, cells: columns.map((col) => this.cellFor(col, quote)) };
  }

  protected cellFor(col: ColumnDef, quote: Quote): RowVM['cells'][number] {
    return cellOf(col, quote);
  }

  // ── 分组（默认无 tab 条）───────────────────────────────────
  protected groupVms(): GroupVM[] {
    return [];
  }

  protected activeGroupId(): string {
    return this.activeGroup;
  }

  protected onGroupSelect(groupId: string): void {
    this.activeGroup = groupId;
  }

  // ── 交互默认实现（子类按需覆写）─────────────────────────────
  protected async onToolbar(name: ToolbarCommand): Promise<void> {
    if (name === 'refresh') return this.refreshQuotes();
    if (name === 'add') return this.onAdd();
    await this.unsupported(name);
  }

  protected async onAdd(): Promise<void> {
    await vscode.window.showInformationMessage(`StockLite: ${this.opts.title}页为内置清单，不支持添加`);
  }

  protected async unsupported(name: ToolbarCommand): Promise<void> {
    const label = name === 'batchImport' ? '批量导入' : '分组管理';
    await vscode.window.showInformationMessage(`StockLite: ${this.opts.title}页不支持${label}`);
  }

  protected async onRowAction(action: RowAction, code: string, name: string): Promise<void> {
    switch (action) {
      case 'openChart':
        this.onRowOpen(code, name);
        return;
      case 'setAlert':
        return runSetAlert(code, name);
      case 'trades':
        await vscode.window.showInformationMessage('StockLite: 交易记录仅自选股 tab 支持');
        return;
      case 'delete':
        return this.deleteCode(code);
    }
  }

  protected onRowOpen(code: string, name: string): void {
    this.deps.bus.emit('openChart', { code, name });
  }

  protected async deleteCode(code: string): Promise<void> {
    void code;
    await vscode.window.showInformationMessage(`StockLite: ${this.opts.title}页为内置榜单，行不可删除`);
  }

  protected async onReorder(codes: string[]): Promise<void> {
    void codes;
  }
}
