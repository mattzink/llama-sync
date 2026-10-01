# Plan: `llama-sync`

An OpenCode V2 plugin (global, publishable) that dynamically populates the model
inventory of a custom OpenAI-compatible provider by watching a running
llama.cpp-based service (`/models` for the list, `/props` for per-model
knowledge; the router's `GET /models/sse` event stream for change
notification where present) — so models never have to be listed by hand
in `opencode.jsonc` again.

**Support scope:** any recent llama.cpp server (the b11277 generation) in
either mode — **router mode** (multiple presets) or **plain
single-instance `llama-server`** (one model, no `status` enrichment).
Everything the plugin depends on is source-verified for both modes (§2.7),
and every design decision degrades gracefully when router-only fields are
absent.

**Verification target:** a personal router-mode instance ("gpuz",
`http://gpuz.zinky.lan:8080`; `models_autoload: true`, `max_instances: 1`,
`--sleep-idle-seconds 3600`). "gpuz" appears in this plan *only* where
behavior was verified live on it (or in this machine's deployment config,
§5/§6.3); no value from it is a plugin default.

---

## 1. Goals / Non-goals

### Goals

- **G1 — Dynamic inventory.** The managed provider's model list (option
  `providerID`) is fetched from `GET {baseURL}/models` at plugin load and
  then refreshed on service events (the router's `GET /models/sse` stream,
  §2.8) and by a periodic safety-net poll while the OpenCode service runs.
- **G2 — No restart to see changes.** Adding/removing a model on the service
  (a router preset; on a plain server, swapping the model file → new id)
  appears/disappears in OpenCode's `/models` within one refresh cycle.
- **G3 — Per-model config out of opencode.jsonc.** Display names, limits,
  capabilities, and variants (e.g. Qwen `chat_template_kwargs` thinking
  variants) live in versioned plugin options, not the global config.
- **G4 — Publishable.** Repo ships to GitHub (`mattzink/llama-sync`)
  and npm (`llama-sync`), installable via
  `opencode plugin add`.
- **G5 — Template-derived model knowledge.** Per-model capability flags,
  context limit, modalities, and thinking/reasoning variants are derived from
  llama.cpp's `GET /props?model={id}&autoload=false` whenever the model is
  loaded or sleeping (router mode) — or unconditionally, on a plain
  single-instance server where the model is loaded by construction (§2.7) —
  and the last-known props are **persisted** so a model
  that is currently unloaded still carries its previously derived values
  (§4.2); plugin options and static defaults remain the fallback (and always
  the override).

### Non-goals

- No model load/unload control (no `POST /models/load` / `POST
  /models/unload`) — read-only discovery. By default the plugin never causes
  a model to load: props are only fetched for `loaded`/`sleeping` models
  (router mode; no-status plain-server entries are loaded by construction,
  §2.7), always with `autoload=false` (a harmless no-op on plain servers,
  which ignore query params entirely).
  The sole exception is the explicit opt-in `propsForUnloaded: "autoload"`
  (§4.4), whose eviction consequences are documented.
- No multi-service, no auth configuration of its own (the plugin's own
  requests reuse the provider entry's top-level `headers` when present —
  same record as `settings.baseURL`, §4.4), no TUI extension, no V1
  compatibility.
- No changes to the provider's chat runtime/package — the plugin only manages
  the *inventory*, not request behavior.
- No retention of the `/props` jinja `chat_template` (or sibling string
  fields): it is parsed in place for a few bounded signals and discarded —
  never stored, hashed, logged, or forwarded (§2.2.1).

---

## 2. Verified facts (basis for the design)

Verified 2026-09-28 (§2.1, §2.3–§2.6) and 2026-09-29 (§2.2, the `/props`
endpoint) against the live service, and the official OpenCode V2 docs
(`opencode.ai/v2/docs`). Re-verified 2026-09-30 after the service upgrade,
against llama.cpp **b11277** (commit `eae11d221`), OpenCode **v2.0.20**, and
the `@opencode/plugin` SDK type definitions (the authoritative plugin API
contract, not just the docs). All claims hold; the b11277 deltas are marked
where they occur (§2.1, §2.7, §2.8).

### 2.1 Service discovery endpoint

`GET {baseURL}/models` (and identical `GET /models`) returns an
OpenAI-compatible list enriched with llama.cpp details (verified live on
the router-mode verification instance, §1). **The shape below is router
mode**; a plain single-instance server returns a different, leaner entry
shape — the plugin parses both (§2.7):

```jsonc
{ "data": [ {
  "id": "qwen3.8-27b-q5xl-dflash2",
  "aliases": [], "tags": [], "object": "model", "owned_by": "llamacpp",
  "created": 1790794860,      // list-build time, not a release date (§2.7);
                              // changes on every router restart
  "status": {
    "value": "downloading" | "downloaded" | "unloaded" | "loading" | "loaded" | "sleeping",
    "args": ["--alias","qwen3.8-27b-q5xl-dflash2", "--ctx-size","160000", /* … */],
    "preset": "…TOML text…",
  },
  "architecture": {
    "input_modalities": ["text", "image"],   // → capabilities.input
    "output_modalities": ["text"],           // → capabilities.output
  },
  "source": "preset", "can_remove": false,
  // b11277: `meta` also appears on router entries while the child runs
  // (merged from the child's `loaded_info`, which carries `meta`);
  // absent on router entries while unloaded — always present on plain
  // entries (§2.7):
  "meta": { "vocab_type": 2, "n_vocab": 248320, "n_ctx": 160000,
            "n_ctx_train": 262144, "n_embd": 5120, "n_params": 27320697856,
            "size": 20865941504, "ftype": "Q5_K - Medium" },
} ] }
```

(b11277: the plain single-instance response additionally carries a legacy
top-level `models` array (Ollama style); the plugin reads `data[]` only.)

Observed presets at verification time (4):

| id | status | input |
| --- | --- | --- |
| `qwen3.8-27b-q4m-dflash2` | unloaded | text, image |
| `qwen3.8-27b-q4xl-dflash2` | unloaded | text |
| `qwen3.8-27b-q5xl` | unloaded | text, image |
| `qwen3.8-27b-q5xl-dflash2` | loaded | text, image |

Useful derived data per entry (the fields below are **router-only**;
on a plain server they are absent and the plugin falls through to props /
defaults — §2.7):

- context limit → `--ctx-size <n>` in `status.args` (160000 for all current presets);
  `meta.n_ctx` is a further fallback link (§4.3; b11277: on router entries
  while the child runs, always on plain entries);
- modalities → `architecture.input_modalities` / `output_modalities`;
- loaded state → `status.value` (also gates `/props` availability, §2.2).

Richer per-model data (capability flags, template-derived variants, runtime
`n_ctx`, fine-grained modalities) comes from `GET /props` — see §2.2.

The response is **verbose** (full llama-server argv + TOML preset per model);
the plugin must retain only a minimal projection in memory/storage.

### 2.2 Per-model properties endpoint (`GET /props`)

`GET {rootURL}/props?model={model-id}&autoload=false` (verified 2026-09-29,
re-verified 2026-09-30 live on the verification instance + against
llama.cpp **b11277** source, commit `eae11d221`,
`tools/server/server-models.cpp`) returns the runtime
properties of a model instance. The response **shape is universal**: a plain
single-instance server builds it with the same code path
(`get_res_props`, `server-context.cpp`) and the router merely proxies the
child's response (§2.7). Note: llama.cpp serves `/props` at the root —
`/v1/props` is 404 — so the plugin resolves it against the provider's
`settings.baseURL` with a trailing `/v1` (and trailing slash) stripped (§4.4 `propsPath`).

**Parameter semantics (from source; router mode unless noted):**

- `model=` accepts the canonical model name **or any alias** —
  `server_models::get_meta()` matches the mapping key or the alias set, and
  `router_validate_model()` resolves alias → canonical name server-side.
  There is no separate "model ID" to pass; the `/models` `id` *is* the
  canonical name.
- `autoload` (query param): when empty, the router's global
  `models_autoload` applies (**true** on gpuz — see the no-param `/props`
  response); otherwise it is parsed as `"true"`/`"1"`. So `autoload=false`
  is a real, honored parameter.
- The router's `/props` is a **proxy to the child llama-server instance**:
  full props (incl. `chat_template`) only exist in a running child. There is
  no metadata-only path — the router caches only the multimodal caps (already
  surfaced in the enriched `/models` response; the source carries a TODO for
  more).
- `autoload=false` + fully **unloaded** model → 400 `model is not loaded`
  (by design). But `is_running()` covers `loaded`, `loading`, **and
  `sleeping`** — so a sleeping model (gpuz runs `--sleep-idle-seconds 3600`)
  still answers full props without being woken.
