import type { ServerResponse } from "node:http";
import { bus } from "./event-bus.js";
import type { RunEvent } from "../types.js";

interface Client {
  res: ServerResponse;
  filter: (e: RunEvent) => boolean;
}

const clients = new Set<Client>();
let unsubscribe: (() => void) | null = null;

function fanout(e: RunEvent) {
  const wire = `id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;
  for (const client of clients) {
    if (!client.filter(e)) continue;
    try {
      client.res.write(wire);
    } catch {
      // ignore; cleanup will happen on 'close'
    }
  }
}

export function startSseHub() {
  if (unsubscribe) return;
  unsubscribe = bus.subscribe(fanout);
}

export function stopSseHub() {
  unsubscribe?.();
  unsubscribe = null;
}

export function attachClient(res: ServerResponse, filter: (e: RunEvent) => boolean): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(": connected\n\n");

  const client: Client = { res, filter };
  clients.add(client);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: hb ${Date.now()}\n\n`);
    } catch {
      // ignore
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
  return cleanup;
}

export function writeReplay(res: ServerResponse, events: RunEvent[]): void {
  for (const e of events) {
    res.write(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
  }
}
