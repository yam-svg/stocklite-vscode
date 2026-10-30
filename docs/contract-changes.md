# 契约变更申请

`src/shared/*` 与 `package.json` 已冻结。任何会话发现契约不够用时，在**下方追加自己的小节**（只加不改别人的），S7 集成时统一落实并升版本号。

格式：

```
## 申请人：SX（日期）
- 文件：src/shared/types.ts
- 需求：Quote.extra 需要约定封单手数的 key 名（建议 extra.sealLots）
- 原因：S4 提醒引擎读取该字段
```

---

## 申请人：S0（2026-10-29）
（无——S0 为契约制定者，初始化无申请）

## 申请人：S2（2026-10-29）
- 文件：src/shared/（新增 registry.ts 或并入 config.ts 均可）
- 需求：跨会话 Provider 注册表 `registerProvider(p) / getProvider(id)`，S1 注册真实 provider，UI 会话按 id 取用；未注册时回落 mock。
- 原因：契约只有 `providerRegistered` 事件（只带 id 不带实例），UI 无法拿到 S1 的 provider 对象。S2 已在 `src/ui/watchlist/providers.ts` 落了同签名过渡版，S7 落实时把 UI 各会话的 import 切到 shared 并删除过渡版即可，事件可保留作刷新通知。
- 文件：src/features/settings/（S5 实现导入导出时注意）
- 需求：导出/导入配置须包含 globalState 键 `watchlistDefaultsSeeded`（S2 的播种判据布尔键，S2 不便往冻结的 StateKeys 里加，字符串常量在 `src/ui/watchlist/store.ts` SEEDED_KEY）。
- 原因：缺这个键，用户从 JetBrains 版迁移导入后会被播种逻辑再塞一遍示例股票。

## 申请人：S4（2026-10-29）
- 文件：src/shared/types.ts
- 需求：`AlertType` 扩充 `'sealShrink' | 'breadthJump'` 两个系统级提醒类型。
- 原因：S4 的封单锐减/大盘宽度异动与到价提醒同存 `StateKeys.alerts`，契约冻结期内在
  `features/alerts/engine.ts` 用 `ExtendedStockAlert = Omit<StockAlert,'type'> & {type: ExtendedAlertType}`
  本地放宽，广播 `alertFired` 时经 `asContract()` 降型；S7 正式化后删该降级函数即可。

- 文件：src/shared/（Provider 注册表）
- 需求：**附议上方 S2 的 `registerProvider/getProvider` 提案**，请 S7 一并落实 shared 版。
- 原因：同一缺口，S4 也落了过渡层——`features/alerts/providerRef.ts` 与 `features/statusbar/providerRef.ts`
  （globalThis 的 `Symbol.for('stocklite.quoteProvider.stock')` 绑定槽，未绑定回落 mock）。
  S7 落实 Registry 后的切换点共三处：S2 的 `ui/watchlist/providers.ts` + S4 的两份 providerRef。

- 文件：src/shared/types.ts（约定类，非结构变更）
- 需求：请 S1 股票 Provider 在 `Quote.extra` 写入 **`sealLots`：带符号封单手数**
  （涨停封板为正、跌停封板为负、未封板缺省），与 JetBrains 版 `StockQuote.sealLots` 语义一致
  （新浪盘口 fields[10]/[20] 单位是股，换算成手）。
- 原因：S4 封单锐减引擎以该键为唯一输入（`features/alerts/engine.ts` SealShrinkDetector）。

- 文件：package.json（配置项，锦上添花）
- 需求：可增补 `stocklite.statusBar.rotationSeconds`（轮播步长，当前与轮询间隔共用）与
  `stocklite.alerts.enabled`（全局提醒开关，当前用 alerts 数组内系统规则 enabled 字段替代）。
- 原因：功能已完整，仅粒度问题；不加不影响 S4 交付。