- `autoload=true` (or omitted, since gpuz's global is true) + unloaded model
  → `ensure_model_ready()` **triggers a load**; with gpuz's
  `max_instances: 1` that LRU-**evicts the currently loaded model** (gpuz
  observation; the general rule is that a router may LRU-evict other
  instances when `max_instances` is reached). The plugin must never issue
  load-triggering props calls by default (opt-in exception:
  `propsForUnloaded`, §4.4).
- **Plain single-instance server:** the `/props` handler takes no request at
  all (`server-context.cpp:4785`) — `model=`/`autoload=` are **ignored**,
  the response is the single model's props, and there is no 400
  "not loaded" path (the model is loaded by construction). This is why the
  plugin's fixed `?model={id}&autoload=false` query string works unchanged
  against both modes.

Response for a **loaded** model (key inventory; values abridged):

```jsonc
{
  "default_generation_settings": {
    "n_ctx": 160000,                            // ← authoritative context limit
    "params": { /* full sampling defaults: temperature, top_k, top_p,
                   max_tokens: -1, n_predict: -1, samplers[], … */ }
  },
  "total_slots": 1,
  "model_alias": "qwen3.8-27b-q5xl-dflash2",
  "model_ftype": "Q5_K - Medium",
  "modalities": { "vision": true, "video": true, "audio": false },
  "media_marker": "…44-char model-specific string…",
  "chat_template": "…~10 KB of jinja…",          // never retained — see §2.2.1
  "chat_template_caps": {                        // ← structured capability flags
    "supports_tools": true,            "supports_tool_calls": true,
    "supports_parallel_tool_calls": true, "supports_object_arguments": true,
    "supports_reasoning_effort": true, "supports_preserve_reasoning": true,
    "supports_system_role": true,      "supports_string_content": true,
    "supports_typed_content": true
  },
  "bos_token": "…", "eos_token": "…",
  "build_info": "llama.cpp b…",
  "is_sleeping": false,
  "endpoint_slots": true, "endpoint_props": false, "endpoint_metrics": false,
  "ui": true, "ui_settings": {}, "cors_proxy_enabled": false,
  "model_path": "…GGUF snapshot path…"
}
```

Observed on the loaded `qwen3.8-27b-q5xl-dflash2` at verification time: all
nine `chat_template_caps` flags `true`; `modalities.vision = true`,
`video = true`, `audio = false`; `n_ctx = 160000` (matches every preset's
`--ctx-size`). Template-derived signals (computed in place, template never
dumped — §2.2.1): the 9,993-char template mentions `enable_thinking` and
`reasoning_effort` and contains the quoted literals `'low'`, `'medium'`,
`'high'`, `'xhigh'` (no `'minimal'`) — but **literal presence is not
support** (the `'high'` mention is a deprecated alias; see the
effort-level item in "Useful derived data" below).

**Availability by status** (b11277; verified live 2026-09-29, re-verified
2026-09-30): `status.value`
can be any of `downloading`, `downloaded`, `unloaded`, `loading`, `loaded`,
`sleeping` (only `loaded`/`unloaded` observed on gpuz so far).
`autoload=false` props succeed for `loaded` and `sleeping` (and pass
validation for `loading`, though the child may not answer yet); a fully
`unloaded` model returns HTTP 400
`{"error": {"code": 400, "message": "model is not loaded", "type": "invalid_request_error"}}`
(stable across polls). So: skip the props call for statuses without a
running child, treat per-model props failure as `null`, and let the next
poll pick up state flips (§4.2). Thanks to the 1 h sleep window,
template-derived variants persist for models that are loaded-but-idle;
after a full unload the **persisted props cache** (§4.2) carries the
last-known values until the preset is removed or repointed.
**Plain single-instance servers** have no `status` field at all: the model
is `loaded` or `sleeping` by construction (the server exists to serve it),
and `/props` answers from its **cache** while sleeping — the endpoint is
exempt from wake (README "Sleeping on Idle"; `server-context.cpp:4785`) —
so the same loaded/sleeping availability holds. The plugin treats
no-`status` entries as loaded (§2.7, §4.2 step 3).

**`POST /apply-template`** (b11277; documented in the server README,
verified live 2026-09-30) applies the chat template to a conversation
**without inference** and returns the rendered prompt in the `prompt`
field. Same routing as the other POSTs: `model` in the **JSON body** (not
the query string), resolved against the provider's `settings.baseURL` with
the trailing `/v1` stripped. The plugin uses it as a one-time behavioral
probe of which
`reasoning_effort` values the template actually maps (§4.3): identical
rendered prompts mean aliased levels, and a template
`raise_exception` surfaces as HTTP 500. Hazard: the 500 body embeds a
jinja **source snippet**, so probe failures reduce to a boolean and the
body is discarded (same discipline as §2.2.1).

Useful derived data per entry:

- `default_generation_settings.n_ctx` → `limit.context` (authoritative while
  loaded; cross-checked against `--ctx-size` in `status.args`, warn on mismatch);
- `chat_template_caps.supports_tools` → `capabilities.tools`;
- `chat_template_caps.supports_reasoning_effort` → gate for effort-variant
  derivation (the supported level set: item below; mechanism in §4.3);
- `enable_thinking` present in the template → `no-think` variant (§4.3);
- `modalities.{vision,video,audio}` → `capabilities.input` (finer than
  `/models` `input_modalities`; distinguishes video).
- **Supported reasoning-effort level set** — verified facts for this Qwen
  template (derivation mechanism: §4.3): it quotes `'high'` only as a
  **deprecated alias** (`== 'high' → set 'xhigh'`) and **raises** on
  anything outside the acceptance guard `not in ('xhigh','medium','low')` —
  its message: *"Supported types are xhigh (default), medium, and low."*
  The `POST /apply-template` render probe (no inference; verified 2026-09-30)
  confirms: `low`/`medium` render distinctly, `high`/`xhigh` render
  identically (alias + default), `minimal`/`max` fail with HTTP 500
  (template `raise_exception`). The 500 body embeds a jinja **source
  snippet** — probe failures reduce to a boolean and the body is discarded
  (never logged; §2.2.1 discipline).

Also useful: `is_sleeping` (universal field) — a cross-check of the router's
`status.value: "sleeping"`, the *only* load-state signal on plain servers,
and the **probe gate** for §4.3: `POST /apply-template` is *not* exempt
from wake, and a behavioral probe must never reload a sleeping model.

Not useful: `params.max_tokens` / `n_predict` (−1 = unlimited; keep the
static output default), `model_path` / `build_info` / `model_ftype`
(ops noise).

#### 2.2.1 The `chat_template` is an LLM-context hazard (verified)

The `chat_template` field is the model's raw jinja prompt. On multimodal
models it contains llama.cpp's media-placeholder tag (`__media__`-style; the
per-model form is `media_marker`, here a 44-char string — value never dumped
during verification). This is a **context hazard, not a plugin-code bug**:
the plugin never renders or tokenizes the template, but anything that puts
the raw template into an LLM's context — an agent or human probing the
service, a log dump, an error message, or persisted text that is later read
back — makes the placeholder look like an mmproj media reference, and the
model/agent fails trying to resolve it. (This session probed `/props`
entirely via jq whitelists — keys/types/sizes and boolean presence tests —
for exactly this reason.)

Rules:

- **Probing/debugging (agent or human):** filter the response at the shell
  boundary (jq whitelist over known scalar fields) so the ~10 KB template
  never enters the conversation context.
- **Plugin:** `props.ts` extracts a **whitelisted projection** — `n_ctx`,
  the nine `chat_template_caps` booleans, the three `modalities` booleans,
  the bounded template signals (§4.3), and the template's **sha256 digest**
  (a 64-hex hash — used to detect template changes; it is not template
  text) — and discards every other field, including `chat_template` and
  `media_marker`, so template text can never reach `ctx.storage`, logs,
  `Model.Info`, or an error message. (Also R4: no 10 KB blob per model in
  the inventory.)
- Template-derived signals are computed **in place** as bounded tests
  (substring `enable_thinking`; the static candidate extraction of §4.3 —
  acceptance-guard literals, default level, comparison literals — plus the
  sha256 digest) — the template is never stringified or retained anywhere.
- On props fetch failure only the HTTP status and `error.message` are logged
  (bounded server text), never the response body.
- A unit test feeds a fixture whose `chat_template` contains `__media__` and
  asserts the serialized projection contains neither the `chat_template` key
  nor the `__media__` substring (§6.1).

### 2.3 OpenCode V2 has no built-in llama.cpp discovery

The providers guide documents built-in discovery only for **Ollama**,
**LM Studio**, and **vLLM**. "For another OpenAI-compatible runtime, use the
custom provider recipe and list its models explicitly." → a plugin is the
correct mechanism.

### 2.4 Plugin API surface used (V2 plugins guide)

- `Plugin.define({ id, setup(ctx) })`; `setup` may return a cleanup function.
- `ctx.provider.transform(editor => editor.models.set(providerID, models))` —
  *replaces a provider's source inventory*; transforms replay in order onto a
  fresh value on every registry rebuild, so the callback must read from a
  mutable closure-held source.
- `ctx.provider.reload()` — republishes after the captured source changed.
- `ctx.provider.get({ providerID })` → `Promise<{ data: ProviderInfo }>`
  (the `@opencode/client` provider API) — `data.settings.baseURL` is the
  target provider's own opencode.jsonc settings; `data.headers` is the
  provider entry's top-level `headers` field (a sibling of `settings`, not
  inside it). Together they are the source of the service URL *and* auth
  headers (when present) for the plugin's own discovery requests, including
  the SSE connection (§2.8) — the plugin has no URL or auth option of its
  own (§4.4). (Inside `ctx.provider.transform`, `editor.get(providerID)`
  instead returns the richer `ProviderRecord` `{ provider, models }`.)
