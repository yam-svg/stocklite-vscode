# S6 交付说明：七个可选 tab 页真实实现

日期：2026-10-29 ｜ 独占目录：`src/features/tabs/`、`scripts/tabs.selftest.ts`、`scripts/tabs-selftest.mjs`

## 交付物

| 文件 | 内容 |
|---|---|
| `src/features/tabs/tabkit.ts` | `SimpleQuoteTab` 公共底座：TableTab 装配、事件订阅（viewAdd/refresh/configChanged）、自治轮询、三态排序、快照构建与右键/工具栏默认行为；`pickToAdd`（搜索+直添 QuickPick）、`pickMany`（多选清单）、`updateStockliteSetting`（Global 作用域写 contributes 设置）等共享件 |
| `src/features/tabs/store.ts` | `TabListStore` 列表仓库（顺序即展示序、可拖拽重排）；播种判据用独立布尔键 `futuresDefaultsSeeded`/`cryptoDefaultsSeeded`（判"数据为空"是 JetBrains 版踩过的坑，绝不复用）；`usEtfDisplayList` 三态（未写入=全显/保存=以盘为准/删空保持空） |
| `src/features/tabs/globalTab.ts` | 全球指数：目录复用 `data/globalIndex.ts` 37 条（未再造）；显示过滤读写双轨设置 `indexes.hidden`/`indexes.enabledOptional`；「＋ 选择指数」= 常用/更多两节 MultiSelect；行"删除"=隐藏；Yahoo 限流状态行标注；延迟/休市角标 |
| `src/features/tabs/futuresTab.ts` | 期货：StateKeys.futures；首用播种 hf_NQ/hf_OIL；`addFuture` 搜索+验行情入列；「导入」粘贴批量；右键删除/拖拽重排；A 股时段感知轮询 |
| `src/features/tabs/fundsTab.ts` | 基金：StateKeys.funds；净值列固定 4 位小数（`fundNavCell` 纯函数）；**无估值列**（JetBrains 已下线 fundgz）；`addFund`/`batchImportFunds`（粘贴提取 6 位码+验净值）；「分组」按钮复用为持仓明细弹窗（数据= `getFundQuotes` 现成接口） |
| `src/features/tabs/cryptoTab.ts` | 加密币：StateKeys.cryptos，首用播种六主流币 USDT 对；三源降级在 `data/cryptos.ts`；连通状态行徽章（来源/部分降级/⚠三源不可达）+ 状态翻转一次性通知（徽章意图延续）；24h 高低/成交额列；`addCrypto`/批量导入 |
| `src/features/tabs/sectorTab.ts` | 板块：东财榜单只读，行业/概念/地域分组条切换；列=涨跌幅/点位/换手/主力净流入(正负着色)/涨跌家数/领涨股；双击行=领涨股出图（`leaderStockSymbol` 纯函数：北交所前缀优先，f141 判沪深）；断连保留旧数据+状态行标注，60s 轮询补全 |
| `src/features/tabs/usTab.ts` | 美股：分组「板块ETF/美股指数」；ETF 33 只目录（`US_SECTOR_ETFS`）+ 盘前/盘后延伸涨跌列 + 时段徽章（盘前/常规盘/盘后/休市）；显示清单独立键 `usEtfWatchlist`（多选勾选/右键移除）；指数行复用 `GLOBAL_INDEXES` 的 US 条目（同一目录单一数据源） |
| `src/features/tabs/ipoTab.ts` | 新股：东财日历只读，分组「申购日历/新股次新股」；`splitIpoGroups` 纯函数（次新股上市日倒序、null 安全）；现价列复用 `getStockQuotes`；未上市双击提示不出图，已上市双击出图；5 分钟轮询 |
| `src/features/tabs/index.ts` | 装配：7 tab 全量 activate（替换 S0 占位视图）；四个预注册桩命令换真实现（addFund/addFuture/addCrypto/addGlobalIndex） |
| `scripts/tabs.selftest.ts` + `scripts/tabs-selftest.mjs` | S6 自测 35 项 + esbuild 打包入口（vscode 走桩，同 watchlist 模式） |

## 守则遵守情况

