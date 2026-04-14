# Changelog

## 0.1.23 — 2026-04-14

- Device registry access + HA ↔ Shelly bridge. "Shellys in the laundry?"
  is now a one-tool question.
- New `src/ha/device-registry.ts` — renders a Jinja template that
  enumerates every entity with its device_id, device_name,
  manufacturer, model, area_id, area_name, and configuration_url, then
  groups by device_id. HA's device/area registries are WebSocket-only
  over REST otherwise, so the template endpoint is our backdoor.
- HAClient gains `renderTemplate(template)` (POST /api/template).
- New `list_devices` tool (src/tools/device-tools.ts) with filters for
  area, manufacturer, model, entity_substring. Returns grouped devices
  with entity counts and the configuration_url where HA has one.
- New `shelly_import_from_ha({area?, auto_register?, password?})` tool.
  For most users, every Shelly they own is already integrated into HA
  — this tool pulls them out of the device registry, extracts the IP
  from configuration_url, and (when auto_register is true) probes and
  registers each one with Dispatch in one call. The agent no longer
  has to ask for IPs manually.
- Chat system prompt reorganised: use list_devices for room/device
  questions; call shelly_import_from_ha FIRST before falling back to
  shelly_add with a manual IP.

## 0.1.22 — 2026-04-14

- Shelly adapter (Phase 1). Dispatch can now talk to Shelly Gen2+
  devices directly — not just through Home Assistant — and generate
  Shelly Scripts on the fly. This unlocks multi-system orchestration
  via chat: e.g. "notify me when the laundry machine finishes" ends up
  as a Shelly Script running on the device that posts a webhook to HA.

- New `src/adapters/shelly/`:
    client.ts    — Gen2+ RPC client with HTTP digest auth, chunked
                   Script.PutCode, and an installScript convenience
                   that creates-or-updates + starts in one call.
    scripts.ts   — Bundled mJS templates:
                     power_threshold_webhook — post to a webhook when
                       apower crosses a threshold (with cooldown +
                       hysteresis).
                     cycle_finish_webhook    — detect laundry/
                       dishwasher end-of-cycle via run→idle+debounce.
    types.ts     — ShellyDeviceInfo, ShellyScriptEntry, KnownShelly.
    index.ts     — facade export.

- New `src/tools/shelly-tools.ts` exposes 8 tools:
    shelly_add              register a device by IP (probes, stores).
    shelly_list             enumerate known devices.
    shelly_info             device info (model, firmware, auth_en).
    shelly_status           full status snapshot.
    shelly_call             raw RPC passthrough (advanced).
    shelly_list_scripts     scripts on a device.
    shelly_install_script   template- or raw-mJS-driven install+start.
    shelly_remove_script    stop + delete by name or numeric id.
  Known devices persist under KV `shelly:device:<id>` plus a
  `shelly:index` array; scripts managed by Dispatch are named with the
  `dispatch_` prefix so they are identifiable.

- Chat system prompt teaches the model when to reach for Shelly (when
  behavior should live on the device itself), to prefer templates over
  raw mJS, and to ask for an IP if shelly_list is empty.

## 0.1.21 — 2026-04-14

- Chat can now actually create Home Assistant automations. Previously
  the agent had the automation-writer behind it but no matching tool,
  so when asked to create an automation it hallucinated "I can't do
  that" and stopped.
- New `src/tools/automation-tools.ts`:
    create_ha_automation   — raw HA automation upsert via /api/config/
                             automation/config/; accepts trigger /
                             condition / action / mode; names the
                             automation `dispatch_ad_hoc_{slug}`.
    list_ha_automations    — see what Dispatch has deployed so far.
    remove_ha_automation   — undo one by slug.
    list_flows             — what Dispatch flows exist + config_schema +
                             current_config + deployed state.
    configure_flow         — write a flow's config.
    deploy_flow            — for native flows, materialize + push YAML.
    disable_flow           — for native flows, remove from HA.
- ToolContext gains optional Storage so tools that invoke the flow
  runner (deploy_flow) get the real adapters instead of a shim.
- Chat system prompt now tells the model explicitly: you CAN create
  automations; here's the workflow (confirm entities → plan → call
  create_ha_automation → verify with list_ha_automations). Forbids
  the old "I can't do that" hallucination.

## 0.1.20 — 2026-04-14

- Learnings (shared memory). Every LLM call that reasons about this HA
  installation now pulls from — and can write to — a single learnings
  store. The assistant stops re-discovering the same quirks every turn.
