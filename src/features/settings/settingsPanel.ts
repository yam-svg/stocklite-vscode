/**
 * 设置页 Webview Panel（S5）。对应 JetBrains 版 StockliteConfigurable 的等价物。
 * 设置项一律读写 contributes.configuration（Global 作用域），保证 tab 显隐的
 * `when: config.stocklite.tabs.*` 与外部编辑 settings.json 双向一致；
 * 持久数据（反馈邮箱/设备号）走 globalState。
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import type { FeatureDeps } from '../../extension';
import { FeedbackClient, type FeedbackItem } from './feedbackApi';
import { GLOBAL_INDEXES, DEFAULT_INDEXES, OPTIONAL_INDEXES } from './indexCatalog';
import { openDonatePanel } from './donatePanel';
import { openOnboardingPanel } from './onboarding';
import { runExportConfig, runImportConfig } from './configCommands';

const TAB_KEYS = ['fund', 'future', 'global', 'sector', 'ipo', 'us', 'crypto'] as const;
type TabKey = (typeof TAB_KEYS)[number];

/** 反馈 device id / 邮箱的 globalState 键（键名与 JetBrains 版 StockliteState 字段对齐；S7 建议上收 StateKeys） */
const FEEDBACK_DEVICE_KEY = 'feedbackDeviceId';
const FEEDBACK_EMAIL_KEY = 'feedbackEmail';

interface StateSnapshot {
  pollIntervalSeconds: number;
  colorUp: 'red' | 'green';
  statusBarEnabled: boolean;
  statusBarCodes: string;
  tabs: Record<TabKey, boolean>;
  hidden: string[];
  enabledOptional: string[];
  feedbackEmail: string;
  donateAvailable: boolean;
  focus: string;
}

