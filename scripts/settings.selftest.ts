/**
 * S5 设置会话自测：node 直跑（npx esbuild 打包后执行），只依赖 settings 目录的纯逻辑模块。
 * 覆盖：指数目录与双轨可见性、导入导出（native 回环 + JetBrains 迁移映射）、反馈接口客户端。
 */
import * as http from 'node:http';
import {
  GLOBAL_INDEXES, DEFAULT_INDEXES, OPTIONAL_INDEXES, visibleGlobalIndexes,
} from '../src/features/settings/indexCatalog';
import { buildExportJson, parseImportJson, normalizeJetbrains } from '../src/features/settings/portableConfig';
import { FeedbackClient, formatTime } from '../src/features/settings/feedbackApi';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  console.log('[indexCatalog]');
  check('目录 37 条', GLOBAL_INDEXES.length === 37, `got ${GLOBAL_INDEXES.length}`);
  check('默认 20 / 更多 17', DEFAULT_INDEXES.length === 20 && OPTIONAL_INDEXES.length === 17);
  check('symbol 无重复', new Set(GLOBAL_INDEXES.map((i) => i.symbol)).size === GLOBAL_INDEXES.length);
  const visible0 = visibleGlobalIndexes([], []);
  check('默认可见 20', visible0.length === 20);
  const visible1 = visibleGlobalIndexes(['^VIX'], ['^STI']);
  check('隐藏默认+开启扩展', visible1.length === 20 && !visible1.some((i) => i.symbol === '^VIX') && visible1.some((i) => i.symbol === '^STI'));
  const visible2 = visibleGlobalIndexes(['^STI', 'unknown.id'], ['^DJI']);
  check('目录外 id 与非法轨道不污染结果', visible2.length === 20 && visible2.some((i) => i.symbol === '^STI') === false);

  console.log('[portableConfig]');
  const nativeJson = buildExportJson({
    state: { watchlist: ['sh600519', 'sz000001'], alerts: [{ id: 'a1', code: 'sh600519', name: '茅台', type: 'priceAbove', threshold: 1700, enabled: true }] },
    settings: { colorUp: 'green', 'tabs.crypto': true },
  }, '2026-10-29T00:00:00Z');
  const nativeBack = parseImportJson(nativeJson);
  check('native 导出/导入回环', JSON.stringify(nativeBack.state.watchlist) === '["sh600519","sz000001"]'
    && nativeBack.settings.colorUp === 'green' && nativeBack.warnings.length === 0);

  const jb = normalizeJetbrains({
    version: '1.2.0',
    stockGroups: [{ id: 'g1', name: '默认组' }],
    stocks: [
      { id: 's1', symbol: 'sh600519', name: '贵州茅台', groupId: 'g1', costPrice: 1500.5, quantity: 100, sortOrder: 1 },
      { id: 's2', symbol: 'sz000001', name: '平安银行', groupId: 'g1', costPrice: 10.2, quantity: 0, sortOrder: 0 },
    ],
    tradeRecords: [
      { id: 't1', stockId: 's1', symbol: 'sh600519', stockName: '贵州茅台', tradeType: 'BUY', price: 1500.5, quantity: 100, note: '初始建仓', tradeAt: 1730000000000 },
      { id: 't2', stockId: 's1', symbol: 'sh600519', stockName: '贵州茅台', tradeType: 'ADJUST', price: 1400, quantity: 100, note: '', tradeAt: 1730000001000 },
    ],
    priceAlerts: [{ id: 'a1', symbol: 'sh600519', name: '贵州茅台', targetPrice: 1600, alertType: 'ABOVE', enabled: true }],
    hiddenGlobalIndexes: ['^VIX', 'BOGUS'],
    enabledOptionalIndexes: ['^STI'],
    settings: { colorScheme: 'GREEN_UP', refreshIntervalStock: 1, enableUsMarketPanel: true, enableFundPanel: false, enablePortfolioStatusBar: false },
  });
  check('watchlist 按 sortOrder 排序', JSON.stringify(jb.state.watchlist) === '["sz000001","sh600519"]', JSON.stringify(jb.state.watchlist));
  check('迁移导入置位播种判据', jb.state.watchlistDefaultsSeeded === true);
  const positions = jb.state.positions as { code: string; cost: number }[];
  check('positions 仅含持仓>0', positions.length === 1 && positions[0].code === 'sh600519' && positions[0].cost === 1500.5);
  const trades = jb.state.tradeRecords as { side: string; date: string; note?: string }[];
  check('ADJUST 记录跳过并告警', trades.length === 1 && trades[0].side === 'buy' && jb.warnings.some((w) => w.includes('ADJUST')));
  check('tradeAt → 东八区日期', trades[0]?.date === '2024-10-27', trades[0]?.date);
  const alerts = jb.state.alerts as { type: string; threshold: number }[];
  check('ABOVE → priceAbove', alerts.length === 1 && alerts[0].type === 'priceAbove' && alerts[0].threshold === 1600);
  check('隐藏指数过滤目录外 id', JSON.stringify(jb.settings['indexes.hidden']) === '["^VIX"]');
  check('colorScheme/间隔映射', jb.settings.colorUp === 'green' && jb.settings.pollIntervalSeconds === 2);
  check('面板开关映射', jb.settings['tabs.us'] === true && jb.settings['tabs.fund'] === false && jb.settings['statusBar.enabled'] === false);

  let threwBad = false;
  try { parseImportJson('not json'); } catch { threwBad = true; }
  check('非法 JSON 抛错', threwBad);
  let threwUnknown = false;
  try { parseImportJson('{"hello":1}'); } catch { threwUnknown = true; }
  check('无法识别的结构抛错', threwUnknown);

  console.log('[feedbackApi]');
  const store = { value: '', get() { return this.value; }, async set(v: string) { this.value = v; } };
  let lastDeleteId = '';
  let seenDeviceHeader = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/rest/v1/feedback') {
      seenDeviceHeader = req.headers['x-device-id'] as string;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const ok = parsed.device_id === seenDeviceHeader && !!req.headers.apikey && parsed.content.length > 0;
        res.statusCode = ok ? 201 : 403;
        res.end('');
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/rest/v1/feedback') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([
        { id: 'f1', content: '功能建议', email: 'a@b.c', reply: '已排期', replied_at: '2026-10-29T01:02:03Z', created_at: '2026-10-28T10:00:00Z' },
        { id: 'f2', content: '报个 bug', email: '', reply: null, replied_at: null, created_at: '2026-10-29T10:00:00Z' },
      ]));
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/rest/v1/feedback') {
      lastDeleteId = url.searchParams.get('id') ?? '';
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify([{ id: lastDeleteId }]));
      return;
    }
    res.statusCode = 404;
    res.end('');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new FeedbackClient({ store, baseUrl: base, anonKey: 'test-key' });

  check('未提交过时历史为空且不联网', JSON.stringify(await client.fetchMine()) === '[]' && store.value === '');
  const okSubmit = await client.submit('功能建议', 'a@b.c');
  check('提交成功且生成 device id', okSubmit && /^[0-9a-f-]{36}$/.test(store.value));
  const items = await client.fetchMine();
  check('历史映射', !!items && items.length === 2 && items[0].reply === '已排期' && items[1].reply === '');
  check('时间格式 YYYY-MM-DD HH:mm', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(items?.[0].time ?? ''), items?.[0].time);
  check('删除成功回传 id（PostgREST eq. 过滤）', (await client.delete('f1')) && lastDeleteId === 'eq.f1', lastDeleteId);
  server.close();

  const emptyStore = { value: '', get() { return this.value; }, async set(v: string) { this.value = v; } };
  check('无 device id 时删除直接 false', (await new FeedbackClient({ store: emptyStore, baseUrl: base }).delete('x')) === false);
  check('formatTime 兜底原文截断', formatTime('garbage-text-xxxxx') === 'garbage-text-xxx', formatTime('garbage-text-xxxxx'));

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