- New `src/memory/` module:
    - learnings.ts — typed Learning + KV-backed LearningsStore
    - prompt.ts — buildHAContext(store) assembles persona + learnings
      into a shared system prompt; every HA-touching LLM call uses it.
- `record_learning` tool added to the chat toolkit. The assistant calls
  it when it figures out something non-obvious (an entity alias that
  reports `unknown` but a real device entity works; a user preference;
  a working control pattern). One-sentence, with entity_ids.
- Wired into three call sites so far: chat freeform agent, energy
  optimizer entity classification, flow-suggestions generator. All
  three now receive the same learnings context.
- Chat system prompt now instructs the model to prefer entities with
  real-valued state over template/alias entities that report
  `unknown`, and to record learnings when useful.
- New UI tab "Memory" lists all learnings (category chip, timestamp,
  entity ids, inline delete). Add manual learnings with + button.
- API: GET / POST / PATCH / DELETE /api/learnings.

## 0.1.19 — 2026-04-14

- Chat tool execution. The free-form chat assistant can now actually
  call Home Assistant — and is no longer allowed to claim it did
  things it didn't.
- New tool framework under `src/tools/`:
    list_states({domain?, limit?})  — discover entities
    get_state({entity_id})          — read one entity in detail
    list_areas()                    — enumerate HA areas
    call_service({domain, service, entity_id?, data?}) — execute + verify
- Service-call verification: after `call_service`, the verifier polls
  the affected entity for up to ~6s and checks the new state matches
  the expected outcome (light.turn_on→on, cover.open_cover→open via
  opening, lock.lock→locked, etc.). The tool result includes
  `verified: true | false | undefined` so the LLM can be honest.
- LLM provider gained `chatStep()` for multi-step tool-calling loops.
  Gemini implementation uses Google's `functionDeclarations` /
  `functionCall` API and a `function`-role turn for tool responses.
- Chat agent refactored: instead of single-shot `generateJson`, it
  runs up to 6 tool-call iterations per user turn. Each tool call is
  recorded to the diagnostic buffer and surfaced in the message as a
  collapsible "N tool calls" tray (entity ids, args, latency, verified
  badge, verification note).
- System prompt enforces honesty: the model must NOT claim success
  unless a tool call returned `verified: true`. If verification failed
  or wasn't possible, it has to say so.

## 0.1.18 — 2026-04-14

- Native flows. New `NativeFlow` type alongside `ManagedFlow`: instead
  of running in Dispatch's runtime, a native flow generates a Home
  Assistant automation YAML and POSTs it to /api/config/automation/
  config/. HA owns triggers, traces, scheduling, history from then on.
  Flows you can read or edit in HA's automation panel — and that
  survive Dispatch being uninstalled.
- New `src/ha/automation-writer.ts` adapter (upsert / remove / get /
  reload). Names automations `dispatch_{flow_id}` so we can identify
  ours; tags the description with `[dispatch_managed]` for safety.
- New `motion-lights` flow: turn on lights when motion sensor goes on
  (any binary_sensor — works with Unifi cameras, Aqara, PIR, etc.),
  for N minutes (default 30), restart timer on re-trigger, optional
  "only after sunset" condition. Mixed light/switch entity targets
  supported.
- `Flow` is now a discriminated union (`mode: 'managed' | 'native'`).
  Type guards `isNativeFlow` / `isManagedFlow` for safe narrowing.
- Flow runner gained `runNative` + `disableFlow`. Native runs record
  the deployed entity_id under KV `native:{flowId}:entity_id`.
- API: list + detail expose `mode`, `deployed`, `haEntityId`. New
  POST /api/flows/:id/disable removes a deployed native automation.
- UI: native flow cards show "Native HA" + "Deployed/Not deployed"
  badges. Detail page swaps "Run now" for "Deploy/Update HA
  automation" + "Remove from HA". Config form supports `entity` and
  `entity[]` field types (textarea, one per line) and `boolean`
  (checkbox).

## 0.1.17 — 2026-04-14

- Diagnostics module. Captures key events (LLM calls with provider /
  model / latency / ok flag, inventory builds, flow runs, errors,
  user-submitted notes) to a rotating KV buffer (last 250). New
  `src/diagnostics/` with a recorder + report bundler. Secrets are
  redacted before persistence.
- New endpoints under `/api/diagnostics`: GET returns a downloadable
  report with recent events, persona snapshot (no API keys), inventory
  summary (counts only), and recent flow runs. POST /note records a
  user note. DELETE clears.
