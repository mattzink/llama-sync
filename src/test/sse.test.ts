import { describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  connectOutcome,
  createFrameParser,
  createScheduler,
  parseSseEvent,
} from "../sse.js";

describe("createFrameParser", () => {
  it("parses exact `data: <json>\\n\\n` frames", () => {
    const p = createFrameParser();
    const payloads = p.feed('data: {"model":"a","event":"model_status"}\n\n');
    expect(payloads).toEqual(['{"model":"a","event":"model_status"}']);
  });

  it("handles multiple frames per chunk", () => {
    const p = createFrameParser();
    const payloads = p.feed(
      'data: {"model":"a","event":"x"}\n\ndata: {"model":"b","event":"y"}\n\ndata: {"model":"c","event":"z"}\n\n',
    );
    expect(payloads).toHaveLength(3);
  });

  it("reassembles frames split across chunk boundaries", () => {
    const p = createFrameParser();
    const full = 'data: {"model":"split","event":"across"}\n\n';
    const payloads: string[] = [];
    for (let i = 0; i < full.length; i += 5) {
      payloads.push(...p.feed(full.slice(i, i + 5)));
    }
    expect(payloads).toEqual(['{"model":"split","event":"across"}']);
  });

  it("normalizes CRLF line endings", () => {
    const p = createFrameParser();
    expect(p.feed('data: {"model":"a","event":"x"}\r\n\r\n')).toEqual(['{"model":"a","event":"x"}']);
  });

  it("ignores non-data lines (event:/id:/retry:/comments) and emits no payload for them", () => {
    const p = createFrameParser();
    expect(p.feed(": comment\nevent: foo\nid: 42\nretry: 1000\n\n")).toEqual([]);
    expect(p.feed("event: model_status\ndata: {\"model\":\"a\",\"event\":\"model_status\"}\n\n")).toEqual(
      ['{"model":"a","event":"model_status"}'],
    );
  });

  it("malformed/unfinished input never crashes; oversized buffer is capped", () => {
    const p = createFrameParser();
    expect(p.feed("data: {broken json")).toEqual([]);
    expect(p.feed("garbage without any terminator ".repeat(200_000))).toEqual([]);
    // after the cap the parser is still usable
    expect(p.feed('data: {"model":"ok","event":"e"}\n\n')).toEqual(['{"model":"ok","event":"e"}']);
  });

  it("strips exactly one optional space after data:", () => {
    const p = createFrameParser();
    expect(p.feed('data:{"model":"a","event":"x"}\n\n')).toEqual(['{"model":"a","event":"x"}']);
    expect(p.feed('data:  two spaces\n\n')).toEqual([" two spaces"]); // only one stripped (per SSE framing)
  });
});

describe("parseSseEvent", () => {
  it("parses valid payloads ({model,event[,data]})", () => {
    expect(parseSseEvent('{"model":"m1","event":"status_change","data":{"status":"loaded"}}')).toEqual({
      model: "m1",
      event: "status_change",
    });
    expect(parseSseEvent('{"model":"*","event":"models_reload"}')).toEqual({ model: "*", event: "models_reload" });
  });

  it("returns null for malformed payloads", () => {
    expect(parseSseEvent("not json")).toBeNull();
    expect(parseSseEvent("[1,2]")).toBeNull();
    expect(parseSseEvent('"str"')).toBeNull();
    expect(parseSseEvent("null")).toBeNull();
    expect(parseSseEvent('{"model":"m1"}')).toBeNull(); // no event
    expect(parseSseEvent('{"event":"x"}')).toBeNull(); // no model
    expect(parseSseEvent('{"model":7,"event":"x"}')).toBeNull();
  });
});

