/**
 * llama-sync — OpenCode V2 plugin: dynamic model inventory for a llama.cpp
 * provider (router or plain single-instance server) driven by GET /models
 * (+ GET /props for capabilities) with router SSE for change detection.
 *
 * Lifecycle (plan §5):
 *   1. resolve options (ctx.options ▸ options.jsonc sibling ▸ built-ins)
 *   2. read the stored inventory (previous run's output — the seed source)
 *   3. register the provider transform with the seed source (must exist
 *      before the first refresh publishes anything)
 *   4. first refresh (regardless of outcome)
 *   5. open SSE (router only; 404/405 → disabled for the plugin's life)
 *   6. safety-net poll timer
 *   7. on config reload / plugin dispose: clear timer, close SSE
 *
 * Publishing: the inventory is republished only when its canonical hash
 * (id/limit/capabilities/variants/enabled projection) changes, then stored
 * (ctx.storage) and announced via ctx.provider.reload().
 */

import { readFileSync } from "node:fs";
import { Plugin, Provider, type Model } from "@opencode/plugin";
import {
  ctxSizeFromArgs,
  fetchModels,
  propsCall,
  isRecord,
  type ModelEntry,
} from "./discover.js";
import { canonicalHash, type HashableModel } from "./hash.js";
import {
  buildInventory,
  selectProps,
  type DeriveContext,
} from "./map.js";
import { BUILTIN_OPTIONS, resolveOptions, type Options } from "./options.js";
import {
  evictAndValidate,
  fetchProps,
  propsEqual,
  resolveEffort,
  shouldProbe,
  type ModelProps,
  type PropsBase,
  type PropsCache,
  type ProbeOutcome,
} from "./props.js";
import { probeCandidateLevels, runEffortProbe } from "./probe.js";
import {
  backoffDelay,
  connectOutcome,
  createFrameParser,
  createScheduler,
  parseSseEvent,
} from "./sse.js";

const TAG = "[llama-sync]";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** {baseURL} + path, with duplicate slashes collapsed (trailing /v1 kept). */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

/**
 * llama.cpp registers /props, POST /apply-template and /models/sse at the
 * server root; a baseURL configured with a trailing /v1 must be stripped for
 * those endpoints (plan §2.3, §2.8).
 */