- UI: header has a small "⬇ report" button that prompts for an
  optional note, then downloads `dispatch-report-{ts}.json`. Paste it
  back to me when something gets stuck and I'll see exactly what
  happened.
- Onboarding UX fix: when you submit your name(s), an immediate
  "Looking around..." bubble appears so the inventory wait isn't
  silent. Failures show a real message + a hint to use the report
  button instead of leaving the form spinning.
- LLM provider exposes a `tag` parameter so each call shows up labeled
  in the report (e.g. discover.energy-optimizer, chat.freeform).

## 0.1.16 — 2026-04-14

- Chat is now the default landing. New `src/chat/` module with persona,
  inventory builder, capability templates, onboarding state machine and
  free-form chat agent. Storage goes through AppStore.kv so personas
  survive restarts and persist alongside everything else.
- Onboarding flow: assistant greets and asks for names → builds a live
  inventory of HA entities/automations/areas → asks the user which
  capability templates interest them (lights, energy, security, water,
  climate, notifications) → if Gemini is configured, generates 4-6
  tailored automation ideas based on the actual hardware.
- Free-form chat after onboarding routes through Gemini with the
  persona's system prompt + a tight inventory summary + recent history.
  Tools (real action execution) come in 0.1.17.
- New endpoints: GET/POST /api/chat, POST /api/chat/action,
  DELETE /api/chat, GET /api/chat/inventory.
- Flows view moved to a second tab (#/flows). Existing functionality
  unchanged.

## 0.1.15 — 2026-04-14

- HA entity publishing. Flows can return `publish: PublishSpec[]` from
  their result and the runner POSTs each spec to /api/states/ — they
  appear as first-class HA sensors named `sensor.dispatch_{flow}_{key}`
  with proper device_class / unit / state_class so they integrate with
  the energy dashboard, voice assistants, and Lovelace cards.
- Energy Optimizer now publishes:
    sensor.dispatch_energy_optimizer_estimated_savings   (EUR)
    sensor.dispatch_energy_optimizer_next_action         (text)
    sensor.dispatch_energy_optimizer_next_charge_start   (timestamp)
    sensor.dispatch_energy_optimizer_cheapest_window_price (EUR/kWh)
    sensor.dispatch_energy_optimizer_reasoning           (text + attrs)
- New `src/ha/entity-publisher.ts` — narrow public API behind which the
  REST POST lives. Adapter pattern stays clean; flows never touch HTTP.

## 0.1.14 — 2026-04-14

- Storage adapter refactor. Split the old `Database` interface into three
  orthogonal adapters — `KVAdapter`, `DatabaseAdapter`, `BlobAdapter` —
  under `src/adapters/`, with a `Storage` bundle that callers depend on.
  Added the sql.js implementations and a local filesystem blob adapter;
  future Cloudflare/D1/R2 implementations drop in without changing any
  call site.
- New `src/store.ts` with typed domain helpers (saveFlowRun, getMapping,
  kvGet, ...) built on the adapter bundle. `FlowContext` now exposes
  both `store` (domain) and `storage` (raw adapters) so flows pick the
  right level.
- Delete old `src/db.ts`. All call sites migrated to async store methods.

## 0.1.13 — 2026-04-14

- LLM-first entity discovery. When `llm_api_key` is set, the energy
  optimizer's setup wizard sends a filtered entity inventory to
  Gemini Flash and asks for a structured mapping with per-entity
  rationale. Falls back to the regex heuristics when no key is set or
  the call fails. Mapping UI now shows the AI's rationale for each pick.
- New `POST /api/suggestions` endpoint: LLM scans the full entity
  inventory and proposes 3-6 automation flows tailored to what's
  actually installed. The flow list renders them as cards.
- Pluggable `LLMProvider` abstraction in `src/llm/` (Gemini first;
  OpenAI/Anthropic as TODOs behind the same interface).

## 0.1.12 — 2026-04-14

- Tighten energy-optimizer entity discovery heuristics after cross-check
  against a real Deye + Tesla + PVPC setup:
  - battery_soc now rejects personal-device batteries (iPhone, watch,
    laptop, zigbee sensors) and requires an inverter/home/storage context.
  - ev_charger_switch requires an EV context (tesla/model_y/car) AND
    rejects home-battery-related switches that also contain "charging".
  - ev_charger_current looks on the `number` domain (and `sensor`) since
    Tesla integrations expose amperage as number.*, not sensor.*.
  - house_load / grid_power / battery_power penalize per-phase sensors
    (_l1_/_l2_/_l3_) so totals rank above phase-specific values.
  - solar_power excludes kWh counters and forecast sensors.
  - Added ev_charge_cable role (binary_sensor.*_charge_cable) used by
    existing solar-surplus automations as a "plugged in" guard.

## 0.1.11 — 2026-04-14

- Revert the s6 service script (was fighting the base image's
  entrypoint and produced `s6-overlay-suexec: fatal: can only run as
  pid 1`). Back to a plain CMD with `init: false`.
- Read SUPERVISOR_TOKEN directly from /run/s6/container_environment/
  at startup. Those files are written by the Supervisor regardless of
  how the process is launched, so we get the token even without
  `with-contenv`.
- Also dump the list of files present under that directory so we can
  see what the Supervisor staged.

## 0.1.10 — 2026-04-14

- Root cause of the "disconnected" state: the HA base image uses
  s6-overlay, and Supervisor-injected env vars live in
  /run/s6/container_environment/, not the container's native env.
  Processes started via plain `CMD` (with init: false) can't see them —
  hence env keys was only OLDPWD/PATH/PWD/SHLVL.
- Replace the bare `CMD` with a proper s6 service script at
  /etc/services.d/ha-dispatch/run that uses `with-contenv bashio` to
  load the Supervisor env. Remove init: false so s6 runs as PID 1.

## 0.1.9 — 2026-04-14

- Supervisor was not injecting SUPERVISOR_TOKEN into our container
  (verified by dumping env keys — nothing matched). Add
  `hassio_role: manager` and `auth_api: true` which some Supervisor
  versions require before injecting the token, and log the full env
  key list so we can verify what made it through.

## 0.1.8 — 2026-04-14

- Debug logging for HA auth: print which *TOKEN / *HASS* / *SUPERVISOR*
  env vars are set (and their lengths) plus baseUrl + token prefix so the
  401 failure can be diagnosed.
- Ping against /api/config (a reliably authed endpoint) instead of /api/,
  and include HTTP status + body in the error.

## 0.1.7 — 2026-04-14

- Switch HA client from WebSocket to REST (via Supervisor proxy). HA's
  WebSocket auth rejected the add-on's SUPERVISOR_TOKEN with "Invalid
  access", but REST via /core/api/* accepts it (the Supervisor rewrites
  the request with its own admin token). Keeps the same public surface
  (getStates, getState, callService, onStateChange); state-change events
  are now polled every 10s which is plenty for slow-moving energy state.

