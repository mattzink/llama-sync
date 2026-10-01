/**
 * Router SSE (GET /models/sse) support — pure parts (plan §2.8): frame
 * parsing, event validation, burst coalescing, and the reconnect backoff
 * schedule. The live connection (fetch + stream read) lives in index.ts.
 *
 * Protocol: 200, Content-Type text/event-stream; each frame is exactly
 * `data: <json>\n\n` (no event:/id:/retry: lines). Events carry no history
 * and the stream has no keepalive — SSE is a change detector only.
 */

export interface FrameParser {
  /** Feed a decoded chunk; returns the completed frame data payloads. */
  feed(chunk: string): string[];
}

const MAX_BUFFER = 1_000_000;

export function createFrameParser(): FrameParser {
  let buffer = "";
  return {
    feed(chunk: string): string[] {
      buffer += chunk.replace(/\r\n/g, "\n");
      const payloads: string[] = [];
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) {
            // strip "data:" plus the single optional space per SSE framing
            dataLines.push(line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5));
          }
          // event:/id:/retry:/comment lines are not part of this protocol; ignored
        }
        if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
      }
      if (buffer.length > MAX_BUFFER) buffer = "";
      return payloads;
    },
  };
}

export interface SseEvent {
  model: string;
  event: string;
}

/** Parse one frame payload (`{"model","event","data"?}`); null when malformed. */
export function parseSseEvent(payload: string): SseEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const r = json as Record<string, unknown>;
  if (typeof r["model"] !== "string" || typeof r["event"] !== "string") return null;
  return { model: r["model"], event: r["event"] };
}

export interface SchedulerOptions {
  now: () => number;
  run: () => Promise<void>;
  /** Coalescing window: a request within this time of the last completion is dropped. */
  minIntervalMs?: number;
}

export interface Scheduler {
  /** Coalesce: a no-op while a refresh is in flight (one rerun queued) or
   * ran < minIntervalMs ago. */
  request(): void;
  inFlight(): boolean;
}

/**
 * Burst coalescing for event-triggered refreshes.
 *
 * - Events while a refresh is in flight: the in-flight run started before
 *   the event, so it cannot reflect it — coalesce all of them into exactly
 *   one extra refresh, started when the run completes.
 * - Events that land < `minIntervalMs` after the last completion are dropped:
 *   the inventory is fresh enough (the safety-net poll bounds staleness).
 */
export function createScheduler(opts: SchedulerOptions): Scheduler {
  const minInterval = opts.minIntervalMs ?? 1000;
  let inFlight = false;
  let pending = false;
  let lastCompleted = -Infinity;

  const start = (): void => {
    inFlight = true;
    pending = false;
    void opts.run().finally(() => {
      inFlight = false;
      lastCompleted = opts.now();
      if (pending) {
        pending = false;
        start();
      }
    });
  };

  return {
    request() {
      if (inFlight) {
        pending = true;
        return;
      }
      if (opts.now() - lastCompleted < minInterval) return;
      start();
    },
    inFlight: () => inFlight,
  };
}

/** Reconnect backoff: 1 s, 2 s, 4 s, … capped at 60 s (attempt is 1-based). */
export function backoffDelay(attempt: number, capMs = 60_000): number {
  const a = Math.max(1, Math.floor(attempt));
  return Math.min(1000 * 2 ** (a - 1), capMs);
}

export type ConnectOutcome = "open" | "retry" | "disabled";

/**
 * 404/405 means the service does not register the endpoint (plain
 * single-instance server, or an older build) — disabled for the plugin's
 * life. Anything else is transient: retry with backoff.
 */
export function connectOutcome(status: number, contentType: string | null): ConnectOutcome {
  if (status === 404 || status === 405) return "disabled";
  if (status === 200 && (contentType ?? "").includes("text/event-stream")) return "open";
  return "retry";
}
