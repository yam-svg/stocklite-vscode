/**
 * 设置页/导入导出/打赏/反馈/首启引导 —— S5 独占本目录。
 * S0 仅占位；S5 实现 Webview 设置页（tab 开关、配色、全球指数双轨选择）与周边功能。
 */
import { commands } from 'vscode';
import type { FeatureDeps } from '../../extension';
import { openSettingsPanel } from './settingsPanel';
import { openDonatePanel } from './donatePanel';
import { openOnboardingPanel, maybeShowFirstRunHint } from './onboarding';
import { runExportConfig, runImportConfig } from './configCommands';

export function activateSettings(deps: FeatureDeps): void {
  deps.context.subscriptions.push(
    commands.registerCommand('stocklite.openSettings', () => openSettingsPanel(deps)),
    commands.registerCommand('stocklite.exportConfig', () => runExportConfig(deps)),
    commands.registerCommand('stocklite.importConfig', () => runImportConfig(deps)),
    commands.registerCommand('stocklite.donate', () => openDonatePanel(deps)),
    // 反馈复用设置页：打开并滚动定位到"意见反馈"小节
    commands.registerCommand('stocklite.feedback', () => openSettingsPanel(deps, 'feedback')),
    commands.registerCommand('stocklite.showOnboarding', () => openOnboardingPanel(deps)),
  );
  maybeShowFirstRunHint(deps);
}