## 0.1.6 — 2026-04-14

- Stop appending '/api/websocket' inside ha-client. Via the Supervisor
  proxy the correct HA WebSocket path is '/core/websocket' (the proxy
  strips the /api prefix). The hassUrl now carries the full endpoint
  path and the client just normalizes the scheme.

## 0.1.5 — 2026-04-14

- Fix HA WebSocket URL: pass origin only so ha-client's `/api/websocket`
  suffix isn't appended to an already-complete path. Previous value
  produced `ws://supervisor/core/websocket/api/websocket` (404).

## 0.1.4 — 2026-04-14

- Fix dashboard API calls to use relative URLs so HA Ingress path prefix
  is respected. Previously absolute `/api/...` paths escaped ingress and
  hit Home Assistant's own API, causing "API unreachable" in the panel.

## 0.1.3 — 2026-04-14

- Move `NODE_ENV=production` to runtime only. When set before
  `npm install`, npm implicitly becomes `--omit=dev`, so esbuild and
  typescript were skipped and `node build.js` failed with
  ERR_MODULE_NOT_FOUND.

## 0.1.2 — 2026-04-14

- Use official HA base images (ghcr.io/home-assistant/{arch}-base) and
  install Node via apk. Supervisor silently rejects non-allowlisted base
  images, which had caused `npm: not found` during build.

## 0.1.1 — 2026-04-14

- Switch base image to node:20-alpine with multi-arch build.yaml
- Add .dockerignore to keep build context lean
- Tighten config.yaml (drop armv7, unused map/role)

## 0.1.0 — 2026-04-14

Initial release.

- Flow runtime skeleton (loads and runs TypeScript flows at runtime)
- Built-in `energy-optimizer` flow with PVPC price data
- Home Assistant WebSocket client (read entities, call services)
- SQLite state store (sql.js, no native deps)
- Dashboard UI with flow list and per-flow status
