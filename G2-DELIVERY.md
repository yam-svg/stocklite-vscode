# G2 交付说明：AI 研判移植（市场天气 + 盘前研判双账本）

日期：2026-10-29 ｜ 独占文件：`src/data/forecast.ts`（新建）、`src/features/tabs/globalTab.ts`、`src/features/tabs/tabkit.ts`、`package.json`、`extension.ts`、`scripts/forecast.*`

## 交付物

| 文件 | 内容 |
|---|---|
| `src/data/forecast.ts` | 研判核心全量移植（逐常量对照 Kotlin ForecastService.kt，无 vscode import、node 直测）：市场天气六因子（涨跌家数/涨停/跌停/连板高度/封板率/量能环比）与五档分档；盘前研判 8:40 初版/9:15 终版生成锁；gap 回归 `0.025+0.171·A50+0.177·NDX(+0.184·亚洲早盘)` 限幅 ±1.5、缺项退化一元口径；T-1 极值（过热 -12/冰点 +12）与暴跌反转（≤-1.5% +8）、人民币升贬（∓6/+4）；结算 `settleForecasts`（盘前只结跳空、15:00 后全结、错过日期结而不统计宁缺毋假）；双账本 `getStats`（跳空三态 + BULL/BEAR 方向，各自样本/命中率）；watcher 调度表（冷启动 3s/5s/25s、nextDelay 60s/5min/2min/15min/1h 按上海钟点分档）；Yahoo 韩日早盘解析（当地"今天"判据防休市旧数据）+ 新浪 NDX 隔夜；globalState 三键 `forecastHistory/sentimentJson/sentimentDate` 与 JetBrains StockliteState 字段名/NaN↔null 惯例兼容 |
| `src/features/tabs/tabkit.ts` | header 槽：`HeaderSegVM/HeaderCardVM/TableHeaderVM` 结构化 VM + `withHeaderSlot()`（在 renderTableHtml 产物上注入容器/CSS/渲染脚本，textContent 渲染、hex 白名单校验、锚点缺失原样返回降级）；`TableHost` 接口 + `HeaderTableTab`（TableTab 平行小副本，框架字段全 private 无法继承覆写）；`SimpleQuoteTab` 增可选 `header()` 构造参——**不传 header 的六个 tab 走原同步路径字节不变** |
| `src/features/tabs/globalTab.ts` | 全球 tab 顶部两段卡：市场天气卡（档位名+分数五档配色+因子明细+提示语）与盘前研判卡（初/终版标注、gapState 大字、跳空命中/方向胜率账本（样本 ≥3/≥5 才展示）、近 20 条跳空流水悬浮、免责声明）；`refreshForecast` 60s 节流（结算→天气→窗口判定→生成/回读）；当日研判收盘后保留展示、隔日隐去（同 Kotlin forecastVisible） |
| `src/extension.ts` | `activateForecast`：递归 setTimeout watcher（上海钟点自适应），双开关 `forecast.enabled` × 全球 tab——关闭时不干活、只留 ≤5 分钟心跳，开启后快速接上；异常不中断调度 |
| `package.json` | 设置项 `stocklite.forecast.enabled`（默认 true）；`selftest:forecast` 入口并挂入 `selftest:all` |
| `scripts/forecast.selftest.ts` + `scripts/forecast-selftest.mjs` | G2 自测 **66 项** + esbuild 打包入口（vscode 走共享桩） |

## 与 JetBrains 版的已知差异

- **AI 短评未移植**（getAiBrief/deepseek 一句话点评）：VSCode 侧无 API-key 输入界面，属后续独立需求；其余研判逻辑无删减。
- 双账本历史落 globalState 三键，键名与 StockliteState 字段对齐，为跨 IDE 迁移留门（导入导出白名单已提 `docs/contract-changes.md` G2 段）。
- 研判卡渲染现为 tabkit 字符串注入实现，未动 G1 的 webviewHtml 模板；header 协议转正申请在 contract-changes.md。

## 守则遵守情况

- 只写五个独占文件 + 两个新脚本；`src/ui/watchlist/`（G1）零改动；shared/ 未动；JetBrains 仓库只读。
- 行情取数全部复用 data 层既有 provider（breadth/futures/globalIndex/marketTime），未新建网络代码；forecast 落库走裸 globalState（避开 ConfigStore.set 的 configChanged 反馈环）。
- 不 commit 不 push，改动全留工作区；F5 与打包上传归用户。

## 验证结果

- `npm run compile`（全仓库 tsc --noEmit + esbuild）：**零错误**。
- `npm run selftest:forecast`：**66/66 通过**——分档/gap 公式（含单侧退化与限幅）/六因子打分与文案/生成锁（初版锁·终版锁·同日唯一·130 条裁剪）/T-1 与汇率极值边界/结算五场景/双账本样本过滤/调度表/Yahoo 旧数据防护/因子 JSON NaN 往返/header 槽注入与降级。
  自测抓到并修复两处移植缺陷：① 盘前跳空结算分支漏标脏导致 openPct/openHit 落库丢失（Kotlin 活对象语义的深拷贝等价实现漏了）；② 天气 factors 存成嵌套数组而读取按字符串解析致回读丢因子。
- 全量回归 `npm run selftest:all`：**全绿**（17/116/56/31/57/25/35/66）。

## F5 手动验收步骤

> 前置：全球指数 tab 开启（默认开）；`stocklite.forecast.enabled` 默认开。

1. 打开全球指数 tab：顶部应出现「市场天气」卡（交易日盘后含档位名+分数+六因子悬浮明细）；9:25 前打开应见「盘前研判」卡（初/终版标注、隐含跳空大字、因子悬浮明细）。
2. 悬浮跳空数字看近 20 条跳空流水（`MM-DD 高开+0.31 → 高开+0.44 ✅`）；有方向样本 ≥5 时悬浮看方向胜率。
3. 设置里关掉 `forecast.enabled` → 顶部卡消失、watcher 停摆（≤5 分钟内生效）；重开恢复。
4. 收盘（15:00）后次日再看当日研判卡，跳空/方向结算值与账本计数应更新（历史 ≥3/5 条才显示胜率）。
5. 无数据兜底：断网时卡显示"数据缺失"/"待生成"，不应报错、不应影响行情列表。
