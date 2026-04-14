# Changelog

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
