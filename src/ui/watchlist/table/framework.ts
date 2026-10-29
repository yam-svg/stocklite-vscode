/**
 * 通用行情表框架（S2 产出，S6 复用）：把一个 WebviewView 变成行情表宿主。
 * 用法：new TableTab(viewId, handlers) → register(context)；数据变化时调 refresh()。
 * webview 纯渲染，所有交互回传 handlers，由业务侧改状态后再 refresh()。
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { renderTableHtml } from './webviewHtml';
import type { RowAction, TableSnapshot, ToolbarCommand, WebviewRequest } from './types';

export interface TableTabHandlers {
  buildSnapshot(): TableSnapshot | Promise<TableSnapshot>;
  onToolbar(name: ToolbarCommand): void;
  onGroupSelect(groupId: string): void;
  /** 表头点击：业务侧用 nextSort() 更新排序态后 refresh() */
  onSort(columnKey: string): void;
  onReorder(codes: string[]): void;
  onRowOpen(code: string, name: string): void;
  onRowAction(action: RowAction, code: string, name: string): void;
}

export class TableTab {
  private view: vscode.WebviewView | undefined;
  private disposed = false;

  constructor(readonly viewId: string, private readonly handlers: TableTabHandlers) {}

  register(context: vscode.ExtensionContext): void {
    const provider: vscode.WebviewViewProvider = {
      resolveWebviewView: (view: vscode.WebviewView): void => {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = renderTableHtml(randomBytes(16).toString('base64'));
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

  /** 重新取模型并推送；webview 未就绪时静默跳过（ready 时会补一次） */
  async refresh(): Promise<void> {
    if (!this.view || this.disposed) return;
    try {
      const model = await this.handlers.buildSnapshot();
      if (this.disposed || !this.view) return;
      await this.view.webview.postMessage({ type: 'snapshot', model } satisfies { type: 'snapshot'; model: TableSnapshot });
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
