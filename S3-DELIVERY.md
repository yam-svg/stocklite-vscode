# S3 交付说明：图表 Webview（K线/分时 + B/S 标记 + 盈亏日历）

日期：2026-10-29 ｜ 独占目录：`src/ui/chart/`、`webview/chart/`、`scripts/chart.selftest.*`、`scripts/tsconfig.chart.json`

## 交付物

| 文件 | 内容 |
|---|---|
| `src/ui/chart/markers.ts` | 移植 Kotlin `TradeMarkerUtil`：K线标记（精确命中→非交易日顺延→越界丢弃、同日同向聚合、先买后卖排序）；日内标记按成交价反查分时曲线（容差 max(1分, 0.1%)，未触及标最接近点，未填价标开盘点） |
| `src/ui/chart/pnl.ts` | 移植 Kotlin `PnlChartService`：逐日回放（加权平均成本/已实现+未实现/当日收益率分母口径）、手动持仓合成建仓、组合按日聚合与当日各股明细 |
| `src/ui/chart/dataSource.ts` | Provider 过渡垫片（`setChartDataProvider`，默认 mock），S7 经此注入 S1 真实 provider |
| `src/ui/chart/chartPanel.ts` | 图表面板宿主侧：单例复用、分时/K线加载（带请求竞态丢弃）、昨收获取、tradesChanged 重算标记、红涨绿跌/主题变更推送、CSP+nonce HTML |
| `src/ui/chart/pnlPanel.ts` | 盈亏日历面板宿主侧：交易记录+手填持仓 → 逐日盈亏 → 组合聚合，一次推给 webview |
| `src/ui/chart/index.ts` | 接线：openChart 命令（无参走自选 QuickPick）、openChart 事件、showPnlCalendar 命令 |
| `webview/chart/chart.js` | klinecharts v9 渲染：日/周/月 K（蜡烛+VOL 副图）↔ 当日分时（面积线+均价线 STOCKLITE_AVG 指标+昨收虚线基准，昨收涨/跌定线色）、周期切换、自定义 tooltip（OHLC/涨跌额%/量、分时显示均价）、B/S 自定义 overlay（圆点+字母，涨色 B 下方/跌色 S 上方）、明暗主题按前景色亮度自适配、ResizeObserver 自适应 |
| `webview/chart/chart.css` | 工具栏/状态条，全走 VSCode 主题变量 |
| `webview/chart/pnl.js` / `pnl.css` | 独立盈亏日历面板：累计盈亏 SVG 走势折线（零轴+渐变填充）、GitHub 风格月历热图（色深按 \|当日盈亏\|/月内max 缩放、周一起、月导航/本月合计、点击日期出各股当日盈亏明细表）、顶部全部/单票切换 |
| `webview/chart/assets/klinecharts.min.js` | klinecharts 9.8.12 UMD（本地资产，CSP 禁远程脚本） |
| `scripts/chart.selftest.ts` + `.mjs` | 自测：31 项断言（标记匹配 15 / 盈亏回放 12 / 组合聚合 4）+ webview JS 语法门禁 + 资产存在性检查 |
| `scripts/tsconfig.chart.json` | S3 范围类型检查（并行会话在途代码污染全量 tsc 时的验收口径，S7 集成后删除） |

## 守则遵守情况

- 只动独占目录 + `S3-DELIVERY.md` + `docs/contract-changes.md` 追加段；未动 `package.json` / `shared/` / 其他会话目录。
- klinecharts 用 `npm install klinecharts@9 --no-save` 安装后把 UMD 复制入资产目录（运行时零 npm 依赖），devDependency 诉求已记入 contract-changes.md（连同 Provider 注册表附议）。
- 不执行 git commit/push，改动全部留在工作区。

## 验证结果

- `npx tsc --noEmit -p scripts/tsconfig.chart.json`：S3 范围（extension/shared/features/watchlist/ui/chart/selftest）**零错误**。
- `node scripts/chart.selftest.mjs`：**31/31 通过**。
- `npm run selftest`（S0 契约层）：**17/17 通过**，未破坏既有契约。
- `node esbuild.mjs` 打包成功。
- ⚠️ 全仓 `npx tsc --noEmit` 仍报错，全部位于 S1 在途的 `src/data/`（providers/funds/globalIndex/ipos，extra 字段 null 与 `Record<string, string|number|undefined>` 不兼容等），非 S3 引入，归 S1/S7 处理。

## F5 手动验收步骤

1. F5 起开发宿主 → 命令面板 `StockLite: 查看K线/分时` → QuickPick 选 `sh600519`（S2 首启已播种）→ 打开图表面板，默认日 K（红绿蜡烛 + 下方量副图 + 右上角现价标签）。
2. 顶栏切 `分时/日K/周K/月K`：分时为面积图（现价≥昨收红、反之绿），叠加均价线与昨收虚线；十字光标 tooltip 分时显示价/均价，K 线显示 OHLC + 涨跌额% + 量。
3. B/S 标记：在"股票"tab 右键某只自选 → 交易记录，录一笔**今天**（买入）和一笔**上周日期**（卖出）；回到图表：K 线对应日期出现 B/S 圆点（B 涨色在 K 线下方、S 跌色上方），切"分时"当日笔标在价格曲线触及处。
4. 设置 `stocklite.colorUp` 改 `green`（绿涨红跌）与切换明暗主题：图表配色即时跟随，无需重开面板。
5. 命令面板 `StockLite: 盈亏日历`：顶部累计盈亏走势折线与汇总（截至日/累计/当日），下方月历热图 ◀▶/今天导航、本月合计；点有色日期出各股当日盈亏明细；下拉切"全部持仓/单票"。
6. 拖动编辑器分栏宽窄，图表实时重排。

## 已知限制（移交 S7/S1）

- 数据为 mock：真实接入 = S1 provider 注册后经 `dataSource.setChartDataProvider()` 注入，UI 零改动。
- 分时 x 轴午休 11:30→13:01 相邻（时间标签连续、无空洞），与 JetBrains 版 lightweight-charts 行为一致。
- klinecharts v9 无 setType，分时↔K 线切换时销毁重建图表（体感 <100ms，保留各自状态）。
- ADJUST（成本修正）类型 Kotlin 版有、TS 契约 TradeRecord 无，回放暂不支持；契约如需支持走 contract-changes。
