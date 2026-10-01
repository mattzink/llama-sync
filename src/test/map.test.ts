import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildInventory,
  deriveModel,
  deriveVariants,
  mergeExtras,
  prettify,
  selectProps,
  type DeriveContext,
} from "../map.js";
import { parseModelsList, type ModelEntry } from "../discover.js";
import { BUILTIN_OPTIONS, type Options } from "../options.js";
import { parseProps, type ModelProps } from "../props.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const routerEntries = (): ModelEntry[] => parseModelsList(fixture("router-models.json"))!;
const plainEntry = (): ModelEntry => parseModelsList(fixture("plain-models.json"))![0]!;

function dctx(): DeriveContext & { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  return { warn: (m) => warnings.push(m), error: (m) => errors.push(m), warnings, errors };
}

function opts(over: Partial<Options> = {}): Options {
  return { ...BUILTIN_OPTIONS, providerID: "gpuz", ...over };
}

/** Qwen props as the plugin would hold them after a successful probe. */
const qwenProps = (): ModelProps => {
  const base = parseProps(fixture("router-props-loaded.json"))!;
  return { ...base, effortLevels: ["low", "medium", "xhigh"], effortSource: "probe" };
};

/** Plain (text-only) props with no effort support. */
const plainProps = (): ModelProps => {
  const base = parseProps(fixture("plain-props.json"))!;
  return { ...base, effortLevels: [], effortSource: "static" };
};

function entry(id: string, over: Partial<ModelEntry> = {}): ModelEntry {
  return { id, aliases: [], tags: [], created: 1790803842, ...over };
}

const loadedEntry = (ctxSize = "160000"): ModelEntry =>
  entry("m", { status: { value: "loaded", args: ["--alias", "m", "--ctx-size", ctxSize] }, meta: { n_ctx: 160000 } });

const unloadedEntry = (over: Partial<ModelEntry> = {}): ModelEntry =>
  entry("m", { status: { value: "unloaded", args: [] }, ...over });

describe("full inventory: all 4 live entries map to valid Model.Info", () => {
  const o = opts();
  const props = new Map([["qwen3.8-27b-q5xl-dflash2", qwenProps()]]);
  const ctx = dctx();
  const models = buildInventory(routerEntries(), props, o, ctx);

  it("emits one Model.Info per entry, with every required field", () => {
    expect(ctx.errors).toEqual([]);
    expect(models).toHaveLength(4);
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.modelID).toBe(m.id); // no aliases in this config
      expect(m.providerID).toBe("gpuz");
      expect(typeof m.name).toBe("string");
      expect(m.name.length).toBeGreaterThan(0);
      expect(Array.isArray(m.variants)).toBe(true);
      expect(typeof m.time.released).toBe("number");
      expect(m.cost).toEqual([]);
      expect(m.status).toBe("active");
      expect(typeof m.enabled).toBe("boolean");
      expect(m.limit.context).toBeGreaterThan(0);
      expect(m.limit.output).toBeGreaterThan(0);
      expect(typeof m.capabilities.tools).toBe("boolean");
      expect(Array.isArray(m.capabilities.input)).toBe(true);
      expect(Array.isArray(m.capabilities.output)).toBe(true);
    }
  });

  it("loaded Qwen gets props-derived values; unloaded ones fall back to /models + defaults", () => {
    const loaded = models.find((m) => m.id === "qwen3.8-27b-q5xl-dflash2")!;
    expect(loaded.limit.context).toBe(160000); // props n_ctx
    expect(loaded.capabilities.input).toEqual(["text", "image", "video"]); // props modalities (finer than /models)
    expect(loaded.capabilities.tools).toBe(true);
    expect(loaded.variants.map((v) => v.id)).toEqual(["low", "medium", "xhigh", "no-think"]);
    expect(loaded.enabled).toBe(true);

    const q4xl = models.find((m) => m.id === "qwen3.8-27b-q4xl-dflash2")!;
    expect(q4xl.capabilities.input).toEqual(["text"]); // /models architecture, text-only
    expect(q4xl.limit.context).toBe(160000); // --ctx-size from args
    expect(q4xl.variants).toEqual([]); // never loaded → no props → defaults
    expect(q4xl.enabled).toBe(true); // includeUnloaded default
  });

  it("unloaded entries are included and enabled by default (includeUnloaded)", () => {
    for (const m of models) expect(m.enabled).toBe(true);
  });
});

