/**
 * 通用行情表 webview 的 HTML 模板（S2 产出）。
 * 纯渲染器：宿主 postMessage 一份 TableSnapshot，本脚本按模型画表格并回传交互事件；
 * 排序/格式化/业务判断全在宿主侧（见 sorting.ts / format.ts）。
 * 全部资源内联（CSP 只放 nonce 脚本 + 内联样式），主题色走 --vscode-* 变量自动跟随明暗。
 */

export function renderTableHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --row-h: 22px; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground);
         background: var(--vscode-sideBar-background); overflow-x: hidden; }
  #toolbar { display: flex; gap: 4px; padding: 4px 6px; align-items: center;
             border-bottom: 1px solid var(--vscode-panel-border); }
  #toolbar button { background: transparent; border: 1px solid transparent; color: var(--vscode-foreground);
             border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: 11px; }
  #toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
  #toolbar .spacer { flex: 1; }
  #status { color: var(--vscode-descriptionForeground); font-size: 10px; white-space: nowrap;
            overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
  #groups { display: flex; gap: 2px; padding: 3px 6px 0; flex-wrap: wrap; }
  #groups button { background: transparent; border: none; color: var(--vscode-descriptionForeground);
            cursor: pointer; font-size: 11px; padding: 2px 8px; border-radius: 8px; }
  #groups button.active { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  #empty { padding: 24px 12px; text-align: center; color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead th { position: sticky; top: 0; z-index: 2; background: var(--vscode-sideBar-background);
             font-weight: 400; color: var(--vscode-descriptionForeground); font-size: 11px;
             text-align: right; padding: 2px 6px; cursor: pointer; user-select: none;
             border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap;
             overflow: hidden; text-overflow: ellipsis; }
  thead th.left { text-align: left; }
  thead th .arrow { font-size: 9px; }
  tbody td { height: var(--row-h); padding: 0 6px; text-align: right; white-space: nowrap;
             overflow: hidden; text-overflow: ellipsis; line-height: var(--row-h); }
  tbody td.left { text-align: left; }
  tbody tr:nth-child(even) { background: var(--vscode-list-hoverBackground); opacity: 0.55; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
  tbody tr.dragging { opacity: 0.4; }
  tbody tr.drop-above { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  .up { color: var(--up-color); } .down { color: var(--down-color); }
  body.red-up { --up-color: var(--vscode-charts-red); --down-color: var(--vscode-charts-green); }
  body.green-up { --up-color: var(--vscode-charts-green); --down-color: var(--vscode-charts-red); }
  .sub { font-size: 9px; color: var(--vscode-descriptionForeground); margin-left: 2px; }
  #menu { position: fixed; display: none; z-index: 10; background: var(--vscode-menu-background);
          color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border);
          box-shadow: 0 2px 8px rgba(0,0,0,.4); padding: 4px 0; min-width: 120px; }
  #menu div { padding: 4px 14px; cursor: pointer; }
  #menu div:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
