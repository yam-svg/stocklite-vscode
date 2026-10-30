/**
 * 可选 tab（基金/期货/全球/板块/新股/美股/加密币）—— S6 独占本目录。
 * 七个 tab 全部基于 S2 通用行情表框架（table/），数据直连 S1 的 src/data 模块；
 * 视图显隐由 package.json 的 when: config.stocklite.tabs.* 控制，无需代码干预。
 * S0 的占位视图与桩命令由本实现接管（同名 viewId/命令在此注册即覆盖占位）。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import { GlobalTab } from './globalTab';
import { FuturesTab } from './futuresTab';
import { FundsTab } from './fundsTab';
import { CryptoTab } from './cryptoTab';
import { SectorTab } from './sectorTab';
import { UsTab } from './usTab';
import { IpoTab } from './ipoTab';

export { GlobalTab } from './globalTab';
export { FuturesTab } from './futuresTab';
export { FundsTab } from './fundsTab';
export { CryptoTab } from './cryptoTab';
export { SectorTab } from './sectorTab';
export { UsTab } from './usTab';
export { IpoTab } from './ipoTab';

export function activateTabs(deps: FeatureDeps): void {
  const globalTab = new GlobalTab(deps);
  const futuresTab = new FuturesTab(deps);
  const fundsTab = new FundsTab(deps);
  const cryptoTab = new CryptoTab(deps);
  const sectorTab = new SectorTab(deps);
  const usTab = new UsTab(deps);
  const ipoTab = new IpoTab(deps);

  for (const tab of [globalTab, futuresTab, fundsTab, cryptoTab, sectorTab, usTab, ipoTab]) {
    void tab.activate();
  }

  // package.json 预注册的四个命令：桩命令换真实现（S0 占位注册由本文件接管）
  const command = (id: string, run: () => Promise<unknown>): void => {
    deps.context.subscriptions.push(vscode.commands.registerCommand(id, () => void run()));
  };
  command('stocklite.addFund', () => fundsTab.addFund());
  command('stocklite.addFuture', () => futuresTab.addFuture());
  command('stocklite.addCrypto', () => cryptoTab.addCrypto());
  command('stocklite.addGlobalIndex', () => globalTab.pickIndexes());
}
