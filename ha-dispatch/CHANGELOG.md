# Changelog

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
