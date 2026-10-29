# StockLite for VS Code

A股/基金/期货/全球指数实时行情、持仓盈亏、买卖点标记与涨跌提醒，常驻 VSCode 状态栏与侧边栏。

> 开发中。本工程由 JetBrains 插件 StockLite 移植而来，
> 总计划与并行会话分工见 ../stocklite-plugin/docs/vscode-port-plan.md。

## 开发

```bash
npm install
npm run compile   # 类型检查 + 打包
npm run selftest  # 契约层自测（不依赖 vscode）
```

F5 启动“扩展开发宿主”查看侧边栏 StockLite 图标（当前为 S0 占位视图）。

## 目录所有权（并行开发铁律）

| 目录 | 归属 |
|---|---|
| `src/shared/`、`package.json`、`src/extension.ts` | S0 冻结，改动走 docs/contract-changes.md |
| `src/data/` | S1 数据源 |
| `src/ui/watchlist/` | S2 通用行情表 + 自选股 |
| `src/ui/chart/` | S3 K线/分时/盈亏日历 |
| `src/features/statusbar/` `src/features/alerts/` | S4 |
| `src/features/settings/` | S5 |
| `src/features/tabs/` | S6 可选 tab |

## S1 数据源层（已交付）

`src/data/` 为移植自 Kotlin MarketDataService/ChartDataService 的纯 TS 数据层（不 import vscode），
含 8 个 provider（stock/fund/future/global/sector/ipo/us/crypto）、交易时段感知轮询调度器
`PollScheduler`（开市 5s/收市 60s、in-flight 合并、失败退避封顶 5 分钟）、37 条全球指数双轨可见性、
大盘涨跌家数/涨停生态/离岸人民币概览与 A 股搜索、导入校验、财报日期。

自测：

```bash
npm run compile                                   # 零错误
node scripts/data-selftest.mjs && node out/data-selftest.cjs   # 离线 116 项
STOCKLITE_ONLINE=1 node out/data-selftest.cjs                   # 追加在线 23 项（真实接口）
```

F5 手动验收（S1 无 UI，验证装配点即可）：

1. F5 起扩展开发宿主（当前仍是 S0 占位视图，属预期）。
2. 宿主终端里跑 `STOCKLITE_ONLINE=1 node out/data-selftest.cjs`，确认在线 23 项全绿；
   若"板块行业榜"偶发失败，是东财 push2 随机断连（既定坑），重跑或等 60s 轮询补全即可。
3. 真正的装配验收待 S7 在 extension.ts 接 `activateData` 后进行（接线需求见 docs/contract-changes.md S1 段）。
