import type { RunEvent, RunEventInput } from "../types.js";

export type EventListener = (e: RunEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();
  private seqs = new Map<string, number>();

  nextSeq(runId: string): number {
    const n = (this.seqs.get(runId) ?? 0) + 1;
    this.seqs.set(runId, n);
    return n;
  }

  seed(runId: string, lastSeq: number): void {
    const current = this.seqs.get(runId) ?? 0;
    if (lastSeq > current) this.seqs.set(runId, lastSeq);
  }

  emit(input: RunEventInput): RunEvent {
    const event: RunEvent = {
      ...input,
      seq: this.nextSeq(input.runId),
      ts: new Date().toISOString(),
    };
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error("[bus] listener error", err);
      }
    }
    return event;
  }

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const bus = new EventBus();
