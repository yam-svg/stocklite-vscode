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
