import { describe, expect, it, vi } from "vitest";
import {
  classifyLevels,
  classifyProbe,
  probeCandidateLevels,
  runEffortProbe,
  type ProbeRequest,
} from "../probe.js";

const QWEN_SIGNALS = {
  guard: ["xhigh", "medium", "low"],
  defaultLevel: "xhigh",
  comparisons: ["high"],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** fetch stub scripted by a FIFO queue of responses ("throw" = network error). */
function queueFetch(responses: (Response | "throw")[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : null;
    calls.push({ url, body });
    const r = responses.shift();
    if (r === "throw") throw new Error("network down");
    return r!;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function probeReq(over: Partial<ProbeRequest> = {}): ProbeRequest {
  return {
    url: "http://x/apply-template",
    headers: {},
    modelId: "qwen3.8-27b-q5xl-dflash2",
    levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
    signals: QWEN_SIGNALS,
    timeoutMs: 1000,
    ...over,
  };
}

describe("probeCandidateLevels", () => {
  it("fixed vocabulary first, comparison literals appended alphabetically", () => {
    expect(probeCandidateLevels({ guard: [], defaultLevel: null, comparisons: [] })).toEqual([
      "minimal", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(probeCandidateLevels({ guard: [], defaultLevel: null, comparisons: ["zeta", "low", "alpha"] })).toEqual([
      "minimal", "low", "medium", "high", "xhigh", "max", "alpha", "zeta",
    ]);
  });
});

describe("classifyProbe (pure)", () => {
  const outcomes = (m: Record<string, string | "rejected">) => new Map(Object.entries(m));

  it("Qwen scenario: distinct hashes mapped, baseline-hash class default-alias, 400/500 rejected", () => {
    const out = outcomes({
      minimal: "rejected",
      low: "H-low",
      medium: "H-medium",
      high: "H-baseline",
      xhigh: "H-baseline",
      max: "rejected",
    });
    expect(classifyProbe(out, "H-baseline", QWEN_SIGNALS)).toEqual(["low", "medium", "xhigh"]);
  });

  it("alias class {high, xhigh} emits the canonical guard member, never the alias", () => {
    const out = outcomes({ high: "H1", xhigh: "H1" });
    expect(classifyProbe(out, "H0", QWEN_SIGNALS)).toEqual(["xhigh"]);
  });

  it("label precedence: guard member ▸ default level ▸ last in vocabulary order", () => {
    // no guard member in the class → the default level wins
    const noGuardSignals = { guard: [], defaultLevel: "foo", comparisons: ["foo", "bar"] };
    expect(classifyProbe(outcomes({ foo: "H1", bar: "H1" }), "H0", noGuardSignals)).toEqual(["foo"]);
    // no guard, default not in the class → last in vocabulary order
    expect(classifyProbe(outcomes({ alpha: "H1", zeta: "H1" }), "H0", noGuardSignals)).toEqual(["zeta"]);
  });

  it("all levels rejected → no effort variants", () => {
    expect(
      classifyProbe(outcomes({ minimal: "rejected", low: "rejected", medium: "rejected" }), "H0", QWEN_SIGNALS),
    ).toEqual([]);
  });

  it("output is in vocabulary order regardless of class arrival order", () => {
    const out = new Map<string, string | "rejected">();
    out.set("medium", "H-medium");
    out.set("low", "H-low");
    out.set("xhigh", "H-xhigh");
    expect(classifyProbe(out, "H0", QWEN_SIGNALS)).toEqual(["low", "medium", "xhigh"]);
  });
});

describe("classifyLevels (per-level classification)", () => {
  it("maps / default-alias / rejected per level, sorted", () => {
    const res = classifyLevels(new Map([["xhigh", "H0"], ["low", "H1"], ["max", "rejected"]]), "H0", QWEN_SIGNALS);
    expect(res).toEqual([
      { level: "low", cls: "mapped", promptHash: "H1" },
      { level: "max", cls: "rejected" },
      { level: "xhigh", cls: "default-alias", promptHash: "H0" },
    ]);
  });
});

describe("runEffortProbe (injected fetch)", () => {
  it("Qwen: baseline + 6 levels → success with canonical emission; model in the JSON body", async () => {
    const { fetchImpl, calls } = queueFetch([
      json(200, { prompt: "PROMPT-baseline" }),
      json(500, { error: { message: "raise_exception __media__ jinja snippet" } }),
      json(200, { prompt: "PROMPT-low" }),
      json(200, { prompt: "PROMPT-medium" }),
      json(200, { prompt: "PROMPT-baseline" }), // high ≡ baseline (alias)
      json(200, { prompt: "PROMPT-baseline" }), // xhigh ≡ baseline (default)
      json(400, { error: { message: "unsupported effort" } }),
    ]);
    const result = await runEffortProbe(probeReq({ fetchImpl }));
    expect(result).toEqual({ status: "success", emitted: ["low", "medium", "xhigh"] });

    expect(calls).toHaveLength(7);
    expect(calls.every((c) => c.url === "http://x/apply-template")).toBe(true);
    const bodies = calls.map((c) => c.body as { model: string; chat_template_kwargs: Record<string, unknown> });
    expect(bodies.every((b) => b.model === "qwen3.8-27b-q5xl-dflash2")).toBe(true);
    expect(bodies[0]!.chat_template_kwargs).toEqual({ enable_thinking: true }); // baseline
    expect(bodies[1]!.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "minimal" });
    expect(bodies[6]!.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "max" });
  });

  it("404/405 → unsupported (endpoint absent; no level calls, no retry flag)", async () => {
    for (const status of [404, 405]) {
      const { fetchImpl, calls } = queueFetch([json(status, { error: { message: "not found" } })]);
      const result = await runEffortProbe(probeReq({ fetchImpl }));
      expect(result).toEqual({ status: "unsupported" });
      expect(calls).toHaveLength(1);
    }
  });

  it("transient failures (5xx, network, missing prompt) → failed", async () => {
    let { fetchImpl } = queueFetch([json(200, { prompt: "P0" }), json(503, "unavailable")]);
    expect(await runEffortProbe(probeReq({ fetchImpl }))).toEqual({ status: "failed" });

    ({ fetchImpl } = queueFetch([json(200, { prompt: "P0" }), "throw"]));
    expect(await runEffortProbe(probeReq({ fetchImpl }))).toEqual({ status: "failed" });

    ({ fetchImpl } = queueFetch([json(200, {})]));
    expect(await runEffortProbe(probeReq({ fetchImpl }))).toEqual({ status: "failed" });

    ({ fetchImpl } = queueFetch([json(200, "not json")]));
    expect(await runEffortProbe(probeReq({ fetchImpl }))).toEqual({ status: "failed" });
  });

  it("hygiene: prompts and 500 bodies (jinja snippets) never appear in the result (R7)", async () => {
    const poison = "SECRET-JINJA __media__ {{ raise_exception('leak') }}";
    const { fetchImpl } = queueFetch([
      json(200, { prompt: `P0 ${poison}` }),
      json(500, { error: { message: poison } }),
      json(200, { prompt: `P1 ${poison}` }),
      json(200, { prompt: `P1 ${poison}` }),
      json(200, { prompt: `P1 ${poison}` }),
      json(200, { prompt: `P1 ${poison}` }),
      json(500, { error: { message: poison } }),
    ]);
    const result = await runEffortProbe(probeReq({ fetchImpl }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET-JINJA");
    expect(serialized).not.toContain("__media__");
    expect(serialized).not.toContain("raise_exception");
    expect(result.status).toBe("success");
  });
});
