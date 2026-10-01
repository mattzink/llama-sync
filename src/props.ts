/**
 * Per-model properties: fetch + whitelist parse of GET /props.
 *
 * The `chat_template` field is the model's raw jinja prompt and an
 * LLM-context hazard (plan §2.2.1): this module reads it in place for a few
 * bounded signals (sha256 digest, enable_thinking presence, static
 * reasoning-effort candidates) and discards it. No template text — and no
 * `media_marker` — ever survives parseProps, so none of it can reach
 * storage, the inventory, logs, or error messages.
 *
 * Also holds the pure props-cache merge/evict/validate helpers (plan §4.2
 * step 4); the ctx.storage plumbing lives in index.ts.
 */

import { sha256Hex, stableStringify } from "./hash.js";
import { errorBodyMessage, fetchHttp, isRecord } from "./discover.js";

const CAP_KEYS = [
  "supports_tools",
  "supports_tool_calls",
  "supports_parallel_tool_calls",
  "supports_object_arguments",
  "supports_reasoning_effort",
  "supports_preserve_reasoning",
  "supports_system_role",
  "supports_string_content",
  "supports_typed_content",
] as const;

export type ChatTemplateCap = (typeof CAP_KEYS)[number];

export interface ChatTemplateCaps {
  supports_tools: boolean;
  supports_tool_calls: boolean;
  supports_parallel_tool_calls: boolean;
  supports_object_arguments: boolean;
  supports_reasoning_effort: boolean;
  supports_preserve_reasoning: boolean;
  supports_system_role: boolean;
  supports_string_content: boolean;
  supports_typed_content: boolean;
}

/**
 * Static (pattern-read) signals from the chat template, computed in place.
 * Bounded: tuple literals and level names only — never template text.
 */
export interface EffortSignals {
  /** Literals of the acceptance guard (`not in (…) … raise_exception`), in template order. */
  guard: string[];
  /** Value of `reasoning_effort|default('…')`, when present. */
  defaultLevel: string | null;
  /** Literals in `… == '…'` comparisons around `reasoning_effort` (may include aliases). */
  comparisons: string[];
}

export interface PropsBase {
  /** default_generation_settings.n_ctx — authoritative context limit. */
  n_ctx: number | null;
  caps: ChatTemplateCaps;
  modalities: { vision: boolean; video: boolean; audio: boolean };
  is_sleeping: boolean;
  /** sha256 of the raw chat_template (64 hex; "" template hashes the empty string). */
  templateHash: string;
  hasEnableThinking: boolean;
  effort: EffortSignals;
}

export type EffortSource = "probe" | "static";

export interface ModelProps extends PropsBase {
  /** Effort levels derived for `templateHash`, in vocabulary order. */
  effortLevels: string[];
  /** How `effortLevels` were derived ("probe" = behavioral render probe). */
  effortSource: EffortSource;
  /** POST /apply-template returned 404/405 — the endpoint does not exist; do not retry. */
  probeUnsupported?: boolean;
}

export interface PropsCacheEntry {
  at: number;
  props: ModelProps;
}

export type PropsCache = Record<string, PropsCacheEntry>;

export const EMPTY_SIGNALS: EffortSignals = { guard: [], defaultLevel: null, comparisons: [] };

/** Fixed effort vocabulary, in probe/emit order. */
export const EFFORT_VOCAB: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Dedup + order: fixed vocabulary first (in vocabulary order), then unknowns alphabetically. */
export function orderLevels(levels: readonly string[]): string[] {
  const set = [...new Set(levels)];
  const known = EFFORT_VOCAB.filter((v) => set.includes(v));
  const extra = set.filter((v) => !EFFORT_VOCAB.includes(v)).sort();
  return [...known, ...extra];
}

/**
 * Static stand-in for the behavioral probe: the acceptance guard is the
 * template's declared supported set; without a guard, comparison literals
 * are the best available (degraded mode, plan §4.3).
 */
export function staticEffortLevels(signals: EffortSignals): string[] {
  const set = signals.guard.length > 0 ? signals.guard : signals.comparisons;
  return orderLevels(set);
}

function tupleLiterals(tuple: string): string[] {
  const out: string[] = [];
  for (const m of tuple.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    const v = m[1] ?? m[2];
    if (typeof v === "string" && v !== "") out.push(v);
  }
  return out;
}

