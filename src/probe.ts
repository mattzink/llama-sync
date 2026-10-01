/**
 * One-time behavioral probe: POST /apply-template (no inference) renders the
 * model's chat template with a `reasoning_effort` kwarg, which reveals which
 * levels the template actually maps — literal presence in the jinja is not
 * support (plan §2.2, §4.3).
 *
 * Hygiene (plan §2.2.1): only the sha256 of the rendered `prompt` field is
 * kept (computed in memory, never logged); HTTP 400/500 bodies embed jinja
 * source snippets and are discarded — probe failures reduce to booleans.
 */

import { sha256Hex } from "./hash.js";
import { fetchHttp, isRecord } from "./discover.js";
import { EFFORT_VOCAB, orderLevels, type EffortSignals } from "./props.js";

export type ProbeClass = "mapped" | "default-alias" | "rejected";

export interface ClassifiedLevel {
  level: string;
  cls: ProbeClass;
  /** sha256 of the rendered prompt (mapped / default-alias classes only). */
  promptHash?: string;
}

/**
 * Candidate levels for the probe, in the fixed vocabulary order
 * (minimal, low, medium, high, xhigh, max) with template-specific
 * comparison literals appended after it, alphabetically.
 */
export function probeCandidateLevels(signals: EffortSignals): string[] {
  return orderLevels([...EFFORT_VOCAB, ...signals.comparisons]);
}

/**
 * Pure render classification.
 *
 * `outcomes` maps each probed level to its rendered-prompt sha256, or
 * "rejected" for HTTP 400/500 (template `raise_exception`).
 *
 * Emission: one variant per distinct rendered class, in vocabulary order,
 * labeled by the class member that (a) is in the acceptance guard, else
 * (b) is the default level, else (c) is last in vocabulary order — so an
 * alias class emits the canonical level (`{high, xhigh}` → `xhigh`), never
 * the alias.
 */
export function classifyProbe(
  outcomes: ReadonlyMap<string, string | "rejected">,
  baselineHash: string,
  signals: EffortSignals,
): string[] {
  const classes = new Map<string, string[]>();
  for (const [level, o] of outcomes) {
    if (o === "rejected") continue;
    const members = classes.get(o) ?? [];
    members.push(level);
    classes.set(o, members);
  }
  const emitted: string[] = [];
  for (const [hash, members] of classes) {
    const ordered = orderLevels(members);
    let label: string | undefined;
    for (const l of ordered) {
      if (signals.guard.includes(l)) {
        label = l;
        break;
      }
    }
    if (label === undefined && signals.defaultLevel !== null) {
      const i = ordered.indexOf(signals.defaultLevel);
      if (i !== -1) label = ordered[i]!;
    }
    if (label === undefined) label = ordered[ordered.length - 1] ?? ordered[0]!;
    emitted.push(label);
  }
  return orderLevels(emitted);
}

export interface ProbeRequest {
  /** Full URL of POST /apply-template (root URL + path). */
  url: string;
  headers: Record<string, string>;
  modelId: string;
  levels: string[];
  signals: EffortSignals;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export type ProbeRunResult =
  | { status: "success"; emitted: string[] }
  /** 404/405 — the endpoint does not exist on this service; do not retry. */
  | { status: "unsupported" }
  /** Transient failure (network, other status, unparsable body): retry next poll. */
  | { status: "failed" };

interface RenderOutcome {
  hash: string | null;
  rejected: boolean;
  unsupported: boolean;
  failed: boolean;
}

const PROBE_MESSAGES = [{ role: "user", content: "hello" }] as const;

async function render(
  req: ProbeRequest,
  chatTemplateKwargs: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<RenderOutcome> {
  const body = JSON.stringify({
    model: req.modelId,
    messages: PROBE_MESSAGES,
    chat_template_kwargs: chatTemplateKwargs,
  });
  const out = await fetchHttp(req.url, req.headers, req.timeoutMs, { method: "POST", body }, fetchImpl);
  if (out.status === 404 || out.status === 405) {
    return { hash: null, rejected: false, unsupported: true, failed: false };
  }
  if (out.status === 400 || out.status === 500) {
    // Template raise_exception — body discarded (it embeds a jinja snippet).
    return { hash: null, rejected: true, unsupported: false, failed: false };
  }
  if (out.status === 0 || out.status < 200 || out.status >= 300) {
    return { hash: null, rejected: false, unsupported: false, failed: true };
  }
  const prompt = isRecord(out.json) ? out.json["prompt"] : undefined;
  if (typeof prompt !== "string") {
    return { hash: null, rejected: false, unsupported: false, failed: true };
  }
  return { hash: sha256Hex(prompt), rejected: false, unsupported: false, failed: false };
}

/**
 * Run the probe: a baseline render without `reasoning_effort` plus one
 * render per candidate level, all with `enable_thinking: true`.
 */
export async function runEffortProbe(req: ProbeRequest): Promise<ProbeRunResult> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const baseline = await render(req, { enable_thinking: true }, fetchImpl);
  if (baseline.unsupported) return { status: "unsupported" };
  if (baseline.failed || baseline.hash === null) return { status: "failed" };
  const outcomes = new Map<string, string | "rejected">();
  for (const level of req.levels) {
    const r = await render(req, { enable_thinking: true, reasoning_effort: level }, fetchImpl);
    if (r.unsupported) return { status: "unsupported" };
    if (r.failed) return { status: "failed" };
    outcomes.set(level, r.rejected ? "rejected" : r.hash!);
  }
  return { status: "success", emitted: classifyProbe(outcomes, baseline.hash, req.signals) };
}

/** Exposed for tests: build the expected classification of a level set. */
export function classifyLevels(
  hashes: ReadonlyMap<string, string | "rejected">,
  baselineHash: string,
  signals: EffortSignals,
): ClassifiedLevel[] {
  const out: ClassifiedLevel[] = [];
  for (const [level, o] of hashes) {
    if (o === "rejected") out.push({ level, cls: "rejected" });
    else out.push({ level, cls: o === baselineHash ? "default-alias" : "mapped", promptHash: o });
  }
  return out.sort((a, b) => (a.level < b.level ? -1 : a.level > b.level ? 1 : 0));
}
