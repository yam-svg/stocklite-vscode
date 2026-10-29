/** QuickInput 小工具：文本/数字/日期输入框与取消语义统一 */
import * as vscode from 'vscode';

/** 用户取消返回 undefined；空串按 fallback 处理（allowEmpty 时） */
export async function promptText(
  title: string,
  placeholder: string,
  validate?: (value: string) => string | undefined,
): Promise<string | undefined> {
  return vscode.window.showInputBox({ title, prompt: placeholder, ignoreFocusOut: true, validateInput: validate });
}

export async function promptNumber(
  title: string,
  placeholder: string,
  opts: { min?: number; max?: number } = {},
): Promise<number | undefined> {
  const raw = await promptText(title, placeholder, (v) => {
    const n = Number(v);
    if (!v.trim() || !Number.isFinite(n)) return '请输入数字';
    if (opts.min !== undefined && n < opts.min) return `不能小于 ${opts.min}`;
    if (opts.max !== undefined && n > opts.max) return `不能大于 ${opts.max}`;
    return undefined;
  });
  return raw === undefined ? undefined : Number(raw);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateDate(v: string): string | undefined {
  if (!DATE_RE.test(v)) return '格式 YYYY-MM-DD';
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '无效日期' : undefined;
}

/** 代码合法性：sh/sz/bj+6位、hk+5位、美股 ticker（全大写可带 .X）、加密/期货等自定义前缀放宽 */
const CODE_RE = /^([a-z]{2}\d{5,6}|[A-Z][A-Z0-9]{0,5}(\.[A-Z])?|hf_[A-Z0-9]{1,6}|nf_\w+|gb_\w+|us\w+|\^[A-Z^.\-]+=?)$/;

export function looksLikeCode(v: string): boolean {
  return CODE_RE.test(v.trim());
}