describe("limit.context precedence (override ▸ props ▸ --ctx-size ▸ meta ▸ default)", () => {
  it("override wins over everything", () => {
    const o = opts({ overrides: { m: { limit: { context: 777 } } } });
    const info = deriveModel(loadedEntry(), qwenProps(), o, o.overrides["m"], dctx());
    expect(info!.limit.context).toBe(777);
  });

  it("props n_ctx wins over --ctx-size (match or not)", () => {
    const info = deriveModel(loadedEntry(), qwenProps(), opts(), undefined, dctx());
    expect(info!.limit.context).toBe(160000);
  });

  it("props-vs-args mismatch → warn, props wins (fresh props only)", () => {
    const ctx = dctx();
    const info = deriveModel(loadedEntry("8192"), qwenProps(), opts(), undefined, ctx);
    expect(info!.limit.context).toBe(160000);
    expect(ctx.warnings.some((w) => w.includes("disagrees"))).toBe(true);
  });

  it("--ctx-size is used when props are absent", () => {
    const info = deriveModel(loadedEntry("8192"), null, opts(), undefined, dctx());
    expect(info!.limit.context).toBe(8192);
  });

  it("meta.n_ctx is used when props and args are absent (plain-server link)", () => {
    const info = deriveModel(entry("m", { meta: { n_ctx: 4096 } }), null, opts(), undefined, dctx());
    expect(info!.limit.context).toBe(4096);
  });

  it("defaults when nothing is available", () => {
    const info = deriveModel(entry("m"), null, opts(), undefined, dctx());
    expect(info!.limit.context).toBe(BUILTIN_OPTIONS.defaults.limit.context);
  });

  it("malformed --ctx-size is skipped (falls through to meta)", () => {
    const info = deriveModel(
      entry("m", { status: { value: "loaded", args: ["--ctx-size", "abc"] }, meta: { n_ctx: 4096 } }),
      null,
      opts(),
      undefined,
      dctx(),
    );
    expect(info!.limit.context).toBe(4096);
  });

  it("limit.output: override ▸ default (props max_tokens is −1/unlimited, unused)", () => {
    expect(deriveModel(loadedEntry(), qwenProps(), opts(), undefined, dctx())!.limit.output).toBe(32768);
    const o = opts({ overrides: { m: { limit: { output: 1234 } } } });
    expect(deriveModel(loadedEntry(), qwenProps(), o, o.overrides["m"], dctx())!.limit.output).toBe(1234);
  });
});

