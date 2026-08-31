import { randomInt, randomUUID } from "node:crypto";

export type QueueMetadata = { id: string; initialPosition: number; queuedMs: number; delayMs: number };
export type QueueSnapshot = {
  maxSize: number; size: number; running?: string; delaying?: string;
  queued: Array<{ id: string; position: number; queuedMs: number }>;
};

export class QueueFullError extends Error {
  constructor(public readonly maxSize: number) {
    super(`NovelAI generation queue is full (${maxSize}/${maxSize} running or queued); retry later`);
    this.name = "QueueFullError";
  }
}

export class QueueCancelledError extends Error {
  constructor(public readonly queueId: string) {
    super(`NovelAI generation ${queueId} was removed from the queue before it entered flight`);
    this.name = "QueueCancelledError";
  }
}

type Entry<T = unknown> = {
  id: string; initialPosition: number; enqueuedAt: number; delayMs: number;
  state: "queued" | "delaying" | "running";
  task: (metadata: QueueMetadata) => Promise<T>;
  resolve: (value: T) => void; reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>; signal?: AbortSignal; abortListener?: () => void;
};

export class GenerationQueue {
  private readonly waiting: Entry<any>[] = [];
  private readonly promises = new Map<string, Promise<any>>();
  private current?: Entry<any>;

  constructor(private readonly maxSize: number, private readonly minDelayMs: number, private readonly maxDelayMs: number) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) throw new Error("Queue maxSize must be a positive integer");
    if (minDelayMs < 0 || maxDelayMs < minDelayMs) throw new Error("Invalid queue delay range");
  }

  get size(): number { return this.waiting.length + (this.current ? 1 : 0); }

  enqueue<T>(task: (metadata: QueueMetadata) => Promise<T>, options: { id?: string; signal?: AbortSignal } = {}): Promise<T> {
    const id = options.id?.trim() || randomUUID();
    const existing = this.promises.get(id);
    if (existing) return existing as Promise<T>;
    if (this.size >= this.maxSize) return Promise.reject(new QueueFullError(this.maxSize));
    if (options.signal?.aborted) return Promise.reject(new QueueCancelledError(id));
    const promise = new Promise<T>((resolve, reject) => {
      const entry: Entry<T> = {
        id, initialPosition: this.size + 1, enqueuedAt: Date.now(), delayMs: this.randomDelay(),
        state: "queued", task, resolve, reject, signal: options.signal,
      };
      if (options.signal) {
        entry.abortListener = () => { this.cancel(id); };
        options.signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      this.waiting.push(entry);
      queueMicrotask(() => this.pump());
    });
    this.promises.set(id, promise);
    const cleanup = () => { if (this.promises.get(id) === promise) this.promises.delete(id); };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  snapshot(): QueueSnapshot {
    return {
      maxSize: this.maxSize, size: this.size,
      ...(this.current?.state === "running" ? { running: this.current.id } : {}),
      ...(this.current?.state === "delaying" ? { delaying: this.current.id } : {}),
      queued: this.waiting.map((entry, index) => ({
        id: entry.id, position: index + (this.current ? 2 : 1), queuedMs: Date.now() - entry.enqueuedAt,
      })),
    };
  }

  cancel(id: string): boolean {
    const index = this.waiting.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      const [entry] = this.waiting.splice(index, 1);
      this.rejectCancelled(entry);
      return true;
    }
    if (this.current?.id === id && this.current.state === "delaying") {
      const entry = this.current;
      if (entry.timer) clearTimeout(entry.timer);
      this.current = undefined;
      this.rejectCancelled(entry);
      queueMicrotask(() => this.pump());
      return true;
    }
    return false;
  }

  cancelQueued(): string[] {
    const ids = this.waiting.map((entry) => entry.id);
    while (this.waiting.length) this.rejectCancelled(this.waiting.shift()!);
    if (this.current?.state === "delaying") {
      const id = this.current.id;
      if (this.cancel(id)) ids.unshift(id);
    }
    return ids;
  }

  private rejectCancelled(entry: Entry): void { this.removeAbortListener(entry); entry.reject(new QueueCancelledError(entry.id)); }

  private pump(): void {
    if (this.current || this.waiting.length === 0) return;
    const entry = this.waiting.shift()!;
    this.current = entry;
    entry.state = "delaying";
    const start = () => {
      if (this.current !== entry) return;
      entry.timer = undefined;
      entry.state = "running";
      // Do not abandon an HTTP request that may already spend Anlas.
      this.removeAbortListener(entry);
      const metadata = {
        id: entry.id, initialPosition: entry.initialPosition,
        queuedMs: Date.now() - entry.enqueuedAt, delayMs: entry.delayMs,
      };
      // Invoke through a promise so synchronous throws follow the same path.
      // Clear internal state before settling the public promise: callers may
      // inspect the queue or reuse the ID immediately after await returns.
      void Promise.resolve().then(() => entry.task(metadata)).then(
        (value) => { this.finish(entry); entry.resolve(value); },
        (error) => { this.finish(entry); entry.reject(error); },
      );
    };
    if (entry.delayMs === 0) start();
    else entry.timer = setTimeout(start, entry.delayMs);
  }

  private removeAbortListener(entry: Entry): void {
    if (entry.signal && entry.abortListener) entry.signal.removeEventListener("abort", entry.abortListener);
  }
  private finish(entry: Entry): void {
    if (this.current === entry) this.current = undefined;
    this.pump();
  }
  private randomDelay(): number {
    return this.minDelayMs === this.maxDelayMs ? this.minDelayMs : randomInt(this.minDelayMs, this.maxDelayMs + 1);
  }
}

function integerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) ? value : fallback;
}

export const generationQueue = new GenerationQueue(
  integerEnv("NAID_QUEUE_MAX", 8),
  integerEnv("NAID_QUEUE_MIN_DELAY_MS", 750),
  integerEnv("NAID_QUEUE_MAX_DELAY_MS", 2_500),
);