- 只写 `src/features/tabs/` 与两个新脚本；未动 `package.json`/`shared/`/`extension.ts`/其他会话目录；数据全部 `import src/data` 直取、未改数据层。
- 全球目录复用 `data/globalIndex.ts`（37 条 + `visibleGlobalIndexes` 双轨单入口），未再造副本；期货播种独立键、判据=布尔键非"列表为空"。
- 契约缺口 3 条已追加 `docs/contract-changes.md` S6 小节（三枚 globalState 键入导入导出、工具栏/菜单文案可配置、调度器接线附议与双轮询提示）。
- `executeCommand` Thenable 统一 `Promise.resolve` 包（tabkit.runSetAlert）；不提交 git，改动全留工作区。

## 验证结果

- `npm run compile`（全仓库 `tsc --noEmit` + esbuild）：**零错误**。
- S6 自测 **35/35 通过**：`node scripts/tabs-selftest.mjs && node out/tabs-selftest.cjs`
  覆盖：播种判据 8（首用播种/删空不复活/非空不覆盖/无 seedKey 不播种/去重/移除/常量表/applyOrder）、
  美股 ETF 清单 3（三态）、双轨可见性 4（默认/hidden/enabledOptional/互不串台）、代码归一 8（期货/加密/基金）、
  领涨股 symbol 4、新股分组 4、列格式化 4（净值 4 位/着色/无效值/万亿缩写）。
- 回归：S0 契约 17/17、S2 自选 45/45 不受影响；打包 esbuild 仅 1 条无害警告
  （桩缺 ConfigurationTarget 导出，自测路径不会调用；属共享桩文件，S6 无权补）。

## F5 手动验收步骤

> 前置：设置里 `stocklite.tabs.*` 打开对应 tab（默认开 基金/期货/全球，板块/新股/美股/加密币需手动开）。

1. **全球指数**：F5 起宿主 →"全球指数"应有默认 20 条（含 交易/休市、延迟 角标）；点标题栏 `+` 或工具栏「＋ 添加」→ 常用/更多两节勾选框，勾"瑞士SMI"确认后列表新增该行、`settings.json`（用户级）出现 `stocklite.indexes.enabledOptional`；对某行右键"删除"=隐藏，恢复用同一弹窗。与设置页"全球指数"弹窗互会同状态。
2. **期货**：首开即见 hf_NQ（纳斯达克100）/hf_OIL（布伦特原油）；改 `stocklite.pollIntervalSeconds` 观察状态行节奏；「＋ 添加」输 `AU0` 见搜索与"直接添加 nf_AU0"项，添加成功；「导入」粘 `hf_NQ, nf_AU0` 提示新增 0（已存在）；行右键删除 + 重启不复活（播种标记生效）。
3. **基金**：「＋ 添加」输 012414 验净值入列（净值列 4 位小数，无估值列）；「导入」粘贴含代码文本自动提取 6 位；工具栏「分组」弹"我的基金持仓明细"QuickPick（description 带净值/日涨幅/净值日期）。
4. **加密币**：首开播种 BTC/ETH/SOL/BNB/XRP/DOGE USDT 六对；断网（或 hosts 屏蔽 api.bitget.com）→ 状态行出现"部分降级"且自动换源；三源全断弹一次"均无法连接"警告、恢复弹一次提示，稳定期不刷屏；「＋ 添加」输 `pepe` 归一 PEPE_USDT。
5. **板块**：分组条切 行业/概念/地域，各 100+ 行（东财断连时状态行标"东财源不稳定"并保留旧数据，60s 后自动补全）；双击任一行打开领涨股走势图（S3 面板）；「＋/导入」只提示不报错。
6. **美股**：「板块ETF」33 只 + 时段徽章；美股盘前/盘后时段"盘前/盘后"列有延伸涨跌，其余时段显示 `--`；「＋ 添加」33 只多选（当前显示预选），取消勾选 XLK 后列表消失且重启保持；右键删除同理；切「美股指数」见 SPX/DJI/IXIC/NDX/VIX 五带状态列；"指数页删行"提示引导全球指数页。
7. **新股**：「申购日历」= 未上市按申购日升序，「新股/次新股」= 上市日倒序；已次新行有现价/涨跌幅（腾讯/新浪源）且双击出图；未上市行双击提示"尚未上市"；命令面板跑 `StockLite: 添加基金/添加期货/添加加密币/选择显示的全球指数` 四条均进真实弹窗（不再是 S6 桩提示）。
8. **通用**：各 tab 点标题栏 `+`/刷新（viewAdd/refresh 广播路由命中本 viewId）；表头三态排序；无排序时行拖拽重排（列表型 tab 落盘、只读榜单不报错）；右键"设置提醒"进 S4 提醒面板。
