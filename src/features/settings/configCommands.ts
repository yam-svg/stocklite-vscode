/**
 * 导入/导出配置命令（vscode 侧）。纯转换逻辑在 portableConfig.ts（可 node 直测）。
 * 导出 = globalState 全部 StateKeys + stocklite 配置项快照，单文件 JSON；
 * 导入 = 覆盖式写入 JSON 中出现的键（native 与 JetBrains 两种格式自动识别）。
 */
import * as vscode from 'vscode';
import type { FeatureDeps } from '../../extension';
import { StateKeys } from '../../shared/config';
import { buildExportJson, parseImportJson } from './portableConfig';

/** 导出时读取的 contributes.configuration 键（点分路径） */
const EXPORTED_SETTINGS = [
  'pollIntervalSeconds',
  'colorUp',
  'tabs.fund', 'tabs.future', 'tabs.global', 'tabs.sector', 'tabs.ipo', 'tabs.us', 'tabs.crypto',
  'statusBar.enabled', 'statusBar.codes',
  'indexes.enabledOptional', 'indexes.hidden',
] as const;

/** StateKeys 之外还要随配置带走的 globalState 裸键（见 docs/contract-changes.md S2/S5 小节） */
const EXTRA_STATE_KEYS = [
  'watchlistDefaultsSeeded', // S2 播种判据，缺失会导致迁移后被重新播种
  'feedbackDeviceId',        // 反馈回复凭据，丢了查不到自己的回复
  'feedbackEmail',
] as const;

export async function runExportConfig(deps: FeatureDeps): Promise<void> {
  const state: Record<string, unknown> = {};
  for (const key of [...Object.values(StateKeys), ...EXTRA_STATE_KEYS]) {
    if (key === StateKeys.onboarded) continue; // 首启标记无迁移价值
    const value = deps.config.get<unknown>(key, undefined);
    if (value !== undefined) state[key] = value;
  }
  const cfg = vscode.workspace.getConfiguration('stocklite');
  const settings: Record<string, unknown> = {};
  for (const key of EXPORTED_SETTINGS) {
    const inspected = cfg.inspect(key);
    const value = inspected?.globalValue ?? inspected?.defaultValue;
    if (value !== undefined) settings[key] = value;
  }
  const target = await vscode.window.showSaveDialog({
    title: '导出 StockLite 配置',
    defaultUri: vscode.Uri.file('stocklite_backup.json'),
    filters: { 'JSON': ['json'] },
  });
  if (!target) return;
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(buildExportJson({ state, settings }), 'utf8'));
    void vscode.window.showInformationMessage(`StockLite 配置已导出：${target.fsPath}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`StockLite 导出失败：${err instanceof Error ? err.message : err}`);
  }
}

export async function runImportConfig(deps: FeatureDeps): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: '导入 StockLite 配置（支持本扩展或 JetBrains 版备份）',
    canSelectMany: false,
    filters: { 'JSON': ['json'] },
  });
  if (!picked || picked.length === 0) return;
  let text: string;
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
  } catch (err) {
    void vscode.window.showErrorMessage(`StockLite 读取文件失败：${err instanceof Error ? err.message : err}`);
    return;
  }
  let payload;
  try {
    payload = parseImportJson(text);
  } catch (err) {
    void vscode.window.showErrorMessage(`StockLite 导入失败：${err instanceof Error ? err.message : err}`);
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    '导入将覆盖当前同名数据（自选/持仓/提醒/设置等），继续？',
    { modal: true }, '导入',
  );
  if (confirmed !== '导入') return;

  for (const [key, value] of Object.entries(payload.state)) {
    await deps.config.set(key, value);
  }
  const cfg = vscode.workspace.getConfiguration('stocklite');
  for (const [key, value] of Object.entries(payload.settings)) {
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
  }
  // 导入即视为已上手，避免迁移用户再被首启引导打扰
  await deps.context.globalState.update(StateKeys.onboarded, true);

  const summary = `StockLite 配置已导入（数据 ${Object.keys(payload.state).length} 项，设置 ${Object.keys(payload.settings).length} 项）`;
  if (payload.warnings.length > 0) {
    void vscode.window.showWarningMessage(`${summary}；${payload.warnings.length} 条记录不兼容已跳过`, { detail: payload.warnings.join('\n') });
  } else {
    void vscode.window.showInformationMessage(summary);
  }
}
