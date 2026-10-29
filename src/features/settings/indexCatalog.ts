/**
 * 全球指数目录 + 双轨可见性计算（纯逻辑，无 vscode 依赖，供 selftest 直跑）。
 * 目录逐条移植自 JetBrains 版 MarketDataService.GLOBAL_INDEXES（37 条：默认 20 + 更多指数 17）。
 * 双轨语义与 GlobalIndexPickerDialog 一致：
 *  - 默认指数：勾选=显示；取消 → 加入 hidden；
 *  - 更多指数（optional）：默认不显示；勾选 → 加入 enabledOptional。
 * S7 集成时建议把本目录上收 shared/，供 S6 的全球 tab 复用（见 docs/contract-changes.md）。
 */

export interface GlobalIndexConfig {
  symbol: string;
  code: string;
  nameEn: string;
  nameCn: string;
  market: string;
  timezone: string;
  /** true = 小众扩展指数（"更多指数"），默认不显示 */
  optional: boolean;
}

function idx(symbol: string, code: string, nameEn: string, nameCn: string, market: string, timezone: string, optional = false): GlobalIndexConfig {
  return { symbol, code, nameEn, nameCn, market, timezone, optional };
}

export const GLOBAL_INDEXES: GlobalIndexConfig[] = [
  idx('^GSPC', 'SPX', 'S&P 500', '标普500', 'US', 'America/New_York'),
  idx('^DJI', 'DJI', 'Dow Jones', '道琼斯', 'US', 'America/New_York'),
  idx('^IXIC', 'IXIC', 'NASDAQ', '纳斯达克', 'US', 'America/New_York'),
  idx('^NDX', 'NDX', 'NASDAQ 100', '纳指100', 'US', 'America/New_York'),
  idx('^VIX', 'VIX', 'CBOE VIX', 'VIX恐慌指数', 'US', 'America/New_York'),
  idx('^FTSE', 'FTSE', 'FTSE 100', '英国富时100', 'UK', 'Europe/London'),
  idx('^GDAXI', 'DAX', 'DAX', '德国DAX', 'DE', 'Europe/Berlin'),
  idx('^FCHI', 'CAC40', 'CAC 40', '法国CAC40', 'FR', 'Europe/Paris'),
  idx('^BVSP', 'BVSP', 'Bovespa', '巴西IBOVESPA', 'BR', 'America/Sao_Paulo'),
  idx('^N225', 'N225', 'Nikkei 225', '日经225', 'JP', 'Asia/Tokyo'),
  idx('^KS11', 'KOSPI', 'KOSPI', '韩国综合指数', 'KR', 'Asia/Seoul'),
  idx('^TWII', 'TWII', 'TAIEX', '台湾加权指数', 'TW', 'Asia/Taipei'),
  idx('^BSESN', 'SENSEX', 'SENSEX', '印度SENSEX', 'IN', 'Asia/Kolkata'),
  idx('^HSI', 'HSI', 'Hang Seng', '恒生指数', 'HK', 'Asia/Hong_Kong'),
  idx('^HSTECH', 'HSTECH', 'Hang Seng TECH', '恒生科技指数', 'HK', 'Asia/Hong_Kong'),
  idx('000001.SS', 'SSE', 'SSE Composite', '上证指数', 'CN', 'Asia/Shanghai'),
  idx('399001.SZ', 'SZSE', 'SZSE Component', '深证成指', 'CN', 'Asia/Shanghai'),
  idx('399006.SZ', 'CYB', 'ChiNext', '创业板指', 'CN', 'Asia/Shanghai'),
  idx('000300.SS', 'CSI300', 'CSI 300', '沪深300', 'CN', 'Asia/Shanghai'),
  idx('000688.SS', 'STAR50', 'STAR 50', '科创50', 'CN', 'Asia/Shanghai'),
  // ── "更多指数"扩展条目（optional，默认关闭）。Yahoo 无源的市场勿加，
  //    实测无数据的候选清单见 JetBrains 版 MarketDataService 注释 ──
  idx('^STOXX50E', 'STOXX50', 'EURO STOXX 50', '欧洲STOXX50', 'EU', 'Europe/Paris', true),
  idx('^SSMI', 'SMI', 'Swiss Market', '瑞士SMI', 'CH', 'Europe/Zurich', true),
  idx('^AEX', 'AEX', 'AEX Amsterdam', '荷兰AEX', 'NL', 'Europe/Amsterdam', true),
  idx('^OMXSPI', 'OMX', 'OMX Stockholm 30', '瑞典OMX', 'SE', 'Europe/Stockholm', true),
  idx('^IBEX', 'IBEX', 'IBEX 35', '西班牙IBEX35', 'ES', 'Europe/Madrid', true),
  idx('^GSPTSE', 'TSX', 'S&P/TSX', '加拿大TSX', 'CA', 'America/Toronto', true),
  idx('^MERV', 'MERV', 'MERVAL', '阿根廷Merval', 'AR', 'America/Argentina/Buenos_Aires', true),
  idx('^NSEI', 'NIFTY', 'NIFTY 50', '印度Nifty50', 'IN', 'Asia/Kolkata', true),
  idx('^STI', 'STI', 'Straits Times', '新加坡海峡时报', 'SG', 'Asia/Singapore', true),
  idx('^KLSE', 'KLCI', 'KLSE Composite', '马来西亚KLCI', 'MY', 'Asia/Kuala_Lumpur', true),
  idx('^JKSE', 'JCI', 'IDX Composite', '印尼雅加达综指', 'ID', 'Asia/Jakarta', true),
  idx('^SET.BK', 'SET', 'SET Index', '泰国SET', 'TH', 'Asia/Bangkok', true),
  idx('^VNINDEX.VN', 'VNINDEX', 'VN Index', '越南VNIndex', 'VN', 'Asia/Ho_Chi_Minh', true),
  idx('^TASI.SR', 'TASI', 'Tadawul TASI', '沙特TASI', 'SA', 'Asia/Riyadh', true),
  idx('^TA125.TA', 'TA125', 'TA-125', '以色列TA125', 'IL', 'Asia/Jerusalem', true),
  idx('^J203.JO', 'TOP40', 'JSE Top 40', '南非Top40', 'ZA', 'Africa/Johannesburg', true),
  idx('^EGX30.CA', 'EGX30', 'EGX 30', '埃及EGX30', 'EG', 'Africa/Cairo', true),
];

export const DEFAULT_INDEXES = GLOBAL_INDEXES.filter((i) => !i.optional);
export const OPTIONAL_INDEXES = GLOBAL_INDEXES.filter((i) => i.optional);

/** 双轨可见性单入口：默认指数去掉 hidden，加上 enabledOptional 中的扩展指数。目录外的 id 忽略 */
export function visibleGlobalIndexes(hidden: Iterable<string>, enabledOptional: Iterable<string>): GlobalIndexConfig[] {
  const hiddenSet = new Set(hidden);
  const enabledSet = new Set(enabledOptional);
  return GLOBAL_INDEXES.filter((i) =>
    i.optional ? enabledSet.has(i.symbol) : !hiddenSet.has(i.symbol),
  );
}
