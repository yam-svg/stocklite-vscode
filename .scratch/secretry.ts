/** 板块单项复检：限流窗口冷却后验证 getSectorQuotes(2) 是否恢复（S7b 在线自测板块 flaky 项定位用） */
import { getSectorQuotes } from '../src/data/sectors';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

void (async () => {
  console.log('冷却 180s 后单测板块行业榜…');
  await sleep(180_000);
  for (let round = 1; round <= 3; round++) {
    const list = await getSectorQuotes(2);
    const ok = !!list && list.length > 50 && list.some((s) => s.code.startsWith('BK'));
    console.log(`第 ${round} 轮：${ok ? `✓ 通过（${list!.length} 条）` : '✗ 失败'}`);
    if (ok) process.exit(0);
    await sleep(30_000);
  }
  process.exit(1);
})();
