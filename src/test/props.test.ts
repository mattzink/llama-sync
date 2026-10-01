import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../hash.js";
import {
  EMPTY_SIGNALS,
  evictAndValidate,
  fetchProps,
  orderLevels,
  parseProps,
  propsEqual,
  resolveEffort,
  shouldProbe,
  staticEffortLevels,
  type ModelProps,
  type PropsBase,
  type PropsCache,
} from "../props.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const qwenProps = () => fixture("router-props-loaded.json");
const qwenBase = (): PropsBase => parseProps(qwenProps())!;

function stubFetch(status: number, body: unknown | string): typeof fetch {
  return (vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  )) as unknown as typeof fetch;
}

describe("parseProps: whitelist projection (Qwen fixture)", () => {
  it("projects exactly the whitelisted fields", () => {
    const p = qwenBase();
    expect(Object.keys(p).sort()).toEqual(
      ["caps", "effort", "hasEnableThinking", "is_sleeping", "modalities", "n_ctx", "templateHash"].sort(),
    );
  });

  it("reads n_ctx, caps, modalities, is_sleeping", () => {
    const p = qwenBase();
    expect(p.n_ctx).toBe(160000);
    expect(p.caps).toEqual({
      supports_tools: true,
      supports_tool_calls: true,
      supports_parallel_tool_calls: true,
      supports_object_arguments: true,
      supports_reasoning_effort: true,
      supports_preserve_reasoning: true,
      supports_system_role: true,
      supports_string_content: true,
      supports_typed_content: true,
    });
    expect(p.modalities).toEqual({ vision: true, video: true, audio: false });
    expect(p.is_sleeping).toBe(false);
  });

  it("computes the template sha256 digest (64-hex, stable)", () => {
    const p = qwenBase();
    const template = (qwenProps() as Record<string, string>)["chat_template"]!;
    expect(p.templateHash).toBe(sha256Hex(template));
    expect(p.templateHash).toMatch(/^[0-9a-f]{64}$/);
    // identical fixture → identical digest; different template → different digest
    expect(qwenBase().templateHash).toBe(p.templateHash);
    const other = parseProps({ ...(qwenProps() as Record<string, unknown>), chat_template: template + "x" })!;
    expect(other.templateHash).not.toBe(p.templateHash);
  });

  it("hasEnableThinking reflects the template", () => {
    const asObj = () => qwenProps() as Record<string, unknown>;
    expect(qwenBase().hasEnableThinking).toBe(true);
    expect(parseProps({ ...asObj(), chat_template: "no thinking here" })!.hasEnableThinking).toBe(false);
    expect(parseProps({ ...asObj(), chat_template: undefined })!.hasEnableThinking).toBe(false);
  });

  it("extracts the Qwen static candidate signals (guard, default, alias comparison)", () => {
    const p = qwenBase();
    expect(p.effort.guard).toEqual(["xhigh", "medium", "low"]);
    expect(p.effort.defaultLevel).toBe("xhigh");
    expect(p.effort.comparisons).toEqual(["high"]);
    // static stand-in = the guard, in vocabulary order
    expect(staticEffortLevels(p.effort)).toEqual(["low", "medium", "xhigh"]);
    expect(orderLevels(["xhigh", "medium", "low", "max"])).toEqual(["low", "medium", "xhigh", "max"]);
  });

  it("degrades to comparison literals when no guard raises", () => {
    const p = parseProps({
      default_generation_settings: { n_ctx: 1024 },
      chat_template_caps: { supports_reasoning_effort: true },
      chat_template:
        "{%- if reasoning_effort == 'ultra' %}{%- endif %}{%- if reasoning_effort == 'sane' %}{%- endif %}",
    })!;
    expect(p.effort.guard).toEqual([]);
    expect(p.effort.comparisons).toEqual(["ultra", "sane"]);
    expect(staticEffortLevels(p.effort)).toEqual(["sane", "ultra"]); // unknowns alphabetical
  });

  it("a `not in` guard without raise_exception is not the acceptance guard", () => {
    const p = parseProps({
      chat_template_caps: { supports_reasoning_effort: true },
      chat_template:
        "{%- if reasoning_effort not in ('a','b') %}{%- endif %}{%- if reasoning_effort == 'c' %}{%- endif %}",
    })!;
    expect(p.effort.guard).toEqual([]);
    expect(p.effort.comparisons).toEqual(["c"]);
  });

  it("supports_reasoning_effort false → empty signals even if the template looks effort-y", () => {
    const p = parseProps({
      chat_template_caps: { supports_reasoning_effort: false },
      chat_template: "reasoning_effort|default('x') not in ('a') raise_exception('boom') == 'b'",
    })!;
    expect(p.effort).toEqual(EMPTY_SIGNALS);
    expect(staticEffortLevels(p.effort)).toEqual([]);
  });

  it("hygiene: no chat_template key, no __media__, no marker, no template text in the projection (R7)", () => {
    const serialized = JSON.stringify(qwenBase());
    expect(serialized).not.toContain("chat_template");
    expect(serialized).not.toContain("__media__");
    expect(serialized).not.toContain("MEDIA-MARKER-SENTINEL");
    expect(serialized).not.toContain("abridged fixture"); // template prose
    expect(serialized).not.toContain("Supported types are"); // template error string
    // the full fixture JSON does contain them — the parse boundary is what drops them
    const raw = JSON.stringify(qwenProps());
    expect(raw).toContain("__media__");
  });
});

