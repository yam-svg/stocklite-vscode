/**
 * 交易时段感知轮询调度器（S1）。不 import vscode：EventBus 由装配方注入。
 * 语义对齐 Kotlin 各面板的 Swing Timer：
 *  - 每 tab 一个任务，间隔由 intervalMs() 动态决定（如 A 股开市 5s/收市 60s）；
 *  - in-flight 合并：上一轮未完成时不并发重复请求，仅记 pending 待本轮完成立即补拉；
 *  - 失败退避：连续失败间隔 ×2（上限 5 分钟），成功即复位；失败轮不发 quotesUpdated（UI 保留旧数据）；
 *  - refreshNow：标题栏刷新按钮，空闲立即拉、忙则并入 pending。
 */
import type { EventBus } from '../shared/events';
import type { Quote, QuoteProvider } from '../shared/types';

export const MAX_BACKOFF_MS = 5 * 60_000;

interface Task {
  tabId: string;
  provider: QuoteProvider;
  getCodes(): string[];
  intervalMs(): number;
  enabled(): boolean;
  backoff: number;
  inFlight: boolean;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

export class PollScheduler {
  private readonly tasks = new Map<string, Task>();

  constructor(private readonly bus: EventBus) {}

  start(spec: { tabId: string; provider: QuoteProvider; getCodes(): string[]; intervalMs(): number; enabled?: () => boolean }): void {
    this.stop(spec.tabId);
    const task: Task = {
      tabId: spec.tabId,
      provider: spec.provider,
      getCodes: spec.getCodes,
      intervalMs: spec.intervalMs,
      enabled: spec.enabled ?? (() => true),
      backoff: 1,
      inFlight: false,
      pending: false,
      timer: null,
      stopped: false,
    };
    this.tasks.set(spec.tabId, task);
    this.tick(task, 0); // 启动即拉一轮，让面板秒开
  }

  /** 标题栏刷新按钮 */
  refreshNow(tabId: string): void {
    const task = this.tasks.get(tabId);
    if (!task) return;
    if (task.inFlight) {
      task.pending = true;
      return;
    }
    if (task.timer) clearTimeout(task.timer);
    this.tick(task, 0);
  }

  stop(tabId: string): void {
    const task = this.tasks.get(tabId);
    if (!task) return;
    task.stopped = true;
    if (task.timer) clearTimeout(task.timer);
    this.tasks.delete(tabId);
  }

  stopAll(): void {
    for (const id of [...this.tasks.keys()]) this.stop(id);
  }

  private tick(task: Task, delayMs: number): void {
    if (task.stopped) return;
    task.timer = setTimeout(() => void this.run(task), delayMs);
    // setTimeout 不阻止进程退出即可，node 测试下由 stopAll 收尾
  }

  private async run(task: Task): Promise<void> {
    if (task.stopped) return;
    if (task.inFlight) {
      task.pending = true;
      return;
    }
    if (!task.enabled()) {
      // tab 关闭：不请求，按基准间隔轻轮询等待重新开启
      this.tick(task, Math.max(1000, Math.min(task.intervalMs(), 60_000)));
      return;
    }
    const codes = task.getCodes();
    if (codes.length === 0) {
      this.tick(task, Math.max(1000, Math.min(task.intervalMs(), 60_000)));
      return;
    }
    task.inFlight = true;
    task.pending = false;
    try {
      const quotes: Quote[] = await task.provider.fetchQuotes(codes);
      task.backoff = 1;
      this.bus.emit('quotesUpdated', { tabId: task.tabId, quotes });
    } catch {
      task.backoff = Math.min(task.backoff * 2, MAX_BACKOFF_MS / Math.max(1000, task.intervalMs()));
    } finally {
      task.inFlight = false;
    }
    if (task.stopped) return;
    if (task.pending) {
      // 拉取期间有刷新请求/新轮到期：立即补一轮
      this.tick(task, 0);
      return;
    }
    this.tick(task, Math.min(task.intervalMs() * task.backoff, MAX_BACKOFF_MS));
  }
}
