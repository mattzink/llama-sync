/**
 * Plugin option resolution: ctx.options ▸ options.jsonc sibling file ▸
 * built-in defaults.
 *
 * Resolution is per top-level key (shallow): a key's value comes from the
 * highest-priority source that provides a valid value for it. Two keys are
 * merged per leaf instead, because a partial user entry must not clobber
 * built-in sub-values:
 *   - `defaults`: built-in ▸ file ▸ ctx, per leaf (limit.context, …)
 *   - `overrides`: per model id, then per field (ctx ▸ file)
 *   - `aliases`: per alias key (ctx ▸ file)
 *
 * Invalid values for a key fall back to the next source (no throw), except
 * a malformed JSONC file, which throws so the caller can log and re-resolve
 * without it.
 */

export interface VariantInput {
  id: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface ModelOverride {
  name?: string;
  limit?: { context?: number; output?: number };
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
  variants?: VariantInput[];
  extraVariants?: VariantInput[];
  disabled?: boolean;
}

/** Alias value: the target model id, or an object form with per-alias overrides. */
export type AliasSpec = string | (ModelOverride & { model: string });

export interface ModelDefaults {
  limit: { context: number; output: number };
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: VariantInput[];
}

export interface Options {
  providerID: string;
  modelsPath: string;
  propsPath: string;
  includeUnloaded: boolean;
  disableUnloaded: boolean;
  refreshMs: number;
  sse: boolean;
  timeoutMs: number;
  autoVariants: boolean;
  variantReasoningEfforts: string[] | null;
  noThinkVariant: boolean;
  effortProbe: boolean;
  defaults: ModelDefaults;
  overrides: Record<string, ModelOverride>;
  aliases: Record<string, AliasSpec>;
  propsForUnloaded: "never" | "autoload";
  propsCache: boolean;
}

export const BUILTIN_OPTIONS: Options = {
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
  overrides: {},
  aliases: {},
  propsForUnloaded: "never",
  propsCache: true,
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isPosInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isPropForUnloaded = (v: unknown): v is "never" | "autoload" =>
  v === "never" || v === "autoload";

/**
 * Tiny JSONC stripper: removes // and /* … *\/ comments (string-aware) and
 * trailing commas before } / ]. No dependency; sufficient for a hand-written
 * options file.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (lineComment) {
      if (c === "\n") {
        lineComment = false;
        out += c;
      }
      continue;
    }
    if (blockComment) {
      if (c === "*" && n === "/") {
        blockComment = false;
        i++;
      } else if (c === "\n") {
        out += c;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        if (i + 1 < text.length) {
          out += n!;
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      blockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function validateVariant(v: unknown): VariantInput | null {
  if (!isRecord(v) || !isString(v["id"])) return null;
  const out: VariantInput = { id: v["id"] };
  if (isRecord(v["settings"])) out.settings = { ...v["settings"] };
  if (isRecord(v["headers"])) {
    const h: Record<string, string> = {};
    for (const [k, x] of Object.entries(v["headers"])) if (typeof x === "string") h[k] = x;
    out.headers = h;
  }
  if (isRecord(v["body"])) out.body = { ...v["body"] };
  return out;
}

const isVariantArray = (v: unknown): v is VariantInput[] =>
  Array.isArray(v) && v.every((x) => validateVariant(x) !== null);

function pickVariantArray(v: unknown): VariantInput[] | null {
  if (!isVariantArray(v)) return null;
  return (v as unknown[]).map((x) => validateVariant(x)!);
}

function validateOverride(v: unknown): ModelOverride | null {
  if (!isRecord(v)) return null;
  const out: ModelOverride = {};
  if (isString(v["name"])) out.name = v["name"];
  if (isRecord(v["limit"])) {
    const limit: { context?: number; output?: number } = {};
    if (isPosInt(v["limit"]["context"])) limit.context = v["limit"]["context"];
    if (isPosInt(v["limit"]["output"])) limit.output = v["limit"]["output"];
    if (limit.context !== undefined || limit.output !== undefined) out.limit = limit;
  }
  if (isRecord(v["capabilities"])) {
    const capabilities: { tools?: boolean; input?: string[]; output?: string[] } = {};
    if (isBool(v["capabilities"]["tools"])) capabilities.tools = v["capabilities"]["tools"];
    if (isStrArray(v["capabilities"]["input"])) capabilities.input = [...v["capabilities"]["input"]];
    if (isStrArray(v["capabilities"]["output"])) capabilities.output = [...v["capabilities"]["output"]];
    if (Object.keys(capabilities).length > 0) out.capabilities = capabilities;
  }
  const variants = pickVariantArray(v["variants"]);
  if (variants) out.variants = variants;
  const extraVariants = pickVariantArray(v["extraVariants"]);
  if (extraVariants) out.extraVariants = extraVariants;
  if (isBool(v["disabled"])) out.disabled = v["disabled"];
  return out;
}

function mergeOverride(fileV: unknown, ctxV: unknown): ModelOverride | null {
  const f = isRecord(fileV) ? validateOverride(fileV) : null;
  const c = isRecord(ctxV) ? validateOverride(ctxV) : null;
  if (!f && !c) return null;
  const merged: ModelOverride = { ...(f ?? {}), ...(c ?? {}) };
  // per-field merge so a ctx entry can extend (not replace) a file entry
  if (f && c) {
    const lim = { ...f.limit, ...c.limit };
    merged.limit = lim.context !== undefined || lim.output !== undefined ? lim : undefined;
    const cap = { ...f.capabilities, ...c.capabilities };
    merged.capabilities =
      cap.tools !== undefined || cap.input !== undefined || cap.output !== undefined
        ? cap
        : undefined;
    merged.variants = c.variants ?? f.variants;
    merged.extraVariants = c.extraVariants ?? f.extraVariants;
    merged.name = c.name ?? f.name;
    merged.disabled = c.disabled ?? f.disabled;
  }
  return merged;
}

function resolveDefaults(
  fileV: unknown,
  ctxV: unknown,
): ModelDefaults {
  const f = isRecord(fileV) ? fileV : {};
  const c = isRecord(ctxV) ? ctxV : {};
  const leaf = <T>(cv: unknown, fv: unknown, valid: (v: unknown) => v is T, fallback: T): T => {
    if (valid(cv)) return cv;
    if (valid(fv)) return fv;
    return fallback;
  };
  const fl = isRecord(f["limit"]) ? f["limit"] : {};
  const cl = isRecord(c["limit"]) ? c["limit"] : {};
  const fc = isRecord(f["capabilities"]) ? f["capabilities"] : {};
  const cc = isRecord(c["capabilities"]) ? c["capabilities"] : {};
  return {
    limit: {
      context: leaf(cl["context"], fl["context"], isPosInt, BUILTIN_OPTIONS.defaults.limit.context),
      output: leaf(cl["output"], fl["output"], isPosInt, BUILTIN_OPTIONS.defaults.limit.output),
    },
    capabilities: {
      tools: leaf(cc["tools"], fc["tools"], isBool, BUILTIN_OPTIONS.defaults.capabilities.tools),
      input: leaf(cc["input"], fc["input"], isStrArray, BUILTIN_OPTIONS.defaults.capabilities.input),
      output: leaf(cc["output"], fc["output"], isStrArray, BUILTIN_OPTIONS.defaults.capabilities.output),
    },
    variants:
      pickVariantArray(c["variants"]) ??
      pickVariantArray(f["variants"]) ??
      BUILTIN_OPTIONS.defaults.variants,
  };
}

function resolveAliases(fileV: unknown, ctxV: unknown): Record<string, AliasSpec> {
  const f = isRecord(fileV) ? fileV : {};
  const c = isRecord(ctxV) ? ctxV : {};
  const out: Record<string, AliasSpec> = {};
  for (const key of new Set([...Object.keys(f), ...Object.keys(c)])) {
    const raw = key in c ? c[key] : f[key];
    if (isString(raw)) {
      out[key] = raw;
      continue;
    }
    if (isRecord(raw)) {
      if (!isString(raw["model"])) continue;
      const ovr = validateOverride(raw);
      out[key] = {
        ...(ovr ?? {}),
        model: raw["model"],
      };
    }
  }
  return out;
}

function resolveOverrides(fileV: unknown, ctxV: unknown): Record<string, ModelOverride> {
  const f = isRecord(fileV) ? fileV : {};
  const c = isRecord(ctxV) ? ctxV : {};
  const out: Record<string, ModelOverride> = {};
  for (const id of new Set([...Object.keys(f), ...Object.keys(c)])) {
    const merged = mergeOverride(f[id], c[id]);
    if (merged) out[id] = merged;
  }
  return out;
}

/**
 * @param ctxOptions options object from the object-form `plugins` entry
 * @param fileText raw text of the `options.jsonc` sibling of src/index.ts,
 *   or null when the file is absent. Throws on malformed JSONC.
 */
export function resolveOptions(
  ctxOptions: Readonly<Record<string, unknown>> | null | undefined,
  fileText: string | null | undefined,
): Options {
  let file: Record<string, unknown> = {};
  if (fileText != null && fileText.trim() !== "") {
    const parsed: unknown = JSON.parse(stripJsonc(fileText));
    if (!isRecord(parsed)) throw new Error("options file must contain a JSON object");
    file = parsed;
  }
  const ctx = isRecord(ctxOptions) ? ctxOptions : {};
  const pick = <T>(key: string, valid: (v: unknown) => v is T, fallback: T): T => {
    const cv = ctx[key];
    if (cv !== undefined && valid(cv)) return cv;
    const fv = file[key];
    if (fv !== undefined && valid(fv)) return fv;
    return fallback;
  };

  const efforts = file["variantReasoningEfforts"];
  const ctxEfforts = ctx["variantReasoningEfforts"];
  let variantReasoningEfforts: string[] | null = null;
  if (ctxEfforts !== undefined && isStrArray(ctxEfforts)) variantReasoningEfforts = [...ctxEfforts];
  else if (ctxEfforts === null) variantReasoningEfforts = null;
  else if (efforts !== undefined && isStrArray(efforts)) variantReasoningEfforts = [...efforts];

  return {
    providerID: pick("providerID", isString, BUILTIN_OPTIONS.providerID),
    modelsPath: pick("modelsPath", isString, BUILTIN_OPTIONS.modelsPath),
    propsPath: pick("propsPath", isString, BUILTIN_OPTIONS.propsPath),
    includeUnloaded: pick("includeUnloaded", isBool, BUILTIN_OPTIONS.includeUnloaded),
    disableUnloaded: pick("disableUnloaded", isBool, BUILTIN_OPTIONS.disableUnloaded),
    refreshMs: pick("refreshMs", isPosInt, BUILTIN_OPTIONS.refreshMs),
    sse: pick("sse", isBool, BUILTIN_OPTIONS.sse),
    timeoutMs: pick("timeoutMs", isPosInt, BUILTIN_OPTIONS.timeoutMs),
    autoVariants: pick("autoVariants", isBool, BUILTIN_OPTIONS.autoVariants),
    variantReasoningEfforts,
    noThinkVariant: pick("noThinkVariant", isBool, BUILTIN_OPTIONS.noThinkVariant),
    effortProbe: pick("effortProbe", isBool, BUILTIN_OPTIONS.effortProbe),
    defaults: resolveDefaults(file["defaults"], ctx["defaults"]),
    overrides: resolveOverrides(file["overrides"], ctx["overrides"]),
    aliases: resolveAliases(file["aliases"], ctx["aliases"]),
    propsForUnloaded: pick("propsForUnloaded", isPropForUnloaded, BUILTIN_OPTIONS.propsForUnloaded),
    propsCache: pick("propsCache", isBool, BUILTIN_OPTIONS.propsCache),
  };
}