describe("parseProps: defensive parsing", () => {
  it("non-objects → null", () => {
    expect(parseProps(null)).toBeNull();
    expect(parseProps("str")).toBeNull();
    expect(parseProps(42)).toBeNull();
    expect(parseProps([])).toBeNull();
  });

  it("empty object → safe-default projection (partial, not null)", () => {
    const p = parseProps({});
    expect(p!.n_ctx).toBeNull();
    expect(p!.is_sleeping).toBe(false);
    expect(p!.modalities).toEqual({ vision: false, video: false, audio: false });
    expect(p!.caps.supports_tools).toBe(false);
    expect(p!.templateHash).toBe(sha256Hex(""));
    expect(p!.effort).toEqual(EMPTY_SIGNALS);
  });

  it("bad sub-objects degrade field by field", () => {
    const p = parseProps({
      default_generation_settings: { n_ctx: "big" },
      modalities: "vision?",
      is_sleeping: "yes",
      chat_template_caps: null,
      chat_template: 42,
    })!;
    expect(p.n_ctx).toBeNull();
    expect(p.modalities).toEqual({ vision: false, video: false, audio: false });
    expect(p.is_sleeping).toBe(false);
    expect(p.hasEnableThinking).toBe(false);
    expect(p.templateHash).toBe(sha256Hex(""));
  });
});

describe("fetchProps (injected fetch)", () => {
  it("200 + valid body → projection", async () => {
    const res = await fetchProps("http://x/props", {}, 1000, stubFetch(200, qwenProps()));
    expect(res.error).toBeNull();
    expect(res.props!.n_ctx).toBe(160000);
  });

  it("error body → bounded `HTTP <status>: <error.message>` (plan §2.2)", async () => {
    const res = await fetchProps(
      "http://x/props",
      {},
      1000,
      stubFetch(400, { error: { code: 400, message: "model is not loaded", type: "invalid_request_error" } }),
    );
    expect(res.props).toBeNull();
    expect(res.error).toBe("HTTP 400: model is not loaded");
  });

  it("500 / other non-2xx → bounded error text, never the body", async () => {
    const res = await fetchProps("http://x/props", {}, 1000, stubFetch(500, "jinja source snippet leak"));
    expect(res.props).toBeNull();
    expect(res.error).toBe("HTTP 500: unknown error");
  });

  it("200 + non-JSON → unparseable error", async () => {
    const res = await fetchProps("http://x/props", {}, 1000, stubFetch(200, "<html>"));
    expect(res.props).toBeNull();
    expect(res.error).toBe("unparseable props response");
  });

  it("network failure → null props, bounded error", async () => {
    const f = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const res = await fetchProps("http://x/props", {}, 1000, f);
    expect(res.props).toBeNull();
    expect(res.error).toBe("network error or timeout");
  });
});

