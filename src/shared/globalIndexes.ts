/**
 * 全球指数目录 + 双轨可见性（S7a 自 data/globalIndex.ts 上收，S5 曾持镜像副本
 * features/settings/indexCatalog.ts，两份合并为单一数据源，防漂移）。
 * 目录逐条移植自 JetBrains 版 MarketDataService.GLOBAL_INDEXES（37 条：默认 20 + 更多指数 17）。
 * 双轨语义与 Kotlin GlobalIndexPickerDialog 一致：
 *  - 默认指数：勾选=显示；取消 → 加入 hidden；
 *  - 更多指数（optional）：默认不显示；勾选 → 加入 enabledOptional。
 * 纯数据无 IO，S1 全球 provider、S5 设置页与 S6 全球 tab 共用本文件。
 */

export interface GlobalIndexConfig {
  symbol: string;
  code: string;
  nameEn: string;
  nameCn: string;
  market: string;
  timezone: string;
  /** true = 小众扩展指数：设置页“更多指数”tab 管理，默认不显示 */
  optional: boolean;
}

const G = (symbol: string, code: string, nameEn: string, nameCn: string, market: string, timezone: string, optional = false): GlobalIndexConfig =>
  ({ symbol, code, nameEn, nameCn, market, timezone, optional });

export const GLOBAL_INDEXES: GlobalIndexConfig[] = [
  G('^GSPC', 'SPX', 'S&P 500', '标普500', 'US', 'America/New_York'),
  G('^DJI', 'DJI', 'Dow Jones', '道琼斯', 'US', 'America/New_York'),
  G('^IXIC', 'IXIC', 'NASDAQ', '纳斯达克', 'US', 'America/New_York'),
  G('^NDX', 'NDX', 'NASDAQ 100', '纳指100', 'US', 'America/New_York'),
  G('^VIX', 'VIX', 'CBOE VIX', 'VIX恐慌指数', 'US', 'America/New_York'),
  G('^FTSE', 'FTSE', 'FTSE 100', '英国富时100', 'UK', 'Europe/London'),
  G('^GDAXI', 'DAX', 'DAX', '德国DAX', 'DE', 'Europe/Berlin'),
  G('^FCHI', 'CAC40', 'CAC 40', '法国CAC40', 'FR', 'Europe/Paris'),
  G('^BVSP', 'BVSP', 'Bovespa', '巴西IBOVESPA', 'BR', 'America/Sao_Paulo'),
  G('^N225', 'N225', 'Nikkei 225', '日经225', 'JP', 'Asia/Tokyo'),
  G('^KS11', 'KOSPI', 'KOSPI', '韩国综合指数', 'KR', 'Asia/Seoul'),
  G('^TWII', 'TWII', 'TAIEX', '台湾加权指数', 'TW', 'Asia/Taipei'),
  G('^BSESN', 'SENSEX', 'SENSEX', '印度SENSEX', 'IN', 'Asia/Kolkata'),
  G('^HSI', 'HSI', 'Hang Seng', '恒生指数', 'HK', 'Asia/Hong_Kong'),
  G('^HSTECH', 'HSTECH', 'Hang Seng TECH', '恒生科技指数', 'HK', 'Asia/Hong_Kong'),
  G('000001.SS', 'SSE', 'SSE Composite', '上证指数', 'CN', 'Asia/Shanghai'),
  G('399001.SZ', 'SZSE', 'SZSE Component', '深证成指', 'CN', 'Asia/Shanghai'),
  G('399006.SZ', 'CYB', 'ChiNext', '创业板指', 'CN', 'Asia/Shanghai'),
  G('000300.SS', 'CSI300', 'CSI 300', '沪深300', 'CN', 'Asia/Shanghai'),
  G('000688.SS', 'STAR50', 'STAR 50', '科创50', 'CN', 'Asia/Shanghai'),
  // “更多指数”扩展条目（optional，默认关闭）。Yahoo 无源的市场勿加：
  // 实测无数据/已下架——意大利FTSE MIB、波兰WIG20、葡萄牙PSI20、菲律宾PSEi、土耳其BIST100、俄罗斯RTSI、墨西哥IPC
  G('^STOXX50E', 'STOXX50', 'EURO STOXX 50', '欧洲STOXX50', 'EU', 'Europe/Paris', true),
  G('^SSMI', 'SMI', 'Swiss Market', '瑞士SMI', 'CH', 'Europe/Zurich', true),
  G('^AEX', 'AEX', 'AEX Amsterdam', '荷兰AEX', 'NL', 'Europe/Amsterdam', true),
  G('^OMXSPI', 'OMX', 'OMX Stockholm 30', '瑞典OMX', 'SE', 'Europe/Stockholm', true),
  G('^IBEX', 'IBEX', 'IBEX 35', '西班牙IBEX35', 'ES', 'Europe/Madrid', true),
  G('^GSPTSE', 'TSX', 'S&P/TSX', '加拿大TSX', 'CA', 'America/Toronto', true),
  G('^MERV', 'MERV', 'MERVAL', '阿根廷Merval', 'AR', 'America/Argentina/Buenos_Aires', true),
  G('^NSEI', 'NIFTY', 'NIFTY 50', '印度Nifty50', 'IN', 'Asia/Kolkata', true),
  G('^STI', 'STI', 'Straits Times', '新加坡海峡时报', 'SG', 'Asia/Singapore', true),
  G('^KLSE', 'KLCI', 'KLSE Composite', '马来西亚KLCI', 'MY', 'Asia/Kuala_Lumpur', true),
  G('^JKSE', 'JCI', 'IDX Composite', '印尼雅加达综指', 'ID', 'Asia/Jakarta', true),
  G('^SET.BK', 'SET', 'SET Index', '泰国SET', 'TH', 'Asia/Bangkok', true),
  G('^VNINDEX.VN', 'VNINDEX', 'VN Index', '越南VNIndex', 'VN', 'Asia/Ho_Chi_Minh', true),
  G('^TASI.SR', 'TASI', 'Tadawul TASI', '沙特TASI', 'SA', 'Asia/Riyadh', true),
  G('^TA125.TA', 'TA125', 'TA-125', '以色列TA125', 'IL', 'Asia/Jerusalem', true),
  G('^J203.JO', 'TOP40', 'JSE Top 40', '南非Top40', 'ZA', 'Africa/Johannesburg', true),
  G('^EGX30.CA', 'EGX30', 'EGX 30', '埃及EGX30', 'EG', 'Africa/Cairo', true),
];

export const DEFAULT_INDEXES = GLOBAL_INDEXES.filter((it) => !it.optional);
export const OPTIONAL_INDEXES = GLOBAL_INDEXES.filter((it) => it.optional);

/** 双轨可见性单入口（Kotlin visibleGlobalIndexes）：optional 需 enabled 命中；默认项需不在 hidden。目录外的 id 忽略 */
export function visibleGlobalIndexes(hidden: Iterable<string>, enabledOptional: Iterable<string>): GlobalIndexConfig[] {
  const hiddenSet = new Set(hidden);
  const enabledSet = new Set(enabledOptional);
  return GLOBAL_INDEXES.filter((it) => (it.optional ? enabledSet.has(it.symbol) : !hiddenSet.has(it.symbol)));
}