describe("capability mapping", () => {
  it("props modalities → input (text + vision→image + video→video + audio→audio)", () => {
    const p = { ...qwenProps(), modalities: { vision: true, video: true, audio: true } };
    expect(deriveModel(loadedEntry(), p, opts(), undefined, dctx())!.capabilities.input).toEqual([
      "text", "image", "video", "audio",
    ]);
  });

  it("fallback to /models architecture (validated subset) when props are null", () => {
    const q4xl = routerEntries().find((e) => e.id === "qwen3.8-27b-q4xl-dflash2")!;
    expect(deriveModel(q4xl, null, opts(), undefined, dctx())!.capabilities.input).toEqual(["text"]);
    const q5xl = routerEntries().find((e) => e.id === "qwen3.8-27b-q5xl")!;
    expect(deriveModel(q5xl, null, opts(), undefined, dctx())!.capabilities.input).toEqual(["text", "image"]);
  });

  it("unknown modality types are filtered", () => {
    const e = entry("m", { architecture: { input_modalities: ["text", "hologram"], output_modalities: ["text"] } });
    expect(deriveModel(e, null, opts(), undefined, dctx())!.capabilities.input).toEqual(["text"]);
  });

  it("output modalities: architecture (router-only) ▸ default; override wins", () => {
    expect(deriveModel(loadedEntry(), null, opts(), undefined, dctx())!.capabilities.output).toEqual(["text"]);
    const e = entry("m", { status: { value: "loaded", args: [] }, architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] } });
    expect(deriveModel(e, null, opts(), undefined, dctx())!.capabilities.output).toEqual(["text", "image"]);
    const o = opts({ overrides: { m: { capabilities: { output: ["text"] } } } });
    expect(deriveModel(e, null, o, o.overrides["m"], dctx())!.capabilities.output).toEqual(["text"]);
    // plain entry (no architecture) → default
    expect(deriveModel(plainEntry(), null, opts(), undefined, dctx())!.capabilities.output).toEqual(["text"]);
  });

  it("tools: override ▸ props caps ▸ default", () => {
    expect(deriveModel(loadedEntry(), qwenProps(), opts(), undefined, dctx())!.capabilities.tools).toBe(true);
    const p = { ...qwenProps(), caps: { ...qwenProps().caps, supports_tools: false } };
    expect(deriveModel(loadedEntry(), p, opts(), undefined, dctx())!.capabilities.tools).toBe(false);
    const o = opts({ overrides: { m: { capabilities: { tools: false } } } });
    expect(deriveModel(loadedEntry(), qwenProps(), o, o.overrides["m"], dctx())!.capabilities.tools).toBe(false);
  });

  it("name: override ▸ prettified id", () => {
    expect(deriveModel(loadedEntry(), qwenProps(), opts(), undefined, dctx())!.name).toBe("M");
    const o = opts({ overrides: { m: { name: "My Model" } } });
    expect(deriveModel(loadedEntry(), qwenProps(), o, o.overrides["m"], dctx())!.name).toBe("My Model");
  });

  it("time.released = created * 1000 (ms); 0 when created is 0", () => {
    expect(deriveModel(loadedEntry(), qwenProps(), opts(), undefined, dctx())!.time.released).toBe(1790803842000);
    expect(deriveModel(entry("m", { created: 0 }), null, opts(), undefined, dctx())!.time.released).toBe(0);
  });
});

describe("plain-server entry (§2.7: no status/architecture, has meta)", () => {
  it("with props → props-derived capabilities, enabled, created-based released", () => {
    const info = deriveModel(plainEntry(), plainProps(), opts(), undefined, dctx())!;
    expect(info.enabled).toBe(true);
    expect(info.limit.context).toBe(4096); // props n_ctx
    expect(info.capabilities.input).toEqual(["text"]); // all modalities false
    expect(info.capabilities.tools).toBe(false); // caps
    expect(info.time.released).toBe(1790803842000);
    expect(info.variants).toEqual([]); // no effort support, no enable_thinking
  });

  it("with props null → defaults (no architecture link to fall back on)", () => {
    const info = deriveModel(plainEntry(), null, opts(), undefined, dctx())!;
    expect(info.limit.context).toBe(4096); // meta.n_ctx
    expect(info.capabilities.input).toEqual(["text"]); // default
    expect(info.capabilities.tools).toBe(true); // default
    expect(info.variants).toEqual([]);
  });
});

