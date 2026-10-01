import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Stable JSON stringify: object keys sorted recursively, array order kept.
 * Non-finite numbers and undefined are normalized to null. The input is
 * expected to be a JSON-shaped value (the mapped inventory projection).
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
    return `{${parts.join(",")}}`;
  }
  return "null";
}

/**
 * Structural view of a mapped model that the change-detection hash reads.
 * Deliberately smaller than Model.Info: the hash must track inventory state
 * (which models exist, with which limits/capabilities/variants/enabled) and
 * nothing else.
 */
export interface HashableModel {
  id: string;
  limit: { context: number; input?: number; output: number };
  capabilities: { tools: boolean; input: readonly string[]; output: readonly string[] };
  variants: ReadonlyArray<{
    id: string;
    settings?: unknown;
    headers?: Record<string, string>;
    body?: unknown;
  }>;
  enabled: boolean;
}

/**
 * Per-model projection hashed by canonicalHash:
 * [id, limit, capabilities, variants, enabled] — the jinja template is gone
 * by construction (dropped at the props parse boundary) and `at`-style
 * timestamps never reach a mapped model, so neither can enter the hash.
 */
function projection(m: HashableModel): unknown {
  return {
    id: m.id,
    limit: {
      context: m.limit.context,
      input: m.limit.input ?? null,
      output: m.limit.output,
    },
    capabilities: {
      tools: m.capabilities.tools,
      input: [...m.capabilities.input].sort(),
      output: [...m.capabilities.output].sort(),
    },
    variants: m.variants
      .map((v) => ({
        id: v.id,
        settings: v.settings ?? null,
        headers: v.headers ?? null,
        body: v.body ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    enabled: m.enabled,
  };
}

export function canonicalHash(models: readonly HashableModel[]): string {
  const sorted = [...models]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(projection);
  return sha256Hex(stableStringify(sorted));
}
