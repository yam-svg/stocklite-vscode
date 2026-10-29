# S2 交付说明：通用行情表框架 + 自选股 tab

日期：2026-10-29 ｜ 独占目录：`src/ui/watchlist/`、`scripts/watchlist.*`、`scripts/vscode-stub.mjs`、`scripts/watchlist-selftest.mjs`

## 交付物

| 文件 | 内容 |
|---|---|
| `src/ui/watchlist/table/types.ts` | 视图模型（TableSnapshot/RowVM/CellVM）与 webview 消息协议 |
| `src/ui/watchlist/table/webviewHtml.ts` | 纯渲染 webview 模板：分组 tab 条、三态排序表头、行拖拽、右键菜单、涨跌色阶（跟随红涨绿跌设置）、明暗主题 |
| `src/ui/watchlist/table/framework.ts` | `TableTab` 通用框架：注册 WebviewView、消息路由、refresh；S6 各 tab 传 handlers 即复用 |
| `src/ui/watchlist/table/format.ts` / `sorting.ts` | 单元格格式化（万/亿、百分比、价格位数）与表头三态排序（纯逻辑） |
| `src/ui/watchlist/stockTab.ts` | 自选股主体：轮询、持仓列、添加/删除/批量导入/分组/交易记录全部交互 |
| `src/ui/watchlist/store.ts` | globalState 仓库（watchlist/stockGroups/tradeRecords/positions），播种判据用独立布尔键（不用"数据为空"判断——JetBrains 版踩过的坑） |
| `src/ui/watchlist/positions.ts` | 加权平均成本推导、已实现盈亏、今日盈亏（公式对齐 Kotlin `MarketTimeUtil.calcTodayPnl`） |
| `src/ui/watchlist/stockTextParser.ts` | 批量导入词法解析，移植自 Kotlin `StockTextParser.kt`（规则逐条对齐） |
| `src/ui/watchlist/providers.ts` | provider 过渡注册表（S1 完成前回落 mock；已在 contract-changes.md 提案 shared 版） |

## 守则遵守情况

- 未动 `package.json` / `shared/` / 其他会话目录；只注册 package.json 已预声明的命令（deleteItem/batchImport/manageGroups/showTradeHistory），"添加"走 `viewAddRequested` 事件与 webview 工具栏。
- 契约缺口 2 条已追加到 `docs/contract-changes.md`（Provider 注册表、播种键纳入导入导出）。
- 不提交 git，改动全部留在工作区。

## 验证结果

- `npx tsc --noEmit`：`src/ui/watchlist/**` 与 `scripts/watchlist.selftest.ts` **零错误**。
  ⚠️ 全仓库当前另有 17 个 tsc 错误，全部位于 S1 `src/data/`（funds/globalIndex/ipos）与 S3 `src/ui/chart/`（chartPanel/markers），非 S2 引入，归各会话修复。
- `node esbuild.mjs` 打包成功（bundle 不做类型检查，不受上述影响）。
- S2 自测 45/45 通过：`node scripts/watchlist-selftest.mjs && node out/watchlist-selftest.cjs`
  覆盖：StockTextParser 17 项（前缀/后缀/裸码/北交所/港股补位/名称配对/去重/上限）、持仓推导 7 项（加权成本/卖出/清仓/今日盈亏精确模式/手填覆盖）、排序 5 项（三态/万亿解析/缺数末位/中文列）、格式化 4 项、仓库 10 项、provider 3 项。
- S0 `npm run selftest` 契约层不受影响。

## F5 手动验收步骤

1. F5 起开发宿主 → 侧边栏 StockLite →"股票"tab（不再是占位视图）。
2. 首启自动播种 3 只示例（贵州茅台/东方财富/沪深300ETF），状态行显示"已更新 · Mock 数据（S1 未接入）· 共 3 只"。
3. 点表头"涨跌幅"×3 次：升序 → 降序 → 恢复默认序；"代码"列中文名称列同理。
4. 拖拽行换位（排序激活时拖不动，属预期）；重启宿主后顺序保持。
5. 工具栏"＋ 添加"→ 输入 `sh600519` 可见"直接添加"项；输入"茅台"见搜索结果；添加成功入列表。
6. 行右键 →"交易记录"→"＋ 添加交易记录"：买入 10 元×1000，日期今天 → 行上出现"成本/持仓/今日盈亏/盈亏"列值（现价<10 时今日盈亏为负红、>10 正绿——颜色随 `stocklite.colorUp` 变化）。
7. 同一记录改成卖 500 后，持仓减半、成本不变（加权平均法）。
8. 工具栏"分组"→ 新建"科技"→ 选中该分组 → "＋ 添加"入组；分组 tab 条切换；"全部"视图合并去重；删除分组后股票回落"全部"。
9. 工具栏"导入"→ 弹出临时编辑器，粘贴 `贵州茅台 600519\n宁德时代、AAPL\n00700.HK` → 停 1 秒自动解析 → QuickPick 勾选（已在自选/未找到有标注，可导入项预选）→ 确认入列表；取消通知即放弃。
10. 行右键"打开图表"：S3 未接管时无崩溃（事件无人订阅静默）；"设置提醒"弹出 S4 占位提示。
11. 视图标题栏 `+`/刷新按钮广播路由正常（`viewAddRequested`/`refreshRequested` 按 viewId=stocklite.stock 命中）。
12. 改设置 `stocklite.colorUp` 为 green → 表格颜色即时翻转、轮询定时器重建。
13. `stocklite.pollIntervalSeconds` 改 5→10，观察状态行更新时间间隔变化。
14. 删除：行右键"删除"立即移除；命令面板"StockLite: 删除所选"可多选批量删。