describe("plain-server props (§2.7: universal shape)", () => {
  it("projects to the identical shape (is_sleeping false)", () => {
    const p = parseProps(fixture("plain-props.json"))!;
    expect(Object.keys(p).sort()).toEqual(
      ["caps", "effort", "hasEnableThinking", "is_sleeping", "modalities", "n_ctx", "templateHash"].sort(),
    );
    expect(p.n_ctx).toBe(4096);
    expect(p.is_sleeping).toBe(false);
    expect(p.modalities).toEqual({ vision: false, video: false, audio: false });
    expect(p.hasEnableThinking).toBe(false);
    expect(p.effort).toEqual(EMPTY_SIGNALS);
  });

  it("is_sleeping true flips only that field", () => {
    const p = parseProps(fixture("plain-props.json"))!;
    const asleep = parseProps({ ...(fixture("plain-props.json") as Record<string, unknown>), is_sleeping: true })!;
    expect(asleep.is_sleeping).toBe(true);
    const { is_sleeping: _a, ...restA } = asleep;
    const { is_sleeping: _b, ...restB } = p;
    expect(restA).toEqual(restB);
  });
});

// ---------------------------------------------------------------------------
// Pure props-cache helpers (§4.2 step 4)
// ---------------------------------------------------------------------------

function makeBase(over: Partial<PropsBase> = {}): PropsBase {
  return { ...qwenBase(), ...over };
}

function cachedProbe(sameDigest: boolean): ModelProps {
  const b = qwenBase();
  return {
    ...b,
    templateHash: sameDigest ? b.templateHash : "0".repeat(64),
    effortLevels: ["low", "medium", "xhigh"],
    effortSource: "probe",
  };
}

function cachedStatic(sameDigest: boolean, unsupported = false): ModelProps {
  const b = qwenBase();
  return {
    ...b,
    templateHash: sameDigest ? b.templateHash : "0".repeat(64),
    effortLevels: ["low", "medium", "xhigh"],
    effortSource: "static",
    ...(unsupported ? { probeUnsupported: true } : {}),
  };
}

describe("shouldProbe", () => {
  const base = qwenBase();
  it("no cache entry → probe", () => {
    expect(shouldProbe(base, undefined, true)).toBe(true);
  });

  it("digest unchanged + probe-derived → no re-probe", () => {
    expect(shouldProbe(base, cachedProbe(true), true)).toBe(false);
  });

  it("digest unchanged + static stand-in (no unsupported flag) → re-probe", () => {
    expect(shouldProbe(base, cachedStatic(true), true)).toBe(true);
  });

  it("digest unchanged + static + probeUnsupported → never re-probe", () => {
    expect(shouldProbe(base, cachedStatic(true, true), true)).toBe(false);
  });

  it("digest changed → probe (even over a probe-derived entry)", () => {
    expect(shouldProbe(base, cachedProbe(false), true)).toBe(true);
    expect(shouldProbe(base, cachedStatic(false, true), true)).toBe(true);
  });

  it("probe gate: sleeping → no probe; cap off → no probe; option off → no probe", () => {
    expect(shouldProbe(makeBase({ is_sleeping: true }), undefined, true)).toBe(false);
    expect(
      shouldProbe(makeBase({ caps: { ...base.caps, supports_reasoning_effort: false } }), undefined, true),
    ).toBe(false);
    expect(shouldProbe(base, undefined, false)).toBe(false);
  });
});