function rootUrl(base: string): string {
  return base.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

/** options.jsonc sibling of src/index.ts (published in the npm package). */
function readOptionsFile(): string | null {
  try {
    return readFileSync(new URL("./options.jsonc", import.meta.url), "utf8");
  } catch {
    return null;
  }
}

interface StoredInventory {
  hash: string;
  models: unknown[];
  at: number;
}

/** The value type of ctx.storage.set — structural JSON (no effect import needed). */
type JsonValue = Parameters<Plugin.Context["storage"]["set"]>[1];

async function loadStored(ctx: Plugin.Context): Promise<Model.Info[]> {
  try {
    const v = await ctx.storage.get("inventory");
    if (isRecord(v) && Array.isArray(v["models"])) {
      return v["models"] as Model.Info[];
    }
  } catch (e) {
    console.warn(`${TAG} could not read stored inventory: ${errorMessage(e)}`);
  }
  return [];
}

async function loadPropsCache(ctx: Plugin.Context, warn: (msg: string) => void): Promise<PropsCache> {
  try {
    const v = await ctx.storage.get("props-cache");
    if (isRecord(v)) {
      const out: PropsCache = {};
      for (const [id, raw] of Object.entries(v)) {
        if (isRecord(raw) && isRecord(raw["props"])) {
          out[id] = {
            at: typeof raw["at"] === "number" ? raw["at"] : 0,
            props: raw["props"] as unknown as ModelProps,
          };
        }
      }
      return out;
    }
  } catch (e) {
    warn(`could not read props cache: ${errorMessage(e)}`);
  }
  return {};
}

/** Bounded fan-out helper for props fetches (concurrency 2 per plan §4.2). */
async function runPool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const n = Math.min(size, items.length);
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

export default Plugin.define({
  id: "llama-sync",
  async setup(ctx) {
    const warn = (msg: string) => console.warn(`${TAG} ${msg}`);
    const error = (msg: string) => console.error(`${TAG} ${msg}`);

    // --- options -----------------------------------------------------------
    let fileText: string | null;
    try {
      fileText = readOptionsFile();
    } catch (e) {
      error(`could not read options.jsonc: ${errorMessage(e)}`);
      fileText = null;
    }
    let opts: Options;
    try {
      opts = resolveOptions(ctx.options, fileText);
    } catch (e) {
      error(`options.jsonc is malformed (${errorMessage(e)}); using ctx.options + built-in defaults`);
      opts = resolveOptions(ctx.options, null);
    }
    const dctx: DeriveContext = { warn, error };

    // --- seed source (previous run's stored inventory) ----------------------
    const seed: Model.Info[] = await loadStored(ctx);
    let lastHash: string | null = canonicalHash(seed);
    const source = { models: seed };

    // transform registration MUST precede the first refresh: the editor
    // closure reads `source.models`, and a mid-refresh publish must never
    // race an unregistered transform (plan §5).
    await ctx.provider.transform((editor) => {
      editor.models.set(opts.providerID, source.models);
    });

    // --- provider lookup ----------------------------------------------------
    let providerMissingWarned = false;
    const readProvider = async (): Promise<{ baseURL: string; headers: Record<string, string> } | null> => {
      try {
        const res = await ctx.provider.get({ providerID: Provider.ID.make(opts.providerID) });
        const data = res.data;
        const settings = isRecord(data.settings) ? data.settings : {};
        const baseURL =
          typeof settings["baseURL"] === "string" && settings["baseURL"] !== ""
            ? (settings["baseURL"] as string)
            : null;
        if (!baseURL) return null;
        const headers: Record<string, string> = {};
        if (isRecord(data.headers)) {
          for (const [k, v] of Object.entries(data.headers)) {
            if (typeof v === "string") headers[k] = v;
          }
        }
        return { baseURL, headers };
      } catch {
        return null;
      }
    };

    // --- refresh ------------------------------------------------------------
    let inFlight = false;
    let pendingRefresh = false;

    const refresh = async (): Promise<void> => {
      if (inFlight) {
        pendingRefresh = true;
        return;
      }
      inFlight = true;
      try {
        const prov = await readProvider();
        if (!prov) {
          if (!providerMissingWarned) {
            error(`provider "${opts.providerID}" not found or has no settings.baseURL; plugin is inert`);
            providerMissingWarned = true;
          }
          return;
        }

        // 1. model list
        const listUrl = joinUrl(prov.baseURL, opts.modelsPath);
        const fetched = await fetchModels(listUrl, prov.headers, opts.timeoutMs);
        if (fetched === null) {
          warn(`GET ${listUrl} failed; keeping last good inventory`);
          return;
        }

        // 2. props for eligible entries (concurrency 2)
        const root = rootUrl(prov.baseURL);
        const persisted: PropsCache = opts.propsCache ? await loadPropsCache(ctx, warn) : {};
        const freshBase = new Map<string, PropsBase>();
        const freshProps = new Map<string, ModelProps>();
        const calls: { entry: ModelEntry; url: string }[] = [];
        for (const e of fetched) {
          const call = propsCall(e, opts);
          if (!call) continue;
          const autoload = call.autoload ? "true" : "false";
          calls.push({
            entry: e,
            url: `${joinUrl(root, opts.propsPath)}?model=${encodeURIComponent(e.id)}&autoload=${autoload}`,
          });
        }
        await runPool(calls, 2, async (c) => {
          const res = await fetchProps(c.url, prov.headers, opts.timeoutMs);
          if (res.props) freshBase.set(c.entry.id, res.props);
          else warn(`props for "${c.entry.id}": ${res.error}`);
        });

        // 3. effort resolution: probe where due (plan §4.3), bounded
        //    concurrency 2 like the props fetches
        const probeUrl = joinUrl(root, "/apply-template");
        const freshIds: ModelEntry[] = [];
        const toProbe: ModelEntry[] = [];
        for (const e of fetched) {
          const base = freshBase.get(e.id);
          if (!base) continue;
          freshIds.push(e);
          if (shouldProbe(base, persisted[e.id]?.props, opts.effortProbe)) toProbe.push(e);
        }
        const probeOutcomes = new Map<string, ProbeOutcome>();
        await runPool(toProbe, 2, async (e) => {
          const base = freshBase.get(e.id)!;
          const result = await runEffortProbe({
            url: probeUrl,
            headers: prov.headers,
            modelId: e.id,
            levels: probeCandidateLevels(base.effort),
            signals: base.effort,
            timeoutMs: opts.timeoutMs,
          });
          probeOutcomes.set(
            e.id,
            result.status === "success"
              ? { kind: "success", levels: result.emitted }
              : result.status === "unsupported"
                ? { kind: "unsupported" }
                : { kind: "failed" },
          );
        });
        for (const e of freshIds) {
          const base = freshBase.get(e.id)!;
          const cached = persisted[e.id]?.props;
          const outcome = shouldProbe(base, cached, opts.effortProbe) ? (probeOutcomes.get(e.id) ?? null) : null;
          freshProps.set(e.id, { ...base, ...resolveEffort(base, cached, outcome) });
        }

        // 4. props cache: write fresh, then evict/validate (plan §4.2 step 4)
        let dirty = false;
        const now = Date.now();
        for (const [id, props] of freshProps) {
          const old = persisted[id];
          if (!old || !propsEqual(old.props, props)) {
            persisted[id] = { at: now, props };
            dirty = true;
          }
        }
        const ctxSizes = new Map<string, number | null>();
        for (const e of fetched) ctxSizes.set(e.id, e.status ? ctxSizeFromArgs(e.status.args) : null);
        const validated = evictAndValidate(persisted, ctxSizes);
        if (validated.dirty) dirty = true;
        const cache = validated.cache;
        if (dirty && opts.propsCache) {
          try {
            await ctx.storage.set("props-cache", cache as unknown as JsonValue);
          } catch (e) {
            warn(`could not persist props cache: ${errorMessage(e)}`);
          }
        }

        // 5. map + publish on change only
        const propsFor = new Map<string, ModelProps>();
        for (const e of fetched) {
          const p = selectProps(e.id, freshProps, cache);
          if (p) propsFor.set(e.id, p);
        }
        const models = buildInventory(fetched, propsFor, opts, dctx);
        const hash = canonicalHash(models);
        if (hash === lastHash) return;
        lastHash = hash;
        source.models = models;
        try {
          const stored: StoredInventory = { hash, models, at: now };
          await ctx.storage.set("inventory", stored as unknown as JsonValue);
        } catch (e) {
          warn(`could not persist inventory: ${errorMessage(e)}`);
        }
        await ctx.provider.reload();
        console.log(`${TAG} published ${models.length} model(s)`);
      } catch (e) {
        error(`refresh failed: ${errorMessage(e)}`);
      } finally {
        inFlight = false;
        if (pendingRefresh) {
          pendingRefresh = false;
          void refresh().catch((e) => error(`refresh failed: ${errorMessage(e)}`));
        }
      }
    };

    // --- SSE (after the first refresh attempt, per plan §5) ------------------
    const scheduler = createScheduler({
      now: () => Date.now(),
      run: () => refresh(),
    });
    let sseClosed = false;
    let sseAttempts = 0;
    let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let sseAbort: AbortController | null = null;

    const sseConnect = async (): Promise<void> => {
      if (sseClosed) return;
      const prov = await readProvider();
      if (!prov) {
        sseScheduleRetry();
        return;
      }
      const ac = new AbortController();
      sseAbort = ac;
      try {
        const res = await fetch(joinUrl(rootUrl(prov.baseURL), "/models/sse"), {
          headers: { accept: "text/event-stream", ...prov.headers },
          signal: ac.signal,
        });
        const outcome = connectOutcome(res.status, res.headers.get("content-type"));
        if (outcome === "disabled") {
          warn(`GET /models/sse returned HTTP ${res.status}; SSE disabled for this service (polling continues)`);
          return;
        }
        if (outcome !== "open" || !res.body) {
          if (!sseClosed) warn(`SSE connect failed (HTTP ${res.status}); retrying`);
          sseScheduleRetry();
          return;
        }
        sseAttempts = 0;
        // (re)connect is a change signal: one catch-up refresh
        scheduler.request();
        const parser = createFrameParser();
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          if (sseClosed) break;
          const payloads = parser.feed(decoder.decode(chunk, { stream: true }));
          for (const payload of payloads) {
            if (parseSseEvent(payload)) scheduler.request();
          }
        }
        if (!sseClosed) sseScheduleRetry(); // clean end → reconnect
      } catch (e) {
        if (!sseClosed && ac.signal.aborted === false) sseScheduleRetry();
      }
    };

    const sseScheduleRetry = (): void => {
      if (sseClosed) return;
      sseAttempts += 1;
      if (sseAttempts === 1) warn("SSE stream closed; reconnecting");
      sseRetryTimer = setTimeout(() => {
        void sseConnect();
      }, backoffDelay(sseAttempts));
    };

    const firstRefresh = refresh().catch((e) => error(`refresh failed: ${errorMessage(e)}`));
    await firstRefresh;
    if (opts.sse) void sseConnect();

    const timer = setInterval(() => {
      void refresh().catch((e) => error(`refresh failed: ${errorMessage(e)}`));
    }, opts.refreshMs);

    return () => {
      clearInterval(timer);
      sseClosed = true;
      if (sseRetryTimer) clearTimeout(sseRetryTimer);
      sseAbort?.abort();
    };
  },
});