</style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-add" title="添加自选">＋ 添加</button>
    <button id="btn-import" title="批量导入（粘贴文本解析）">导入</button>
    <button id="btn-groups" title="管理分组">分组</button>
    <span class="spacer"></span>
    <span id="status"></span>
  </div>
  <div id="groups"></div>
  <div id="empty" hidden></div>
  <table><thead id="thead"></thead><tbody id="tbody"></tbody></table>
  <div id="menu"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const post = (msg) => vscode.postMessage(msg);
  const $ = (id) => document.getElementById(id);
  let model = null;
  let dragKey = null;

  $('btn-add').onclick = () => post({ type: 'toolbar', name: 'add' });
  $('btn-import').onclick = () => post({ type: 'toolbar', name: 'batchImport' });
  $('btn-groups').onclick = () => post({ type: 'toolbar', name: 'manageGroups' });

  function fmtHeader() {
    const thead = $('thead');
    thead.textContent = '';
    if (!model || model.rows.length === 0) return;
    const tr = document.createElement('tr');
    model.columns.forEach((col) => {
      const th = document.createElement('th');
      if (col.align === 'left') th.className = 'left';
      if (col.width) th.style.width = col.width + 'px';
      let label = col.title;
      if (model.sort && model.sort.key === col.key) {
        label += ' ' + (model.sort.dir === 'asc' ? '▲' : '▼');
      }
      th.textContent = label;
      th.title = col.sortable === false ? col.title : '点击切换 升序/降序/默认';
      if (col.sortable !== false) {
        th.onclick = () => post({ type: 'sort', key: col.key });
      }
      tr.appendChild(th);
    });
    thead.appendChild(tr);
  }

  function fmtGroups() {
    const bar = $('groups');
    bar.textContent = '';
    (model.groups || []).forEach((g) => {
      const b = document.createElement('button');
      b.textContent = g.name;
      if (g.id === model.activeGroupId) b.className = 'active';
      b.onclick = () => post({ type: 'selectGroup', groupId: g.id });
      bar.appendChild(b);
    });
  }

  // 拖拽仅在无排序列时启用，落点后按当前可见行整体重排
  function canReorder() { return !model.sort; }

  function fmtRows() {
    const tbody = $('tbody');
    tbody.textContent = '';
    const empty = $('empty');
    if (!model || model.rows.length === 0) {
      empty.hidden = false;
      empty.textContent = model ? model.emptyMessage : '';
      return;
    }
    empty.hidden = true;
    model.rows.forEach((row) => {
      const tr = document.createElement('tr');
      if (canReorder()) tr.draggable = true;
      tr.dataset.key = row.key;
      row.cells.forEach((cell, ci) => {
        const td = document.createElement('td');
        const col = model.columns[ci];
        td.textContent = cell.text;
        if (col && col.align === 'left') td.className = 'left';
        if (cell.dir === 1) td.classList.add('up');
        else if (cell.dir === -1) td.classList.add('down');
        if (cell.sub) {
          const s = document.createElement('span');
          s.className = 'sub';
          s.textContent = cell.sub;
          td.appendChild(s);
        }
        tr.appendChild(td);
      });
      tr.ondblclick = () => post({ type: 'rowOpen', code: row.key, name: row.name });
      tr.oncontextmenu = (e) => { openMenu(e, row); return false; };
      tr.ondragstart = (e) => { dragKey = row.key; tr.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
      tr.ondragend = () => { tr.classList.remove('dragging'); clearDropMarks(); };
      tr.ondragover = (e) => { if (canReorder()) { e.preventDefault(); clearDropMarks(); tr.classList.add('drop-above'); } };
      tr.ondrop = (e) => {
        e.preventDefault();
        clearDropMarks();
        if (!dragKey || dragKey === row.key) return;
        const keys = model.rows.map((r) => r.key);
        const from = keys.indexOf(dragKey);
        if (from < 0) return;
        keys.splice(from, 1);
        // 落点样式是 drop-above：统一插到目标行之前
        keys.splice(keys.indexOf(row.key), 0, dragKey);
        post({ type: 'reorder', codes: keys });
      };
      tbody.appendChild(tr);
    });
  }

  function clearDropMarks() {
    document.querySelectorAll('tr.drop-above').forEach((el) => el.classList.remove('drop-above'));
  }

  const MENU_ITEMS = [
    ['openChart', '打开图表'],
    ['setAlert', '设置提醒'],
    ['trades', '交易记录'],
    ['delete', '删除'],
  ];
  let menuRow = null;
  function openMenu(e, row) {
    menuRow = row;
    const menu = $('menu');
    menu.textContent = '';
    MENU_ITEMS.forEach(([action, label]) => {
      const item = document.createElement('div');
      item.textContent = label;
      item.onclick = () => { hideMenu(); post({ type: 'rowAction', action, code: row.key, name: row.name }); };
      menu.appendChild(item);
    });
    menu.style.display = 'block';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 140) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 110) + 'px';
  }
  function hideMenu() { $('menu').style.display = 'none'; menuRow = null; }
  document.addEventListener('click', hideMenu);
  window.addEventListener('blur', hideMenu);

  function render(next) {
    model = next;
    document.body.className = model.colorUpIsRed ? 'red-up' : 'green-up';
    $('status').textContent = model.statusText || '';
    fmtGroups();
    fmtHeader();
    fmtRows();
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'snapshot') render(msg.model);
  });
  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
