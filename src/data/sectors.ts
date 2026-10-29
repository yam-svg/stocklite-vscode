/**
 * A股板块行情（移植自 MarketDataService 板块段，东财 push2 clist 接口族）。
 * 已知坑（2026-10-29 修正）：push2 边缘节点对 Node 连接随机 RST，通过率随边缘 IP/时间窗漂移
 * （实测出现过单域名 0/6 与 5/6 分钟级互换），与 UA/ALPN 无关——对策是跨镜像域名轮换 + 每页最多
 * 4 次重试（间隔 1.2s，背靠背无意义）。其余既定：大分页禁用 pz=100、上限 12 页、页间 400ms 缓和；
 * 中途断连返回已取部分（接口按涨跌幅降序，已取即榜单头部），60s 轮询下一轮自动补全。
 */
import { StaleCache, numOf, emGetText, sleep } from './util';

export interface AStockSector {
  /** 板块代码，如 BK0475 */
  code: string;
  name: string;
  /** 板块指数点位，缺失 NaN */
  price: number;
  changePct: number;
  /** 换手率% */
  turnoverRate: number;
  /** 主力净流入（元），负数为净流出 */
  mainInflow: number;
  upCount: number;
  downCount: number;
  leaderName: string;
  /** 领涨股代码（f140），点击弹走势图用 */
  leaderCode: string;
  /** 领涨股市场（f141）：1=沪 0=深，北交所按代码前缀判断 */
  leaderMarket: number;
  leaderPct: number;
}

const EM_REFERER = { Referer: 'https://data.eastmoney.com/' };
const SECTOR_FIELDS = 'f2,f3,f8,f12,f14,f62,f104,f105,f128,f136,f140,f141';
/** 镜像池，逐次轮换直到某次落到放行节点（通过率随 IP/时间窗漂移，多镜像是主要手段） */
const SECTOR_HOSTS = ['https://82.push2.eastmoney.com', 'https://push2.eastmoney.com', 'https://push2delay.eastmoney.com', 'https://33.push2.eastmoney.com'];

function optNum(o: any, key: string, fallback: number): number {
  const v = typeof o?.[key] === 'number' ? o[key] : Number(o?.[key]);
  return Number.isFinite(v) ? v : fallback;
}

async function fetchSectorList(fsT: number): Promise<AStockSector[] | null> {
  const result: AStockSector[] = [];
  let total = Number.MAX_SAFE_INTEGER;
  let page = 1;
  while (result.length < total && page <= 12) {
    if (page > 1) await new Promise((r) => setTimeout(r, 400));
    const query = `/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:${fsT}&fields=${SECTOR_FIELDS}`;
    let raw: string | null = null;
    // 镜像轮换 + 递增退避：EM 边缘节点按“新建连接速率/IP”限流（批量请求后短窗口内新连接被 RST），
    // 背靠背或短间隔重试无效，退避须跨过限流窗口（实测 1.2s→8s 递增有效）
    for (let attempt = 0; attempt < SECTOR_HOSTS.length * 2 && raw === null; attempt++) {
      if (attempt > 0) await sleep(Math.min(8000, 1200 * 1.8 ** (attempt - 1)));
      raw = await emGetText(SECTOR_HOSTS[attempt % SECTOR_HOSTS.length] + query, EM_REFERER);
    }
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw)?.data : null;
    } catch {
      data = null;
    }
    const diff = Array.isArray(data?.diff) ? data.diff : null;
    if (!diff || diff.length === 0) {
      // 首页即失败算整源失败；中途断连返回已取部分供轮询补全
      return page === 1 || result.length === 0 ? null : result;
    }
    if (page === 1) total = optNum(data, 'total', 0);
    for (const o of diff) {
      const code = String(o?.f12 ?? '');
      const name = String(o?.f14 ?? '');
      if (!code || !name) continue;
      result.push({
        code, name,
        price: optNum(o, 'f2', NaN),
        changePct: optNum(o, 'f3', NaN),
        turnoverRate: optNum(o, 'f8', NaN),
        mainInflow: optNum(o, 'f62', 0),
        upCount: Math.trunc(optNum(o, 'f104', 0)),
        downCount: Math.trunc(optNum(o, 'f105', 0)),
        leaderName: String(o?.f128 ?? ''),
        leaderCode: String(o?.f140 ?? ''),
        leaderMarket: Math.trunc(optNum(o, 'f141', 0)),
        leaderPct: optNum(o, 'f136', NaN),
      });
    }
    page++;
  }
  return result.length > 0 ? result : null;
}

// 60秒新鲜度与大盘概览同节奏；stale 3 天盖过休市时段（收盘后东财仍返回收盘数据，
// 真正取不到时靠旧值撑住界面）
const sectorListCaches = new Map<number, StaleCache<AStockSector[]>>([
  [1, new StaleCache<AStockSector[]>(60_000, 3 * 24 * 60 * 60_000)],
  [2, new StaleCache<AStockSector[]>(60_000, 3 * 24 * 60 * 60_000)],
  [3, new StaleCache<AStockSector[]>(60_000, 3 * 24 * 60 * 60_000)],
]);

/** 板块全量行情（fsT: 1地域/2行业/3概念）。缓存新鲜时不发请求；失败兜底期内沿用旧值 */
export function getSectorQuotes(fsT: 1 | 2 | 3): Promise<AStockSector[] | null> {
  const cache = sectorListCaches.get(fsT);
  return cache ? cache.getOrFetch(() => fetchSectorList(fsT)) : Promise.resolve(null);
}

/** 板块行转通用 Quote（点位/涨跌幅；extra 携带面板需要的扩展列） */
export function sectorToQuote(s: AStockSector, tabId: string) {
  const prevClose = Number.isFinite(s.changePct) && s.changePct !== -100 && Number.isFinite(s.price) && s.price > 0
    ? numOf(String(s.price / (1 + s.changePct / 100)))
    : NaN;
  return {
    code: `${tabId}:${s.code}`,
    name: s.name,
    price: s.price,
    prevClose,
    changePct: s.changePct,
    extra: {
      boardCode: s.code,
      turnoverRate: s.turnoverRate,
      mainInflow: s.mainInflow,
      upCount: s.upCount,
      downCount: s.downCount,
      leaderName: s.leaderName,
      leaderCode: s.leaderCode,
      leaderMarket: s.leaderMarket,
      leaderPct: s.leaderPct,
    },
  };
}