- `ctx.storage.get/set` — durable JSON, scoped to the plugin (last-good
  inventory cache, mirroring Ollama's "keep the last successful inventory
  during a temporary outage" behavior).
- `ctx.options` — plugin options from the object-form `plugins` entry.
- Model construction: `{ ...Model.Info.default(providerID, Model.ID.make(id)), … }`
  with `Provider.ID` / `Model.ID` branded constructors.
- Fallback if `models.set` proves inapplicable to a config-defined provider:
  `ctx.model.transform(editor => editor.update(providerID, id, draft => …))`
  ("update can add a model only under an available provider").

### 2.5 `Model.Info` required fields (OpenAPI schema)

`id`, `modelID`, `providerID`, `name` — required strings; `variants`
(required array, may be empty); `time.released` (required number,
**milliseconds** since the epoch — the SDK's catalog loader sets it via
`Date.parse`; `Model.Info.default()` uses `0`); `cost` (required array,
empty for local); `capabilities` (required: `tools`, `input[]`,
`output[]`); `status` (`"active"`); `enabled` (boolean); `limit` with
required `context` and `output` integers (`input` optional). Optional:
`settings`, `headers`, `body`, `package`, `family`. `Model.Info.default()`
fills the required defaults; the plugin sets every property per the
exhaustive table in §4.3 (`settings`, `headers`, `body`, `package`,
`family` are intentionally not set, with reasons given there).

**Alias semantics** (V2 docs, Models → Aliases): `id` is the selectable
catalog reference (`provider/<id>#<variant>`) and `modelID` is what is
sent to the provider — the two may deliberately differ, which is
OpenCode's native alias mechanism and the basis for the plugin's
`aliases` option (§4.3, §4.4).

### 2.6 Plugin loading (V2 plugins config guide)

- Package plugins: `package.json` manifest with `"type": "module"`,
  `"exports": { ".": "./src/index.ts" }`, dependency
  `@opencode/plugin` (per the official Publish section).
- Install via `opencode plugin add <spec>` — specs include npm names, versions,
  and npm-compatible Git specs (`github:user/repo`, `git+ssh:…`).
- Object-form entry passes options:
  `"plugins": [{ "package": "<spec>", "options": { … } }]`.
- A local directory *under* `~/.config/opencode/plugins/` (the global
  discovery dir) would be auto-discovered; we deliberately avoid that path
  for this repo (see §4.6) and install through an explicit `plugins` entry,
  which also delivers `ctx.options`.

### 2.7 Server modes: router vs plain single-instance (compatibility matrix)

Recent llama.cpp servers run in two modes; the plugin must work against
both. Everything below is source-verified on b11277 (commit `eae11d221`)
and, where noted, the server README.

| | **Router mode** (gpuz) | **Plain single-instance** |
| --- | --- | --- |
| Models | N presets, each a child `llama-server` process | exactly 1 (server process == model) |
| `GET /models` / `/v1/models` | both registered | both registered |
| Entry fields (common) | `id`, `aliases`, `tags`, `object`, `created`, `owned_by`, `meta{vocab_type, n_vocab, n_ctx, n_ctx_train, n_embd, n_params, size, ftype}` (b11277: plain entries always carry `meta`; router entries only while the child runs — the child's `loaded_info` is merged in, which includes `meta`) | same |
| Entry fields (mode-specific) | `status{value,args,preset?,failed?}`, `architecture{input_modalities,output_modalities}`, `source`, `can_remove` | — |
| `created` | `std::time(0)` — **list-build time, not a release date** (all entries share one value; the value changed on the 2026-09-30 router restart) | same |
| `GET /props` query params | `model=` (canonical or alias) + `autoload=` honored | **ignored** (handler takes no request) |
| `/props` while sleeping | child answers without waking (`is_running()` includes sleeping) | **cached** props, `is_sleeping: true`, no wake (README: exempt endpoint) |
| `/props` failure modes | unloaded + `autoload=false` → 400 `model is not loaded` | none — the model is always loaded or sleeping |
| `POST /apply-template` | proxied to the child (`model` in the JSON body) | root endpoint; body `model` ignored |
| Wake side effects | an autoload props call can **load** a preset (LRU-evicting others at `max_instances`) | any non-exempt request (incl. `/apply-template`) **wakes** a sleeping model |
| `is_sleeping` in props | present | present |
| SSE | `GET /models/sse` registered (§2.8) | not registered |

**Design consequences (how the plan handles plain servers):**

1. **Status classification** (§4.2 step 3): an entry *without* a `status`
   field is treated as `loaded` — the model is loaded by construction — so
   props are fetched for it every poll (no 400 possible, §2.2).
   `includeUnloaded`/`disableUnloaded` are inert on plain servers (no
   unloaded entries exist).
2. **Capability modalities**: the router's `architecture.*` is the
   *fallback* link in the mapping chain (§4.3); plain servers omit it, but
   props `modalities` — the first link — is always available there (loaded
   or sleeping), so a transient props failure degrades to the validated
   props cache, else `defaults`.
3. **`--ctx-size` guard** (§4.2 step 4): `status.args` is router-only; the
   invalidation guard is inert when args are absent. A plain-server model
   swap changes the `/models` `id` (the model name), which the
   deregistration-eviction rule already handles: old id gone → cache entry
   dropped; new id → no cache entry.
4. **Probe gating** (§4.2 step 3, §4.3): the behavioral probe runs only
   when fresh props say `is_sleeping: false` — otherwise it would wake a
   sleeping model (plain server or router child). While sleeping with a
   changed template, that poll uses the static candidate set, cached under
   `effortSource: "static"`; the flag is what makes the probe run on the
   next load (§4.2 step 3).
5. **`time.released`**: `e.created` is list-build time in *both* modes — a
   display-only proxy (the server exposes no release-date data; the source
   carries a TODO for GGUF metadata). `created` is Unix **seconds**;
   `Model.Info.time.released` is **milliseconds** — map as
   `e.created * 1000` (§4.3).
6. **Version scope**: verified on b11277; the plugin requires a build with
   `GET /props` incl. `chat_template_caps` and the `/models` `data[]` list
   (all recent builds). A build without the caps object degrades cleanly:
   missing caps parse to `false` → no effort variants, tools capability
   falls to the option/default.

### 2.8 Router SSE endpoint (`GET /models/sse`) — change notification

Verified against b11277 source (router `server_models` manager,
`server.cpp` route table, server README):

- **Router-mode only.** Registered in the "custom routes for router" block
  of `server.cpp` (alongside POST `/models`, `/models/load`,
  `/models/unload`, `DELETE /models`). Plain single-instance servers do not
  register it → the safety-net poll remains the sole trigger there.
- **Protocol:** `200`, `Content-Type: text/event-stream`; each frame is
  exactly `data: <json>\n\n` (no `event:` / `id:` / `retry:` lines).
- **Event payload:** `{"model": "<id>" | "*", "event": "<type>",
  "data": <object>}` — the `data` key is omitted when null.
- **Event types and triggers** (b11277 — these are all the `notify_sse`
  call sites in the router manager):

  | `event` | `model` field | Trigger |
  | --- | --- | --- |
  | `models_reload` | `*` | every `load_models()` run: startup, `GET /models?reload=`, deferred post-download reload |
  | `model_status` | id | child process spawn (autoload load, explicit `/models/load`, download start); `data.status` |
  | `status_change` | id | every status transition reported by the child monitor (`loading` → `loaded`, → `sleeping`, → `unloaded`, …); `data.status` plus optional `info` (child `loaded_info`), `progress`, `exit_code` |
  | `download_progress` / `download_finished` / `download_failed` | id | Hugging Face download lifecycle |
  | `model_remove` | id | `DELETE /models` |

- **Coverage:** every b11277 code path that mutates the router's
  in-memory model list emits one of the above (`load_models` →
  `models_reload`; spawn → `model_status`; transition → `status_change`;
  delete → `model_remove`); `server_models::update_meta` has no callers.
  **There is no file watcher for the preset file:** editing presets on disk
  mutates the live list only via `?reload=` or a restart — and since the
  plugin mirrors the *live* list, that is exactly what it needs to track
  (a `?reload=` run emits `models_reload`).
- **No keepalive:** the stream is silent between events. The
  `--sse-ping-interval` flag (default 30 s, README) applies only to
  chat/completions response streaming (server context), not to this
  endpoint. Consequence: a clean close (process exit) is observable from
  the client (stream end/error), but a silent network drop is not.
- **Auth:** the API-key middleware (`server-http.cpp`) applies to every
  route except a small public set (`/health`, `/v1/health`, and the frontend
  assets — `get_public_endpoints`, verified in the b11277 source; **metrics
  is not public**);
  `/models/sse` is not in it → a router run with `--api-key` requires the
  SSE connection to carry the same `Authorization` / `X-Api-Key` the
  provider entry already uses for chat (§4.4).
- **Sleep:** the sleep-on-idle logic exists only in the server context
  (child inference processes); the router parent never sleeps → a
  persistent SSE connection neither wakes anything nor is dropped by sleep.
- **No history:** the stream carries only future events; the initial state
  and any post-reconnect catch-up come from a full refresh (§4.2).

**Design consequence:** SSE is used as a *change detector*, never as a data
source — every event (and every (re)connect) triggers the standard full
refresh (§4.2 step 10), so one code path serves polling and events alike.
The `refreshMs` poll keeps running as the safety net that bounds staleness
from missed events; plain mode (no endpoint) and `sse: false` degrade to
polling-only.

---

## 3. Repository layout

```text
llama-sync/
├── plan.md                     # this file
├── mise.toml                   # dev tooling (same pattern as sibling repo
│                               #   gravwar): node 26; pnpm adopted from
│                               #   package.json `packageManager`;
│                               #   node_modules/.bin on PATH; `setup` task
├── package.json                # name: llama-sync, type: module,
│                               #   exports { ".": "./src/index.ts" },
│                               #   packageManager: pnpm@12.4.2,
│                               #   deps: { "@opencode/plugin" }
├── pnpm-lock.yaml
├── tsconfig.json               # strict, NodeNext, ES2022, noEmit for checks
├── .gitignore                  # node_modules/, dist/, *.tsbuildinfo
├── README.md                   # install, options reference, usage, examples
├── LICENSE                     # MIT
├── options.example.jsonc       # documented option set (copied to options.jsonc)
├── .github/workflows/ci.yml    # jdx/mise-action: install, typecheck, unit tests
└── src/
    ├── index.ts                # Plugin.define entry: lifecycle, refresh loop
    ├── discover.ts             # fetch + parse GET {base}/models (pure core, testable)
    ├── props.ts                # fetch + whitelist-parse GET /props (drops jinja;
                                #   template digest + static candidate signals);
                                #   pure props-cache merge/evict/validate helpers
    ├── probe.ts                # POST /apply-template effort probe: fetch + pure
                                #   render-classification (mapped / default-alias / rejected)
    ├── sse.ts                  # SSE frame parsing + coalescing/backoff schedule
                                #   (pure); the live connection lives in index.ts
    ├── map.ts                  # (entry, props, options) → Model.Info (pure, unit-tested)
    ├── options.ts              # option resolution: ctx.options ▸ options.jsonc ▸ defaults
    ├── hash.ts                 # canonical change-detection hash
    └── test/
        ├── discover.test.ts
        ├── props.test.ts
        ├── probe.test.ts
        ├── sse.test.ts
        ├── map.test.ts
        ├── options.test.ts
        ├── hash.test.ts
        └── fixtures/
            ├── router-models.json     # captured live router /models (trimmed)
            ├── router-props-*.json    # captured live props; chat_template replaced
            │                          #   by a short sentinel containing __media__
            ├── plain-models.json      # plain single-instance /models shape (no status/
            │                          #   architecture; has meta) — per §2.7
            └── plain-props.json       # plain /props (same shape as router props,
                                       #   `is_sleeping` exercised as both true and false)
```

**Dev tooling via mise** (same pattern as the sibling repo `gravwar`):
`mise.toml` pins `node = "26"`, adopts the pnpm version from
`package.json`'s `packageManager` field
(`idiomatic_version_file_enable_tools = ["pnpm"]`), puts
`node_modules/.bin` on PATH, and defines a `setup` task
(`pnpm install` with source/output tracking). Locally, `mise install`
provisions everything; all scripts run via pnpm. CI installs the toolchain
with `jdx/mise-action@v4` before `pnpm install --frozen-lockfile` (§7.3).

Pure modules (`discover` parse, `props` parse, `map`, `options`, `hash`)
take plain data in and return plain data out, so they are fully
unit-testable without an OpenCode runtime; only `index.ts` touches `ctx`.

---

## 4. Plugin design

### 4.1 Lifecycle (`src/index.ts`)

```ts
export default Plugin.define({
  id: "llama-sync",
  async setup(ctx) {
    const opts = await resolveOptions(ctx)          // options.ts
    const providerID = Provider.ID.make(opts.providerID)
    // baseURL: read from the provider entry's settings.baseURL each poll
    // (ctx.provider.get, §4.4) — missing provider/baseURL → log error, inert

    const source = { models: await loadStored(ctx) }  // last-good from ctx.storage, or []

    const refresh = async () => {
      const fetched = await fetchModels(opts)        // discover.ts; null on any failure
      if (fetched === null) { log warn; return }    // keep last-good, no reload
      const cache = await loadPropsCache(ctx)       // "props-cache" from ctx.storage, or {}
      const fresh = await fetchPropsForRunning(fetched, opts)  // props.ts; loaded/sleeping; no-status = loaded (§2.7)
      const merged = mergePropsCache(cache, fresh, fetched, opts)   // fresh wins; evict gone ids
      if (merged.dirty) await ctx.storage.set("props-cache", merged.cache)
      const models = fetched.map(e => mapEntry(
        e, fresh.get(e.id) ?? cacheEntry(merged.cache.get(e.id), e.status.args), opts))  // fresh ▸ cached ▸ null
      if (hash(models) === hash(source.models)) return     // no change, no churn
      source.models = models                                  // mapped Model.Info[]
      await ctx.storage.set("inventory", { hash: hash(models), models, at: Date.now() })
      await ctx.provider.reload()
    }

    await ctx.provider.transform(editor => {
      editor.models.set(providerID, source.models)   // replays onto fresh state
    })

    await refresh()                                     // best-effort initial fetch
    const sse = opts.sse
      ? connectSSE(opts, () => scheduleRefresh())       // §2.8: any event → coalesced refresh
      : null
    //   opened after the first refresh attempt (regardless of outcome);
    //   404/405 (plain server or older build) → disabled for the plugin's
    //   life + one log line;
    //   end/error → reconnect with backoff (1 s → 60 s) + one catch-up
    //   refresh (the stream has no history, §2.8); scheduleRefresh() is a
    //   no-op while a refresh is in flight or ran <1 s ago (burst coalescing)
    const timer = setInterval(() => void refresh().catch(log), opts.refreshMs)
    //   safety net, always on: bounds staleness from missed events (the
    //   stream is silent between events — no keepalive, §2.8); the sole
    //   trigger on plain servers / when sse: false
    return () => { clearInterval(timer); sse?.close() }
  },
})
```

Ordering note: the transform is registered *before* the first refresh so the
registry always has a (possibly empty/stale) inventory for the provider;
`ctx.storage` pre-seeding means a restart shows the previous inventory
immediately even if the service is momentarily unreachable. `source.models`
and the inventory cache hold *mapped* `Model.Info[]` (never raw endpoint
payloads), so restarts replay a ready-to-publish inventory and the jinja
`chat_template` can never reach storage (§2.2.1). The props cache holds
only the whitelisted scalar projection (booleans/numbers + timestamp) —
never the template (§4.2 step 4).

### 4.2 Refresh algorithm

1. `GET {baseURL}{modelsPath}` with `AbortController` timeout (`timeoutMs`,
   default 5000). Here `baseURL` is the target provider's
   `settings.baseURL`, read from its own opencode.jsonc entry via
   `ctx.provider.get({ providerID })` and **re-read on every poll** (§4.4)
   — a config edit takes effect on the next cycle, and the plugin has no
   URL option of its own.
2. Parse `data[]` (defensive: non-array/missing → failure, keep last-good).
3. For each entry whose `status.value` is `loaded` or `sleeping` — or that
   has **no `status` field at all** (plain single-instance server: the model
   is loaded by construction, §2.7) —
   `GET {rootURL}{propsPath}?model={id}&autoload=false` (rootURL = `baseURL`
   with a trailing `/v1` (and trailing slash) stripped; same timeout;
   bounded concurrency, 2) → whitelist parse via `props.ts` →
   `ModelProps | null`. With `propsForUnloaded: "autoload"` (§4.4), also
   fetch `unloaded` entries — with `autoload=true`, which makes the router
   load them on demand (the documented eviction hazard, §2.2) — harmless on
   plain servers, whose params are ignored (§2.2). Otherwise skip the call
   for `unloaded`/`downloaded`/`downloading`/`loading` (router: no running
   child — the 400 is deterministic, §2.2). Any per-model failure →
   `null`; no retry within the poll; warn logged as `status +
   error.message` only (§2.2.1).
   The parse also yields the template's **sha256 digest** and the static
   candidate signals (§4.3). The projection's `effortLevels` are completed
   by the one-time `POST /apply-template` **behavioral probe** (§4.3,
   `probe.ts`; same rootURL/timeout/concurrency, `autoload=false`, `model`
   in the JSON body) where *all* hold: `caps.supports_reasoning_effort` is
   true, the fresh props say `is_sleeping: false` (**probe gate** — the
   endpoint is not wake-exempt, §2.7: a sleeping model uses the static set
   for this poll), and at least one of: no cache entry exists; the digest
   differs from the cache entry's `templateHash`; the cache entry's
   `effortSource` is `"static"` and `probeUnsupported` is not set (a static
   stand-in from a digest change while sleeping — this is what makes the
   probe actually run on the next load).
   Probe outcomes: success → new `templateHash` + probe-derived level
   classes + `effortSource: "probe"` stored in the cache (step 4); 404/405
   → probe unsupported for this service, entry stored with the new
   `templateHash`, the static-set `effortLevels`, `effortSource: "static"`,
   and a `probeUnsupported: true` flag (no further retries); other failure
   → the cache entry is left unchanged so the next poll retries. When the
   probe is gated (sleeping) but the digest changed, step 4 stores the new
   `templateHash` with the static candidate set and
   `effortSource: "static"` — the next non-sleeping poll re-probes.
   **Invariant:** a cache entry's `effortLevels` are always the ones
   derived for its `templateHash`, and `effortSource` records how they were
   derived (`"probe"` | `"static"`). A digest-unchanged entry with
   `effortSource: "probe"` reuses its cached `effortLevels` — no re-probe.
4. **Props cache** (option `propsCache`, default on): merge the persisted
   cache (`"props-cache"` in `ctx.storage`, shape
   `{ <model-id>: { at, props } }` where `props` is the whitelisted
   projection — numbers, booleans, a bounded string set (level names), and
   the 64-hex `templateHash` (the digest the entry's `effortLevels` were
   derived for, §4.2 step 3), plus the `effortSource: "probe" | "static"`
   marker (how those `effortLevels` were derived) and the optional
   `probeUnsupported` flag; the template itself can never enter it,
   §2.2.1) with the fresh results:
   - **Write:** for each *fresh* id, update the entry only when the
     projection content changed (compare ignoring `at`) — timestamps never
     cause storage churn.
   - **Evict:** drop every entry whose id is absent from this poll's
     `/models` list (a preset that is deregistered leaves no residue).
   - **Invalidate:** drop an entry whose cached `n_ctx` disagrees with the
     model's current `--ctx-size` arg (the preset was repointed; treat as
     absent for this poll). Router-only input — the guard is **inert when
     `status.args` is absent** (plain servers, §2.7; there a model swap
     changes the id and eviction handles it). The guard is cheap and
     re-cached on next load.
   - Persist to `ctx.storage` only when dirty. Pure merge/evict/validate
     helpers live in `props.ts` (unit-tested); `ctx.storage` plumbing in
     `index.ts`.
5. Map each entry via `map.ts` with props = **fresh ▸ validated cached
   entry ▸ `null`** → `Model.Info[]` (§4.3), then append the resolved
   `aliases` (§4.3).
6. `hash = canonicalHash(projection)` — projection per model:
   `[id, limit, capabilities, variants, enabled]`, array sorted by `id`,
   stable JSON stringify. (The jinja template is gone by construction —
   dropped at the parse boundary, §2.2.1 — so it can never enter the hash;
   the cache's `at` timestamps are not part of the projection either.)
7. If `hash === lastHash` → no-op (avoids needless registry rebuilds every
   poll — the response's `created`/arg strings must not cause churn).
8. Else publish: update `source.models`, persist to `ctx.storage`,
   `ctx.provider.reload()`.
9. Any models-list fetch/parse failure → keep current inventory,
   `console.warn` with the error (visible in `opencode` server logs).
   Per-model props failures never abort the refresh (§4.3 fallback). Never
   publish an empty list on a *failed* fetch (only on a *successful* fetch of
   a genuinely empty list).
10. **Triggers** (the algorithm is identical regardless of which fired):

- **timer** — every `refreshMs` (always active);
- **SSE event** (router mode, option `sse`, §2.8) — any event from
     `GET /models/sse` schedules a refresh; the event payload is used
     *only as a trigger, never as data* (the refresh re-fetches `/models`
  - props through the steps above), coalesced: in-flight or <1 s since
     the last refresh → skip;
- **SSE (re)connect** — the stream has no history (§2.8): the initial
     connect and every reconnect (backoff 1 s → 60 s) run one catch-up
     refresh.
   Plain servers (no `/models/sse` route) and `sse: false` → timer only.

**Churn profile:** the load-side flip is the first poll that sees a preset
`loaded` with no cache entry — props succeed in that same poll →
auto-derived variants and props-derived modalities appear (one hash change,
one rebuild) and the cache is seeded. (An earlier poll that catches the
preset `loading`/`unloaded` publishes one extra default-valued entry first;
with on-demand autoload the two usually merge.) Sleep and full unload then cause **no** inventory change:
the cached projection yields the same derived values, so the hash is stable
and no rebuild fires (the cache also keeps props-only details alive, e.g.
the `video` input modality that the router's `/models`
`input_modalities` omits). Preset removal is one rebuild (entry disappears)
plus the cache eviction from step 4. A plain-server model swap (new GGUF →
new id) is the same: one rebuild + eviction, then the new id's first-load
rebuild. Rebuilds track actual state changes, not polls.

### 4.3 Mapping: endpoint entry + props + options → `Model.Info`

For each entry `e` with id `e.id`, props `p` = the **fresh** projection for
this poll, else the **validated cached** projection (§4.2 step 4), else
`null` (never-loaded, or evicted/invalidated preset), and override
`o = options.overrides[e.id]`. "If props" below means fresh *or* cached —
mapping cannot tell the two apart, which is deliberate: option changes
(like `variantReasoningEfforts`) re-apply to cached values on the next poll.

**Full-coverage table** — every `Model.Info` property of the §2.5 schema is
either derived or explicitly left unset:

| Model.Info property | Value (derivation precedence) |
| --- | --- |
| `id` *(required)* | `e.id` — the `/models` entry id (router: canonical name / preset alias; plain: the loaded model's name) |
| `modelID` *(required)* | `e.id` (same as `id`) |
| `providerID` *(required)* | option `providerID` (default `"llamacpp"`) |
| `name` *(required)* | `o.name` ?? prettified `e.id` (spaces, title case) — the endpoint exposes no display name |
| `variants` *(required)* | `o.variants` ?? (if `autoVariants` && `p` → derive, below) ?? `defaults.variants` ([]) |
| `time.released` *(required)* | `e.created * 1000` ?? 0 — note: `created` is Unix **seconds** (list-build time in *both* modes, not a release date, §2.7) while `time.released` is **milliseconds** (the SDK's catalog loader sets it via `Date.parse`) — a display-only proxy |
| `cost` *(required)* | `[]` — local service, no cost model |
| `status` | `"active"` — the plugin never reports other states (unloaded is expressed via `enabled`, §4.5) |
| `enabled` | §4.5 (unloaded-model policy: `includeUnloaded` / `disableUnloaded`) |
| `limit.context` *(required)* | `o.limit.context` ?? `p.n_ctx` (if props) ?? `--ctx-size` parsed from `e.status.args` *(router-only link; skipped when absent — §2.7)* ?? `e.meta?.n_ctx` *(b11277: plain entries always; router entries only while the child runs — §2.7; reached when props are absent, e.g. a plain-server props failure, where it beats the default)* ?? `defaults.limit.context` (160000). If both `p.n_ctx` and `--ctx-size` exist and disagree → warn, props wins (runtime truth) — only *fresh* props can reach this; the §4.2 guard already drops cached entries whose `n_ctx` no longer matches the args |
| `limit.output` *(required)* | `o.limit.output` ?? `defaults.limit.output` (32768) — props `max_tokens`/`n_predict` are −1 (unlimited), unusable |
| `capabilities.tools` | `o.capabilities?.tools` ?? `p.caps.supports_tools` (if props) ?? `defaults.capabilities.tools` (true) |
| `capabilities.input` | `p.modalities` mapped (always `text`; `vision`→`image`, `video`→`video`, `audio`→`audio`) ?? `e.architecture.input_modalities` (validated subset of known media types) ?? `defaults.capabilities.input` (["text"]) |
| `capabilities.output` | `e.architecture.output_modalities` *(router-only field; plain servers fall through)* ?? `defaults.capabilities.output` (["text"]) — llama.cpp models are text-output in practice |
| `settings` *(optional)* | **not set** — `/props` `default_generation_settings.params` is the *server-wide* sampling defaults (gpuz: a 42-key object with `max_tokens: −1`, verified), not a per-model authoritative limit, and its output-limit values are −1/unlimited; generation parameters stay under OpenCode's own model settings |
| `headers` *(optional)* | **not set** — llama.cpp servers expose no per-model auth (the verification instance is LAN-local, no auth); network-level auth belongs outside the provider |
| `body` *(optional)* | **not set** — a static per-model body would conflict with the per-variant `chat_template_kwargs` settings; nothing else to inject |
| `package` *(optional)* | **not set** — local llama.cpp presets have no package identity |
| `family` *(optional)* | **not set** — `/models` `architecture` is the modalities object only (no family string) and `Model.Family` is a branded value; parsing a family from the id prefix would be deployment-specific guessing |

Construction: `{ ...Model.Info.default(providerID, Model.ID.make(id)), …overrides }`
— the spread applies the table's values over the schema's required defaults,
so any property omitted above keeps its `Model.Info.default()` value.

**Variant derivation** (when props are available; every emitted setting is a
plain constant built by the plugin — never taken from the template):

Effort levels need two signals because **literal presence in the template is
not support** (the Qwen template quotes `'high'` only as a deprecated alias
and *raises* on everything outside its accepted set — §2.2):

1. **Static candidates** (`props.ts`, in place, every poll — bounded
   pattern reads, no template text retained): when
   `caps.supports_reasoning_effort` is true, extract
   - **acceptance guard** — literals of a `not in ( … )` guard whose block
     calls `raise_exception`; the template's declared supported set (this
     Qwen: `('xhigh','medium','low')`);
   - **default level** — the value of `reasoning_effort|default('…')` (here
     `'xhigh'`);
   - **comparison literals** — literals in `… == '…'` contexts around
     `reasoning_effort` (includes the alias `'high'` — a candidate, not an
     answer).
   No guard found → candidates = comparison literals (degraded mode).
2. **Behavioral confirmation** (`probe.ts`, one-time per template digest and
   only while the model is not sleeping — §4.2 step 3): `POST
   {rootURL}/apply-template` (no inference) with
   `{"model": <id>, "messages": [{…one small user turn…}],
   "chat_template_kwargs": {"enable_thinking": true,
   "reasoning_effort": <L>}}` for each candidate `L`, in the fixed
   vocabulary order — `minimal, low, medium, high, xhigh, max`, plus any
   template-specific comparison literals appended after it, alphabetically
   — plus a baseline render without `reasoning_effort`. Classify by
   sha256 of the `prompt` field (computed in memory; prompt never logged):
   - HTTP 400/500 (template `raise_exception`) → **rejected**; the body is
     discarded — it embeds a jinja source snippet (§2.2.1);
   - prompt hash ≡ baseline hash → **default-alias** (renders identically to
     the template default, e.g. `high` ≡ `xhigh`);
   - distinct hash → **mapped** level.
   On probe failure the static guard set stands in for `effortLevels`
   (degraded, never a crash); `effortProbe: false` skips the probe entirely.

**Emission:** one variant per *distinct rendered class*, in vocabulary
order, labeled by the class member that (a) is in the acceptance guard,
else (b) is the default level, else (c) is last in vocabulary order — so an
alias class emits the canonical level (`{high, xhigh}` → `xhigh`), never
the alias:

`{ id: <level>, settings: { chat_template_kwargs: { enable_thinking: true,
reasoning_effort: <level> } } }`

If `variantReasoningEfforts` is set, the emitted set is further restricted
to that list (still intersected with what the template actually maps).

- `no-think` variant: if `noThinkVariant` (default true) and the template
  mentions `enable_thinking`, append `{ id: "no-think", settings:
  { chat_template_kwargs: { enable_thinking: false } } }`. Behaviorally
  verified 2026-09-30: `enable_thinking: false` renders cleanly (effort
  system message dropped, explicit no-think markers emitted in place of the
  thinking preamble).
- No props (neither fresh nor a validated cache entry — never-loaded preset,
  or one evicted/invalidated per §4.2) → `defaults.variants` / `[]`.
  Explicit `overrides[<id>].variants` always win and work in any load state
  and with or without a cache — that is how the curated Qwen set in the
  migrated config stays in effect while auto-derivation serves future
  presets.

For the loaded Qwen3.8-27B this now yields exactly
`low / medium / xhigh / no-think` — identical to the curated set currently
in `opencode.jsonc` (probe-verified 2026-09-30: `low`/`medium` render
distinctly, `high` ≡ `xhigh` alias, `minimal`/`max` rejected by the
template). The migrated overrides therefore remain a no-op safety net;
dropping their `variants` arrays switches those models to the derived set
with no visible change.

**Aliases and additive variants** (options `aliases`, `extraVariants`):

- **Aliases** — discovered ids are *never renamed* (existing selectors
  keep working); instead `aliases` publishes *additional* entries for the
  same model. For each alias whose target exists in the current `/models`
  list, the target's mapped entry is re-emitted with `id` = alias key and
  `modelID` = target id — OpenCode sends the target id to the service
  (§2.5). The alias **inherits the target's props-derived values**: the
  same projection is reused, so no extra `/props` calls and no wake-side-
  effect change — then alias-level `name` / `limit` / `capabilities` /
  `variants` / `extraVariants` / `disabled` apply with the same precedence
  as `overrides`. Target absent this poll → the alias is skipped (one
  warn); a key equal to a discovered id (or a duplicate alias key) →
  rejected (one error, alias skipped). An alias disappears automatically
  on the poll its target leaves the list, and alias entries enter the
  churn hash (§4.2 step 6) like any other entry. Works in both server
  modes (a plain server's single model can be aliased too).
- **`extraVariants`** — the additive complement of `variants` (which
  *replaces* the derived set): base set = explicit `variants` if present,
  else the auto-derived set; `extraVariants` (variant entry shape
  `{ id, settings?, headers?, body? }` — V2 docs, Models → Variants) is
  merged in, **replacing a same-`id` derived entry** (OpenCode's catalog
  semantics for same-id variants) or appending otherwise, so e.g. the
  derived `low/medium/xhigh/no-think` stays intact while a custom
  `{ id: "turbo", settings: { chat_template_kwargs: { … } } }` is added.
  `extraVariants` is accepted in both `overrides[<id>]` and alias entries.

### 4.4 Options

**The service URL is not a plugin option.** The plugin reads
`settings.baseURL` from the target provider's own opencode.jsonc entry
(`ctx.provider.get({ providerID })`, §2.4) — the provider has to be
configured anyway, since it is how OpenCode chats with the service — so
there is exactly one source of truth. The value is re-read on every poll.
If the provider entry (or its `settings.baseURL`) is missing, the plugin
logs one error and stays inert (no polling, no inventory writes). If the
provider entry has top-level `headers` (a sibling of `settings`, e.g.
`Authorization` for a router behind `--api-key` — read from `data.headers`
of the provider record), they are sent on every plugin request — the
discovery fetches and the SSE connection, both of which the API-key
middleware covers (§2.8). No separate auth option exists.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `providerID` | string | `"llamacpp"` | Provider key in opencode.jsonc whose inventory is managed; also the entry the plugin reads `settings.baseURL` from (must match the config) |
| `modelsPath` | string | `"/models"` | Appended to the provider's `settings.baseURL` |
| `propsPath` | string | `"/props"` | Props endpoint path, resolved against the provider's `settings.baseURL` with a trailing `/v1` stripped (llama.cpp serves `/props` at root, not under `/v1` — verified 404) |
| `includeUnloaded` | boolean | `true` | Include router presets with `status.value === "unloaded"` (service auto-loads on demand); inert on plain single-instance servers (no unloaded entries exist) |
| `disableUnloaded` | boolean | `false` | If true, unloaded router presets appear but `enabled: false` (mutually exclusive with `includeUnloaded: false`; wins over it; router-only concept) |
| `refreshMs` | number | `30000` | Poll interval. With SSE active (router mode) it is the **safety net** that bounds staleness from missed events (the stream has no keepalive — §2.8); on plain servers and with `sse: false` it is the sole trigger. The default is fine with SSE on; raise it (e.g. `300000`) to cut steady-state traffic once SSE is proven on your network |
| `sse` | boolean | `true` | Subscribe to the router's `GET /models/sse` event stream and refresh on events (§2.8, §4.2 step 10). Router mode only — a 404/405 disables it for the plugin's life (one log line); reconnects use backoff 1 s → 60 s with a catch-up refresh. The `refreshMs` safety-net poll is unaffected |
| `timeoutMs` | number | `5000` | Fetch timeout (models list and every props call) |
| `autoVariants` | boolean | `true` | Derive thinking/reasoning variants from `/props` (§4.3); if false, variants come only from overrides / `defaults.variants` |
| `variantReasoningEfforts` | string[] | `null` (= all template-found levels) | Restrict auto-derived effort variants to a subset (still intersected with what the template actually supports) |
| `noThinkVariant` | boolean | `true` | Append a `no-think` variant when the template supports `enable_thinking` |
| `effortProbe` | boolean | `true` | Run the one-time `POST /apply-template` behavioral probe (§4.3 step 2) when a model's template digest is new/changed. `false`: effort levels come from the static candidate read only |
| `defaults` | object | `{ limit: { context: 160000, output: 32768 }, capabilities: { tools: true }, variants: [] }` | Applied to every discovered model (input/output modalities and auto-variants come from the endpoints, not here) |
| `overrides` | object | `{}` | Keyed by discovered model id; per-model `{ name?, limit?, capabilities?, variants?, extraVariants?, disabled? }` — `variants` **replaces** the auto-derived set; `extraVariants` is **merged** into it (§4.3) |
| `aliases` | object | `{}` | Additional catalog entries that alias discovered models (OpenCode's `id` ≠ `modelID` mechanism, §2.5). Key = the new selectable model id; value = target model id (string) or `{ model, name?, limit?, capabilities?, variants?, extraVariants?, disabled? }`. The alias inherits the target's props-derived values (no extra `/props` calls) and is pruned when the target leaves `/models`; keys colliding with a discovered id are rejected (one error, alias skipped). Works in both server modes (§4.3) |
| `propsForUnloaded` | `"never" \| "autoload"` | `"never"` | `"never"` (default): props are only fetched for `loaded`/`sleeping` models — the plugin never causes a load. `"autoload"`: fetch props for unloaded models too, letting the router load them on demand. **Destructive on routers**: a load may LRU-evict the currently active model (gpuz: `max_instances: 1`, verified) — use only knowingly. Inert on plain servers (no unloaded model exists) |
| `propsCache` | boolean | `true` | Persist the last-known props projection per model id (whitelisted scalars only, §2.2.1) so a currently-unloaded model keeps its previously derived values. Fresh props always win; entries are evicted when the id disappears from `/models` or when the cached `n_ctx` no longer matches `--ctx-size` in the model's args (§4.2 step 4). `false` disables persistence — unloaded models fall back to defaults on every poll |

**Resolution order** (per key, shallow): `ctx.options` (object-form config
entry) ▸ `options.jsonc` sibling file ▸ built-in defaults.
Sibling file path: `options.jsonc` next to `src/index.ts` (resolved via
`import.meta.url`); parsed with a tiny JSONC stripper (comments/trailing
commas) — no dependency. For npm-installed copies the sibling file won't
exist, so options come from `ctx.options` or the built-in defaults.

### 4.5 Unloaded-model policy (default)

`includeUnloaded: true` — all models selectable; a router with on-demand
loading (gpuz: `models_autoload: true`, verified) can serve an unloaded
preset on demand, so hiding it would lose real models. (On plain
single-instance servers the option is inert — the single model is never
"unloaded".) Operators who prefer strict behavior set `disableUnloaded:
true` (visible but not selectable) or `includeUnloaded: false` (hidden).
Sleep nuance (b11277): with `--sleep-idle-seconds N` (gpuz: 3600) a model
that went idle stays `sleeping` for N seconds — still "running" for
`/props` purposes (the router child answers; a plain server serves cached
props) — so its props stay *fresh* through the sleep window. After a full
unload (or LRU eviction) the persisted props cache (§4.2 step 4) keeps the
last derived values, so load state changes are invisible in the inventory:
only preset removal (cache eviction) or repointing (cache invalidation)
changes what an unloaded model presents.

### 4.6 Installation mechanics (avoids double-load)

The repo lives at `~/llama-sync` — **not** inside any
`.opencode/plugins/` or `~/.config/opencode/plugins/` discovery path — and is
loaded exclusively through an explicit `plugins` entry. Single load,
`ctx.options` delivered, no discovery/config duplication questions.

- **Dev (this machine):** global `~/.config/opencode/opencode.jsonc`

  ```jsonc
  "plugins": [{
    "package": "/home/mattzink/llama-sync",
    "options": { /* per §4.4, incl. the migrated Qwen overrides */ }
  }]
  ```

- **Published:** `opencode plugin add llama-sync` (npm) or
  `opencode plugin add github:mattzink/llama-sync` (git); remove the
  dev entry.

---

## 5. Config migration (global `opencode.jsonc`)

*This section documents the current machine's deployment (the verification
instance); the values are deployment-specific, not plugin defaults — the
plugin itself ships none of them.*

Remove the static `models` map from `providers.gpuz` (the plugin's
`models.set` replaces the inventory anyway) and keep only the provider
definition:

```jsonc
"providers": {
  "gpuz": {
    "name": "gpuz",
    "package": "aisdk:@ai-sdk/openai-compatible",
    "settings": {
      "baseURL": "http://gpuz.zinky.lan:8080/v1",
      "fetchOptions": { "keepAlive": true }
    }
  }
}
```

Per-model data preserved via the plugin entry's `options.overrides`
(migrated verbatim from the current config):

- `qwen3.8-27b-q5xl-dflash2` → `name: "Qwen 3.8"` + 4 variants
  (`low` / `medium` / `xhigh` / `no-think` with `chat_template_kwargs`
  `enable_thinking` + `reasoning_effort`).
- `qwen3.8-27b-q4-dflash2` → `name: "Qwen 3.8 Fast"` + same 4 variants.
  (Note: this id is *not* currently in the gpuz inventory — it was listed in
  config while the service has `q4m`/`q4xl`; after migration it will no
  longer appear unless the service adds it. The overrides entry is kept so
  the moment the preset exists it is fully configured.)

With `/props` plus the one-time render probe, the plugin *derives* variants
from each model's own chat template (§4.3) — for this Qwen family exactly
`low / medium / xhigh / no-think` (probe-verified 2026-09-30: `high` is a
deprecated alias of `xhigh`; `minimal`/`max` are rejected by the template).
New presets get their own template's actually-mapped levels automatically.
The explicit `variants` arrays above are a curated override: they win over
auto-derivation and work regardless of load state. Drop `variants` from an
override to switch that model to the template-derived set — for the Qwen
models the derived set matches the curated one, so the override is a no-op
safety net.

Everything else in the global config (`lsp`, `websearch`, `mcp`) untouched.

---

## 6. Testing plan

### 6.1 Unit tests (vitest)

- `props.test.ts` — whitelist parse (fixture: captured live props,
  `chat_template` replaced by a sentinel containing `__media__`):
  - valid props → projection with exactly `{ n_ctx, caps, modalities,
    templateHash, static candidate signals }`; assert the serialized
    projection has no `chat_template` key and no
    `__media__` / template substring (the hygiene invariant, §2.2.1);
  - static candidate extraction on the Qwen fixture: acceptance guard
    `('xhigh','medium','low')` read, default level `xhigh`, comparison
    literals include the alias `high`; a guard-less fixture degrades to
    comparison literals; template sha256 digest stable for identical
    fixtures; `supports_reasoning_effort` read from caps;
  - error body `{"error": {"message": "model is not loaded", …}}` → `null`;
    bad JSON / non-object / missing fields → `null` or partial projection
    with safe defaults;
  - fetch failure → `null` (injected fetch stub);
  - plain-server props fixture (§2.7; `is_sleeping` true and false) →
    identical projection shape (the props response is universal, §2.2);
  - **props cache helpers** (pure, §4.2 step 4): fresh projection updates
    the entry; unchanged content → `dirty: false` (no storage write); id
    absent from the live `/models` list → evicted; cached `n_ctx` ≠
    `--ctx-size` in args → entry dropped; serialized cache contains only
    scalars (no `chat_template`, no `__media__` — hygiene invariant holds
    for storage, not just the live projection).
- `probe.test.ts` — render classification (injected fetch stubs):
  - distinct prompt hashes → mapped; hash ≡ baseline → default-alias;
    HTTP 500 → rejected — the error body's jinja source snippet must never
    appear in any returned value or log (hygiene assertion);
  - emission labels: alias class `{high, xhigh}` → canonical `xhigh`
    (acceptance-guard member rule); probe failure → static guard set
    fallback; 404 → unsupported flag, no retry;
  - hygiene: return values carry hashes only — no prompt content, no
    `__media__` substring.
- `map.test.ts` — fixtures from the captured live responses (§2.1, §2.2):
  - all 4 entries map to valid `Model.Info` (required fields present);
  - `limit.context` precedence: override ▸ props `n_ctx` ▸ `--ctx-size`
    (present, absent, malformed) ▸ `meta.n_ctx` (absent in pre-b11277
    fixture shapes) ▸ default; props-vs-args mismatch → warn (log spy),
    props wins;
  - modality mapping: props `modalities` (vision/video/audio) → input list;
    fallback to `/models` `input_modalities` incl. the text-only `q4xl`
    entry when props are null;
  - plain-server entry (no `status`, no `architecture`, has `meta`, §2.7):
    with props → capabilities from props `modalities`, `enabled: true`,
    `time.released` from `created`; with props null → defaults (there is no
    `architecture` link to fall back on);
  - variant derivation from probe classes: Qwen fixture → exactly
    `low/medium/xhigh/no-think` (alias class `{high, xhigh}` emits one
    canonical `xhigh` variant; rejected `minimal`/`max` never emitted);
    `supports_reasoning_effort: false` → effort variants suppressed (no-think
    still emitted when `enable_thinking` present); no props →
    `defaults.variants`/[]; `autoVariants: false`; `noThinkVariant: false`;
    `variantReasoningEfforts` restriction (intersected with the derived set);
  - **cached vs fresh props:** a cached projection (identical shape) yields
    the same `Model.Info` as a fresh one for the same model — mapping is
    source-agnostic; fresh beats cache when both present for an id;
    cache entry invalidated by args mismatch → fallback path (defaults),
    not an error;
  - override precedence (name/limit/capabilities/variants/disabled) —
    explicit `variants` beat auto-derived in both loaded and unloaded states;
  - **aliases:** an alias entry carries its own `id`, the target's
    `modelID`, and the target's props-derived values, with alias-level
    overrides applied on top (`name`/`variants`/`disabled`); target absent
    from the fetched list → alias omitted; alias key equal to a discovered
    id (or duplicate) → rejected, no entry; alias of an `enabled: false`
    target inherits `enabled: false` unless overridden;
  - **extraVariants:** merged into the derived set (derived order kept,
    extras appended); a same-`id` extra replaces the derived entry;
    composes with an explicit `variants` base (replace, then merge);
  - unloaded policies: include / exclude / disable;
  - status classifier: `loaded`/`sleeping` → props consulted;
    `unloaded`/`loading`/`downloading`/`downloaded` → props ignored (null
    path), no crash (all six b11277 values); **missing `status` field
    (plain server) → treated as loaded** (props consulted);
- `discover.test.ts` — response shape validation: valid list, empty list,
  non-array, bad JSON, missing `data` (each → models or `null` correctly);
  plain single-instance shape (§2.7: no `status`/`architecture`, has
  `meta`) → one entry, no crash; fetch failure → `null` (via injected
  fetch stub).
- `options.test.ts` — resolution precedence matrix (ctx.options ▸ file ▸
  defaults), JSONC stripping (comments, trailing commas), missing file.
- `sse.test.ts` — frame parser + scheduling (injected chunks/clock):
  `data: {json}\n\n` framing; frames split across chunk boundaries and
  multiple frames per chunk; malformed frame → skipped, no crash;
  coalescing: N events while a refresh is in flight → at most one extra
  refresh scheduled; backoff schedule 1 s, 2 s, 4 s, … capped at 60 s;
  404/405 → disabled, no reconnect.
- `hash.test.ts` — stability (same input → same hash), sensitivity to real
  changes (context size, variant add/remove, enabled flip), insensitivity to
  order and to ignored fields (args/preset text); props jinja cannot leak by
  construction (never projected).

### 6.2 Static checks

`pnpm typecheck` = `tsc --noEmit` (strict, NodeNext) over `src/` incl.
tests; `pnpm test` = `vitest run`. The toolchain (node 26 + pnpm) comes
from `mise.toml` (§3); CI (GitHub Actions) runs `jdx/mise-action@v4`,
`pnpm install --frozen-lockfile`, then typecheck + vitest on push.

### 6.3 Manual E2E checklist (on this machine, before publish)

1. Add dev `plugins` entry to global config; apply §5 config migration.
2. `opencode service restart`; grep server log: plugin loaded, initial
   inventory size 4, no errors.
3. Model listing via `opencode api` (models endpoint) → 4 `gpuz/*` models
   with correct limits/capabilities; `q4xl` is text-only.
4. TUI `/models` → same 4 models; the first refresh performs the one-time
   `/apply-template` probe for the loaded Qwen (no inference — confirm in
   the server log that it ran); its variants show
   `low/medium/xhigh/no-think` from the explicit override (which always
   wins, §4.3) — to confirm the *derivation* rule, temporarily drop the
   override's `variants` and verify the same four derived variants appear
   from the cached probe (no second probe); the three unloaded models show
   override/default variants only (fresh install — the props cache is empty
   until each has been loaded at least once); a new session can run a
   prompt through `gpuz/qwen3.8-27b-q5xl-dflash2#xhigh` (regression check
   that request behavior is unchanged).
5. **Live add (SSE):** add a preset on gpuz → appears near-instantly via
   the SSE event (§2.8), well within `refreshMs`, no restart; repeat with
   `sse: false` → appears within `refreshMs`.
6. **Live remove (SSE):** remove a preset → disappears near-instantly
   (`model_remove` event).
7. **Outage:** stop the gpuz service → `/models` still shows last-good
   inventory (no blanking, no error spam beyond one warn per poll).
8. **Recovery:** restart service → inventory reconciles.
9. **Restart stability:** `opencode service restart` → inventory present
   immediately (storage pre-seed) even with service stopped.
10. **Load-state flips + props cache:** load an unloaded preset on gpuz →
    within `refreshMs` its template-derived variants appear (one rebuild;
    cache seeded); let it go idle → `sleeping`, variants persist (props
    still fresh); force-unload it → variants **persist from the cache** (no
    revert, no rebuild); `opencode service restart` with gpuz stopped →
    inventory *and* cached variants restore from `ctx.storage` (item 9);
    remove the preset on gpuz → entry disappears within `refreshMs` and its
    cache entry is evicted (verify the plugin storage's `props-cache` no
    longer contains the id).
11. **Plain single-instance server (portability, §2.7):** run a local
    `llama-server -m <small.gguf> --ctx-size 4096 --port 8081` (no router);
    add a scratch provider (`settings.baseURL: "http://127.0.0.1:8081/v1"`)
    - a second `plugins` entry with `providerID: "plain"` → one
    model appears with props-derived capabilities and the derived variant
    set; no 400s in the server log; `limit.context` = 4096 via props
    `n_ctx`; then with `--sleep-idle-seconds 30` let it sleep → the model
    stays listed, variants persist, and polls wake nothing (cached props,
    no probe re-run — `is_sleeping: true` gates it).
12. **SSE reconnect + catch-up:** `kill -9` the gpuz router process, then
     restart the service while the stream is down and add a preset → server
     log shows stream close + reconnect with backoff, and the catch-up
     refresh on reconnect publishes the preset (timestamp check: not the
     safety-net timer); with `--api-key` on the router and the key in the
     provider's top-level `headers` → SSE connects (no 401s in the log).

Exit criteria: all unit tests green, typecheck green, checklist 1–12 pass.

---

## 7. Publishing

1. **npm** — package name `llama-sync` (unscoped, personal).
   Manifest per the official Publish section:

   ```json
   {
     "name": "llama-sync",
     "version": "0.1.0",
     "type": "module",
     "exports": { ".": "./src/index.ts" },
     "packageManager": "pnpm@12.4.2",
     "files": ["src", "README.md", "LICENSE", "options.example.jsonc"],
     "dependencies": { "@opencode/plugin": "latest" }
   }
   ```

   `pnpm publish --access public` from a clean tag (`v0.1.0`).
   Revisit pinning `@opencode/plugin` to a known-good version once a
   compatible release is confirmed (docs show `latest`).
2. **GitHub** — `mattzink/llama-sync` (this repo, pushed as-is).
   README: what/why, install (`opencode plugin add …`), options reference,
   llama.cpp service notes (router vs plain server per §2.7; endpoint shapes
   incl. `/props` + the `chat_template` context hazard; change notification
   via router SSE (§2.8) + the safety-net poll; unloaded policy + the
   persistent props cache), development (mise toolchain,
   typecheck/test), license.
3. **CI** — GitHub Actions: `jdx/mise-action@v4` (node 26 + pnpm per
   `mise.toml`), `pnpm install --frozen-lockfile`, typecheck, `vitest run`
   (same pattern as gravwar).
4. **Switch this machine to the published spec** (or the git spec) once
   published; keep the dev entry until then.

---

## 8. Risks & open questions

| # | Item | Mitigation / decision |
| --- | --- | --- |
| R1 | `models.set` may only replace *plugin-owned* inventories, not a config-defined provider's | Design decision to make during implementation: verify with log + API listing. Fallback: `ctx.model.transform` adding/updating each model under the available provider (documented to allow adding under available providers). Same user-visible outcome. |
| R2 | Endpoint shapes are llama.cpp-server extensions, not standard OpenAI (`/models` enrichment, `/props`), and the router-specific fields (`status`, `architecture`, `source`) are absent on plain single-instance servers | Source-verified compatibility matrix for both modes (§2.7); defensive parsing where a missing field falls through the derivation chain (props first) to options/defaults; failure keeps last-good (a per-model props failure degrades gracefully, §4.3). Options allow `modelsPath`/`propsPath` + defaults so other compatible services can be served later. |
| R3 | The selected default model gets removed from the service inventory mid-use | OpenCode surfaces `Model unavailable`; acceptable, documented in README. Plugin never auto-reselects. |
| R4 | Verbose endpoint payload (args/preset, ~10 KB jinja template per model) | Store/hash only the minimal projection (§4.2); props whitelist drops the template at the parse boundary (§2.2.1); storage stays small. |
| R5 | Double-load if the directory ever moves under a discovery path | §4.6: explicit-entry-only installation; add a README note. |
| R6 | Full props require a running child (b11277: router `/props` proxies to the instance; `autoload=false` + unloaded → 400 by design). The tempting fix (`autoload` default) is worse: it *loads* unloaded models and, with `max_instances: 1`, LRU-evicts the active one | Default `propsForUnloaded: "never"` + skip props for non-running statuses (§4.2). The **persistent props cache** (§4.2 step 4) then carries last-known values: after a first load, derived variants/modalities survive sleep *and* full unload; only never-loaded (or repointed) presets run on defaults. The 1 h sleep window keeps props fresh in between; one rebuild only on first-ever load. Opt-in `"autoload"` exists for operators who accept eviction. Documented in README. |
| R7 | `chat_template` jinja contains media-placeholder tags (`__media__`) that poison any LLM context they enter (agent probing, log dumps, persisted text) — placeholder reads as an mmproj media reference and the model/agent fails | Whitelist parse at the boundary; in-place bounded signals only; template never stored/hashed/logged/forwarded; jq-whitelist probing discipline for humans/agents (§2.2.1); hygiene unit test asserts no `__media__` leak. |
| R8 | Effort levels have no structured field, and literal presence in the jinja is misleading (the Qwen template quotes `'high'` only as a deprecated alias and *raises* on unsupported levels) | Two-stage derivation (§4.3): static acceptance-guard/default/comparison read + one-time `POST /apply-template` render probe (hash classes: mapped / default-alias / rejected), cached per template digest so it runs once per template; alias classes emit the canonical level; probe failure degrades to the static set; `variantReasoningEfforts` restricts; explicit `variants` override always wins; switch to a structured field if llama.cpp exposes one. |
| R9 | `status.value` has six values (downloading/downloaded/unloaded/loading/loaded/sleeping); gpuz currently shows only loaded/unloaded, but transient states can appear mid-refresh | Pure status classifier (§4.2 step 3): props fetched only for `loaded`/`sleeping`; `loading`/`downloading`/`downloaded` → props `null` for that poll, no special-casing, no crash; unit-tested across all six values. |
| R10 | The persisted props cache can go stale if a preset is repointed to a different model file/template under the same id | Bounded staleness: the `n_ctx` vs `--ctx-size` guard invalidates the entry (§4.2 step 4); any other change self-heals on the next load — fresh props overwrite the cache within one poll, and an unloaded model is not served until it loads anyway; deregistered ids are evicted so the cache never grows unbounded; `propsCache: false` disables the mechanism entirely. |
| R11 | Verification so far ran against one configuration (gpuz router, b11277); other recent configurations may differ (plain single-instance, different `max_instances`/`models_autoload`, sleep on/off, older recent builds) | Every gpuz-specific observation in this plan is labeled as such; the §2.7 matrix is source-verified for both modes and every router-only field has an explicit fallback (no-status → loaded; no `architecture` → props `modalities` → defaults; no args → guard inert; props params ignored on plain); the probe is gated on `is_sleeping` so nothing ever wakes a sleeping model; plain-server E2E is checklist item 11; the version floor is stated (builds with `/props` incl. `chat_template_caps`). |
| R12 | The SSE stream has no keepalive and no history (§2.8): a silently dropped connection (network blip without RST) is undetectable from the stream, and events missed while disconnected are not replayed | SSE is a change detector, never a data source: every event and every (re)connect triggers a full re-fetch (§4.2 step 10); the `refreshMs` poll runs unconditionally and bounds worst-case staleness; clean disconnects (process exit) are observable and trigger reconnect + catch-up; `sse: false` gives the previous polling-only behavior with no other difference |
| Q1 | npm package name / license (MIT) | Name `llama-sync` verified available 2026-09-30: npm registry 404. Sole exact GitHub match is `shyeetsao/llama-sync` — a dormant 0-star Python repo (Jan 2024, no description), no conflict; `mattzink/llama-sync` does not exist yet. Prior art (not a conflict): `eddiecsilva/opencode-llama-sync` — a 0-star personal shell script that registers llama.cpp models into `opencode.json` one-shot; it validates the problem space but does no live watching, props, or variant work. Defaults as written; trivial to change before publish. |
| Q2 | `includeUnloaded: true` default | Chosen on the assumption a router auto-loads on demand (gpuz: `models_autoload: true`, verified); inert on plain servers; flip via option if wrong. |

---

## 9. Implementation order

1. Scaffolding: `mise.toml` (gravwar pattern: node 26, pnpm via
   `packageManager`, `node_modules/.bin` PATH, `setup` task),
   `package.json` (incl. `packageManager`), `mise install` + `pnpm install`
   (generates `pnpm-lock.yaml`), `tsconfig.json`, `.gitignore`, vitest config.
2. Pure modules + unit tests (`options`, `hash`, `map`, `discover`,
   `props` — whitelist parser, template digest + static candidates, pure
   props-cache merge/evict/validate helpers; `probe` — render
   classification; `sse` — frame parser, coalescing, backoff schedule)
   — capture live fixtures (props `chat_template` redacted to the
   `__media__` sentinel) while probing via jq whitelists, and synthesize
   the plain-server fixtures per §2.7 (`plain-models.json`,
   `plain-props.json`) — all green before touching `ctx`.
3. `src/index.ts` lifecycle wiring (refresh loop + SSE connection, §2.8).
4. Local install + config migration (§5), run E2E checklist (§6.3).
5. README, LICENSE, CI workflow; push to GitHub.
6. `pnpm publish --access public`; switch this machine to the published spec.

---

## 10. Deviations from plan & implementation findings (2026-10-01)

### 10.1 Tooling & packaging

1. **Latest tool versions** (user instruction: use the latest available, per
   plan §7): `typescript@7.0.2` (plan §3 assumed ^5.x-era), `vitest@5.0.3`
   (assumed ^3.x-era), `@types/node@^26.6.3`, pnpm 12.4.2, Node 26
   (`mise.toml`). All green.
2. **`@opencode/plugin` pinned `^2.0.20`** (the version actually
   implemented and tested against; package.json initially said `latest` —
   repinned before publish so installs are reproducible).
3. **Root `index.ts` added** (one-line re-export of `./src/index.js`):
   OpenCode resolves *local-directory* plugin entries to `<dir>/server.*`
   or `<dir>/index.*` at the directory root (`Host.resolve`); it does not
   read `package.json` `exports` for that case. npm and git installs go
   through `exports["."]` and are unaffected. Documented in README
   (Development).

### 10.2 Migration (plan §5)

4. **Plan-strict overrides**: the migrated `options.overrides` carry
   exactly the §5-prescribed content — `qwen3.8-27b-q5xl-dflash2` →
   `name: "Qwen 3.8"` + 4 variants, `qwen3.8-27b-q4m-dflash2` →
   `name: "Qwen 3.8 Fast"` + same 4 variants. Nothing extra.
5. **Stale id corrected**: plan §5 line for the Fast model says
   `qwen3.8-27b-q4-dflash2`; the actual preset id on the service is
   `qwen3.8-27b-q4m-dflash2` (the migration uses the real id, so the
   override matches the inventory).
6. **Hot-reload migration, no restart needed**: this development session
   runs *inside* the live opencode service (systemd `opencode.service`,
   `serve --service` on port 80), so `opencode service restart` cannot run
   mid-conversation. All plugin behavior was therefore verified on an
   isolated scratch instance (`serve --service` under a private XDG tree,
   same provider config) first; the real `opencode.jsonc` was then
   migrated as a **single atomic write** (static `models` map removed +
   `plugins` entry added in one file rewrite → one config reload). The
   live service picked it up via its config watcher: `llama-sync` went
   ACTIVE within seconds and published the full 4-model gpuz inventory
   (verified via the live service API, including `video` input modality on
   `q5xl-dflash2` from live `/props` — richer than the old static config).
   The pre-migration config is saved as
   `~/.config/opencode/opencode.jsonc.bak-20261001-llama-sync`. A
   `opencode service restart` remains an optional clean-boot check, not a
   requirement. The migration used the dev local-directory entry
   (`"package": "/home/mattzink/llama-sync"` — the exact E2E-verified
   shape); after npm publish it switches to the npm spec `"llama-sync"`.

### 10.3 E2E environment (plan §6.3)

7. **Scratch API auth**: plain `serve` returns 401 on `/api/*` in this
   deployment; the scratch ran with `serve --service`, whose Basic-auth
   password (`opencode:<pw>`) is written to
   `$XDG_STATE_HOME/opencode/state/opencode/service.json`.
8. **Deterministic SSE verification via a local mock router**
   (127.0.0.1:8091, Python, logs every request) instead of mutating the
   live router: single emitted frame → exactly **one off-cycle**
   `GET /v1/models` (PASS); 3-frame burst → 3 refreshes (scheduler
   semantics, §10.4.13). Live-router SSE verified separately by
   raw-socket frame capture and the router's `?reload=1` broadcast canary;
   captured live frame: `data: {"model":"*","event":"models_reload"}`
   (wildcard, no `data` field — `parseSseEvent` is event-name-agnostic).
9. **Checklist coverage**: items 1–6, 9, 12 verified in E2E (item 5/6 via
   mock emit; the live broadcast path via captured frame shape). Items 7–8
   (stopping gpuz / recovery), 10 (load-state flip), 11 (plain
   single-instance server) were **not** run live: destructive to the live
   service (which is also this session's own provider) or impossible
   locally (no `llama-server` binary on this machine) — covered by unit
   tests and the §2.7-synthesized plain fixtures instead.
10. **E2E harness lives in `/tmp/opencode/e2e`** (network tests, mock
    router, socket probes, scratch XDG tree) with a symlinked
    `node_modules` — the repo itself carries no E2E artifacts.
11. **OpenCode repo moved**: the plugin-loader source of truth is now
    `anomalyco/opencode` (v2.0.20), not `sst/opencode`.
12. **Tooling quirk**: `ss` renders remote port 8080 as `http-alt`
    (grepping for "8080" misses the router connection).

### 10.4 Runtime findings (behavior verified; no code change beyond the plan)

13. **Scheduler burst semantics** (mock-verified): a pending rerun bypasses
    `minInterval`, and events arriving *during* an in-flight run chain
    exactly one further rerun. A 3-frame burst straddling two in-flight
    runs produced 3 refreshes — the initially-drafted test expectation of
    "2" was wrong, not the code (matches §2.8 design).
14. **Plugin re-activation semantics**: the supervisor takes an
    index-aligned prefix diff of the `plugins` array — *any* edit
    (including one that merely shifts an existing entry's index)
    re-activates the plugin (full teardown + setup). Provider-section
    edits (e.g. `baseURL`) also re-activate; the new setup reads the new
    provider for both the refresh and the SSE connection (an early
    observation that provider edits don't re-activate was refuted — it was
    explained by the re-run setup using the new baseURL for both).
15. **Startup / re-activation race**: plugin setup runs before provider
    registration, so the first refresh is inert ("provider not found or
    has no settings.baseURL") and the first SSE attempt fails; recovery
    comes ~1 s later via the SSE-retry catch-up refresh (plain servers:
    first 30 s poll). With a stored inventory, models are seeded from
    storage at 0.0 s regardless (preseed verified: all 4 gpuz models
    present at boot before the first successful refresh).
16. **SSE idle close at ~300 s**: the Bun client stack closes the plugin's
    idle SSE connection after ~5 minutes (the router sends no keepalives).
    Evidence: a raw-socket probe survived 340 s idle (router and network
    exonerated); the localhost mock stream survived its 283 s max idle
    stretch (aborted by teardown just short of the mark); the old
    scratch instance's close lines fit `connect + ~300 s` lifetimes
    (first observed close at 298 s). The plugin handles it exactly as
    designed: one warning, backoff reconnect (~1 s), immediate catch-up
    refresh, `refreshMs` poll as backstop — worst-case staleness ≤ one
    poll interval. Documented in README ("Stream lifetime"). The apparent
    phase-lock of the close lines to the built-in 300 s models.dev catalog
    refresh (`packages/core/src/models-dev.ts`, which emits
    `provider.updated`/`model.updated` each cycle) is a log-interleave
    artifact: the untimestamped plugin stdout lines fall into the same
    5-minute log window as the catalog events.
17. **Plugin console output**: with a directly-started
    `serve --print-logs`, plugin `console.warn` lines appear in the
    service log as raw, untimestamped `[llama-sync]` stdout lines
    interleaved with structured lines (grep `\[llama-sync\]`). A healthy
    run is completely silent (no publish on hash-equal refreshes, no
    closes). E2E verification therefore relied on side effects (API
    listings, `ss` sockets, the DB `kv` storage row, mock request logs)
    rather than log lines.
18. **Second ESTAB to the mock** observed during E2E is Bun's keep-alive
    pool holding a second connection — not a second SSE stream.

### 10.5 Code-level notes (implementation details vs plan prose)

19. `createScheduler` lives in `src/sse.ts` (there is no
    `src/scheduler.ts`; plan §4 layout wording).
20. The `ctx.storage.set` value type is expressed as
    `Parameters<Plugin.Context["storage"]["set"]>[1]` to avoid importing
    Effect types in the plugin entry.
21. **Probe-failure caching clarified**: a transient probe failure
    (`"failed"`) is never cached terminally — `resolveEffort` reuses the
    cache only when it is consistent with the current template digest
    (preserving probed levels or the `probeUnsupported` flag), and a
    static stand-in *without* `probeUnsupported` re-triggers the probe on
    the next refresh (`shouldProbe`).
22. **Aliases follow target visibility**: an alias whose target is present
    in `/models` but *hidden* by `includeUnloaded: false` is skipped with
    one warning (plan §4.3 only spelled out "target absent this poll").
23. **Live template quirk**: the Qwen `reasoning_effort` jinja has an
    *empty* `comparisons` array (plan fixtures assumed populated ones);
    static derivation falls through the guard-preferred signal chain
    (`props.ts`), which handles it — the derived set for gpuz still comes
    out `low / medium / xhigh / no-think`.
24. **Hygiene held**: `chat_template` (`__media__`) never reached storage,
    logs, or hashes at any point (§2.2.1 discipline followed end-to-end).

### 10.6 Publish status (2026-10-01)

- Committed: `19a5746` on `main` (all code, tests, docs, packaging).
- `git push` to `github.com/mattzink/llama-sync` and `npm publish
  --access public` (name verified available per Q1) are **pending
  credentials**: this machine has no GitHub auth (no gh CLI, no SSH key,
  no credential store) and no `~/.npmrc` token (`npm whoami` →
  ENEEDAUTH). Once auth exists: `git push -u origin main`, then
  `pnpm publish --access public`, then flip the `package` value in the
  migrated `opencode.jsonc` from the dev path to `"llama-sync"`.
