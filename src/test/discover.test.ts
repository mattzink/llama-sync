import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ctxSizeFromArgs,
  errorBodyMessage,
  fetchHttp,
  fetchModels,
  isRunningStatus,
  isUnloadedStatus,
  parseModelsList,
  propsCall,
  type ModelEntry,
} from "../discover.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const routerModels = () => fixture("router-models.json") as { data: Record<string, unknown>[] };

function entry(over: Partial<ModelEntry> & { id: string }): ModelEntry {
  return { aliases: [], tags: [], created: 0, ...over };
}

describe("parseModelsList: router shape", () => {
  it("projects all 4 live entries with the retained fields only", () => {
    const list = parseModelsList(routerModels());
    expect(list).not.toBeNull();
    expect(list!.map((e) => e.id)).toEqual([
      "qwen3.8-27b-q4m-dflash2",
      "qwen3.8-27b-q4xl-dflash2",
      "qwen3.8-27b-q5xl",
      "qwen3.8-27b-q5xl-dflash2",
    ]);
    const loaded = list!.find((e) => e.id === "qwen3.8-27b-q5xl-dflash2")!;
    expect(loaded.status?.value).toBe("loaded");
    expect(loaded.status?.args).toContain("--ctx-size");
    expect(loaded.architecture).toEqual({ input_modalities: ["text", "image"], output_modalities: ["text"] });
    expect(loaded.meta?.n_ctx).toBe(160000);
    expect(loaded.created).toBeGreaterThan(0);
  });

  it("drops the verbose preset TOML (R4: minimal projection)", () => {
    const list = parseModelsList(routerModels());
    const serialized = JSON.stringify(list);
    // the trimmed-marker only ever existed in the dropped `preset` field;
    // note: strings like "presence-penalty" may appear in status.args, which is retained
    expect(serialized).not.toContain("# …(trimmed)");
    expect(serialized).not.toContain('"preset"');
  });
});

describe("parseModelsList: defensive parsing", () => {
  it("empty list → []", () => {
    expect(parseModelsList({ data: [] })).toEqual([]);
  });

  it("non-array data → null", () => {
    expect(parseModelsList({ data: "nope" })).toBeNull();
    expect(parseModelsList({ data: { x: 1 } })).toBeNull();
  });

  it("missing data → null; non-object → null; bad JSON (null) → null", () => {
    expect(parseModelsList({})).toBeNull();
    expect(parseModelsList(null)).toBeNull();
    expect(parseModelsList("nope")).toBeNull();
    expect(parseModelsList([1, 2])).toBeNull();
  });

  it("skips malformed entries, keeps good ones", () => {
    const list = parseModelsList({
      data: [
      { id: "good", created: 5 },
      { name: "no-id" },
      null,
      42,
      { id: "" },
      { id: "also-good" },
      ],
    });
    expect(list!.map((e) => e.id)).toEqual(["good", "also-good"]);
  });

  it("degrades missing sub-objects to safe defaults", () => {
    const list = parseModelsList({ data: [{ id: "x", created: "bogus", aliases: 7, status: { value: 1 } }] });
    expect(list).toEqual([
      { id: "x", aliases: [], tags: [], created: 0 },
    ]);
  });
});

describe("parseModelsList: plain single-instance shape (§2.7)", () => {
  it("no status/architecture, has meta → one entry, no crash", () => {
    const list = parseModelsList(fixture("plain-models.json"));
    expect(list).toEqual([
      {
        id: "qwen3-4b-instruct",
        aliases: [],
        tags: [],
        created: 1790803842,
        meta: { n_ctx: 4096 },
      },
    ]);
  });

  it("reads data[] only (legacy top-level models array ignored)", () => {
    const raw = fixture("plain-models.json") as Record<string, unknown>;
    expect(raw["models"]).toBeDefined(); // present in the fixture (b11277)
    const list = parseModelsList(raw);
    expect(list!.length).toBe(1);
  });
});

