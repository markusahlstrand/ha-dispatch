# HA Dispatch

Durable, AI-native automation for Home Assistant. Like node-red, but with retries, memoization, and LLM calls that don't blow your API budget.

## What's different

- **Flows survive restarts** — a `step.sleep("2 hours")` still fires even if HA reboots.
- **Every step is retried and memoized** — expensive LLM or HTTP calls never run twice for the same input.
- **TypeScript, not JSON** — flows are code, version-controlled, testable.
- **Bring your own flows** — pick from bundled flows, install from a marketplace, or write your own.

## Bundled flows

- **energy-optimizer** — price-aware EV charging and battery scheduling (PVPC, Solcast, Deye, Tesla)
- *(more coming — presence-notify, laundry-done, doorbell-ai, price-alert)*

## Install

In Home Assistant, go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add:

```
https://github.com/markusahlstrand/ha-dispatch
```

Then install the **HA Dispatch** add-on from the store.

## Development

```bash
cd ha-dispatch
npm install
npm run build
```

## License

MIT
