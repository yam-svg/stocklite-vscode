/* StockLite 盈亏日历 webview（S3）：走势折线(SVG) + 月历热图 + 当日各股明细。
 * 数据只来自宿主 {type:'data'} 消息；颜色深浅按当日盈亏绝对值缩放，红涨绿跌跟随设置。 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  let data = null;
  let view = 'ALL'; // ALL 或股票代码
  let month = null; // 'YYYY-MM'
  let selectedDate = null;
  let colorUpIsRed = true;

  const UP_RED = '#e14b4b';
  const UP_GREEN = '#21a366';
  const upColor = () => (colorUpIsRed ? UP_RED : UP_GREEN);
  const downColor = () => (colorUpIsRed ? UP_GREEN : UP_RED);
  const pnlColor = (v) => (v > 0 ? upColor() : v < 0 ? downColor() : 'var(--vscode-descriptionForeground)');

  function fmtMoney(v) {
    if (v === undefined || v === null || isNaN(v)) return '--';
    const abs = Math.abs(v);
    const sign = v >= 0 ? '+' : '-';
    if (abs >= 1e8) return sign + (abs / 1e8).toFixed(2) + '亿';
    if (abs >= 1e4) return sign + (abs / 1e4).toFixed(2) + '万';
    return sign + abs.toFixed(2);
  }

  function monthOf(dateStr) { return dateStr.slice(0, 7); }

  /** 当前视图的 {dates, dayByDate, details, cumByDate} */
  function currentView() {
    if (!data) return null;
    if (view === 'ALL') return data.portfolio;
    const stock = data.stocks.find((s) => s.code === view);
    if (!stock) return null;
    const dayByDate = {}, cumByDate = {}, details = {};
    stock.rows.forEach((r) => {
      dayByDate[r.date] = r.dayPnl;
      cumByDate[r.date] = r.cumPnl;
      if (Math.abs(r.dayPnl) > 1e-9) details[r.date] = [{ name: stock.name, pnl: r.dayPnl, pct: r.dayPct }];
    });
    return { dates: stock.rows.map((r) => r.date), cum: stock.rows.map((r) => r.cumPnl), dayByDate, cumByDate, details };
  }

  // ── 顶部：选择器 + 汇总 ──
  function renderHeader() {
    const sel = $('stockSel');
    sel.textContent = '';
    const all = document.createElement('option');
    all.value = 'ALL';
    all.textContent = '全部持仓';
    sel.appendChild(all);
    (data ? data.stocks : []).forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.code;
      opt.textContent = s.name + ' ' + s.code;
      sel.appendChild(opt);
    });
    sel.value = view;
  }

  function renderSummary(v) {
    const el = $('summary');
    if (!v || v.dates.length === 0) { el.textContent = '暂无持仓盈亏数据（先在自选股录入成交记录）'; return; }
    const last = v.dates.length - 1;
    const latestDate = v.dates[last];
    const cum = v.cumByDate ? v.cumByDate[latestDate] : v.cum[last];
    const day = v.dayByDate[latestDate] ?? 0;
    el.innerHTML =
      '截至 ' + latestDate + '　累计盈亏 <b style="color:' + pnlColor(cum) + '">' + fmtMoney(cum) +
      '</b>　当日 <b style="color:' + pnlColor(day) + '">' + fmtMoney(day) + '</b>';
  }

  // ── 走势折线（SVG，累计盈亏）──
  function renderTrend(v) {
    const svg = $('trend');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!v || v.dates.length < 2) { svg.classList.add('hidden'); return; }
    svg.classList.remove('hidden');
    const w = svg.clientWidth || 600, h = 150, pad = { l: 8, r: 8, t: 10, b: 16 };
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const series = v.cumByDate ? v.dates.map((d) => v.cumByDate[d]) : v.cum;
    let min = Math.min(0, ...series), max = Math.max(0, ...series);
    if (max === min) max = min + 1;
    const x = (i) => pad.l + (i / (series.length - 1)) * (w - pad.l - pad.r);
    const y = (val) => pad.t + (1 - (val - min) / (max - min)) * (h - pad.t - pad.b);
    const ns = 'http://www.w3.org/2000/svg';
    const zero = y(0);
    const grid = document.createElementNS(ns, 'line');
    grid.setAttribute('x1', pad.l); grid.setAttribute('x2', w - pad.r);
    grid.setAttribute('y1', zero); grid.setAttribute('y2', zero);
    grid.setAttribute('stroke', 'var(--vscode-editorIndentGuide-background1, rgba(127,127,127,.3))');
    grid.setAttribute('stroke-dasharray', '3,3');
    svg.appendChild(grid);
    const pts = series.map((val, i) => x(i).toFixed(1) + ',' + y(val).toFixed(1)).join(' ');
    const last = series[series.length - 1];
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', pnlColor(last));
    line.setAttribute('stroke-width', '1.6');
    svg.appendChild(line);
    const area = document.createElementNS(ns, 'polygon');
    area.setAttribute('points', pts + ' ' + x(series.length - 1).toFixed(1) + ',' + zero + ' ' + x(0).toFixed(1) + ',' + zero);
    area.setAttribute('fill', pnlColor(last));
    area.setAttribute('opacity', '0.10');
    svg.appendChild(area);
    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', pad.l); lbl.setAttribute('y', h - 4);
    lbl.setAttribute('font-size', '10');
    lbl.setAttribute('fill', 'var(--vscode-descriptionForeground)');
    lbl.textContent = v.dates[0] + ' ~ ' + v.dates[v.dates.length - 1];
    svg.appendChild(lbl);
  }

  // ── 月历热图 ──
  function renderCalendar(v) {
    const grid = $('grid'), week = $('weekRow');
    week.textContent = '';
    grid.textContent = '';
    ['一', '二', '三', '四', '五', '六', '日'].forEach((d) => {
      const s = document.createElement('span'); s.textContent = d; week.appendChild(s);
    });
    if (!month) return;
    $('monthLbl').textContent = month.replace('-', '年') + '月';
    const [ys, ms] = month.split('-');
    const year = +ys, mon = +ms;
    const first = new Date(year, mon - 1, 1);
    const daysInMonth = new Date(year, mon, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // 周一起

    const monthKeyPrefix = month;
    let sum = 0, maxAbs = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const key = monthKeyPrefix + '-' + String(d).padStart(2, '0');
      const pnl = v && v.dayByDate[key];
      if (pnl !== undefined) { sum += pnl; maxAbs = Math.max(maxAbs, Math.abs(pnl)); }
    }
    $('monthSum').innerHTML = '本月合计 <b style="color:' + pnlColor(sum) + '">' + fmtMoney(sum) + '</b>';

    for (let i = 0; i < lead; i++) blank(grid);
    for (let d = 1; d <= daysInMonth; d++) {
      const key = monthKeyPrefix + '-' + String(d).padStart(2, '0');
      const pnl = v && v.dayByDate[key];
      const cell = document.createElement('div');
      cell.className = 'cell' + (pnl !== undefined ? ' has' : '');
      if (key === selectedDate) cell.classList.add('selected');
      const dd = document.createElement('div'); dd.className = 'd'; dd.textContent = String(d);
      cell.appendChild(dd);
      if (pnl !== undefined && Math.abs(pnl) > 1e-9) {
        const vv = document.createElement('div'); vv.className = 'v';
        vv.style.color = pnlColor(pnl);
        vv.textContent = fmtMoney(pnl);
        cell.appendChild(vv);
        // 颜色深浅按 |pnl|/maxAbs 缩放（GitHub 贡献图风格），底色跟随涨跌色
        const alpha = maxAbs > 0 ? 0.08 + 0.32 * (Math.abs(pnl) / maxAbs) : 0.08;
        const rgb = pnl > 0 ? hexRgb(upColor()) : hexRgb(downColor());
        cell.style.background = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha.toFixed(3) + ')';
        cell.addEventListener('click', () => { selectedDate = key; render(); });
      }
      grid.appendChild(cell);
    }
  }

  function blank(grid) {
    const b = document.createElement('div');
    b.className = 'cell blank';
    grid.appendChild(b);
  }

  function hexRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  // ── 当日明细 ──
  function renderDetail(v) {
    const tbody = $('detailTable').querySelector('tbody');
    tbody.textContent = '';
    const rows = selectedDate && v ? (v.details[selectedDate] || []) : [];
    $('detailTitle').textContent = selectedDate
      ? selectedDate + ' 当日各股盈亏（' + rows.length + ' 条）'
      : '点击日期查看各股当日盈亏';
    const err = $('errors');
    err.textContent = data && data.errors && data.errors.length ? '部分数据获取失败：\n' + data.errors.join('\n') : '';
    err.classList.toggle('hidden', !err.textContent);
    rows
      .slice()
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
      .forEach((r) => {
        const tr = document.createElement('tr');
        [r.name, fmtMoney(r.pnl), (r.pct >= 0 ? '+' : '') + r.pct.toFixed(2) + '%'].forEach((txt, i) => {
          const td = document.createElement('td');
          td.textContent = txt;
          if (i > 0) td.style.color = pnlColor(r.pnl);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
  }

  function render() {
    const v = currentView();
    if (data && !month) {
      const dates = data.portfolio.dates;
      month = dates.length ? monthOf(dates[dates.length - 1]) : currentMonth();
    }
    renderHeader();
    renderSummary(v);
    renderTrend(v);
    renderCalendar(v);
    renderDetail(v);
  }

  function currentMonth() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function shiftMonth(delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    selectedDate = null;
    render();
  }

  $('prevM').addEventListener('click', () => shiftMonth(-1));
  $('nextM').addEventListener('click', () => shiftMonth(1));
  $('todayM').addEventListener('click', () => { month = currentMonth(); selectedDate = null; render(); });
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('stockSel').addEventListener('change', (e) => { view = e.target.value; selectedDate = null; render(); });
  window.addEventListener('resize', () => renderTrend(currentView()));

  window.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type === 'data') {
      data = msg;
      colorUpIsRed = !!msg.colorUpIsRed;
      render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