describe("resolveEffort", () => {
  const base = qwenBase();

  it("probe success → probe-derived levels", () => {
    expect(resolveEffort(base, undefined, { kind: "success", levels: ["low", "medium", "xhigh"] })).toEqual({
      effortLevels: ["low", "medium", "xhigh"],
      effortSource: "probe",
    });
  });

  it("probe 404/405 → static stand-in + probeUnsupported flag", () => {
    expect(resolveEffort(base, undefined, { kind: "unsupported" })).toEqual({
      effortLevels: ["low", "medium", "xhigh"], // static guard set
      effortSource: "static",
      probeUnsupported: true,
    });
  });

  it("transient failure reuses a consistent probe-derived cache entry", () => {
    expect(resolveEffort(base, cachedProbe(true), { kind: "failed" })).toEqual({
      effortLevels: ["low", "medium", "xhigh"],
      effortSource: "probe",
    });
  });

  it("transient failure reuses a consistent static+unsupported entry", () => {
    expect(resolveEffort(base, cachedStatic(true, true), { kind: "failed" })).toEqual({
      effortLevels: ["low", "medium", "xhigh"],
      effortSource: "static",
      probeUnsupported: true,
    });
  });

  it("probe gated/skipped (null outcome) reuses cache when consistent", () => {
    expect(resolveEffort(base, cachedProbe(true), null).effortSource).toBe("probe");
  });

  it("failure with a changed digest falls back to static for the NEW digest", () => {
    expect(resolveEffort(base, cachedProbe(false), { kind: "failed" })).toEqual({
      effortLevels: ["low", "medium", "xhigh"],
      effortSource: "static",
    });
  });

  it("no cache + no probe → static guard set", () => {
    expect(resolveEffort(base, undefined, null)).toEqual({
      effortLevels: ["low", "medium", "xhigh"],
      effortSource: "static",
    });
  });
});

describe("propsEqual / cache merge hygiene", () => {
  it("ignores the `at` timestamp, compares content", () => {
    const a: ModelProps = { ...qwenBase(), effortLevels: ["low"], effortSource: "static" };
    expect(propsEqual(a, { ...a })).toBe(true);
    expect(propsEqual(a, { ...a, n_ctx: 999999 })).toBe(false);
    expect(propsEqual(a, { ...a, effortLevels: ["high"] })).toBe(false);
  });

  it("a serialized cache holds only whitelisted scalars (R7 holds for storage too)", () => {
    const cache: PropsCache = {
      "qwen3.8-27b-q5xl-dflash2": { at: 1234, props: { ...qwenBase(), effortLevels: ["low", "medium", "xhigh"], effortSource: "probe" } },
    };
    const serialized = JSON.stringify(cache);
    expect(serialized).not.toContain("chat_template");
    expect(serialized).not.toContain("__media__");
    expect(serialized).not.toContain("MEDIA-MARKER-SENTINEL");
    expect(serialized).not.toContain("abridged fixture");
    expect(serialized).not.toContain("raise_exception");
  });
});

describe("evictAndValidate (§4.2 step 4)", () => {
  const entry = (n_ctx: number | null): { at: number; props: ModelProps } => ({
    at: 1,
    props: { ...qwenBase(), n_ctx, effortLevels: [], effortSource: "static" },
  });

  it("keeps entries whose id is live and whose n_ctx matches --ctx-size", () => {
    const { cache, dirty } = evictAndValidate(
      { a: entry(160000), b: entry(4096) },
      new Map([
        ["a", 160000],
        ["b", 4096],
        ["c", null],
      ]),
    );
    expect(Object.keys(cache).sort()).toEqual(["a", "b"]);
    expect(dirty).toBe(false);
  });

  it("evicts ids absent from the live list", () => {
    const { cache, dirty } = evictAndValidate({ a: entry(160000), b: entry(4096) }, new Map([["a", 160000]]));
    expect(Object.keys(cache)).toEqual(["a"]);
    expect(dirty).toBe(true);
  });

  it("drops an entry whose cached n_ctx no longer matches --ctx-size (preset repointed)", () => {
    const { cache, dirty } = evictAndValidate(
      { a: entry(160000) },
      new Map([["a", 8192]]),
    );
    expect(Object.keys(cache)).toEqual([]);
    expect(dirty).toBe(true);
  });

  it("the guard is inert when status.args is absent (plain servers: ctxSize null)", () => {
    const { cache, dirty } = evictAndValidate(
      { a: entry(160000) },
      new Map([["a", null]]),
    );
    expect(Object.keys(cache)).toEqual(["a"]);
    expect(dirty).toBe(false);
  });

  it("an entry with null n_ctx is never invalidated by the guard", () => {
    const { cache, dirty } = evictAndValidate({ a: entry(null) }, new Map([["a", 8192]]));
    expect(Object.keys(cache)).toEqual(["a"]);
    expect(dirty).toBe(false);
  });
});
