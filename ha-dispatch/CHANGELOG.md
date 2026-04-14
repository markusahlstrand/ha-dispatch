# Changelog

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
