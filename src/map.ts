/**
 * Mapping: (endpoint entry, props projection, options) → Model.Info.
 *
 * Full-coverage mapping per plan §4.3: every Model.Info property is either
 * derived or explicitly left to Model.Info.default() (settings/headers/body/
 * package/family are intentionally not set — reasons in the plan). Mapping
 * is source-agnostic: it cannot tell fresh props from validated cached props
 * (deliberate — option changes re-apply to cached values on the next poll).
 */

import { Model, Provider } from "@opencode/plugin";
import { ctxSizeFromArgs, isUnloadedStatus, type ModelEntry } from "./discover.js";
import type { ModelProps, PropsCache } from "./props.js";
import type { ModelOverride, Options, VariantInput } from "./options.js";

const KNOWN_MEDIA: Record<string, boolean> = { text: true, image: true, video: true, audio: true };

/**
 * §4.2 step 5: this poll's props for an entry — the fresh projection wins
 * over a validated cached entry; null when neither exists. Mapping is
 * deliberately source-agnostic (fresh vs cached is indistinguishable).
 */
export function selectProps(
  id: string,
  fresh: ReadonlyMap<string, ModelProps>,
  cache: PropsCache,
): ModelProps | null {
  return fresh.get(id) ?? cache[id]?.props ?? null;
}

export interface DeriveContext {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The endpoint exposes no display name: prettify the id (spaces, title case). */
export function prettify(id: string): string {
  return id
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ");
}

function knownTypes(modalities: readonly string[]): string[] {
  return [...new Set(modalities.filter((t) => t in KNOWN_MEDIA))];
}

/**
 * Auto-derived variants from a props projection (plan §4.3 emission):
 * one effort variant per level in `effortLevels` (already the distinct
 * rendered classes, vocabulary-ordered, canonical-labeled), optionally
 * restricted by `variantReasoningEfforts`, plus the `no-think` variant when
 * the template supports `enable_thinking`. Every emitted setting is a plain
 * constant — never taken from the template.
 */
export function deriveVariants(p: ModelProps, options: Options): VariantInput[] {
  const out: VariantInput[] = [];
  if (p.caps.supports_reasoning_effort) {
    const restriction = options.variantReasoningEfforts;
    const levels = restriction ? p.effortLevels.filter((l) => restriction.includes(l)) : p.effortLevels;
    for (const level of levels) {
      out.push({
        id: level,
        settings: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: level } },
      });
    }
  }
  if (options.noThinkVariant && p.hasEnableThinking) {
    out.push({ id: "no-think", settings: { chat_template_kwargs: { enable_thinking: false } } });
  }
  return out;
}

/**
 * Merge additive variants: a same-`id` extra replaces the base entry
 * (OpenCode's catalog semantics for same-id variants), others append.
 */
export function mergeExtras(base: readonly VariantInput[], extras: readonly VariantInput[] | undefined): VariantInput[] {
  if (!extras || extras.length === 0) return [...base];
  const out = [...base];
  for (const ex of extras) {
    const i = out.findIndex((v) => v.id === ex.id);
    if (i !== -1) out[i] = { ...ex };
    else out.push({ ...ex });
  }
  return out;
}

export interface DerivedModelInput {
  providerID: string;
  catalogId: string;
  modelID: string;
  name: string;
  variants: readonly VariantInput[];
  releasedMs: number;
  context: number;
  output: number;
  tools: boolean;
  input: readonly string[];
  outputModalities: readonly string[];
  enabled: boolean;
}

/** Build a Model.Info: Model.Info.default() spread, then the table's values. */
export function buildModel(a: DerivedModelInput): Model.Info {
  const providerID = Provider.ID.make(a.providerID);
  const base = Model.Info.default(providerID, Model.ID.make(a.catalogId));
  return {
    ...base,
    id: Model.ID.make(a.catalogId),
    modelID: Model.ID.make(a.modelID),
    providerID,
    name: a.name,
    variants: a.variants.map((v) => ({
      id: Model.VariantID.make(v.id),
      ...(v.settings !== undefined ? { settings: { ...v.settings } } : {}),
      ...(v.headers !== undefined ? { headers: { ...v.headers } } : {}),
      ...(v.body !== undefined ? { body: { ...v.body } } : {}),
    })),
    time: { released: Number.isFinite(a.releasedMs) ? a.releasedMs : 0 },
    cost: [],
    status: "active",
    enabled: a.enabled,
    limit: { context: a.context, output: a.output },
    capabilities: {
      tools: a.tools,
      input: [...a.input],
      output: [...a.outputModalities],
    },
  };
}

export interface AliasInfo {
  catalogId: string;
  /** Effective enabled of the target entry (alias inherits unless overridden). */
  inheritedEnabled: boolean;
}

/**
 * Map one endpoint entry (or an alias re-emission of the target entry).
 * Returns null when the entry is hidden (unloaded + includeUnloaded: false).
 */
