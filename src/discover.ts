/**
 * Discovery: fetch + defensive parse of GET {baseURL}{modelsPath}.
 *
 * The endpoint is an OpenAI-compatible list enriched with llama.cpp details.
 * Router-mode entries carry `status{value,args,preset}`, `architecture`,
 * `source`, `can_remove`; plain single-instance entries are leaner (no
 * status/architecture; `meta` present). The parser retains a minimal
 * projection only — the verbose `status.preset` TOML (and `args` beyond
 * `--ctx-size` extraction) never survives past this boundary (plan R4).
 */

export interface ModelStatus {
  value: string;
  /** Router-only argv; plain-server entries have no status at all. */
  args: string[];
}

export interface ModelEntry {
  id: string;
  aliases: string[];
  tags: string[];
  /** Unix seconds (list-build time in both modes, not a release date). 0 when absent. */
  created: number;
  /** Absent on plain single-instance servers (the model is loaded by construction). */
  status?: ModelStatus;
  /** Router-only. */
  architecture?: { input_modalities: string[]; output_modalities: string[] };
  /** meta.n_ctx only (plain entries always; router entries while the child runs). */
  meta?: { n_ctx: number };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const strArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

export function parseModelsList(json: unknown): ModelEntry[] | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const data = (json as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) return null;
  const out: ModelEntry[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r["id"] !== "string" || r["id"] === "") continue;
    const e: ModelEntry = {
      id: r["id"],
      aliases: strArray(r["aliases"]) ?? [],
      tags: strArray(r["tags"]) ?? [],
      created:
        typeof r["created"] === "number" && Number.isFinite(r["created"]) ? r["created"] : 0,
    };
    const status = r["status"];
    if (typeof status === "object" && status !== null && !Array.isArray(status)) {
      const s = status as Record<string, unknown>;
      if (typeof s["value"] === "string") {
        e.status = { value: s["value"], args: strArray(s["args"]) ?? [] };
      }
    }
    const arch = r["architecture"];
    if (typeof arch === "object" && arch !== null && !Array.isArray(arch)) {
      const a = arch as Record<string, unknown>;
      const input = strArray(a["input_modalities"]);
      const output = strArray(a["output_modalities"]);
      if (input || output) {
        e.architecture = { input_modalities: input ?? [], output_modalities: output ?? [] };
      }
    }
    const meta = r["meta"];
    if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      if (typeof m["n_ctx"] === "number" && Number.isFinite(m["n_ctx"]) && m["n_ctx"] > 0) {
        e.meta = { n_ctx: m["n_ctx"] };
      }
    }
    out.push(e);
  }
  return out;
}

export interface HttpOutcome {
  /** 0 = network error / timeout (no HTTP response at all). */
  status: number;
  /** Parsed JSON body when the response had a JSON body; null otherwise. */
  json: unknown | null;
}

/**
 * Bounded fetch with timeout. Never throws: network failures and non-JSON
 * bodies all reduce to status/json fields. Response bodies are parsed but
 * only ever read through whitelisting helpers (never logged whole).
 */
export async function fetchHttp(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  init?: { method?: string; body?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<HttpOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: init?.body,
      signal: ac.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // non-JSON body — leave json null
    }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded server error text: `error.message` (or top-level `message`) only. */
export function errorBodyMessage(json: unknown): string {
  if (typeof json === "object" && json !== null && !Array.isArray(json)) {
    const r = json as Record<string, unknown>;
    const err = r["error"];
    if (typeof err === "object" && err !== null) {
      const em = (err as Record<string, unknown>)["message"];
      if (typeof em === "string") return em;
    }
    if (typeof r["message"] === "string") return r["message"];
  }
  return "unknown error";
}

export async function fetchModels(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelEntry[] | null> {
  const out = await fetchHttp(url, headers, timeoutMs, undefined, fetchImpl);
  if (out.status < 200 || out.status >= 300) return null;
  return parseModelsList(out.json);
}

/** `--ctx-size <n>` from a router status argv. null when absent or malformed. */
export function ctxSizeFromArgs(args: readonly string[] | undefined): number | null {
  if (!args) return null;
  const i = args.indexOf("--ctx-size");
  if (i === -1) return null;
  const v = args[i + 1];
  if (typeof v !== "string") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Plain single-instance entries have no `status` field at all: the model is
 * loaded by construction, so props are always available for them.
 */
export function isRunningStatus(e: ModelEntry): boolean {
  if (!e.status) return true;
  return e.status.value === "loaded" || e.status.value === "sleeping";
}

export function isUnloadedStatus(e: ModelEntry): boolean {
  return e.status?.value === "unloaded";
}

/**
 * Which entries get a GET /props call this poll, and with which `autoload`.
 * null = skip (no running child; the 400 would be deterministic).
 */
export function propsCall(
  e: ModelEntry,
  opts: { propsForUnloaded: "never" | "autoload" },
): { autoload: boolean } | null {
  if (isRunningStatus(e)) return { autoload: false };
  if (isUnloadedStatus(e) && opts.propsForUnloaded === "autoload") return { autoload: true };
  return null;
}