describe("variant derivation", () => {
  const p = qwenProps();

  it("Qwen fixture → exactly low/medium/xhigh/no-think with chat_template_kwargs", () => {
    expect(deriveVariants(p, opts())).toEqual([
      { id: "low", settings: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low" } } },
      { id: "medium", settings: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium" } } },
      { id: "xhigh", settings: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "xhigh" } } },
      { id: "no-think", settings: { chat_template_kwargs: { enable_thinking: false } } },
    ]);
  });

  it("supports_reasoning_effort false → effort suppressed, no-think still emitted", () => {
    const p2 = { ...p, caps: { ...p.caps, supports_reasoning_effort: false } };
    expect(deriveVariants(p2, opts())).toEqual([
      { id: "no-think", settings: { chat_template_kwargs: { enable_thinking: false } } },
    ]);
  });

  it("no effort and no enable_thinking → no variants", () => {
    expect(deriveVariants(plainProps(), opts())).toEqual([]);
  });

  it("autoVariants false → defaults.variants (no derivation)", () => {
    const o = opts({ autoVariants: false, defaults: { ...BUILTIN_OPTIONS.defaults, variants: [{ id: "fixed" }] } });
    expect(deriveModel(loadedEntry(), p, o, undefined, dctx())!.variants.map((v) => v.id)).toEqual(["fixed"]);
  });

  it("no props → defaults.variants / []", () => {
    expect(deriveModel(loadedEntry(), null, opts(), undefined, dctx())!.variants).toEqual([]);
    const o = opts({ defaults: { ...BUILTIN_OPTIONS.defaults, variants: [{ id: "d1" }] } });
    expect(deriveModel(loadedEntry(), null, o, undefined, dctx())!.variants.map((v) => v.id)).toEqual(["d1"]);
  });

  it("noThinkVariant false → no no-think", () => {
    expect(deriveVariants(p, opts({ noThinkVariant: false })).map((v) => v.id)).toEqual(["low", "medium", "xhigh"]);
  });

  it("variantReasoningEfforts restricts (still intersected with the derived set)", () => {
    expect(deriveVariants(p, opts({ variantReasoningEfforts: ["low"] })).map((v) => v.id)).toEqual(["low", "no-think"]);
    expect(deriveVariants(p, opts({ variantReasoningEfforts: ["bogus"] })).map((v) => v.id)).toEqual(["no-think"]);
  });

  it("explicit override variants beat auto-derivation in loaded and unloaded states", () => {
    const o = opts({ overrides: { m: { variants: [{ id: "curated", settings: { k: 1 } }] } } });
    const loaded = deriveModel(loadedEntry(), qwenProps(), o, o.overrides["m"], dctx())!;
    const unloaded = deriveModel(unloadedEntry(), qwenProps(), o, o.overrides["m"], dctx())!;
    for (const m of [loaded, unloaded]) {
      expect(m.variants).toEqual([{ id: "curated", settings: { k: 1 } }]);
    }
  });
});

describe("extraVariants merging", () => {
  const o = (extra: unknown) => opts({ overrides: { m: { extraVariants: extra as never } } });

  it("appends to the derived set (derived order kept)", () => {
    const info = deriveModel(loadedEntry(), qwenProps(), o([{ id: "turbo", settings: { x: 1 } }]), o([{ id: "turbo", settings: { x: 1 } }]).overrides["m"], dctx())!;
    expect(info.variants.map((v) => v.id)).toEqual(["low", "medium", "xhigh", "no-think", "turbo"]);
  });

  it("a same-id extra replaces the derived entry", () => {
    const ovr = [{ id: "low", settings: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "custom" } } }];
    const info = deriveModel(loadedEntry(), qwenProps(), o(ovr), o(ovr).overrides["m"], dctx())!;
    expect(info.variants.map((v) => v.id)).toEqual(["low", "medium", "xhigh", "no-think"]);
    expect(info.variants[0]!.settings).toEqual({ chat_template_kwargs: { enable_thinking: true, reasoning_effort: "custom" } });
  });

  it("composes with an explicit variants base (replace, then merge)", () => {
    const o2 = opts({
      overrides: {
        m: {
          variants: [{ id: "a", settings: {} }],
          extraVariants: [{ id: "a", settings: { rep: true } }, { id: "b", settings: {} }],
        },
      },
    });
    const info = deriveModel(loadedEntry(), qwenProps(), o2, o2.overrides["m"], dctx())!;
    expect(info.variants).toEqual([
      { id: "a", settings: { rep: true } },
      { id: "b", settings: {} },
    ]);
  });

  it("mergeExtras unit behavior", () => {
    const base = [{ id: "x" }, { id: "y" }];
    expect(mergeExtras(base, undefined)).toEqual([{ id: "x" }, { id: "y" }]);
    expect(mergeExtras(base, [])).toEqual([{ id: "x" }, { id: "y" }]);
    expect(mergeExtras(base, [{ id: "y", settings: { s: 1 } }, { id: "z" }])).toEqual([
      { id: "x" },
      { id: "y", settings: { s: 1 } },
      { id: "z" },
    ]);
  });
});

