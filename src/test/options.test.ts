import { describe, expect, it } from "vitest";
import { BUILTIN_OPTIONS, resolveOptions, stripJsonc, type Options } from "../options.js";

const FILE = `
{
  // a line comment with "quotes" and /* nothing */ inside
  "providerID": "gpuz",          // trailing comment
  "refreshMs": 60000,
  "defaults": {
    "limit": { "context": 8192 }, // only context set; output falls back
    /* block
       comment */
    "capabilities": { "input": ["text", "image"] },
  },
  "overrides": {
    "qwen-a": { "name": "Qwen A", "limit": { "context": 4096 } },
    "qwen-b": { "disabled": true },
  },
  "aliases": { "fast": "qwen-a" },
  "urlLike": "http://example.com/a//b", // not a comment
  "strWithStar": "a /* not a comment */ b",
}
`;

describe("stripJsonc", () => {
  it("removes line comments, block comments and trailing commas", () => {
    const out = stripJsonc(FILE);
    expect(JSON.parse(out)).toMatchObject({ providerID: "gpuz", refreshMs: 60000 });
  });

  it("keeps // and /* inside string literals", () => {
    const parsed = JSON.parse(stripJsonc(FILE)) as Record<string, unknown>;
    expect(parsed["urlLike"]).toBe("http://example.com/a//b");
    expect(parsed["strWithStar"]).toBe("a /* not a comment */ b");
  });

  it("does not treat an escaped quote as string end", () => {
    expect(JSON.parse(stripJsonc(`{ "a": "x \\/ not comment" }`))).toEqual({ a: "x / not comment" });
    expect(JSON.parse(stripJsonc(`{ "a": "say \\"hi\\" // still string" }`))).toEqual({
      a: 'say "hi" // still string',
    });
  });
});

describe("resolveOptions: precedence ctx ▸ file ▸ built-in", () => {
  it("starts from built-in defaults when nothing is provided", () => {
    expect(resolveOptions(undefined, null)).toEqual(BUILTIN_OPTIONS);
    expect(resolveOptions({}, "")).toEqual(BUILTIN_OPTIONS);
  });

  it("file values beat built-ins; ctx beats file (per top-level key)", () => {
    const o = resolveOptions({ refreshMs: 120000 }, FILE);
    expect(o.providerID).toBe("gpuz"); // file
    expect(o.refreshMs).toBe(120000); // ctx
    expect(o.modelsPath).toBe("/models"); // built-in
    expect(o.sse).toBe(true); // built-in
  });

  it("ctx wins for every scalar key", () => {
    const ctx: Record<string, unknown> = {
      providerID: "ctxprov",
      modelsPath: "/m",
      propsPath: "/p",
      includeUnloaded: false,
      disableUnloaded: true,
      refreshMs: 1000,
      sse: false,
      timeoutMs: 250,
      autoVariants: false,
      noThinkVariant: false,
      effortProbe: false,
      propsForUnloaded: "autoload",
      propsCache: false,
    };
    const o = resolveOptions(ctx, FILE);
    expect(o.providerID).toBe("ctxprov");
    expect(o.modelsPath).toBe("/m");
    expect(o.propsPath).toBe("/p");
    expect(o.includeUnloaded).toBe(false);
    expect(o.disableUnloaded).toBe(true);
    expect(o.refreshMs).toBe(1000);
    expect(o.sse).toBe(false);
    expect(o.timeoutMs).toBe(250);
    expect(o.autoVariants).toBe(false);
    expect(o.noThinkVariant).toBe(false);
    expect(o.effortProbe).toBe(false);
    expect(o.propsForUnloaded).toBe("autoload");
    expect(o.propsCache).toBe(false);
  });
});

describe("resolveOptions: invalid values fall back (no throw)", () => {
  it("invalid ctx value falls back to file value", () => {
    const o = resolveOptions({ refreshMs: "soon" }, FILE);
    expect(o.refreshMs).toBe(60000); // file
  });

  it("invalid ctx and file values fall back to built-in", () => {
    const o = resolveOptions(
      { timeoutMs: -5 },
      JSON.stringify({ timeoutMs: "nope" }),
    );
    expect(o.timeoutMs).toBe(BUILTIN_OPTIONS.timeoutMs);
  });

  it("invalid object sub-values are dropped, valid siblings kept", () => {
    const o = resolveOptions(
      {},
      JSON.stringify({
        overrides: { a: { name: 42, disabled: "yes", limit: { context: 1234 } } },
        aliases: { x: { model: 42 }, y: "target" },
      }),
    );
    expect(o.overrides["a"]).toEqual({ limit: { context: 1234 } });
    expect(o.aliases).toEqual({ y: "target" });
  });

  it("malformed file text throws so the caller can degrade", () => {
    expect(() => resolveOptions({}, "{ not json")).toThrow();
    expect(() => resolveOptions({}, "[1,2,3]")).toThrow();
  });

  it("degrades to ctx + built-ins after a malformed file", () => {
    expect(() => {
      try {
        resolveOptions({ sse: false }, "{ broken");
      } catch {
        // caller behavior
      }
      expect(resolveOptions({ sse: false }, null).sse).toBe(false);
    }).not.toThrow();
  });
});

