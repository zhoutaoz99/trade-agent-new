import { insertRunEvent } from "../db/repo.js";
import { bus } from "./event-bus.js";
import type { RunEvent } from "../types.js";

/**
 * Per-run serial write queue. New writes chain onto the tail so events for a run
 * land in `seq` order regardless of how many are in flight.
 */
const tails = new Map<string, Promise<void>>();

function safePayload(payload: unknown): unknown {
  try {
    JSON.stringify(payload);
    return payload;
  } catch {
    return { note: "[unserializable payload]" };
  }
}

function enqueueWrite(event: RunEvent) {
  const prev = tails.get(event.runId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => insertRunEvent({ ...event, payload: safePayload(event.payload) }))
    .catch((err) => {
      console.error(`[db-writer] failed to persist event run=${event.runId} seq=${event.seq}`, err);
    });
  tails.set(event.runId, next);
  next.finally(() => {
    if (tails.get(event.runId) === next) tails.delete(event.runId);
  });
}

let unsubscribe: (() => void) | null = null;

export function startDbWriter() {
  if (unsubscribe) return;
  unsubscribe = bus.subscribe(enqueueWrite);
}

export function stopDbWriter() {
  unsubscribe?.();
  unsubscribe = null;
}

export async function flushDbWrites(runId?: string): Promise<void> {
  if (runId) {
    const t = tails.get(runId);
    if (t) await t.catch(() => {});
    return;
  }
  await Promise.all([...tails.values()].map((t) => t.catch(() => {})));
}