describe("overrides precedence", () => {
  it("name / limit / capabilities / disabled all apply", () => {
    const o = opts({
      overrides: {
        m: {
          name: "Over",
          limit: { context: 111, output: 222 },
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          disabled: true,
        },
      },
    });
    const info = deriveModel(loadedEntry(), qwenProps(), o, o.overrides["m"], dctx())!;
    expect(info.name).toBe("Over");
    expect(info.limit).toEqual({ context: 111, output: 222 });
    expect(info.capabilities.tools).toBe(false);
    expect(info.enabled).toBe(false);
  });

  it("no override → full derivation unchanged", () => {
    const info = deriveModel(loadedEntry(), qwenProps(), opts(), undefined, dctx())!;
    expect(info.enabled).toBe(true);
  });
});

describe("aliases (§4.3)", () => {
  const targetId = "qwen3.8-27b-q5xl-dflash2";
  const baseOpts = (aliases: Options["aliases"]) => opts({ aliases });

  it("string-form alias: own id, target modelID, inherited props-derived values", () => {
    const o = baseOpts({ "qwen-fast": targetId });
    const ctx = dctx();
    const models = buildInventory(routerEntries(), new Map([[targetId, qwenProps()]]), o, ctx);
    const alias = models.find((m) => m.id === "qwen-fast")!;
    const target = models.find((m) => m.id === targetId)!;
    expect(ctx.errors).toEqual([]);
    expect(alias).toBeDefined();
    expect(alias.modelID).toBe(targetId);
    expect(alias.name).toBe("Qwen Fast"); // prettified alias key
    // inherited props-derived values: same projection reused
    expect(alias.limit.context).toBe(target.limit.context);
    expect(alias.capabilities).toEqual(target.capabilities);
    expect(alias.variants).toEqual(target.variants);
    expect(alias.enabled).toBe(true);
    expect(models).toHaveLength(5); // 4 discovered + 1 alias
  });

  it("object-form alias applies alias-level overrides on top", () => {
    const o = baseOpts({
      "qwen-fast": {
        model: targetId,
        name: "Fast Qwen",
        variants: [{ id: "fast-only" }],
        limit: { context: 32000 },
      },
    });
    const models = buildInventory(routerEntries(), new Map([[targetId, qwenProps()]]), o, dctx());
    const alias = models.find((m) => m.id === "qwen-fast")!;
    expect(alias.name).toBe("Fast Qwen");
    expect(alias.limit.context).toBe(32000);
    expect(alias.variants).toEqual([{ id: "fast-only" }]);
    expect(alias.capabilities).toEqual(models.find((m) => m.id === targetId)!.capabilities); // still inherited
  });

  it("target absent this poll → alias omitted (one warn, no error)", () => {
    const o = baseOpts({ ghost: "not-in-list" });
    const ctx = dctx();
    const models = buildInventory(routerEntries(), new Map(), o, ctx);
    expect(models.find((m) => m.id === "ghost")).toBeUndefined();
    expect(ctx.warnings.some((w) => w.includes("ghost"))).toBe(true);
    expect(ctx.errors).toEqual([]);
  });

  it("alias key colliding with a discovered id → rejected (one error, no entry)", () => {
    const o = baseOpts({ [targetId]: "other" });
    const ctx = dctx();
    const models = buildInventory(routerEntries(), new Map(), o, ctx);
    expect(models.filter((m) => m.id === targetId)).toHaveLength(1); // only the discovered one
    expect(ctx.errors.some((e) => e.includes("collides"))).toBe(true);
  });

  it("alias of an enabled: false target inherits false; explicit disabled: false re-enables", () => {
    const o = baseOpts({
      "qwen-fast": { model: targetId, disabled: false },
      "qwen-slow": targetId,
    });
    const o2 = { ...o, overrides: { [targetId]: { disabled: true } } };
    const ctx = dctx();
    const models = buildInventory(routerEntries(), new Map([[targetId, qwenProps()]]), o2, ctx);
    const target = models.find((m) => m.id === targetId)!;
    const fast = models.find((m) => m.id === "qwen-fast")!;
    const slow = models.find((m) => m.id === "qwen-slow")!;
    expect(target.enabled).toBe(false);
    expect(fast.enabled).toBe(true); // explicit override wins
    expect(slow.enabled).toBe(false); // inherited
  });

  it("alias of a hidden target (includeUnloaded: false) is not emitted", () => {
    const o = baseOpts({ "m-alias": "m" });
    const entries = [unloadedEntry()];
    const models = buildInventory(entries, new Map(), opts({ includeUnloaded: false, aliases: o.aliases }), dctx());
    expect(models).toEqual([]); // target hidden → alias skipped
  });
});

