/**
 * S2 自测：通用行情表框架 + 自选股纯逻辑（node 直跑，vscode 依赖经桩替换）。
 * 覆盖：批量导入词法解析（Kotlin StockTextParser 对等）、持仓推导与盈亏公式、
 * 三态排序、金额格式化、自选/分组仓库行为、provider 过渡注册。
 */
import { parseStockText, MAX_ENTRIES } from '../src/ui/watchlist/stockTextParser';
import { derivePosition, realizedPnl, todayPnl, effectivePosition, todayShanghai } from '../src/ui/watchlist/positions';
import { nextSort, sortRows, sortableValue } from '../src/ui/watchlist/table/sorting';
import { formatCompact, changePctOf, cellOf } from '../src/ui/watchlist/table/format';
import type { ColumnDef, Quote, TradeRecord } from '../src/shared/types';
import { WatchlistStore } from '../src/ui/watchlist/store';
import type { ConfigStore } from '../src/shared/config';
import { getProvider, isMock, registerProvider } from '../src/ui/watchlist/providers';
import { createMockProvider } from '../src/shared/mockProvider';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function trade(over: Partial<TradeRecord>): TradeRecord {
  return { id: Math.random().toString(36).slice(2), code: 'sh600519', name: '贵州茅台', side: 'buy', price: 10, quantity: 100, date: '2026-01-01', ...over };
}

function quote(over: Partial<Quote>): Quote {
  return { code: 'sh600519', name: '贵州茅台', price: 11, prevClose: 10.5, ...over };
}