## 申请人：S5（2026-10-29）
- 文件：src/shared/config.ts
- 需求：StateKeys 增补两项——`feedbackDeviceId: 'feedbackDeviceId'`（反馈匿名设备 UUID）、`feedbackEmail: 'feedbackEmail'`（反馈邮箱持久化），键名与 JetBrains 版 StockliteState 字段对齐。
- 原因：S5 反馈客户端需持久化这两个键；契约冻结期内以裸键名+注释过渡（settingsPanel.ts 内 FEEDBACK_DEVICE_KEY/FEEDBACK_EMAIL_KEY 与目标值一致，落实后替换引用即可）。
- 文件：src/shared/（建议新增 shared/globalIndexes.ts）
- 需求：把 `src/features/settings/indexCatalog.ts` 的 37 条全球指数目录（含 optional 标记与双轨可见性入口 `visibleGlobalIndexes()`）上收 shared/，作为 S1 全球 provider 与 S6 全球 tab 的单一数据源。
- 原因：目录暂放 settings 目录（S5 无法新建 shared 文件）；两处各自维护会漂移。
- 文件：package.json（发布配置）
- 需求：vsce 打包须包含 `webview/settings/donate/*.png`（打赏收款码）；建议 `"files": ["out", "webview"]` 或配 .vscodeignore。
- 原因：当前无 files/.vscodeignore，默认打包会带上 src/、scripts/、out/*.map。
- 答复 S2：导出已包含 `watchlistDefaultsSeeded`（configCommands EXTRA_STATE_KEYS），JetBrains 迁移导入会自动置位该键。


## 申请人：S3（2026-10-29）
- 文件：src/shared/（Provider 注册表）
- 需求：**附议 S2/S4 的 `registerProvider/getProvider` 提案**；S3 的切换点在 `src/ui/chart/dataSource.ts`
  （`setChartDataProvider(p)` 与提案签名兼容，S1 图表类 provider（日K/周K/月K/分时/昨收）注册后由 S7 一行注入。
- 原因：图表需要 fetchKline/fetchMinute/昨收，契约事件不带实例，过渡期图表全走 mockProvider。
- 文件：package.json（devDependencies + 打包）
- 需求：`klinecharts@^9.8` 入 devDependencies；`.vscodeignore` 保留 `webview/chart/assets/klinecharts.min.js`。
- 原因：S3 守则禁改 package.json，当前用 `npm install klinecharts@9 --no-save` 安装后把 UMD 复制进
  `webview/chart/assets/` 由 webview 直接引用（运行时零 npm 依赖）；devDependency 只是保住复制源，
  否则他人 `npm ci` 后无法重新导出资产。资产已入库，缺依赖不影响编译与运行。

## 申请人：S1（2026-10-29）
- 文件：src/extension.ts（装配，S7 落实）
- 需求：activate 时调用 `activateData(deps: DataDeps)`（`src/data/index.ts`）。字段接线：
  `bus`＝shared EventBus 单例；`registerProvider`＝S2/S4 附议的 Provider 注册表入口；
  `getTabCodes(tabId)`＝从 StateKeys 自选列表读（stock/fund/future/global/sector/ipo/us/crypto 各 tab）；
  `isTabEnabled(tabId)`＝转 ConfigStore.tabEnabled（缺省 false，stock 恒开）；
  `getGlobalVisibility()`＝转 SettingsKeys 的 indexes 双轨 `{hidden: string[], enabledOptional: string[]}`；
  `pollIntervalSeconds`＝可选设置（缺省 5s，A 股仍由 marketTime 动态 5s/60s）；
  `breadthSnapshotStore`＝可选持久化注入（大盘概览历史，缺省内存态）；`disposables`＝context.subscriptions。
  deactivate 无需处理（已 push 进 disposables）。标题栏刷新：把 `refreshRequested` 事件按 viewId 转 `bindRefresh(scheduler, viewId)`。
- 原因：src/data 全程不 import vscode（可 node 直测），装配点集中在 S7；Kotlin 侧对应各面板 Swing Timer 启动点。
- 文件：package.json（scripts）
- 需求：增补 `"selftest:data": "node scripts/data-selftest.mjs && node out/data-selftest.cjs"`；
  在线抽查加环境变量 `STOCKLITE_ONLINE=1` 前缀（联网打真实接口，约 23 项）。
- 原因：S1 自测脚本已就绪（离线 116 项），入口脚本归 S7 合并时统一挂上。
- 答复 S5（全球指数目录上收 shared）：S1 已在 `src/data/globalIndex.ts` 落地 37 条目录 +
  `visibleGlobalIndexes(hidden, enabledOptional)` 单入口（默认 20/optional 17，与 settings/indexCatalog 判据一致，在线自测验证）。
  建议 S7 合并时把该文件整体上收 shared/globalIndexes.ts，S1 与 S6 同引用一份，避免两处漂移。
- 附议 S2/S4/S3 的 registerProvider 提案：`activateData` 的注册即走注入的 registerProvider，签名与
  `QuoteProvider{id, fetchQuotes, fetchKline, fetchMinute?, search?}` 冻结契约一致；S3 的 setChartDataProvider(p) 可直接取注册表里的任一 provider 实例。

## 申请人：S6（2026-10-29）
- 文件：package.json scripts + src/features/（configCommands 导入导出清单）
- 需求：S6 新增的三枚 globalState 键请并入配置导出/导入与 JetBrains 迁移白名单：
  `futuresDefaultsSeeded`、`cryptoDefaultsSeeded`（首用播种布尔标记，同 `watchlistDefaultsSeeded` 语义）、
  `usEtfWatchlist`（美股板块 ETF 显示清单：未写入=33 只全显，写入后以落盘值为准）。
  另挂自测入口 `"selftest:tabs": "node scripts/tabs-selftest.mjs && node out/tabs-selftest.cjs"`。
- 原因：S6 守则禁改 shared/package.json；期货/加密列表与美股清单在 StateKeys 中无注册键或无标记键，
  只能沿用 S2 的 SEEDED_KEY 字面量键先例，S7 上收注册表时一并处理即可。
- 文件：src/ui/watchlist/table/webviewHtml.ts（工具栏/右键菜单文案）
- 需求：TableTab 工具栏三键（＋ 添加/导入/分组）与右键四键（打开图表/设置提醒/交易记录/删除）文案固定，
  非自选股 tab 语义不贴（S6 现状：基金页把「分组」按钮复用为"持仓明细"入口，板块/新股页只读靠提示兜底）。
  建议 handlers 或 TableSnapshot 增可选 `toolbarLabels?: Partial<Record<ToolbarCommand, string>>` 与
  `menuLabels?: Partial<Record<RowAction, string>>`，缺省保持现文案。
- 原因：webview 模板归 S2 冻结、S6 禁改；语义映射（分组→持仓明细等）只能提示兜底，体验打折。
- 文件：src/extension.ts（装配，S7 落实）
- 需求：附议 S1 的 activateData 接线。S6 各 tab 当前**自带轮询**（SimpleQuoteTab.restartPolling，
  节奏同 S1 调度器档位），并已按 tabId 发 `quotesUpdated` 事件；S7 接入调度器后若改由调度器统一下发行情，
  把各 tab 构造参 `intervalMs` 调大或加开关即可避免双轮询（数据取数函数与调度器同源 data 层，无行为差异）。
- 原因：extension.ts 冻结在 S0 装配点，S1 调度器尚未接线；S6 不等装配、tab 自治保功能可用。

---

## 落实记录：S7a（2026-10-29）
全部申请已落实并全量回归绿（compile 零错误 + 七组自测 17/116/45/31/57/25/35）：
- registry：新建 `src/shared/registry.ts`，extension.ts 注入 activateData 的 registerProvider；4 处过渡层已切换/删除（watchlist/providers.ts、features/alerts/providerRef.ts、features/statusbar/providerRef.ts、ui/chart/dataSource.ts）。
- globalIndexes：新建 `src/shared/globalIndexes.ts`（上收 S1 目录），settings/indexCatalog 与全球 tab 同引用。
- AlertType 正式扩 `sealShrink|breadthJump`，engine.ts 的 asContract 降型已删。
- StateKeys 补 `feedbackDeviceId/feedbackEmail`，S5 裸键替换。
- package.json：selftest 全套脚本入口 + `selftest:all`；klinecharts@^9 devDep；版本 1.0.0；新建 .vscodeignore。
- 可选项（statusBar.rotationSeconds、alerts.enabled）按 §7 方案未做。
- S7b 待办：图标 128×128、README/CHANGELOG、在线自测、F5 冒烟、vsce 打包（上传归用户）。

## 落实记录：S7b（2026-10-29）
S6 三条申请处理结果：
- 三枚键（已落实）：configCommands.ts 的 EXTRA_STATE_KEYS 扩为
  `watchlistDefaultsSeeded + FUTURES_SEEDED_KEY/CRYPTO_SEEDED_KEY/US_ETF_LIST_KEY`（后三枚从 tabs/store 导入常量，非字面量）。
- 双轮询（已定案，与 S6 建议的方向相反）：**tab 自持轮询为唯一行情源，调度器不 start 任何任务**。
  理由：tab 的 fetch 携带页面私有态（fundsTab navRows、cryptoTab 连通上报、globalTab rateLimited），
  且 tab 侧与 providers.ts 是两套并行 Quote 映射，切调度器有显示发散风险；节奏与数据源本同。
  activateData 只注册 provider + 加密连通探测，scheduler 实例保留供 refreshNow 语义与后续演进。定案注释在 src/data/index.ts。
- toolbarLabels/menuLabels（暂缓，不阻塞发布）：webview 模板冻结、现语义兜底可用，属润色项；
  留待 1.0.x 迭代实现（TableSnapshot 增可选 labels 字段的方案 S6 已给出，届时直接照做）。

S7b 收尾完成项：在线自测 139 项全绿（板块项冷却复检 496 条通过，flaky 属 push2 限流常态）；
icon.png 生成入库 + package.json icon 字段；LICENSE/README 定稿/CHANGELOG；
vsce 打包 stocklite-1.0.0.vsix（15 文件 267.92 KB，.vscodeignore 修正 *-DELIVERY.md 通配）；
F5 冒烟清单与上架步骤见 docs/release-checklist.md（F5 验证与上传归用户）。

## 申请人：G1（2026-10-29）
- 文件：src/shared/config.ts（SettingsKeys）+ src/features/settings/
- 需求：设置键 `stocklite.enableSealLots`（布尔，默认 true），语义=是否在股票表显示封单手数列
  （对齐 JetBrains StockliteState.enableSealLots）。
- 原因：G1 的封单手数列已在 `ui/watchlist/stockCells.ts` 落地、行为=Kotlin 默认值（常开）；
  开关本身要动冻结的 SettingsKeys 与 S5 设置页，本会话不越界。缺省态与 JetBrains 一致，
  不阻塞 1.0.0；落实后 stockCells/stockTab 只需在列装配处读该键短路即可。
- 备注（非申请，备案呈现差异）：JetBrains 1.18.0 中竞价/封单均为涨跌幅列同行灰色小字
  （封单优先于竞价，ChangePctRenderer），并非独立列；G1 按移植任务书改为
  竞价→价格单元格 sub 小字、封单→独立"封单手数"列，标注时机与文案格式逐字对齐 Kotlin。

## 申请人：G2（2026-10-29）
- 文件：src/ui/watchlist/table/webviewHtml.ts + src/shared/types.ts（header 协议转正）
- 需求：TableSnapshot 增可选 `header?: { cards: Array<{ segments: Array<{ text: string; dir?: -1|0|1; hex?: string; bold?: boolean }>; detail: Array<Array<{ text: string; dir?: -1|0|1; hex?: string; bold?: boolean }>> }> }`，
  webview 模板原生渲染在表格上方；届时 tabkit.ts 的 `withHeaderSlot()` 与 `HeaderTableTab` 可删，
  globalTab 回归公共 TableTab。
- 原因：研判/天气两段卡需要表头区，webviewHtml 归 G1 禁碰，G2 现状是在 renderTableHtml 产物上做
  **字符串注入**（`withHeaderSlot` 拼 CSS/容器/监听脚本，锚点缺失原样返回降级），仅全球 tab 经
  `HeaderTableTab`（TableTab 的平行小副本，框架字段全 private 无法继承覆写）启用，其余七 tab 零影响。
  注入是过渡实现，协议化后删副本回归正路。VM 结构定义在 tabkit.ts（HeaderCardVM/HeaderSegVM），照抄即可。
- 文件：src/features/settings/（configCommands 导入导出清单）
- 需求：G2 的三枚 globalState 键并入导出/导入与 JetBrains 迁移白名单：
  `forecastHistory`（研判双账本历史，键名/字段与 JetBrains StockliteState.forecastHistory 兼容，NaN 落 null）、
  `sentimentJson` + `sentimentDate`（市场天气快照，同 Kotlin 键）。常量已导出：`src/data/forecast.ts` 的
  FORECAST_HISTORY_KEY/SENTIMENT_JSON_KEY/SENTIMENT_DATE_KEY，EXTRA_STATE_KEYS 直接 import 非字面量。
- 原因：研判历史是跨 IDE 迁移的核心资产（跳空/方向命中率账本要跟着走），且 G2 守则禁碰 settings 目录；
  键名对齐 StockliteState 字段名即为此准备。缺导出不影响功能，仅迁移时历史断档。
- 备注 1（非申请）：`stocklite.forecast.enabled`（默认 true）G2 按分工直改 package.json 完成，
  未走 SettingsKeys（ConfigStore.setting() 直读 workspace config，无需注册即生效）；S5 设置页如需可视化开关再补。
- 备注 2（非申请，备案呈现差异）：AI 短评（Kotlin ForecastService.getAiBrief，deepseek 生成一句话点评）
  未移植——VSCode 侧无 API-key 输入界面，属后续独立需求；其余研判逻辑逐常量对照 Kotlin 完成。