describe("status classification (all six b11277 values + missing)", () => {
  const values = ["downloading", "downloaded", "unloaded", "loading", "loaded", "sleeping"] as const;

  it("loaded/sleeping/missing-status → props consulted (autoload=false)", () => {
    for (const v of ["loaded", "sleeping"] as const) {
      expect(propsCall(entry({ id: "m", status: { value: v, args: [] } }), { propsForUnloaded: "never" }))
        .toEqual({ autoload: false });
    }
    expect(propsCall(entry({ id: "m" }), { propsForUnloaded: "never" })).toEqual({ autoload: false });
  });

  it("unloaded → skipped with never, autoload=true with the opt-in", () => {
    const e = entry({ id: "m", status: { value: "unloaded", args: [] } });
    expect(propsCall(e, { propsForUnloaded: "never" })).toBeNull();
    expect(propsCall(e, { propsForUnloaded: "autoload" })).toEqual({ autoload: true });
  });

  it("loading/downloading/downloaded → always skipped (no running child)", () => {
    for (const v of ["downloading", "downloaded", "loading"] as const) {
      const e = entry({ id: "m", status: { value: v, args: [] } });
      expect(propsCall(e, { propsForUnloaded: "never" }), v).toBeNull();
      expect(propsCall(e, { propsForUnloaded: "autoload" }), v).toBeNull();
    }
  });

  it("isRunningStatus / isUnloadedStatus agree with the classifier", () => {
    for (const v of values) {
      const e = entry({ id: "m", status: { value: v, args: [] } });
      expect(isRunningStatus(e), v).toBe(v === "loaded" || v === "sleeping");
      expect(isUnloadedStatus(e), v).toBe(v === "unloaded");
    }
    expect(isRunningStatus(entry({ id: "m" }))).toBe(true);
    expect(isUnloadedStatus(entry({ id: "m" }))).toBe(false);
  });
});

describe("ctxSizeFromArgs", () => {
  it("parses --ctx-size <n>", () => {
    expect(ctxSizeFromArgs(["--alias", "x", "--ctx-size", "160000", "--tmpdir", "/t"])).toBe(160000);
  });

  it("null when absent, malformed, or missing value", () => {
    expect(ctxSizeFromArgs(["--ctx-size"])).toBeNull();
    expect(ctxSizeFromArgs(["--ctx-size", "abc"])).toBeNull();
    expect(ctxSizeFromArgs(["--ctx-size", "0"])).toBeNull();
    expect(ctxSizeFromArgs(["-nope"])).toBeNull();
    expect(ctxSizeFromArgs(undefined)).toBeNull();
  });
});

describe("fetchHttp / fetchModels (injected fetch)", () => {
  function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
    return (vi.fn(async (input: string | URL, init?: RequestInit) =>
      handler(String(input instanceof URL ? input.href : input), init),
    )) as unknown as typeof fetch;
  }

  it("fetchModels parses a 200 body", async () => {
    const f = stubFetch(() => new Response(JSON.stringify(fixture("router-models.json")), { status: 200 }));
    const list = await fetchModels("http://x/models", {}, 1000, f);
    expect(list!.length).toBe(4);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("HTTP error → null; network error → null; non-JSON body → null", async () => {
    expect(await fetchModels("http://x", {}, 1000, stubFetch(() => new Response("err", { status: 500 })))).toBeNull();
    const thrower = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await fetchModels("http://x", {}, 1000, thrower as unknown as typeof fetch)).toBeNull();
    expect(await fetchModels("http://x", {}, 1000, stubFetch(() => new Response("<html>nope", { status: 200 })))).toBeNull();
  });

  it("timeout aborts the request (status 0)", async () => {
    const slow: typeof fetch = (vi.fn((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    )) as unknown as typeof fetch;
    const out = await fetchHttp("http://x", {}, 50, undefined, slow);
    expect(out.status).toBe(0);
    expect(out.json).toBeNull();
  });

  it("sends provided headers and the accept header", async () => {
    let seen: Record<string, string> = {};
    const f: typeof fetch = (vi.fn(async (_input, init) => {
      seen = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
      return new Response("{}", { status: 200 });
    })) as unknown as typeof fetch;
    await fetchHttp("http://x", { Authorization: "Bearer t" }, 1000, undefined, f);
    expect(seen["Authorization"]).toBe("Bearer t");
    expect(seen["accept"]).toBe("application/json");
  });

  it("POST sets content-type and body", async () => {
    let seen: { ct?: string; body?: string } = {};
    const f: typeof fetch = (vi.fn(async (_input, init) => {
      seen = { ct: (init?.headers as Record<string, string>)?.["content-type"], body: init?.body as string };
      return new Response(JSON.stringify({ prompt: "p" }), { status: 200 });
    })) as unknown as typeof fetch;
    const out = await fetchHttp("http://x", {}, 1000, { method: "POST", body: '{"a":1}' }, f);
    expect(out.status).toBe(200);
    expect(seen.ct).toBe("application/json");
    expect(seen.body).toBe('{"a":1}');
  });
});

describe("errorBodyMessage", () => {
  it("prefers error.message, then message, then a generic fallback", () => {
    expect(errorBodyMessage({ error: { message: "model is not loaded", code: 400 } })).toBe("model is not loaded");
    expect(errorBodyMessage({ message: "oops" })).toBe("oops");
    expect(errorBodyMessage({ error: "weird" })).toBe("unknown error");
    expect(errorBodyMessage(null)).toBe("unknown error");
    expect(errorBodyMessage("text")).toBe("unknown error");
  });
});