const RAISE_RE = /\braise(?:_exception)?\s*\(/;
/** Jinja block end: `endif` (Jinja) or `end if` (spaced forms). */
const END_IF_RE = /\b(?:end\s+if|endif)\b/;

function findGuard(template: string, re: RegExp): string[] {
  for (const m of template.matchAll(re)) {
    const idx = m.index ?? 0;
    const before = template.slice(Math.max(0, idx - 160), idx);
    if (!/reasoning_effort/.test(before)) continue;
    const after = template.slice(idx + m[0].length, idx + m[0].length + 400);
    const block = after.split(END_IF_RE)[0] ?? "";
    if (!RAISE_RE.test(block)) continue;
    const lits = tupleLiterals(m[1] ?? "");
    if (lits.length > 0) return lits;
  }
  return [];
}

/**
 * In-place bounded reads of the template (no template text retained):
 *  1. acceptance guard — literals of a `not in (…)` (or `not (… in (…))`)
 *     guard whose block calls `raise_exception` — the template's declared
 *     supported set;
 *  2. default level — `reasoning_effort|default('…')`;
 *  3. comparison literals — `… == '…'` around `reasoning_effort` (includes
 *     aliases like `'high'` — candidates, not answers).
 */
export function extractEffortSignals(template: string): EffortSignals {
  let guard = findGuard(template, /\bnot\s+in\s*\(([^()]*)\)/g);
  if (guard.length === 0) {
    for (const m of template.matchAll(/\bin\s*\(([^()]*)\)/g)) {
      const idx = m.index ?? 0;
      const before = template.slice(Math.max(0, idx - 160), idx);
      if (!/reasoning_effort/.test(before) || !/\bnot\b/.test(before)) continue;
      const after = template.slice(idx + m[0].length, idx + m[0].length + 400);
      const block = after.split(END_IF_RE)[0] ?? "";
      if (!RAISE_RE.test(block)) continue;
      const lits = tupleLiterals(m[1] ?? "");
      if (lits.length > 0) {
        guard = lits;
        break;
      }
    }
  }
  let defaultLevel: string | null = null;
  const dm =
    template.match(/\breasoning_effort\s*\|\s*default\(\s*'([^']*)'\s*\)/) ??
    template.match(/\breasoning_effort\s*\|\s*default\(\s*"([^"]*)"\s*\)/);
  if (dm && dm[1]) defaultLevel = dm[1];
  const comparisons: string[] = [];
  const push = (v?: string) => {
    if (v && v !== "" && !comparisons.includes(v)) comparisons.push(v);
  };
  for (const m of template.matchAll(/\breasoning_effort\s*==\s*'([^']*)'/g)) push(m[1]);
  for (const m of template.matchAll(/\breasoning_effort\s*==\s*"([^"]*)"/g)) push(m[1]);
  for (const m of template.matchAll(/'([^']*)'\s*==\s*reasoning_effort\b/g)) push(m[1]);
  for (const m of template.matchAll(/"([^"]*)"\s*==\s*reasoning_effort\b/g)) push(m[1]);
  return { guard, defaultLevel, comparisons };
}

function parseCaps(v: unknown): ChatTemplateCaps {
  const src = isRecord(v) ? v : {};
  const caps = {} as ChatTemplateCaps;
  for (const k of CAP_KEYS) caps[k] = src[k] === true;
  return caps;
}

/**
 * Whitelist projection of a /props response. Returns null when the body is
 * not a usable object; missing sub-objects degrade to safe defaults
 * (caps false, modalities false, n_ctx null).
 */
export function parseProps(json: unknown): PropsBase | null {
  if (!isRecord(json)) return null;
  const dgs = isRecord(json["default_generation_settings"]) ? json["default_generation_settings"] : null;
  const n_ctx =
    dgs && typeof dgs["n_ctx"] === "number" && Number.isFinite(dgs["n_ctx"]) && dgs["n_ctx"] > 0
      ? dgs["n_ctx"]
      : null;
  const mod = isRecord(json["modalities"]) ? json["modalities"] : {};
  const template = typeof json["chat_template"] === "string" ? json["chat_template"] : null;
  const caps = parseCaps(json["chat_template_caps"]);
  return {
    n_ctx,
    caps,
    modalities: {
      vision: mod["vision"] === true,
      video: mod["video"] === true,
      audio: mod["audio"] === true,
    },
    is_sleeping: json["is_sleeping"] === true,
    templateHash: sha256Hex(template ?? ""),
    hasEnableThinking: template !== null && template.includes("enable_thinking"),
    effort:
      caps.supports_reasoning_effort && template !== null
        ? extractEffortSignals(template)
        : EMPTY_SIGNALS,
  };
}

export interface PropsFetchResult {
  props: PropsBase | null;
  /** Bounded failure text (HTTP status + server error.message only). */
  error: string | null;
}

export async function fetchProps(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PropsFetchResult> {
  const out = await fetchHttp(url, headers, timeoutMs, undefined, fetchImpl);
  if (out.status >= 200 && out.status < 300) {
    const props = parseProps(out.json);
    if (props) return { props, error: null };
    return { props: null, error: "unparseable props response" };
  }
  if (out.status === 0) return { props: null, error: "network error or timeout" };
  return { props: null, error: `HTTP ${out.status}: ${errorBodyMessage(out.json)}` };
}

// ---------------------------------------------------------------------------
// Pure props-cache helpers (plan §4.2 step 4)
// ---------------------------------------------------------------------------

/** Content equality of two projections (the cache `at` timestamp is excluded). */
export function propsEqual(a: ModelProps, b: ModelProps): boolean {
  return stableStringify(a) === stableStringify(b);
}

export type ProbeOutcome =
  | { kind: "success"; levels: string[] }
  | { kind: "unsupported" }
  | { kind: "failed" };

/**
 * Whether the behavioral probe should run this poll. All must hold:
 * `effortProbe` on, the template supports reasoning effort, the fresh props
 * say the model is not sleeping (the endpoint is not wake-exempt — a
 * sleeping model keeps the static stand-in this poll), and at least one of:
 * no cache entry; template digest changed; the cached levels are a static
 * stand-in without `probeUnsupported` (what re-runs the probe on next load).
 */
export function shouldProbe(
  base: PropsBase,
  cached: ModelProps | undefined,
  effortProbe: boolean,
): boolean {
  if (!effortProbe || !base.caps.supports_reasoning_effort || base.is_sleeping) return false;
  if (!cached) return true;
  if (cached.templateHash !== base.templateHash) return true;
  return cached.effortSource === "static" && !cached.probeUnsupported;
}

/**
 * Resolve this poll's effort fields from the probe outcome (or its absence).
 * Invariant kept: the resulting effortLevels are always the ones derived for
 * the base's templateHash.
 */
export function resolveEffort(
  base: PropsBase,
  cached: ModelProps | undefined,
  outcome: ProbeOutcome | null,
): Pick<ModelProps, "effortLevels" | "effortSource" | "probeUnsupported"> {
  if (outcome && outcome.kind === "success") {
    return { effortLevels: outcome.levels, effortSource: "probe" };
  }
  if (outcome && outcome.kind === "unsupported") {
    return { effortLevels: staticEffortLevels(base.effort), effortSource: "static", probeUnsupported: true };
  }
  // outcome null (probe gated/skipped) or "failed" (transient): reuse the
  // cache when it is consistent with this digest, else stand in with static.
  if (cached && cached.templateHash === base.templateHash) {
    if (cached.effortSource === "probe") {
      return { effortLevels: cached.effortLevels, effortSource: "probe" };
    }
    if (cached.probeUnsupported) {
      return {
        effortLevels: cached.effortLevels,
        effortSource: "static",
        probeUnsupported: true,
      };
    }
  }
  return { effortLevels: staticEffortLevels(base.effort), effortSource: "static" };
}

/**
 * Evict entries whose id is absent from this poll's /models list, and drop
 * entries whose cached n_ctx no longer matches the model's `--ctx-size` arg
 * (the preset was repointed). The guard is inert when `status.args` is
 * absent (plain servers: a model swap changes the id and eviction handles it).
 *
 * `ctxSizes` maps every live id to its parsed `--ctx-size` (null when absent).
 */
export function evictAndValidate(
  cache: PropsCache,
  ctxSizes: ReadonlyMap<string, number | null>,
): { cache: PropsCache; dirty: boolean } {
  let dirty = false;
  const next: PropsCache = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (!ctxSizes.has(id)) {
      dirty = true;
      continue;
    }
    const ctxSize = ctxSizes.get(id) ?? null;
    if (ctxSize !== null && entry.props.n_ctx !== null && entry.props.n_ctx !== ctxSize) {
      dirty = true;
      continue;
    }
    next[id] = entry;
  }
  return { cache: next, dirty };
}
