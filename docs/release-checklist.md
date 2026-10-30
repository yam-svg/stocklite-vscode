# 1.0.0 发布清单（S7b）

包产物：`stocklite-1.0.0.vsix`（15 文件 / 277.5 KB，2026-10-30 最终重打包；已校验：out/extension.js、webview 全资产、
icon.png、readme/LICENSE/changelog 在包内；src/scripts/docs/*.map/.scratch/*-DELIVERY/.idea 均不在——`.idea/**` 已补入 .vscodeignore）。
真实仓库已建：https://github.com/yam-svg/stocklite-vscode （HEAD 95a2da5）。package.json 已加回 `repository` + `bugs`
字段，readme 末尾附「相关链接」；因 1.0.0 从未发布过（Marketplace 404），原地重打包沿用 1.0.0，不出修订版。

## 一、F5 冒烟清单（开发宿主）

准备：VSCode 打开 `stocklite-vscode`，F5 启动扩展开发宿主。以下按操作流排列，全部通过即可发。

**首启与播种**
1. 首启出现 StockLite 侧边栏（默认 股票/基金/期货/全球 四 tab），股票 tab 有内置示例自选并出行情。
2. 首启新手引导气泡出现一次，重开窗口不再出现；`StockLite: 新手指引` 可随时重开。
3. 状态栏出现指数条目（默认上证指数），点击弹状态栏菜单。

**八 tab 出数（在线）**
4. 股票 tab：自选列表价格/涨跌幅刷新（开市 5s 节奏）；右键行 → 设置提醒、删除、加入分组可用。
5. 基金 tab：估值/持仓净值出数；`StockLite: 添加基金` 可新增。
6. 期货 tab：内置默认含纳斯达克100（hf_NQ）与布伦特原油（hf_OIL）且出数。
7. 全球 tab：默认指数出数；`StockLite: 选择显示的全球指数` 弹窗两个 tab（可选/已隐藏），勾一个"更多指数"里的指数后列表新增。
8. 板块 tab：行业/概念榜能出数（东财 push2 偶发断连属常态，等待 60s 轮询补全即可）。
9. 新股 tab：今日新股/次新股列表出数。
10. 美股 tab：内置美股 ETF 清单出数（盘外时段显示收盘价属正常）。
11. 加密 tab：默认 BTC/ETH 出数，右上网络连通徽章亮（三源降级 Bitget→Gate→binance）。
12. 被关掉的 tab（settings 里 `stocklite.tabs.*` 取消勾选后）从侧边栏消失，重新勾选后恢复，且**窗口宽度不被压缩**（勿 removeAll 重建）。

**命令面板全量（20 条）**
13. Ctrl+Shift+P 逐条执行均无报错：添加自选 / 刷新当前视图 / 删除所选 / 批量导入股票 / 管理分组 /
    导出配置 / 导入配置 / 打开设置 / 查看K线·分时 / 盈亏日历 / 交易记录 / 设置提醒 / 支持作者 /
    意见反馈 / 新手指引 / 状态栏菜单 / 添加基金 / 添加期货 / 添加加密币 / 选择显示的全球指数。

**图表与盈亏**
14. 选中个股 → `查看K线/分时`：K线/分时切换正常、日/周/月切换正常、买卖点 B/S 标记出现（有交易记录时）。
15. 恒指科技（hkHSTECH 源）走势图能画出。
16. `盈亏日历`：月历热图渲染、切换月份正常；`交易记录` 列表正常。

**设置与数据往返**
17. `导出配置` 存为 JSON → 删掉几项自选 → `导入配置` 选同一文件 → 自选/持仓/提醒/三枚播种键（期货/加密默认项、美股清单）全部还原。
18. 设置页改轮询间隔与涨跌配色立即生效；`支持作者` 弹微信/支付宝赞赏码图；`意见反馈` 可提交（code==20000 成功提示）。
19. 断网后 tab 保留旧数据不清空、状态栏提示异常；恢复网络后自动回血（失败退避 ≤5min）。
20. 关闭全部 StockLite tab 与窗口，无 jcef/进程残留报错（VSCode 侧无此问题则直接确认退出干净）。

## 二、上架步骤（归用户）

**Visual Studio Marketplace（主渠道）**
1. 注册 publisher（建议 ID 与 package.json 的 `publisher: "stocklite"` 保持一致）：
   https://marketplace.visualstudio.com/manage → Create publisher。
2. 生成 PAT：Azure DevOps（https://dev.azure.com → User settings → Personal access tokens），
   与 publisher 同账号，Scope 勾选 `Marketplace → Manage`。
3. 发布：
   `npx @vscode/vsce publish -p <PAT> stocklite-1.0.0.vsix`
   （或网页端直接上传 vsix：marketplace.visualstudio.com/manage → 上传扩展包。）
4. ✅ `repository`/`bugs` 已指向真实仓库 github.com/yam-svg/stocklite-vscode（2026-10-30 重打包确认在包内），
   Marketplace 详情页会自动显示 Repository / Issues 链接。

**Open VSX（VSCodium/各发行版默认市场）**
1. 在 https://open-vsx.org 用账号签发 API token（Namespace `stocklite` 需先创建）。
2. `npx ovsx publish stocklite-1.0.0.vsix -p <token>`

**发布后**
3. Marketplace 页面核对：图标、README 首屏英文开场+中文详情、分类 Other、版本号 1.0.0。
4. 真实仓库建好后打 tag `v1.0.0`（push 归用户）。
