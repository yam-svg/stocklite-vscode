/* StockLite 图表 webview（S3）：klinecharts 渲染 K线/分时，B·S 标记用自定义 overlay。
 * 数据来源只有一条通道：宿主 postMessage（kline/minute/settings/error）。
 * 明暗主题按 VSCode 前景色亮度判定；红涨绿跌跟随设置。禁远程脚本（CSP nonce）。 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const chartEl = $('chart');
  const statusEl = $('status');

  const PALETTE = {
    light: { text: '#33363e', subText: '#6b6f76', grid: '#ececef', axisText: '#6b6f73', labelBg: '#5a5f6b', avg: '#c47f17' },
    dark: { text: '#d1d4dc', subText: '#8a8e99', grid: '#20242e', axisText: '#7d8290', labelBg: '#4c525e', avg: '#e0a836' },
  };
  const UP_RED = '#e14b4b';
  const UP_GREEN = '#21a366';

  let chart = null;
  let mode = null; // 'candle' | 'minute'
  let theme = 'dark';
  let colorUpIsRed = true;
  let pricePrec = 2;
  let markerIds = [];
  let baselineId = null;
  let pending = null; // 最近一次 kline/minute 数据，设置/主题变更后重绘用

  const intlDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' });
  const intlTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });

  function colors() {
    const t = PALETTE[theme];
    const up = colorUpIsRed ? UP_RED : UP_GREEN;
    const down = colorUpIsRed ? UP_GREEN : UP_RED;
    return Object.assign({ up: up, down: down, noChange: t.subText }, t);
  }

  function hexAlpha(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function fmt(v, prec) {
    if (v === undefined || v === null || isNaN(v)) return '--';
    return Number(v).toFixed(prec === undefined ? pricePrec : prec);
  }

  function fmtVol(v) {
    if (!v) return '--';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
    return String(Math.round(v));
  }

  // ── 主题检测：编辑器前景色偏亮 ⇒ 深色主题 ──
  function detectTheme() {
    const fg = getComputedStyle(document.body).color || 'rgb(200,200,200)';
    const m = fg.match(/\d+/g);
    if (!m) return;
    const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
    theme = lum > 0.55 ? 'dark' : 'light';
  }

  // ── B/S 标记 overlay（单点标注，extendData={side}）──
  function registerTradeMarker() {
    klinecharts.registerOverlay({
      name: 'stockliteTradeMarker',
      totalStep: 2,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: false,
      createPointFigures: function (params) {
        const coords = params.coordinates;
        if (!coords || coords.length === 0) return [];
        const buy = params.overlay && params.overlay.extendData && params.overlay.extendData.side === 'buy';
        const c = colors();
        const color = buy ? c.up : c.down;
        const x = coords[0].x;
        const y = buy ? coords[0].y + 18 : coords[0].y - 18;
        return [
          { key: 'dot', name: 'circle', attrs: { x: x, y: y, r: 7 },
            styles: { style: 'solid', color: color, borderSize: 1, borderColor: theme === 'dark' ? '#1b1e27' : '#ffffff' } },
          { key: 'txt', name: 'text',
            attrs: { x: x, y: y, text: buy ? 'B' : 'S', align: 'center', baseline: 'middle' },
            styles: { color: '#ffffff', size: 10, family: 'sans-serif', weight: 'bold' } },
        ];
      },
    });
  }

  // ── 分时均价线指标：读数据点上的 avgPrice 扩展字段 ──
  function registerAvgIndicator() {
    klinecharts.registerIndicator({
      name: 'STOCKLITE_AVG',
      precision: 2,
      figures: [{ key: 'avgPrice', title: '均价 ', type: 'line' }],
      calc: function (dataList) {
        return dataList.map(function (d) { return { avgPrice: d.avgPrice }; });
      },
    });
  }

  function tooltipCustom(data) {
    const cur = data.current;
    const base = data.prev ? data.prev.close : cur.open;
    const chg = cur.close - base;
    const pct = base ? (chg / base) * 100 : 0;
    const c = colors();
    const chgColor = chg > 0 ? c.up : chg < 0 ? c.down : c.subText;
    const label = mode === 'minute' ? intlTime.format(new Date(cur.timestamp)) : intlDate.format(new Date(cur.timestamp));
    const rows = [{ title: label, value: fmt(cur.close) }];
    if (mode !== 'minute') {
      rows.push(
        { title: '开', value: fmt(cur.open) },
        { title: '高', value: fmt(cur.high) },
        { title: '低', value: fmt(cur.low) },
        { title: '涨跌', value: { text: (chg >= 0 ? '+' : '') + fmt(chg) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)', color: chgColor } },
      );
    } else if (cur.avgPrice !== undefined) {
      rows.push({ title: '均价', value: fmt(cur.avgPrice) });
    }
    if (cur.volume !== undefined) rows.push({ title: '量', value: fmtVol(cur.volume) });
    return rows;
  }

  function areaLineColor(c) {
    return areaUp ? c.up : c.down;
  }

  let areaUp = true;

  function applyStyles() {
    if (!chart) return;
    const c = colors();
    chart.setStyles({
      grid: { horizontal: { show: true, color: c.grid }, vertical: { show: true, color: c.grid } },
      candle: {
        type: mode === 'minute' ? 'area' : 'candle_solid',
        bar: {
          upColor: c.up, downColor: c.down, noChangeColor: c.noChange,
          upBorderColor: c.up, downBorderColor: c.down, noChangeBorderColor: c.noChange,
          upWickColor: c.up, downWickColor: c.down, noChangeWickColor: c.noChange,
        },
        area: {
          lineSize: 1.4, smooth: false, value: 'close', lineColor: areaLineColor(c),
          backgroundColor: [
            { offset: 0, color: hexAlpha(areaLineColor(c), 0.28) },
            { offset: 1, color: hexAlpha(areaLineColor(c), 0.02) },
          ],
          ripplePoint: { color: areaLineColor(c), radius: 3 },
          ripplePointLine: { show: true, style: 'dashed', dashedValue: [4, 2], size: 1, color: areaLineColor(c) },
        },
        priceMark: {
          high: { color: c.subText, text: { size: 10 } },
          low: { color: c.subText, text: { size: 10 } },
          last: { show: true, upColor: c.up, downColor: c.down, noChangeColor: c.noChange },
        },
        tooltip: { showRule: 'follow_cross', showType: 'standard', custom: tooltipCustom,
          text: { color: c.text, size: 11 }, rect: { paddingLeft: 8, paddingRight: 8 } },
      },
      indicator: {
        bars: [{ upColor: c.up, downColor: c.down, noChangeColor: c.noChange }],
        lines: [{ color: c.avg, size: 1 }, { color: c.axisText, size: 1 }],
        lastValueMark: { show: false },
        tooltip: { showRule: 'always', showType: 'standard',
          text: { color: c.subText, size: 10 }, defaultValue: '--' },
      },
      xAxis: {
        axisLine: { show: true, color: c.grid },
        tickText: { color: c.axisText, size: 10 },
        crosshair: { horizontal: { show: false } },
      },
      yAxis: {
        axisLine: { show: false },
        tickText: { color: c.axisText, size: 10 },
        inside: true,
      },
      crosshair: {
        horizontal: { line: { show: true, size: 1, style: 'dashed', dashedValue: [4, 3], color: c.axisText },
          label: { show: true, background: c.labelBg, color: '#ffffff', size: 10 } },
        vertical: { line: { show: true, size: 1, style: 'dashed', dashedValue: [4, 3], color: c.axisText },
          label: { show: true, background: c.labelBg, color: '#ffffff', size: 10 } },
      },
    });
  }

  function clearMarkers() {
    if (!chart) return;
    markerIds.forEach(function (id) { chart.removeOverlay(id); });
    markerIds = [];
    if (baselineId) { chart.removeOverlay(baselineId); baselineId = null; }
  }

  function drawMarkers(markers) {
    if (!chart) return;
    clearMarkers();
    (markers || []).forEach(function (m) {
      const id = chart.createOverlay({
        name: 'stockliteTradeMarker',
        points: [{ timestamp: m.timestamp, value: m.value }],
        extendData: { side: m.side },
        lock: true,
        groupId: 'trades',
      });
      if (id) markerIds.push(id);
    });
  }

  function drawBaseline(ts, prevClose) {
    if (!chart || !(prevClose > 0)) return;
    if (baselineId) { chart.removeOverlay(baselineId); baselineId = null; }
    baselineId = chart.createOverlay({
      name: 'horizontalStraightLine',
      points: [{ timestamp: ts, value: prevClose }],
      lock: true,
      groupId: 'trades',
      styles: { line: { style: 'dashed', dashedValue: [5, 4], size: 1, color: colors().subText } },
    });
  }

  function ensureChart(nextMode) {
    if (chart && mode === nextMode) return;
    if (chart) {
      klinecharts.dispose(chartEl);
      chart = null;
      markerIds = [];
      baselineId = null;
    }
    mode = nextMode;
    detectTheme();
    chart = klinecharts.init(chartEl, { locale: 'zh-CN', timezone: 'Asia/Shanghai' });
    chart.setTimezone('Asia/Shanghai');
    applyStyles();
    if (mode === 'minute') chart.createIndicator('STOCKLITE_AVG', true, { id: 'candle_pane' });
    chart.createIndicator('VOL', false, { id: 'pane_vol', height: 72 });
  }

  function detectPrecision(list) {
    let prec = 0;
    for (let i = 0; i < Math.min(list.length, 50); i++) {
      const s = String(list[i].close);
      const dot = s.indexOf('.');
      if (dot >= 0) prec = Math.max(prec, Math.min(s.length - dot - 1, 6));
    }
    return Math.min(Math.max(prec, 2), 6);
  }

  function renderKline(bars, markers) {
    if (!bars || bars.length === 0) { showStatus('暂无K线数据'); return; }
    hideStatus();
    ensureChart('candle');
    pricePrec = detectPrecision(bars);
    chart.setPriceVolumePrecision(pricePrec, 0);
    const data = bars.map(function (b) {
      return { timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    });
    chart.applyNewData(data, false, function () { drawMarkers(markers); });
    setActivePeriod('kline:' + (pending.period || 'day'));
  }

  function renderMinute(msg) {
    const points = msg.points || [];
    if (points.length === 0) { showStatus('暂无分时数据'); return; }
    hideStatus();
    ensureChart('minute');
    const prevClose = msg.prevClose || 0;
    areaUp = !prevClose || points[points.length - 1].price >= prevClose;
    applyStyles();
    pricePrec = detectPrecision(points.map(function (p) { return { close: p.price }; }));
    chart.setPriceVolumePrecision(pricePrec, 0);
    let prev = 0;
    const data = points.map(function (p) {
      const open = prev || p.price;
      prev = p.price;
      return {
        timestamp: p.timestamp, open: open, close: p.price,
        high: Math.max(open, p.price), low: Math.min(open, p.price),
        volume: p.volume, avgPrice: p.avgPrice,
      };
    });
    chart.applyNewData(data, false, function () {
      drawMarkers(msg.markers);
      drawBaseline(data[0].timestamp, prevClose);
    });
    setActivePeriod('minute');
  }

  function setActivePeriod(key) {
    const btns = document.querySelectorAll('#periods button');
    btns.forEach(function (b) {
      const period = b.getAttribute('data-period');
      const active = key === 'minute' ? period === 'minute' : key === 'kline:' + period;
      b.classList.toggle('active', active);
    });
  }

  function showStatus(text) { statusEl.textContent = text; statusEl.classList.remove('hidden'); }
  function hideStatus() { statusEl.classList.add('hidden'); }

  // ── 初始化与消息路由 ──
  registerTradeMarker();
  registerAvgIndicator();
  detectTheme();

  document.querySelectorAll('#periods button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setActivePeriod(btn.getAttribute('data-period'));
      vscode.postMessage({ type: 'setPeriod', period: btn.getAttribute('data-period') });
      showStatus('加载中…');
    });
  });
  $('refresh').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
    showStatus('加载中…');
  });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () { if (chart) chart.resize(); }).observe(chartEl);
  } else {
    window.addEventListener('resize', function () { if (chart) chart.resize(); });
  }

  window.addEventListener('message', function (e) {
    const msg = e.data || {};
    if (msg.type === 'settings') {
      colorUpIsRed = !!msg.colorUpIsRed;
      $('title').textContent = (msg.name || '') + ' ' + (msg.code || '');
      applyStyles();
    } else if (msg.type === 'kline') {
      pending = msg;
      renderKline(msg.bars, msg.markers);
    } else if (msg.type === 'minute') {
      pending = msg;
      renderMinute(msg);
    } else if (msg.type === 'error') {
      showStatus('加载失败：' + msg.message);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
