import { describe, expect, it } from "vitest";
import { canonicalHash, sha256Hex, stableStringify, type HashableModel } from "../hash.js";

/** Minimal HashableModel builder for tests. */
function m(over: Partial<HashableModel> = {}): HashableModel {
  return {
    id: "model-a",
    limit: { context: 160000, output: 32768 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    enabled: true,
    ...over,
  };
}

function variant(id: string, settings?: Record<string, unknown>) {
  return { id, ...(settings !== undefined ? { settings } : {}) };
}

describe("sha256Hex", () => {
  it("is 64 hex chars and stable", () => {
    const h = sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("hello")).toBe(h);
    expect(sha256Hex("world")).not.toBe(h);
  });
});

describe("stableStringify", () => {
  it("sorts object keys recursively, keeps array order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ x: [3, 1, 2] })).toBe(stableStringify({ x: [3, 1, 2] }));
    expect(stableStringify({ x: [3, 1, 2] })).not.toBe(stableStringify({ x: [1, 3, 2] }));
    expect(stableStringify({ o: { z: { c: 1 }, a: 2 } })).toBe(stableStringify({ o: { a: 2, z: { c: 1 } } }));
  });

  it("normalizes undefined and non-finite numbers", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify({ a: NaN })).toBe(stableStringify({ a: null }));
    expect(stableStringify({ a: Infinity })).toBe(stableStringify({ a: null }));
  });
});

describe("canonicalHash", () => {
  const base = [m(), m({ id: "model-b", limit: { context: 4096, output: 8192 } })];

  it("is stable for identical input (incl. key and model order)", () => {
    const h1 = canonicalHash(base);
    const shuffled = [
      { ...base[1]!, limit: { ...base[1]!.limit }, capabilities: { ...base[1]!.capabilities } },
      base[0]!,
    ];
    expect(canonicalHash(shuffled)).toBe(h1);
    // object key order within a model must not matter
    const reordered = [
      { ...m(), limit: { output: 32768, context: 160000 }, capabilities: { input: ["text"], tools: true, output: ["text"] } },
      m({ id: "model-b", limit: { output: 8192, context: 4096 } }),
    ];
    expect(canonicalHash(reordered)).toBe(h1);
  });

  it("changes when context size changes", () => {
    expect(canonicalHash([m({ limit: { context: 8192, output: 32768 } })])).not.toBe(canonicalHash(base.slice(0, 1)));
  });

  it("changes on variant add / remove", () => {
    const withVariant = [m({ variants: [variant("low")] })];
    expect(canonicalHash(withVariant)).not.toBe(canonicalHash(base.slice(0, 1)));
    expect(canonicalHash([m({ variants: [variant("low"), variant("medium")] })])).not.toBe(
      canonicalHash(withVariant),
    );
    // variant order is normalized
    expect(
      canonicalHash([m({ variants: [variant("low"), variant("medium")] })]),
    ).toBe(canonicalHash([m({ variants: [variant("medium"), variant("low")] })]));
  });

  it("changes on enabled flip", () => {
    expect(canonicalHash([m({ enabled: false })])).not.toBe(canonicalHash(base.slice(0, 1)));
  });

  it("changes when a model is added or removed", () => {
    expect(canonicalHash(base)).not.toBe(canonicalHash(base.slice(0, 1)));
  });

  it("changes on modality change", () => {
    expect(
      canonicalHash([m({ capabilities: { tools: true, input: ["text", "image"], output: ["text"] } })]),
    ).not.toBe(canonicalHash(base.slice(0, 1)));
    // modality order is normalized
    expect(
      canonicalHash([m({ capabilities: { tools: true, input: ["text", "image"], output: ["text"] } })]),
    ).toBe(canonicalHash([m({ capabilities: { tools: true, input: ["image", "text"], output: ["text"] } })]));
  });

  it("is insensitive to fields outside the projection (name/time/cost/settings cannot leak)", () => {
    const a = canonicalHash([m()]);
    const withExtraneous = [
      {
        ...m(),
        // none of these are part of Model.Info's hashed projection
        name: "totally different",
        time: { released: 9999999999 },
        cost: [{ tier: null, input: 0, output: 0, cache: { read: 0, write: 0 } }],
        status: "deprecated",
        settings: {
          chat_template: "SHOULD-NEVER-LEAK __media__ jinja blob",
        },
      } as HashableModel,
    ];
    expect(canonicalHash(withExtraneous)).toBe(a);
  });
});
