/**
 * 契约层自测：node 直跑（经 esbuild 打包后执行），不依赖 vscode 运行时。
 * 覆盖 types 契约可消费性、EventBus、http 重试/GBK 解码、mockProvider 数据形状。
 */
import * as http from 'node:http';
import { EventBus } from '../src/shared/events';
import { decodeBytes, httpGetText } from '../src/shared/http';
import { createMockProvider } from '../src/shared/mockProvider';
import type { AppEvents } from '../src/shared/events';

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

async function main(): Promise<void> {
  console.log('[events]');
  const bus = new EventBus();
  let got: AppEvents['quotesUpdated'] | undefined;
  const sub = bus.on('quotesUpdated', (p) => (got = p));
  bus.emit('quotesUpdated', { tabId: 'stock', quotes: [] });
  check('on/emit 送达载荷', got?.tabId === 'stock');
  sub.dispose();
  bus.emit('quotesUpdated', { tabId: 'other', quotes: [] });
  check('dispose 后不再送达', got?.tabId === 'stock');
  bus.on('configChanged', () => {
    throw new Error('boom');
  });
  let second = false;
  bus.on('configChanged', () => (second = true));
  bus.emit('configChanged', { key: 'k' });
  check('单个 handler 抛错不影响其他 handler', second);

  console.log('[http]');
  // GBK 码点：中=D6D0 国=B9FA
  const gbk = decodeBytes(new Uint8Array([0xd6, 0xd0, 0xb9, 0xfa]), true);
  check('GBK 解码（中国）', gbk === '中国', `got ${gbk}`);
  check('utf-8 解码', decodeBytes(new TextEncoder().encode('沪深300'), false) === '沪深300');

  let attempts = 0;
  const server = http.createServer((_req, res) => {
    attempts++;
    if (attempts < 3) {
      res.statusCode = 500;
      res.end('bad');
    } else {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('ok');
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const body = await httpGetText(`http://127.0.0.1:${port}/`);
  check('失败自动重试后成功', body === 'ok' && attempts === 3, `attempts=${attempts}`);
  server.close();

  const slow = http.createServer((_req, res) => {
    setTimeout(() => res.end('late'), 300);
  });
  await new Promise<void>((r) => slow.listen(0, r));
  const slowPort = (slow.address() as { port: number }).port;
  try {
    await httpGetText(`http://127.0.0.1:${slowPort}/`, { retries: 0, timeoutMs: 50 });
    check('超时抛错', false, '本该超时却成功返回');
  } catch {
    check('超时抛错', true);
  }
  slow.close();

  console.log('[mockProvider]');
  const provider = createMockProvider('stock');
  const quotes = await provider.fetchQuotes(['sh000001', 'sh600519']);
  const q = quotes[1];
  check('批量顺序与入参一致', quotes[0].code === 'sh000001' && q.code === 'sh600519');
  check('名称映射', q.name === '贵州茅台');
  check('涨跌幅与价格自洽', Math.abs((q.changePct ?? 0) - ((q.price - q.prevClose) / q.prevClose) * 100) < 1e-9);
  const again = await provider.fetchQuotes(['sh600519']);
  check('确定性伪随机（两次结果一致）', again[0].price === q.price);

  const bars = await provider.fetchKline('sh600519', 'day', 120);
  check('K线数量', bars.length === 120);
  check('K线 high/low 包住开收', bars.every((b) => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)));
  check('K线日期升序', bars.every((b, i) => i === 0 || b.date > bars[i - 1].date));

  const minute = await provider.fetchMinute!('sh600519');
  check('分时点数=242', minute.length === 242);
  check('分时时间格式 HH:mm', /^\d{2}:\d{2}$/.test(minute[0].time));

  const hits = await provider.search!('茅台');
  check('search 命中名称', hits.length === 1 && hits[0].code === 'sh600519');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