async function main(): Promise<void> {
  console.log('[stockTextParser]');
  {
    const t = parseStockText('600519');
    check('裸 6 位 6 开头→sh', t[0]?.code === 'sh600519');
  }
  check('裸 6 位 0 开头→sz', parseStockText('000001')[0]?.code === 'sz000001');
  check('裸 6 位 5 开头（ETF）→sh', parseStockText('510300')[0]?.code === 'sh510300');
  check('北交所 43/92 →bj', parseStockText('430047').length === 1 && parseStockText('430047')[0].code === 'bj430047' && parseStockText('920002')[0].code === 'bj920002');
  check('裸 5 位→港股', parseStockText('00700')[0]?.code === 'hk00700');
  check('带前缀（含空格大小写混排）', parseStockText('SZ 000001').length === 1 && parseStockText('SZ 000001')[0].code === 'sz000001');
  check('hk 前缀 4 位补足 5 位', parseStockText('hk0700')[0]?.code === 'hk00700');
  check('后缀式 600519.SH', parseStockText('600519.SH')[0]?.code === 'sh600519');
  check('后缀式 00700.HK', parseStockText('00700.HK')[0]?.code === 'hk00700');
  {
    const t = parseStockText('贵州茅台 600519');
    check('名称+代码同段配对', t.length === 1 && t[0].code === 'sh600519' && t[0].name === '贵州茅台');
  }
  {
    const t = parseStockText('贵州茅台、宁德时代');
    check('纯名称段各自成条', t.length === 2 && t[0].name === '贵州茅台' && !t[0].code && t[1].name === '宁德时代');
  }
  check('全大写 ticker 视为美股', parseStockText('AAPL')[0]?.code === 'AAPL');
  check('含小写单词不当代码', parseStockText('the apple pie')[0] === undefined);
  check('BRK.B 型 ticker', parseStockText('BRK.B')[0]?.code === 'BRK.B');
  {
    const t = parseStockText('600519\n600519\nsz000001\n600519');
    check('相同代码去重且保序', t.length === 2 && t[0].code === 'sh600519' && t[1].code === 'sz000001');
  }
  {
    const many = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => `60${String(i).padStart(4, '0')}`).join('\n');
    check(`上限 ${MAX_ENTRIES} 条`, parseStockText(many).length === MAX_ENTRIES);
  }
  check('日期/带点数字不误配成代码', parseStockText('2026.10.29 涨幅 3.25%').every((t) => !t.code));

  console.log('[positions]');
  {
    const pos = derivePosition([trade({ date: '2026-01-01', side: 'buy', price: 10, quantity: 100 }), trade({ date: '2026-01-02', side: 'buy', price: 12, quantity: 100 })]);
    check('加权平均成本', Math.abs(pos.cost - 11) < 1e-9 && pos.quantity === 200);
  }
  {
    const recs = [trade({ side: 'buy', price: 10, quantity: 100 }), trade({ date: '2026-01-05', side: 'sell', price: 13, quantity: 100 })];
    const pos = derivePosition(recs);
    check('清仓后数量归零', pos.quantity === 0);
    check('已实现盈亏', Math.abs(realizedPnl(recs) - 300) < 1e-9);
  }
  {
    const recs = [trade({ date: '2026-01-01', side: 'buy', price: 11, quantity: 100 }), trade({ date: todayShanghai(), side: 'buy', price: 10.8, quantity: 100 })];
    const pos = derivePosition(recs);
    const q = quote({ price: 11, prevClose: 10.5 });
    const tp = todayPnl(q, pos, recs);
    check('今日盈亏精确模式（昨收基准×历史仓+今日买入逐笔）', Math.abs(tp - (0.5 * 100 + 0.2 * 100)) < 1e-9, `got ${tp}`);
    const tpNoTrade = todayPnl(q, { cost: 10, quantity: 300 }, []);
    check('今日盈亏无今日记录=涨跌额×数量', Math.abs(tpNoTrade - 0.5 * 300) < 1e-9);
  }
  {
    const pos = effectivePosition([trade({})], { code: 'sh600519', name: '贵州茅台', cost: 9.9, quantity: 500 });
    check('手填覆盖优先', pos.cost === 9.9 && pos.quantity === 500);
    const pos2 = effectivePosition([trade({})], { code: 'sh600519', name: '贵州茅台', cost: 9.9, quantity: 0 });
    check('覆盖数量 0 视为无效回退推导', pos2.quantity === 100);
  }

  console.log('[sorting]');
  check('三态：asc→desc→默认', nextSort(null, 'price')!.dir === 'asc' && nextSort({ key: 'price', dir: 'asc' }, 'price')!.dir === 'desc' && nextSort({ key: 'price', dir: 'desc' }, 'price') === null);
  check('换列重新升序起算', nextSort({ key: 'price', dir: 'desc' }, 'name')!.dir === 'asc');
  check('sortableValue 解析 万/亿/%', sortableValue({ key: 'a', name: 'a', cells: [{ text: '1.2万' }] }, 0) === 12000 && sortableValue({ key: 'a', name: 'a', cells: [{ text: '+2.50%' }] }, 0) === 2.5 && sortableValue({ key: 'a', name: 'a', cells: [{ text: '3.50亿' }] }, 0) === 350000000);
  {
    const cols: ColumnDef[] = [{ key: 'name', title: '名', kind: 'text' }, { key: 'price', title: '价', kind: 'price' }];
    const mk = (k: string, price: string) => ({ key: k, name: k, cells: [{ text: k }, { text: price }] });
    const rows = [mk('b', '3.00'), mk('c', '--'), mk('a', '10.00')];
    const asc = sortRows(rows, { key: 'price', dir: 'asc' }, cols).map((r) => r.key);
    const desc = sortRows(rows, { key: 'price', dir: 'desc' }, cols).map((r) => r.key);
    check('数值排序非字典序且缺数恒末位', asc.join() === 'b,a,c' && desc.join() === 'a,b,c', `asc=${asc} desc=${desc}`);
    const byName = sortRows(rows, { key: 'name', dir: 'asc' }, cols).map((r) => r.key);
    check('文本列中文 locale 排序', byName.join() === 'a,b,c');
  }

  console.log('[format]');
  check('formatCompact 万亿缩写', formatCompact(123456789) === '1.23亿' && formatCompact(12345) === '1.23万');
  check('changePctOf 缺省推算', Math.abs(changePctOf(quote({ price: 11, prevClose: 10 })) - 10) < 1e-9);
  {
    const pctCol: ColumnDef = { key: 'changePct', title: '涨跌幅', kind: 'percent' };
    const priceCol: ColumnDef = { key: 'price', title: '现价', kind: 'price' };
    const cellUp = cellOf(pctCol, quote({ changePct: 2 }));
    const cellPriceDown = cellOf(priceCol, quote({ price: 9, prevClose: 10 }));
    check('percent 列随自身正负着色', cellUp.text === '+2.00%' && cellUp.dir === 1);
    check('price 列随当日涨跌着色', cellPriceDown.dir === -1);
  }

  console.log('[store]');
  {
    const data = new Map<string, unknown>();
    const fakeConfig = {
      get: <T>(key: string, fallback: T): T => (data.has(key) ? (data.get(key) as T) : fallback),
      set: async (key: string, value: unknown) => {
        data.set(key, JSON.parse(JSON.stringify(value)));
      },
    } as unknown as ConfigStore;
    const store = new WatchlistStore(fakeConfig);
    await store.seedDefaultsIfNeeded();
    check('首启播种示例股票', store.watchlist().length === 3);
    await store.setWatchlist(['sh600519', 'sz300059']);
    await store.setGroups([{ id: 'g1', name: '科技', codes: ['sz300059', 'hk00700'] }]);
    check('all 合并扁平+分组去重', store.effectiveCodes('all').join() === 'sh600519,sz300059,hk00700');
    check('分组视图只含组内', store.effectiveCodes('g1').join() === 'sz300059,hk00700');
    check('重复添加返回 false', (await store.addCode('sh600519', 'all')) === false);
    check('加入分组成功', (await store.addCode('sh600036', 'g1')) === true);
    await store.removeCode('sz300059');
    check('removeCode 两处同删', store.watchlist().includes('sz300059') === false && store.groups()[0].codes.includes('sz300059') === false);
    await store.applyOrder('g1', ['hk00700', 'sh600036']);
    check('组内重排落盘', store.effectiveCodes('g1').join() === 'hk00700,sh600036');
    await store.setPosition('sh600519', '贵州茅台', 10, 200);
    check('持仓覆盖读写', store.positionFor('sh600519')?.cost === 10);
    await store.setPosition('sh600519', '贵州茅台', 10, 0);
    check('数量 0 清除覆盖', store.positionFor('sh600519') === undefined);
  }

  console.log('[providers]');
  check('未注册回落到 mock', isMock('stock') && getProvider('stock').id === 'mock:stock');
  {
    const real = { ...createMockProvider('stock'), id: 'stock' };
    registerProvider(real);
    check('注册后接管', !isMock('stock') && getProvider('stock') === real);
    const quotes = await getProvider('stock').fetchQuotes(['sh600519', 'sz300059']);
    check('provider 批量顺序与 mock 名称映射', quotes.length === 2 && quotes[0].name === '贵州茅台' && quotes[0].code === 'sh600519');
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