describe("resolveOptions: defaults merge per leaf", () => {
  it("merges file defaults over built-ins leaf by leaf", () => {
    const o = resolveOptions({}, FILE);
    expect(o.defaults.limit.context).toBe(8192); // file
    expect(o.defaults.limit.output).toBe(BUILTIN_OPTIONS.defaults.limit.output); // built-in
    expect(o.defaults.capabilities.input).toEqual(["text", "image"]); // file
    expect(o.defaults.capabilities.output).toEqual(["text"]); // built-in
    expect(o.defaults.capabilities.tools).toBe(true); // built-in
    expect(o.defaults.variants).toEqual([]);
  });

  it("ctx defaults beat file defaults per leaf", () => {
    const o = resolveOptions(
      { defaults: { limit: { output: 123 }, capabilities: { tools: false } } },
      FILE,
    );
    expect(o.defaults.limit.output).toBe(123);
    expect(o.defaults.limit.context).toBe(8192); // file still applies
    expect(o.defaults.capabilities.tools).toBe(false);
    expect(o.defaults.capabilities.input).toEqual(["text", "image"]);
  });

  it("ctx defaults variants replace wholesale (no leaf merge for arrays)", () => {
    const o = resolveOptions(
      { defaults: { variants: [{ id: "v1" }] } },
      JSON.stringify({ defaults: { variants: [{ id: "f1" }] } }),
    );
    expect(o.defaults.variants).toEqual([{ id: "v1" }]);
  });
});

describe("resolveOptions: overrides merge per id, then per field", () => {
  it("merges ctx and file override objects for the same id", () => {
    const o = resolveOptions(
      { overrides: { "qwen-a": { limit: { output: 99 } }, "qwen-c": { name: "C" } } },
      FILE,
    );
    expect(o.overrides["qwen-a"]).toEqual({
      name: "Qwen A", // file
      limit: { context: 4096, output: 99 }, // merged
      disabled: undefined,
    });
    expect(o.overrides["qwen-b"]).toEqual({ disabled: true });
    expect(o.overrides["qwen-c"]).toEqual({ name: "C" });
  });

  it("ctx replaces file for array/object fields", () => {
    const o = resolveOptions(
      { overrides: { "qwen-a": { variants: [{ id: "x" }] } } },
      JSON.stringify({ overrides: { "qwen-a": { variants: [{ id: "y" }], name: "A" } } }),
    );
    expect(o.overrides["qwen-a"]?.variants).toEqual([{ id: "x" }]);
    expect(o.overrides["qwen-a"]?.name).toBe("A");
  });
});

describe("resolveOptions: aliases and variantReasoningEfforts", () => {
  it("alias keys resolve ctx ▸ file (whole value)", () => {
    const o = resolveOptions(
      { aliases: { fast: { model: "other", name: "Fast" } }, slow: "file-target" } as Record<string, unknown>,
      JSON.stringify({ aliases: { fast: "file-target", slow: "file-target2" } }),
    );
    expect(o.aliases["fast"]).toEqual({ model: "other", name: "Fast" });
    expect(o.aliases["slow"]).toBe("file-target2");
  });

  it("object alias form keeps valid override fields", () => {
    const o = resolveOptions(
      {},
      JSON.stringify({
        aliases: {
          a: { model: "t", name: "A", extraVariants: [{ id: "e", settings: { k: 1 } }] },
        },
      }),
    );
    expect(o.aliases["a"]).toEqual({
      model: "t",
      name: "A",
      extraVariants: [{ id: "e", settings: { k: 1 } }],
    });
  });

  it("variantReasoningEfforts: null default, ctx array, explicit ctx null, file array", () => {
    expect(resolveOptions({}, null).variantReasoningEfforts).toBeNull();
        expect(resolveOptions({ variantReasoningEfforts: ["low"] }, null).variantReasoningEfforts).toEqual(["low"]);
    expect(resolveOptions({ variantReasoningEfforts: null }, JSON.stringify({ variantReasoningEfforts: ["x"] })).variantReasoningEfforts).toBeNull();
    expect(resolveOptions({}, JSON.stringify({ variantReasoningEfforts: ["x", "y"] })).variantReasoningEfforts).toEqual(["x", "y"]);
  });
});

describe("Options type surface", () => {
  it("built-in defaults match the plan table", () => {
    expect(BUILTIN_OPTIONS).toMatchObject({
      providerID: "llamacpp",
      modelsPath: "/models",
      propsPath: "/props",
      includeUnloaded: true,
      disableUnloaded: false,
      refreshMs: 30000,
      sse: true,
      timeoutMs: 5000,
      autoVariants: true,
      variantReasoningEfforts: null,
      noThinkVariant: true,
      effortProbe: true,
      defaults: {
        limit: { context: 160000, output: 32768 },
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
      },
      propsForUnloaded: "never",
      propsCache: true,
    });
    const o: Options = BUILTIN_OPTIONS;
    expect(o).toBeTruthy();
  });
});