export function deriveModel(
  e: ModelEntry,
  p: ModelProps | null,
  options: Options,
  override: ModelOverride | undefined,
  ctx: DeriveContext,
  alias?: AliasInfo,
): Model.Info | null {
  const d = options.defaults;
  if (!alias && isUnloadedStatus(e) && !options.includeUnloaded) return null;

  // limit.context: override ▸ props n_ctx ▸ --ctx-size (router-only) ▸
  // meta.n_ctx ▸ defaults; fresh props vs args disagreement warns, props wins.
  let context: number;
  const argsCtx = e.status ? ctxSizeFromArgs(e.status.args) : null;
  if (override?.limit?.context !== undefined) {
    context = override.limit.context;
  } else if (p !== null && p.n_ctx !== null) {
    context = p.n_ctx;
    if (argsCtx !== null && argsCtx !== context) {
      ctx.warn(
        `"${e.id}": props n_ctx ${context} disagrees with --ctx-size ${argsCtx}; using props (runtime truth)`,
      );
    }
  } else if (argsCtx !== null) {
    context = argsCtx;
  } else if (e.meta?.n_ctx !== undefined) {
    context = e.meta.n_ctx;
  } else {
    context = d.limit.context;
  }
  const output = override?.limit?.output ?? d.limit.output;

  // capabilities
  const tools = override?.capabilities?.tools ?? (p ? p.caps.supports_tools : d.capabilities.tools);
  let input: string[] | null = null;
  if (override?.capabilities?.input) {
    input = [...override.capabilities.input];
  } else if (p) {
    // props modalities first: always text; vision→image, video→video, audio→audio
    input = [
      "text",
      ...(p.modalities.vision ? ["image"] : []),
      ...(p.modalities.video ? ["video"] : []),
      ...(p.modalities.audio ? ["audio"] : []),
    ];
  } else if (e.architecture && e.architecture.input_modalities.length > 0) {
    const v = knownTypes(e.architecture.input_modalities);
    if (v.length > 0) input = v;
  }
  if (input === null) input = [...d.capabilities.input];

  // llama.cpp models are text-output in practice; the router's
  // output_modalities is the only source (router-only field).
  let outputModalities: string[] | null = null;
  if (override?.capabilities?.output) {
    outputModalities = [...override.capabilities.output];
  } else if (e.architecture && e.architecture.output_modalities.length > 0) {
    const v = knownTypes(e.architecture.output_modalities);
    if (v.length > 0) outputModalities = v;
  }
  if (outputModalities === null) outputModalities = [...d.capabilities.output];

  // variants: explicit ▸ auto-derived (autoVariants && props) ▸ defaults;
  // extraVariants merged in either way.
  const baseVariants: VariantInput[] =
    override?.variants ?? (options.autoVariants && p ? deriveVariants(p, options) : [...d.variants]);
  const variants = mergeExtras(baseVariants, override?.extraVariants);

  // enabled (§4.5): override wins when explicit (both true and false);
  // unloaded policy applies to status "unloaded" only (transient states stay
  // selectable); aliases inherit the target's effective enabled.
  let enabled: boolean;
  if (override?.disabled === true) {
    enabled = false;
  } else if (override?.disabled === false) {
    enabled = true;
  } else if (alias) {
    enabled = alias.inheritedEnabled;
  } else {
    enabled = !(isUnloadedStatus(e) && options.disableUnloaded);
  }

  return buildModel({
    providerID: options.providerID,
    catalogId: alias?.catalogId ?? e.id,
    modelID: e.id,
    name: override?.name ?? prettify(alias?.catalogId ?? e.id),
    variants,
    releasedMs: e.created * 1000,
    context,
    output,
    tools,
    input,
    outputModalities,
    enabled,
  });
}

/**
 * Build the full inventory: discovered entries in list order, then aliases
 * (plan §4.3). Aliases are additional catalog entries for the same model —
 * discovered ids are never renamed. An alias is skipped when its target is
 * absent this poll (one warn); an alias key colliding with a discovered id
 * is rejected (one error).
 */
export function buildInventory(
  entries: readonly ModelEntry[],
  props: ReadonlyMap<string, ModelProps>,
  options: Options,
  ctx: DeriveContext,
): Model.Info[] {
  const models: Model.Info[] = [];
  const mapped = new Map<string, { entry: ModelEntry; info: Model.Info }>();
  for (const e of entries) {
    const info = deriveModel(e, props.get(e.id) ?? null, options, options.overrides[e.id], ctx);
    if (info) {
      models.push(info);
      mapped.set(e.id, { entry: e, info });
    }
  }
  for (const [aliasKey, spec] of Object.entries(options.aliases)) {
    const targetId = typeof spec === "string" ? spec : spec.model;
    if (entries.some((e) => e.id === aliasKey)) {
      ctx.error(`alias "${aliasKey}": collides with a discovered model id; rejected`);
      continue;
    }
    const target = mapped.get(targetId);
    if (!target) {
      ctx.warn(`alias "${aliasKey}": target "${targetId}" not in the current model list; skipping`);
      continue;
    }
    const ovr = typeof spec === "string" ? undefined : spec;
    const info = deriveModel(target.entry, props.get(targetId) ?? null, options, ovr, ctx, {
      catalogId: aliasKey,
      inheritedEnabled: target.info.enabled,
    });
    if (info) models.push(info);
  }
  return models;
}