export class SettingsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private pendingFocus = '';
  private feedbackItems: FeedbackItem[] = [];
  private feedbackLoading = false;
  readonly feedback: FeedbackClient;

  constructor(private readonly deps: FeatureDeps) {
    this.feedback = new FeedbackClient({
      store: {
        get: () => deps.config.get<string>(FEEDBACK_DEVICE_KEY, ''),
        set: async (v) => {
          // 反馈设备号是内部标识，不走 configChanged 广播
          await deps.context.globalState.update(FEEDBACK_DEVICE_KEY, v);
        },
      },
    });
    deps.context.subscriptions.push(
      deps.bus.on('configChanged', () => this.pushState()),
    );
  }

  open(focus = ''): void {
    this.pendingFocus = focus;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        'stocklite.settings', 'StockLite 设置', vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = this.html(panel.webview);
      panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
      panel.onDidDispose(() => { this.panel = undefined; });
      this.panel = panel;
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
    }
    void this.refreshFeedback();
    this.pushState();
  }

  private snapshot(): StateSnapshot {
    const cfg = this.deps.config;
    const codes = cfg.setting<string[]>('statusBar.codes') ?? [];
    const donateOk =
      existsSync(this.deps.context.asAbsolutePath('webview/settings/donate/wechat.png')) ||
      existsSync(this.deps.context.asAbsolutePath('webview/settings/donate/alipay.png'));
    return {
      pollIntervalSeconds: cfg.setting<number>('pollIntervalSeconds') ?? 5,
      colorUp: (cfg.setting<string>('colorUp') === 'green' ? 'green' : 'red'),
      statusBarEnabled: cfg.setting<boolean>('statusBar.enabled') ?? true,
      statusBarCodes: codes.join(', '),
      tabs: Object.fromEntries(TAB_KEYS.map((k) => [k, cfg.setting<boolean>(`tabs.${k}`) ?? false])) as Record<TabKey, boolean>,
      hidden: cfg.setting<string[]>('indexes.hidden') ?? [],
      enabledOptional: cfg.setting<string[]>('indexes.enabledOptional') ?? [],
      feedbackEmail: cfg.get<string>(FEEDBACK_EMAIL_KEY, ''),
      donateAvailable: donateOk,
      focus: this.pendingFocus,
    };
  }

  private pushState(): void {
    this.panel?.webview.postMessage({ type: 'state', payload: this.snapshot() });
  }

  private pushFeedback(): void {
    this.panel?.webview.postMessage({ type: 'feedback', items: this.feedbackItems, loading: this.feedbackLoading });
  }

  private toast(text: string): void {
    this.panel?.webview.postMessage({ type: 'toast', text });
  }

  private async refreshFeedback(): Promise<void> {
    this.feedbackLoading = true;
    this.pushFeedback();
    const items = await this.feedback.fetchMine();
    this.feedbackLoading = false;
    if (items === null) this.toast('反馈历史加载失败，请稍后重试');
    this.feedbackItems = items ?? [];
    this.pushFeedback();
  }

  private async updateSetting(key: string, value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration('stocklite').update(key, value, vscode.ConfigurationTarget.Global);
  }

  private async onMessage(msg: { type?: string; [k: string]: unknown }): Promise<void> {
    const type = msg.type;
    if (type === 'setSetting') {
      const key = String(msg.key ?? '');
      const value = msg.value;
      if (key === 'pollIntervalSeconds' && typeof value === 'number') {
        await this.updateSetting('pollIntervalSeconds', Math.max(2, Math.floor(value)));
      } else if (key === 'colorUp' && (value === 'red' || value === 'green')) {
        await this.updateSetting('colorUp', value);
      } else if (key === 'statusBar.enabled' && typeof value === 'boolean') {
        await this.updateSetting('statusBar.enabled', value);
      } else if (key === 'statusBar.codes' && typeof value === 'string') {
        const list = value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
        await this.updateSetting('statusBar.codes', list);
      } else if (/^tabs\.[a-z]+$/.test(key) && TAB_KEYS.includes(key.slice(5) as TabKey) && typeof value === 'boolean') {
        await this.updateSetting(key, value);
      }
      return;
    }
    if (type === 'indexesSave') {
      const known = new Set(GLOBAL_INDEXES.map((i) => i.symbol));
      const clean = (v: unknown) =>
        Array.isArray(v) ? [...new Set(v.map(String).filter((s) => known.has(s)))].sort() : undefined;
      const hidden = clean(msg.hidden);
      const enabled = clean(msg.enabledOptional);
      if (hidden) await this.updateSetting('indexes.hidden', hidden);
      if (enabled) await this.updateSetting('indexes.enabledOptional', enabled);
      return;
    }
    if (type === 'export') { await runExportConfig(this.deps); return; }
    if (type === 'import') {
      await runImportConfig(this.deps);
      this.pushState();
      return;
    }
    if (type === 'donate') { openDonatePanel(this.deps); return; }
    if (type === 'onboarding') { openOnboardingPanel(this.deps); return; }
    if (type === 'feedbackRefresh') { await this.refreshFeedback(); return; }
    if (type === 'feedbackSubmit') {
      const content = String(msg.content ?? '').trim();
      const email = String(msg.email ?? '').trim();
      if (!content) { this.toast('反馈内容不能为空'); return; }
      await this.deps.context.globalState.update(FEEDBACK_EMAIL_KEY, email);
      const ok = await this.feedback.submit(content, email);
      this.toast(ok ? '反馈已提交，感谢！可在下方历史中查看回复' : '提交失败：网络或后端异常，请稍后重试');
      if (ok) await this.refreshFeedback();
      return;
    }
    if (type === 'feedbackDelete') {
      const ok = await this.feedback.delete(String(msg.id ?? ''));
      this.toast(ok ? '已删除' : '删除失败');
      if (ok) await this.refreshFeedback();
    }
  }

  // ── Webview HTML（内联 CSS/JS + CSP nonce，模式与 S0 placeholder 一致） ──

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = webview.cspSource;
    const catalog = JSON.stringify({
      main: DEFAULT_INDEXES.map((i) => ({ s: i.symbol, cn: i.nameCn, en: i.nameEn })),
      more: OPTIONAL_INDEXES.map((i) => ({ s: i.symbol, cn: i.nameCn, en: i.nameEn })),
    }).replace(/</g, '\\u003c');
    const stateJson = JSON.stringify(this.snapshot()).replace(/</g, '\\u003c');
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${csp} data:;">
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; padding: 16px 20px 48px; font-size: 13px; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 4px 0 14px; }
  h2 { font-size: 14px; margin: 22px 0 8px; padding-bottom: 4px;
       border-bottom: 1px solid var(--vscode-panel-border); }
  .row { display: flex; align-items: center; gap: 8px; margin: 7px 0; flex-wrap: wrap; }
  .desc { color: var(--vscode-descriptionForeground); font-size: 12px; }
  input[type=number] { width: 70px; }
  input[type=text] { flex: 1 1 320px; min-width: 220px; }
  input, textarea, select, button { font-family: inherit; font-size: 13px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 3px 7px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; padding: 4px 12px; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.subtle { background: var(--vscode-button-secondaryBackground);
                  color: var(--vscode-button-secondaryForeground); }
  input[type=radio], input[type=checkbox] { accent-color: var(--vscode-button-background); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 4px 16px; }
  .grid label { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
  .subtabs { display: flex; gap: 4px; margin: 8px 0 4px; }
  .subtabs span { padding: 3px 12px; border-radius: 3px 3px 0 0; cursor: pointer;
                  border: 1px solid var(--vscode-panel-border); border-bottom: none; }
  .subtabs span.on { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
  textarea { width: 100%; box-sizing: border-box; min-height: 66px; resize: vertical; }
  .fb-item { border: 1px solid var(--vscode-panel-border); border-radius: 4px;
             padding: 8px 10px; margin: 8px 0; }
  .fb-item .meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .fb-reply { margin-top: 6px; padding: 6px 8px; border-radius: 3px;
              background: var(--vscode-textBlockQuote-background); }
  #toast { position: fixed; right: 18px; bottom: 18px; max-width: 420px; padding: 8px 14px;
           border-radius: 4px; background: var(--vscode-notifications-background, #333);
           color: var(--vscode-notifications-foreground, #eee);
           border: 1px solid var(--vscode-notifications-border, #555);
           box-shadow: 0 2px 8px rgba(0,0,0,.35); display: none; z-index: 9; }
  .flash { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>StockLite 设置</h1>

  <h2>常规</h2>
  <div class="row">
    <label>行情轮询间隔 <input id="poll" type="number" min="2" step="1"> 秒</label>
    <span class="desc">（最小 2 秒）</span>
  </div>
  <div class="row">
    <span>涨跌配色</span>
    <label><input type="radio" name="colorUp" id="cuRed" value="red"> 红涨绿跌</label>
    <label><input type="radio" name="colorUp" id="cuGreen" value="green"> 绿涨红跌</label>
  </div>

  <h2>状态栏</h2>
  <div class="row"><label><input id="sbEnabled" type="checkbox"> 在状态栏显示行情</label></div>
  <div class="row">
    <input id="sbCodes" type="text" placeholder="轮播代码，逗号分隔，如 sh000001,^GSPC">
    <span class="desc">留空则从自选股/全球指数自动选取</span>
  </div>

  <h2>标签页</h2>
  <div class="row desc">股票页始终显示；勾选后立即生效（关闭的页从侧边栏移除）。</div>
  <div class="grid" id="tabs"></div>

  <h2 id="sec-indexes">全球指数</h2>
  <div class="row desc">常用指数默认全部显示；更多指数按需开启。</div>
  <div class="subtabs">
    <span data-tab="main" class="on">常用指数</span><span data-tab="more">更多指数</span>
  </div>
  <div class="row">
    <button class="subtle" id="idxAll">全选</button>
    <button class="subtle" id="idxNone">全不选</button>
  </div>
  <div class="grid" id="idxGrid"></div>

  <h2 id="sec-data">数据</h2>
  <div class="row">
    <button id="btnExport">导出配置…</button>
    <button id="btnImport" class="subtle">导入配置…</button>
    <button id="btnOnb" class="subtle">新手指引</button>
  </div>
  <div class="row desc">导出/导入兼容 JetBrains 版 StockLite 备份（stocklite_backup.json），可跨 IDE 迁移。</div>

  <h2 id="sec-support">支持作者</h2>
  <div class="row">
    <button id="btnDonate" class="subtle">查看赞赏码（微信 / 支付宝）</button>
    <span class="desc">扫码自愿打赏：你的支持是 StockLite 持续更新的动力 ❤</span>
  </div>

  <h2 id="sec-feedback">意见反馈</h2>
  <textarea id="fbText" placeholder="写下你的建议或遇到的问题（可回复交流）"></textarea>
  <div class="row">
    <input id="fbEmail" type="text" placeholder="邮箱（选填，方便回复通知你）">
    <button id="fbSend">提交反馈</button>
    <button id="fbRefresh" class="subtle">刷新历史</button>
  </div>
  <div id="fbList" class="desc">加载中…</div>
</div>
<div id="toast"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const CATALOG = ${catalog};
  const TAB_LABELS = { fund: '基金', future: '期货', global: '全球指数', sector: '板块', ipo: '新股', us: '美股', crypto: '加密币' };
  const TAB_DEFAULTS = { fund: true, future: true, global: true, sector: false, ipo: false, us: false, crypto: false };
  let idxTab = 'main';
  let idx = { main: [], more: [] };  // 勾选状态
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);
  const post = (m) => vscode.postMessage(m);
  const focused = (el) => document.activeElement === el;

  function toast(text) {
    const t = $('toast');
    t.textContent = text; t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3500);
  }

  // ── 标签页复选框 ──
  const tabsBox = $('tabs');
  const tabEls = {};
  Object.keys(TAB_LABELS).forEach((k) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.dataset.tab = k;
    cb.addEventListener('change', () => post({ type: 'setSetting', key: 'tabs.' + k, value: cb.checked }));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + TAB_LABELS[k]));
    tabsBox.appendChild(label);
    tabEls[k] = cb;
  });

  // ── 指数双轨 ──
  function renderIndexGrid() {
    const grid = $('idxGrid');
    grid.textContent = '';
    CATALOG[idxTab].forEach((item) => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = idx[idxTab].indexOf(item.s) >= 0;
      cb.addEventListener('change', () => {
        const arr = idx[idxTab];
        const i = arr.indexOf(item.s);
        if (cb.checked && i < 0) arr.push(item.s);
        if (!cb.checked && i >= 0) arr.splice(i, 1);
        postIndexes();
      });
      label.appendChild(cb);
      const txt = document.createElement('span');
      txt.textContent = ' ' + item.cn + ' (' + item.en + ')';
      label.appendChild(txt);
      grid.appendChild(label);
    });
  }
  function postIndexes() {
    post({
      type: 'indexesSave',
      // 常用 tab 存的是"勾选显示"，落盘取反成 hidden；更多 tab 即 enabledOptional
      hidden: CATALOG.main.filter((i) => idx.main.indexOf(i.s) < 0).map((i) => i.s),
      enabledOptional: idx.more,
    });
  }
  document.querySelectorAll('.subtabs span').forEach((el) => {
    el.addEventListener('click', () => {
      idxTab = el.dataset.tab;
      document.querySelectorAll('.subtabs span').forEach((x) => x.classList.toggle('on', x === el));
      renderIndexGrid();
    });
  });
  $('idxAll').addEventListener('click', () => {
    idx[idxTab] = CATALOG[idxTab].map((i) => i.s); renderIndexGrid(); postIndexes();
  });
  $('idxNone').addEventListener('click', () => {
    idx[idxTab] = []; renderIndexGrid(); postIndexes();
  });

  // ── 基础设置事件 ──
  let pollTimer = null;
  $('poll').addEventListener('change', (e) => {
    clearTimeout(pollTimer);
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) pollTimer = setTimeout(() => post({ type: 'setSetting', key: 'pollIntervalSeconds', value: v }), 300);
  });
  $('cuRed').addEventListener('change', () => post({ type: 'setSetting', key: 'colorUp', value: 'red' }));
  $('cuGreen').addEventListener('change', () => post({ type: 'setSetting', key: 'colorUp', value: 'green' }));
  $('sbEnabled').addEventListener('change', (e) => post({ type: 'setSetting', key: 'statusBar.enabled', value: e.target.checked }));
  $('sbCodes').addEventListener('change', (e) => post({ type: 'setSetting', key: 'statusBar.codes', value: e.target.value }));
  $('btnExport').addEventListener('click', () => post({ type: 'export' }));
  $('btnImport').addEventListener('click', () => post({ type: 'import' }));
  $('btnDonate').addEventListener('click', () => post({ type: 'donate' }));
  $('btnOnb').addEventListener('click', () => post({ type: 'onboarding' }));
  $('fbSend').addEventListener('click', () => post({ type: 'feedbackSubmit', content: $('fbText').value, email: $('fbEmail').value }));
  $('fbRefresh').addEventListener('click', () => post({ type: 'feedbackRefresh' }));

  function applyState(s) {
    if (!focused($('poll'))) $('poll').value = s.pollIntervalSeconds;
    $('cuRed').checked = s.colorUp === 'red';
    $('cuGreen').checked = s.colorUp === 'green';
    $('sbEnabled').checked = s.statusBarEnabled;
    if (!focused($('sbCodes'))) $('sbCodes').value = s.statusBarCodes;
    Object.keys(tabEls).forEach((k) => {
      tabEls[k].checked = typeof s.tabs[k] === 'boolean' ? s.tabs[k] : TAB_DEFAULTS[k];
    });
    const known = (list) => (list || []).filter((x) => typeof x === 'string');
    idx.main = CATALOG.main.filter((i) => known(s.hidden).indexOf(i.s) < 0).map((i) => i.s);
    idx.more = known(s.enabledOptional);
    renderIndexGrid();
    if (!focused($('fbEmail'))) $('fbEmail').value = s.feedbackEmail;
    if (s.focus) {
      const sec = $('sec-' + s.focus);
      if (sec) {
        sec.scrollIntoView({ behavior: 'smooth' });
        sec.classList.add('flash');
        setTimeout(() => sec.classList.remove('flash'), 1600);
      }
    }
  }

  function renderFeedback(items, loading) {
    const box = $('fbList');
    box.textContent = '';
    if (loading) { box.textContent = '加载中…'; return; }
    if (!items.length) { box.textContent = '暂无历史反馈。'; return; }
    items.forEach((it) => {
      const card = document.createElement('div'); card.className = 'fb-item';
      const head = document.createElement('div'); head.className = 'meta';
      head.textContent = it.time + (it.email ? ' · ' + it.email : '');
      const body = document.createElement('div'); body.textContent = it.content;
      card.appendChild(head); card.appendChild(body);
      if (it.reply) {
        const r = document.createElement('div'); r.className = 'fb-reply';
        r.textContent = '回复（' + it.repliedTime + '）：' + it.reply;
        card.appendChild(r);
      }
      // VSCode webview 不支持 confirm()，用两连击代替二次确认
      const del = document.createElement('button'); del.className = 'subtle'; del.textContent = '删除';
      del.style.marginTop = '6px';
      let armed = false;
      del.addEventListener('click', () => {
        if (!armed) {
          armed = true;
          del.textContent = '再点一次确认删除';
          setTimeout(() => { armed = false; del.textContent = '删除'; }, 2500);
          return;
        }
        post({ type: 'feedbackDelete', id: it.id });
      });
      card.appendChild(del);
      box.appendChild(card);
    });
  }

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'state') applyState(m.payload);
    if (m.type === 'feedback') renderFeedback(m.items || [], !!m.loading);
    if (m.type === 'toast') toast(String(m.text || ''));
  });

  applyState(${stateJson});
})();
</script>
</body>
</html>`;
  }
}

let instance: SettingsPanel | undefined;

export function openSettingsPanel(deps: FeatureDeps, focus = ''): void {
  if (!instance) instance = new SettingsPanel(deps);
  instance.open(focus);
}
