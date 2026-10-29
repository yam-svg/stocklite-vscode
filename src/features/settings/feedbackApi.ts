/**
 * 意见反馈（可回复）客户端 —— 移植自 JetBrains 版 service/FeedbackService.kt。
 * Supabase PostgREST 匿名通道：本机生成 UUID 作 device_id，凭它查自己的反馈与开发者回复；
 * anon key 可随插件公开分发，权限由 Supabase RLS 限制（仅插入 + 按 x-device-id 查询/删除）。
 * 纯逻辑无 vscode 依赖：device id 存取注入，baseUrl 可覆盖（selftest 打本地假服务）。
 */
import { randomUUID } from 'crypto';

export const SUPABASE_URL = 'https://wudikstpbcpfkbonmfxp.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_CBWJFeu3z8XtT2koZ-mvCw_MseWTReV';

export interface FeedbackItem {
  id: string;
  /** 已格式化的本地时间 'YYYY-MM-DD HH:mm' */
  time: string;
  content: string;
  email: string;
  /** 空串表示尚未回复 */
  reply: string;
  repliedTime: string;
}

/** device id 持久化端口（vscode 侧接 globalState，selftest 用内存 Map） */
export interface DeviceIdStore {
  get(): string;
  set(value: string): Promise<void>;
}

export interface FeedbackClientOptions {
  store: DeviceIdStore;
  baseUrl?: string;
  anonKey?: string;
}

export class FeedbackClient {
  private readonly baseUrl: string;
  private readonly anonKey: string;

  constructor(private readonly opts: FeedbackClientOptions) {
    this.baseUrl = opts.baseUrl ?? SUPABASE_URL;
    this.anonKey = opts.anonKey ?? SUPABASE_ANON_KEY;
  }

  /** 首次使用生成并持久化；删除重装后视为新用户（与 JetBrains 版一致） */
  async ensureDeviceId(): Promise<string> {
    let id = this.opts.store.get();
    if (!id) {
      id = randomUUID();
      await this.opts.store.set(id);
    }
    return id;
  }

  private headers(deviceId: string): Record<string, string> {
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${this.anonKey}`,
      'x-device-id': deviceId,
    };
  }

  /** 提交一条反馈；2xx 即成功（RLS 拒绝时返回 4xx） */
  async submit(content: string, email: string): Promise<boolean> {
    const deviceId = await this.ensureDeviceId();
    const payload = JSON.stringify({
      id: randomUUID(),
      device_id: deviceId,
      email,
      content,
    });
    try {
      const res = await fetch(`${this.baseUrl}/rest/v1/feedback`, {
        method: 'POST',
        headers: { ...this.headers(deviceId), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  /** 本机反馈历史（含回复），时间倒序；失败返回 null，未提交过返回空表 */
  async fetchMine(): Promise<FeedbackItem[] | null> {
    const deviceId = this.opts.store.get();
    if (!deviceId) return [];
    const url = `${this.baseUrl}/rest/v1/feedback` +
      `?device_id=eq.${encodeURIComponent(deviceId)}` +
      '&select=id,content,email,reply,replied_at,created_at' +
      '&order=created_at.desc&limit=50';
    try {
      const res = await fetch(url, { headers: this.headers(deviceId), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const rows = (await res.json()) as Record<string, unknown>[];
      if (!Array.isArray(rows)) return null;
      return rows.map((o) => ({
        id: String(o.id ?? ''),
        time: formatTime(String(o.created_at ?? '')),
        content: String(o.content ?? ''),
        email: String(o.email ?? ''),
        reply: String(o.reply ?? ''),
        repliedTime: formatTime(String(o.replied_at ?? '')),
      }));
    } catch {
      return null;
    }
  }

  /** 删除自己的一条反馈（服务端 RLS 校验归属）；成功返回 true */
  async delete(id: string): Promise<boolean> {
    const deviceId = this.opts.store.get();
    if (!deviceId || !id) return false;
    try {
      const res = await fetch(`${this.baseUrl}/rest/v1/feedback?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { ...this.headers(deviceId), Prefer: 'return=representation' },
        signal: AbortSignal.timeout(15_000),
      });
      // RLS 无删除权限时 DELETE 静默删 0 行返回空数组，据此判定
      if (!(res.status >= 200 && res.status < 300)) return false;
      const body = await res.text();
      return body.includes('"id"');
    } catch {
      return false;
    }
  }
}

/** ISO timestamptz → 本地时区 'YYYY-MM-DD HH:mm'；解析失败退回原文截断 */
export function formatTime(raw: string): string {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.replace('T', ' ').slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
