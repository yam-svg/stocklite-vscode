/**
 * Mock 数据源（S0 产出）：让 UI 会话在 S1 真实 provider 就绪前可独立开发调试。
 * 数据为确定性伪随机（同一 code 每次结果一致），实现与真实 provider 相同的 QuoteProvider 契约。
 */
import type { KlineBar, MinutePoint, Quote, QuoteProvider, SearchResultItem } from './types';
import { sleep } from './http';

const NAMES: Record<string, string> = {
  sh000001: '上证指数',
  sz399001: '深证成指',
  sh600519: '贵州茅台',
  sz300750: '宁德时代',
  sh601899: '紫金矿业',
  hkHSTECH: '恒生科技',
  'gb_dji': '道琼斯',
  'usNVDA': '英伟达',
  '012414': '某基金',
  hf_NQ: '纳斯达克100期货',
  btcusdt: 'BTC/USDT',
};

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function basePrice(code: string): number {
  return 5 + (hashCode(code) % 40000) / 100;
}

function tick(code: string, i: number): number {
  const h = hashCode(`${code}#${i}`);
  return ((h % 1000) / 1000 - 0.5) * 0.02; // ±1%
}

export function createMockProvider(id: string): QuoteProvider {
  return {
    id: `mock:${id}`,
    async fetchQuotes(codes: string[]): Promise<Quote[]> {
      await sleep(120);
      return codes.map((code) => {
        const prevClose = basePrice(code);
        const price = prevClose * (1 + tick(code, 999));
        return {
          code,
          name: NAMES[code] ?? code.toUpperCase(),
          price,
          prevClose,
          change: price - prevClose,
          changePct: ((price - prevClose) / prevClose) * 100,
          time: new Date().toTimeString().slice(0, 5),
          volume: hashCode(code) % 1000000,
          amount: (hashCode(code) % 1000000) * price,
        };
      });
    },
    async fetchKline(code: string, _period: 'day' | 'week' | 'month', count: number): Promise<KlineBar[]> {
      const bars: KlineBar[] = [];
      let close = basePrice(code) * 0.8;
      const start = Date.now() - count * 86400000;
      for (let i = 0; i < count; i++) {
        const open = close;
        close = open * (1 + tick(code, i));
        const high = Math.max(open, close) * 1.005;
        const low = Math.min(open, close) * 0.995;
        bars.push({
          date: new Date(start + i * 86400000).toISOString().slice(0, 10),
          open,
          close,
          high,
          low,
          volume: hashCode(`${code}v${i}`) % 500000,
        });
      }
      return bars;
    },
    async fetchMinute(code: string): Promise<MinutePoint[]> {
      const points: MinutePoint[] = [];
      let price = basePrice(code);
      for (let m = 0; m < 242; m++) {
        price *= 1 + tick(code, 1000 + m) * 0.2;
        const hh = String(9 + Math.floor((m + 30) / 60)).padStart(2, '0');
        const mm = String((m + 30) % 60).padStart(2, '0');
        points.push({ time: `${hh}:${mm}`, price, avgPrice: price * 0.999 });
      }
      return points;
    },
    async search(keyword: string): Promise<SearchResultItem[]> {
      const kw = keyword.toLowerCase();
      return Object.entries(NAMES)
        .filter(([code, name]) => code.toLowerCase().includes(kw) || name.includes(keyword))
        .slice(0, 10)
        .map(([code, name]) => ({ code, name, market: id }));
    },
  };
}