describe("unloaded policies (§4.5)", () => {
  const e = unloadedEntry();

  it("default: included and enabled", () => {
    expect(deriveModel(e, null, opts(), undefined, dctx())!.enabled).toBe(true);
  });

  it("includeUnloaded: false → hidden (null)", () => {
    expect(deriveModel(e, null, opts({ includeUnloaded: false }), undefined, dctx())).toBeNull();
  });

  it("disableUnloaded: true → visible but enabled: false", () => {
    expect(deriveModel(e, null, opts({ disableUnloaded: true }), undefined, dctx())!.enabled).toBe(false);
  });

  it("transient states (loading etc.) stay selectable even with disableUnloaded", () => {
    for (const v of ["loading", "downloading", "downloaded"]) {
      const t = entry("m", { status: { value: v, args: [] } });
      expect(deriveModel(t, null, opts({ disableUnloaded: true }), undefined, dctx())!.enabled, v).toBe(true);
    }
  });

  it("disableUnloaded + override disabled: false → explicitly enabled", () => {
    const o = opts({ disableUnloaded: true, overrides: { m: { disabled: false } } });
    expect(deriveModel(e, null, o, o.overrides["m"], dctx())!.enabled).toBe(true);
  });
});

describe("selectProps (§4.2 step 5)", () => {
  const fa = { ...qwenProps(), n_ctx: 1 };
  const ca = { ...qwenProps(), n_ctx: 2 };
  const cb = { ...qwenProps(), n_ctx: 3 };
  const fresh = new Map([["a", fa]]);
  const cache = {
    a: { at: 1, props: ca },
    b: { at: 1, props: cb },
  };

  it("fresh beats cache when both present for an id", () => {
    expect(selectProps("a", fresh, cache)).toBe(fa);
  });

  it("cache used when no fresh projection", () => {
    expect(selectProps("b", fresh, cache)).toBe(cb);
  });

  it("null when neither exists", () => {
    expect(selectProps("c", fresh, cache)).toBeNull();
  });
});

describe("cached vs fresh props: mapping is source-agnostic", () => {
  it("a cached projection (identical content) yields the same Model.Info as a fresh one", () => {
    const fresh = qwenProps();
    // simulate the cache round-trip: JSON serialization/deserialization
    const cached = JSON.parse(JSON.stringify(fresh)) as ModelProps;
    const e = loadedEntry();
    const a = deriveModel(e, fresh, opts(), undefined, dctx())!;
    const b = deriveModel(e, cached, opts(), undefined, dctx())!;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("different content is visible (mapping uses whatever projection it is given)", () => {
    const e = loadedEntry();
    const small = { ...qwenProps(), n_ctx: 4096 };
    const a = deriveModel(e, qwenProps(), opts(), undefined, dctx())!;
    const b = deriveModel(e, small, opts(), undefined, dctx())!;
    expect(a.limit.context).not.toBe(b.limit.context);
  });

  it("invalidated cache (treated as absent) → fallback path, not an error", () => {
    const ctx = dctx();
    const info = deriveModel(unloadedEntry(), null, opts(), undefined, ctx);
    expect(info).not.toBeNull();
    expect(info!.limit.context).toBe(160000); // --ctx-size fallback
    expect(ctx.errors).toEqual([]);
  });
});

describe("prettify", () => {
  it("spaces + title case on - _ . and whitespace runs", () => {
    expect(prettify("qwen3.8-27b-q5xl-dflash2")).toBe("Qwen3 8 27b Q5xl Dflash2");
    expect(prettify("a__b..c---d")).toBe("A B C D");
    expect(prettify("  spaced   out  ")).toBe("Spaced Out");
  });
});
