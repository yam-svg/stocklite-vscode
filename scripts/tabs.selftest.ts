/**
 * S6 自测：七个可选 tab 的纯逻辑（node 直跑，vscode 依赖经桩替换）。
 * 覆盖：列表仓库播种判据（布尔键，删空不复活）、美股 ETF 显示清单三态、
 * 全球指数双轨可见性、期货/加密/基金代码归一、板块领涨股 symbol 推导、
 * 新股分组判据、净值列格式化（列格式化/播种判据/过滤判据为任务书点名项）。
 */
import {
  TabListStore, usEtfDisplayList, US_ETF_LIST_KEY,
  FUTURES_SEEDED_KEY, CRYPTO_SEEDED_KEY, FUTURE_SEEDS, CRYPTO_SEEDS,
} from '../src/features/tabs/store';
import { fundNavCell } from '../src/features/tabs/fundsTab';
import { leaderStockSymbol } from '../src/features/tabs/sectorTab';
import { splitIpoGroups } from '../src/features/tabs/ipoTab';
import { normalizeFutureSymbol } from '../src/data/futures';
import { normCryptoSymbol } from '../src/data/cryptos';
import { normFundCode } from '../src/data/funds';
import { GLOBAL_INDEXES, visibleGlobalIndexes } from '../src/shared/globalIndexes';
import { formatCompact } from '../src/ui/watchlist/table/format';
import type { IpoInfo } from '../src/data/ipos';
import type { ConfigStore } from '../src/shared/config';

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

/** 内存版 ConfigStore 桩：只实现 TabListStore/usEtfDisplayList 用到的 get/set */
function fakeConfig(): ConfigStore {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T): T => (data.has(key) ? (data.get(key) as T) : fallback),
    set: async (key: string, value: unknown) => {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  } as unknown as ConfigStore;
}

function ipo(over: Partial<IpoInfo>): IpoInfo {
  return {
    pureCode: '301001', sinaSymbol: 'sz301001', name: '新股', applyCode: '301001',
    applyDate: '2026-10-20', listingDate: null, issuePrice: 10, issuePe: 20, industryPe: null,
    maxApplyQty: null, raiseFunds: null, firstDayChangePct: null, listed: false, isBeijing: false,
    ...over,
  };
}