describe("createScheduler (coalescing, injected clock)", () => {
  function harness(minIntervalMs = 1000) {
    let t = 0;
    let runs = 0;
    let inFlight = false;
    let finishCurrent: (() => void) | null = null;
    const events: string[] = [];
    const sched = createScheduler({
      now: () => t,
      minIntervalMs,
      run: async () => {
        runs += 1;
        inFlight = true;
        await new Promise<void>((res) => {
          finishCurrent = res;
        });
        finishCurrent = null;
        inFlight = false;
        events.push(`run${runs}@${t}`);
      },
    });
    return {
      sched,
      finish: () => {
        finishCurrent?.();
      },
      advance: (ms: number) => {
        t += ms;
      },
      get runs() {
        return runs;
      },
      get inFlight() {
        return inFlight;
      },
      events,
    };
  }

  it("a request starts a refresh", async () => {
    const h = harness();
    h.sched.request();
    expect(h.runs).toBe(1);
    expect(h.inFlight).toBe(true);
    h.finish();
    await vi.waitFor(() => expect(h.runs).toBe(1));
    expect(h.inFlight).toBe(false);
  });

  it("N events while in flight → exactly one extra refresh", async () => {
    const h = harness();
    h.sched.request(); // start run 1
    h.sched.request();
    h.sched.request();
    h.sched.request(); // 3 coalesced while in flight
    expect(h.runs).toBe(1);
    h.finish();
    await vi.waitFor(() => expect(h.runs).toBe(2));
    h.finish();
    await vi.waitFor(() => expect(h.inFlight).toBe(false));
    expect(h.runs).toBe(2); // no further pending
  });

  it("a request < minInterval after completion is dropped", async () => {
    const h = harness();
    h.sched.request();
    h.finish();
    await vi.waitFor(() => expect(h.inFlight).toBe(false));
    h.advance(100); // 100 ms after completion
    h.sched.request();
    expect(h.runs).toBe(1); // dropped
    h.advance(900); // 1000 ms after completion
    h.sched.request();
    expect(h.runs).toBe(2); // accepted
    h.finish();
    await vi.waitFor(() => expect(h.inFlight).toBe(false));
  });

  it("the extra in-flight refresh itself coalesces further events", async () => {
    const h = harness();
    h.sched.request();
    h.sched.request(); // coalesced into the rerun
    h.finish();
    await vi.waitFor(() => expect(h.runs).toBe(2));
    h.sched.request(); // in flight during the rerun → one more
    h.finish();
    await vi.waitFor(() => expect(h.runs).toBe(3));
    h.finish();
    await vi.waitFor(() => expect(h.inFlight).toBe(false));
    expect(h.runs).toBe(3);
  });
});

describe("backoffDelay", () => {
  it("1 s, 2 s, 4 s, 8 s, 16 s, 32 s then capped at 60 s", () => {
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(3)).toBe(4000);
    expect(backoffDelay(4)).toBe(8000);
    expect(backoffDelay(5)).toBe(16000);
    expect(backoffDelay(6)).toBe(32000);
    expect(backoffDelay(7)).toBe(60000); // 64 s capped
    expect(backoffDelay(8)).toBe(60000);
    expect(backoffDelay(100)).toBe(60000);
  });

  it("treats attempt < 1 as 1", () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(-3)).toBe(1000);
  });
});

describe("connectOutcome", () => {
  it("404/405 → disabled (no reconnect for the plugin's life)", () => {
    expect(connectOutcome(404, "text/event-stream")).toBe("disabled");
    expect(connectOutcome(405, null)).toBe("disabled");
  });

  it("200 + text/event-stream → open", () => {
    expect(connectOutcome(200, "text/event-stream")).toBe("open");
    expect(connectOutcome(200, "text/event-stream; charset=utf-8")).toBe("open");
  });

  it("anything else → retry", () => {
    expect(connectOutcome(200, "application/json")).toBe("retry");
    expect(connectOutcome(500, "text/event-stream")).toBe("retry");
    expect(connectOutcome(401, null)).toBe("retry");
    expect(connectOutcome(0, null)).toBe("retry");
  });
});
