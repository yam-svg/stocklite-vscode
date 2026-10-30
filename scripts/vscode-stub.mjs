// 自测打包时的 vscode 桩：shared/config.ts 顶层不触碰 vscode API，
// 空壳即可让 store 等模块在 node 下完成 import 与实例化。
export const workspace = {
  getConfiguration: () => ({ get: (_key, dflt) => dflt, update: async () => {} }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
};
export const window = {};
export const commands = {};
export class Disposable {
  dispose() {}
}
export const ProgressLocation = { Notification: 15 };
export const ViewColumn = { Beside: 2 };
export const QuickPickItemKind = { Separator: 1 };