async function main(): Promise<void> {
  console.log('[TabListStore 播种判据]');
  {
    const cfg = fakeConfig();
    const store = new TabListStore(cfg, 'futures', { seedKey: FUTURES_SEEDED_KEY, seedCodes: FUTURE_SEEDS });
    await store.seedDefaultsIfNeeded();
    check('首用播种内置期货', store.list().join() === FUTURE_SEEDS.join() && cfg.get<boolean>(FUTURES_SEEDED_KEY, false) === true);
    await store.setList([]);
    await store.seedDefaultsIfNeeded();
    check('删除内置后不复活（判据是布尔键非空列表）', store.list().length === 0);
  }
  {
    const cfg = fakeConfig();
    await cfg.set('futures', ['hf_GC']);
    const store = new TabListStore(cfg, 'futures', { seedKey: FUTURES_SEEDED_KEY, seedCodes: FUTURE_SEEDS });
    await store.seedDefaultsIfNeeded();
    check('已有自选时播种不覆盖', store.list().join() === 'hf_GC');
  }
  {
    const cfg = fakeConfig();
    const store = new TabListStore(cfg, 'funds');
    await store.seedDefaultsIfNeeded();
    check('无 seedKey 的列表不播种', store.list().length === 0 && cfg.get<boolean>('someSeedKey', false) === false);
    check('add 去重（重复 false 新增加 true）', (await store.add('012414')) === true && (await store.add('012414')) === false);
    await store.add('512890');
    await store.remove('012414');
    check('remove 后仅剩其余', store.list().join() === '512890');
    check('CRYPTO_SEEDS 为六主流币 USDT 对', CRYPTO_SEEDED_KEY === 'cryptoDefaultsSeeded' && CRYPTO_SEEDS.length === 6 && CRYPTO_SEEDS[0] === 'BTC_USDT');
  }
  {
    const cfg = fakeConfig();
    const store = new TabListStore(cfg, 'cryptos');
    await store.setList(['BTC_USDT', 'ETH_USDT', 'SOL_USDT']);
    await store.applyOrder(['SOL_USDT', 'BTC_USDT']);
    check('applyOrder 视图内重排+视图外附尾', store.list().join() === 'SOL_USDT,BTC_USDT,ETH_USDT');
  }

  console.log('[美股 ETF 显示清单]');
  {
    const cfg = fakeConfig();
    check('未写入=全显', usEtfDisplayList(cfg, ['XLK', 'XLE']).join() === 'XLK,XLE');
    await cfg.set(US_ETF_LIST_KEY, ['XLE']);
    check('显式保存=以保存值为准', usEtfDisplayList(cfg, ['XLK', 'XLE']).join() === 'XLE');
    await cfg.set(US_ETF_LIST_KEY, []);
    check('删空后保持空（不被全显复活）', usEtfDisplayList(cfg, ['XLK', 'XLE']).length === 0);
  }

  console.log('[全球指数双轨可见性]');
  {
    const mainCount = GLOBAL_INDEXES.filter((c) => !c.optional).length;
    const optCount = GLOBAL_INDEXES.length - mainCount;
    check('默认=全部常用且不含 optional', visibleGlobalIndexes([], []).length === mainCount && GLOBAL_INDEXES.length === 37 && optCount === 17);
    const hidden = visibleGlobalIndexes(['^GSPC'], []);
    check('hidden 隐藏常用条目', !hidden.some((c) => c.symbol === '^GSPC') && hidden.length === mainCount - 1);
    const enabled = visibleGlobalIndexes([], ['^SSMI']);
    check('enabledOptional 启用更多条目', enabled.some((c) => c.symbol === '^SSMI') && enabled.length === mainCount + 1);
    check('hidden 不影响 optional / 双轨互不串台', visibleGlobalIndexes(['^SSMI'], ['^SSMI']).some((c) => c.symbol === '^SSMI') && visibleGlobalIndexes([], ['^GSPC']).length === mainCount);
  }

  console.log('[代码归一]');
  check('期货裸代码默认 nf_ 前缀且大写', normalizeFutureSymbol('NQ') === 'nf_NQ' && normalizeFutureSymbol('IF2412') === 'nf_IF2412');
  check('期货带前缀保留市场（大小写归一）', normalizeFutureSymbol('hf_nq') === 'hf_NQ' && normalizeFutureSymbol(' HF_OIL ') === 'hf_OIL');
  check('期货 nf_ 前缀小写体转大写', normalizeFutureSymbol('nf_au0') === 'nf_AU0');
  check('加密三写法归一 BTC_USDT', normCryptoSymbol('btc/usdt') === 'BTC_USDT' && normCryptoSymbol('BTCUSDT') === 'BTC_USDT' && normCryptoSymbol('BTC_USDT') === 'BTC_USDT');
  check('加密裸币种默认 USDT 计价', normCryptoSymbol('sol') === 'SOL_USDT' && normCryptoSymbol('pepe') === 'PEPE_USDT');
  check('加密带 _ 原样大写', normCryptoSymbol('eth_usdc') === 'ETH_USDC');
  check('基金提取 6 位代码', normFundCode(' 012414 ') === '012414' && normFundCode('fund：000001x') === '000001');
  check('基金无 6 位码原样返回', normFundCode('abc') === 'abc');

  console.log('[板块领涨股 symbol]');
  check('沪市领涨→sh', leaderStockSymbol({ leaderCode: '600519', leaderMarket: 1 }) === 'sh600519');
  check('深市领涨→sz', leaderStockSymbol({ leaderCode: '300750', leaderMarket: 0 }) === 'sz300750');
  check('北交所前缀优先于 market', leaderStockSymbol({ leaderCode: '920002', leaderMarket: 0 }) === 'bj920002' && leaderStockSymbol({ leaderCode: '430047', leaderMarket: 1 }) === 'bj430047');
  check('空/非法代码→undefined', leaderStockSymbol({ leaderCode: '', leaderMarket: 1 }) === undefined && leaderStockSymbol({ leaderCode: 'BK0475', leaderMarket: 1 }) === undefined);

  console.log('[新股分组判据]');
  {
    const { apply, listed } = splitIpoGroups([]);
    check('空列表两类皆空', apply.length === 0 && listed.length === 0);
  }
  {
    const list = [
      ipo({ sinaSymbol: 'sz301001', listed: false }),
      ipo({ sinaSymbol: 'sh688100', listed: true, listingDate: '2026-10-10' }),
      ipo({ sinaSymbol: 'sz301002', listed: true, listingDate: '2026-10-25' }),
      ipo({ sinaSymbol: 'bj920001', listed: true, listingDate: null }),
    ];
    const { apply, listed } = splitIpoGroups(list);
    check('未上市=申购日历', apply.length === 1 && apply[0].sinaSymbol === 'sz301001');
    check('上市日倒序', listed[0].sinaSymbol === 'sz301002' && listed[1].sinaSymbol === 'sh688100');
    check('listingDate null 安全参与排序', listed.length === 3 && listed[2].sinaSymbol === 'bj920001');
  }

  console.log('[列格式化]');
  {
    const cell = fundNavCell(1.23456, 1.23);
    check('净值固定 4 位小数', cell.text === '1.2346' && cell.dir === 1);
    check('跌时 dir=-1', fundNavCell(0.9876, -0.5).dir === -1);
    check('无效净值显示 --', fundNavCell(NaN, 0).text === '--' && fundNavCell(0, 0).text === '--');
    check('formatCompact 亿/万', formatCompact(1.23e8) === '1.23亿' && formatCompact(23456) === '2.35万');
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
