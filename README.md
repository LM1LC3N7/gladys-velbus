# Velbus for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com):
**Velbus** home automation (Belgium, Netherlands), **locally** through a
network gateway: a **Signum** (TLS, with its password) or a **TCP gateway**.
USB directly on Gladys is not supported.

> **Never tested with a real installation.** Unofficial, not affiliated with
> Velbus.

- Bus scan: every module at addresses 1 to 254, with the channel names set in
  VelbusLink.
- Relays: switches, or lights by configuration. Dimmers: lights with their
  brightness. Blinds: shutters with their position (never a switch).
- Thermostats: temperature, set point, mode (comfort, day, night, frost
  protection), heating or cooling, running; changing them from Gladys is
  **off by default**, and decided on the thermostat read from the bus just
  before.
- Push buttons: a scene trigger (pressed, held, released).
- One connection, spaced reconnections, a watchdog; the Signum password is a
  secret field, only sent over TLS, never logged; an optional pin of the
  Signum certificate.

User guides: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (Node 22 and 24), against an in-memory bus
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npx github:GladysAssistant/integration-store .
```

Layout: `src/velbus/` (frames, messages, module table, connection),
`src/app.js` (model, devices, states, scene events, commands),
`src/devices.js`, `src/publisher.js` (rate limits),
`test/helpers/fakeBus.js` (the simulated gateway and bus, and a virtual
clock). `src/velbus/module-table.js` is generated from velbus-aio's module
descriptions by `scripts/generate-module-table.mjs`. See `CLAUDE.md` and
`TODO.md`.

## Credits and licence

Apache-2.0 (`LICENSE`). The protocol is ported from
[velbus-aio](https://github.com/Cereal2nd/velbus-aio) 2026.9.0 by Maikel Punie
(Apache-2.0 / MIT), itself partly built on python-velbus by Thomas Delaet
(MIT): see `THIRD_PARTY_NOTICES.md`.
