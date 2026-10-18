# TODO - Velbus v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: lot 7 was
  claimed in /t/10385 (post #262); the main session posts one recap per wave.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-18): own TCP / TLS client on
      `node:net` / `node:tls` ported from velbus-aio 2026.9.0 (frames,
      checksum, Signum password, pacing, bus scan, sub-addresses, channel
      names, statuses); module table generated from velbus-aio's module
      descriptions (83 supported types); relays (switch or light), dimmers,
      blinds (state, position), temperature, thermostats (set point, preset,
      mode, running); push buttons as a scene trigger; thermostat commands
      opt-in, decided on a fresh read; "Test the connection"; fr/en. Tested
      against an in-memory bus only (frames checked byte for byte against
      velbus-aio's own `RawMessage.to_bytes()`).
- [x] **Review fixes** (2026-10-18, extra review of 4f1a6cb: 2 blocking, 6
      important, 13 minor): see "Decisions after the review" below.
- [ ] **Milestone 2 - real installation**: run against a Signum and a TCP
      gateway; capture real frames (anonymised) as fixtures; fix what differs
      (see below).
- [ ] **Milestone 3 - more**: DALI (VMBDALI, VMBDALI-20: channels discovered
      on the DALI bus), PIR sensors as motion sensors, counters (VMB7IN,
      VMB8IN-20: energy index, take the lessons on cumulative indexes), the
      VMB4AN analog inputs, the VMBMETEO station, button LEDs, the clock sync
      of velbus-aio, a cache of the scan in `/data` (devices before the scan
      ends), the VLP file of VelbusLink as a source of names.
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real installation

- What a Signum does with a wrong password: closes the connection (handled:
  twice in a row stops), stays silent, or something else.
- Whether a Signum or velserv accepts a second client (VelbusLink, Home
  Assistant) while this one is connected.
- That `FA FF` (status request of every channel) makes a thermostat answer
  `EA` on every thermostat module, including VMB1TS and the -20 panels; the
  fresh read before a thermostat command relies on it.
- That a relay, dimmer or blind module always answers a command with its
  status (the confirmation); otherwise every command shows "sent, without
  confirmation".
- The set point command `E4 00 <t>` sets the current preset's set point
  (velbus-aio sends the same).
- The thermostat on a sub-address (VMBGPO, VMBELO: `ThermostatAddr` 3): its
  status comes from that sub-address (handled through the index), its
  commands go to the main address (as velbus-aio).
- The scan time on a large bus (254 requests 60 ms apart, then 2 s per module
  for the names).
- Names with accents (read as ASCII here, as velbus-aio).
- The "Output" relay (channel 18) of the VMBEL and VMBGP-20 panels: which
  command and status drive it (published read only here, commands refused).
- The reserved bits of the DLC byte (bits 7, 5, 4 must be 0 here): does a
  gateway or a module ever set them?
- Whether a gateway echoes the frames it receives from the client (an echo
  of a type request is an RTR frame: ignored by the watchdog and the model).
- The pace of the answers to a channel name request (up to 99 frames,
  velbus-aio waits 2 s after it): enough on a busy bus?

## Decisions

- **Network gateways only**: the brief excludes USB; velbus-aio's serial and
  `esphome://` paths are not ported.
- **Own client, no dependency**: no maintained Velbus client on npm under a
  usable licence; velbus-aio is ported and credited in
  `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`). Runtime
  dependency: the SDK only.
- **Licence of velbus-aio**: its `LICENSE` file is Apache-2.0, its
  `pyproject.toml` says MIT; both are named in the notice, the code is taken
  under Apache-2.0 (the licence of this integration). velbus-aio reuses
  python-velbus (Thomas Delaet, MIT): credited too.
- **Version 0.1.0, set by hand once**: the template ships 1.0.0; the
  sibling modules start at 0.1.x, so `package.json`, `package-lock.json`, the
  manifest `version` and the `docker_image` tag were set together to 0.1.0 in
  milestone 1, before any release. Every later version comes from
  Actions -> Release (the first patch release gives 0.1.1).
- **Module table generated**, not hand-written:
  `scripts/generate-module-table.mjs` reads velbus-aio's `module_spec/*.json`
  and keeps the channels shown and the message variants used. Loaded into
  Maps: nothing the bus sends becomes an object key.
- **Frames**: one forward pass, a 14-byte buffer at most; a wrong byte drops
  the candidate and the reader restarts at the next start byte inside it
  (velbus-aio parses 14-byte windows and can lose a frame glued to garbage).
  Bits of the length byte other than RTR and the length must be zero.
- **One connection, two queues**: commands (urgent) before the scan and the
  background reads; 60 ms between frames, 2 s after a name request for the
  background only; 600 frames waiting at most; a write buffer over 64 KB cuts
  the session.
- **An answer belongs to its request**: Velbus has no request ids; a waiter
  is registered when its frame is written and only frames received after
  that count, from the module's own addresses (main or sub-address), for the
  channel asked. A status already received before the write never answers
  a later request; a status the module sent before the request but that
  arrives after its write is taken (the bus gives no way to tell them
  apart, and it is still a current status of that channel).
- **Model in the bus order**: every frame changes the model when the client
  emits it; the publication, the scene events and the device names follow
  once per event loop turn (a burst is one publication).
- **Commands**: written within 3.5 s of the request or refused "nothing was
  sent"; confirmed by a status of the channel received after the write
  until 4.5 s, else "sent, without confirmation" and a read back 2 s later.
  One command at a time per channel. Values validated strictly (`null`, `''`
  are not 0).
- **Ack independent of the publication**: a command resolves on the module's
  confirmation, never on `publishStates` (test: a publication that never
  ends does not block the ack).
- **Thermostats opt-in** (`allow_thermostat`, off): heating is a physical
  risk. Checked when asked, again before the fresh read, and right before
  the socket write (`check` in the client queue). Each command first reads
  the thermostat (`FA FF`, an `EA` received after it): already at the value,
  nothing sent; no answer, nothing sent; the preset keeps the program state
  read then (`run` 0, `manual` 0xFFFF, `sleep` its timer), as velbus-aio.
  Set points 5 to 30 °C, rounded to the half degree.
- **Presets**: comfort -> COMFORT, night -> NIGHT, safe -> FROST, day -> ECO
  (no Gladys twin; labelled "Day"). Heating / cooling is read-only (`mode`),
  the heater / cooler outputs give `operating-state`.
- **Blinds**: `shutter`, never a switch. Gladys position 100 = open, Velbus
  0 = up: converted. A position of 0 in Gladys is sent as "down" (velbus-aio:
  some modules ignore position 100). The state is the motion, or open /
  closed at the ends when stopped.
- **Relays**: `switch/binary` by default, `light/binary` for the relays listed
  in `relay_kinds`; the feature key is the kind (changing it adds a feature,
  keeps the old one and its history). A relay module's push button status
  also updates its relays (velbus-aio).
- **Dimmers**: `light/binary` + `light/brightness` (0-100, the module scale,
  100 or 254, converted); on = restore the last level when the module has the
  command, else full.
- **Units**: only core ones: `celsius` for the temperature and the set
  point; none for brightness and position (the core lists none for `light`
  and `shutter`).
- **Ids**: `<kind>:<address hex>-<channel>` (`relay:1a-3`, `thermostat:40-10`):
  the address is how a Velbus installation is wired and what every module
  has (old modules have no serial). A module moved to another address gives
  new devices (documented).
- **Buttons**: a scene trigger `button` with `module` (hex, upper case, as
  VelbusLink), `channel`, `action` (`pressed`, `long_pressed`, `released`),
  plus `name`; no device (no state worth keeping). 120 events per minute,
  then dropped with one log line per minute.
- **Signum**: TLS without CA check (self-signed, as velbus-aio); the SHA-256
  fingerprint is logged at the first connection and can be pinned
  (`tls_fingerprint`); a different certificate stops the connection before
  the password, persisted. The password is a secret field, only written on
  TLS (never on plain TCP: the status says it is ignored), never logged.
  Two sessions in a row closed within 10 s of the password, before any frame:
  refused, stop persisted in `/data/velbus-state.json` (the place only),
  lifted by a new configuration or "Test the connection".
- **Reconnection**: 10 s, 30 s, 1 min, 2 min, then 5 min. Watchdog: after 2
  min without a frame, a type request to a known module; no frame within
  10 s: reconnect. A reconnection reads the statuses again, without a scan.
- **Scan**: at the first connection, and on "Scan" in Gladys. A module type
  answer from a sub-address of another module is not a module. A module not
  found any more leaves the discovered devices (the created ones stay in
  Gladys). DALI and unknown types are listed in the connection status.
- **Not checked**: Docker is not installed on this PC, so no image build and
  no end-to-end test in a container; never run against a real installation.

## Decisions after the review (2026-10-18)

- **B1 - relays read only**: `switch` stays the default (as velbus-aio and
  Home Assistant); `relay_kinds` takes a third kind, `readonly`: a state in
  `unknown`/`binary`, `read_only`, feature key `readonly`. setValue
  refuses every relay key (`switch`, `light`, `readonly`) of a read-only
  relay, an old feature kept included: "read only: nothing was sent". Docs
  and manifest warn that a switch or a light obeys Google, Alexa, the MCP and
  the scenes, list the relays to protect (pump, ventilation, heating,
  freezer, door strike, valve, virtual relays) and tell to delete the old
  feature.
- **B2 - the channel turn ends at the write**: `command()` runs the decision
  (fresh read included) and the write in the channel's turn; the turn ends
  as soon as the frame is written (`ticket.onWritten`) or refused; the
  confirmation is awaited outside it. A stop or an off is written at once
  while the command before still waits for its confirmation (test).
- **I1**: a certificate that differs from the pin: the presented and the
  pinned fingerprints are logged and shown in the status; the docs advise to
  pin on a first connection without the password.
- **I2**: button events are bounded at the entry: a frame over the budget of
  the minute is refused before it is queued, counted (`publisher.dropped`),
  logged once per minute (test: a 50 KB burst).
- **I3**: new channel names republish the Discovery after 2 s of quiet, 10 s
  after the first at most; after a scan, at once.
- **I4**: separate caps: 20 commands, 600 background frames (a full
  background queue never refuses a command); an identical background request
  already waiting is merged with it.
- **I5**: a relay channel over 8 (the "Output" relay 18 of the VMBEL and
  VMBGP-20 panels) is published read only and its commands refused "this
  module does not take this command" (the command carries a bitmask of 8).
- **I6**: with a password over TLS, a session must bring a valid Velbus frame
  within 30 s; two sessions in a row without one stop the connection (closed
  within 10 s: "password refused"; else "no Velbus frame"), persisted as
  `password_refused` or `no_frames`. Until a frame came, the status says
  "connected to the gateway", never "connected to the bus".
- **M1**: a position is confirmed by a movement or a position within 2 % of
  the target. **M2**: a relay state goes to every relay key it has (the kind
  of now and the old ones kept). **M3**: docs: Eco asked = Velbus "day".
  **M4**: python-velbus notice from its own LICENSE. **M5**: a command
  refused while the scan keeps the bus busy says so. **M6**: a command keeps
  the pause after a name request (`nextWriteAt` never moves back). **M7**:
  invalid frames counted, one warning per minute. **M8**: the watchdog wants
  a non-RTR frame. **M9**: the password is taken as typed (no trim). **M10**:
  `allow_thermostat` applies at once in configUpdated, even when the change
  also restarts the connection. **M11**: the trigger field `module` is
  compared by the core as written (strict equality, no hook to normalize a
  filter): documented, 2 upper-case hex digits. **M12**: the status shows the
  scan progress every 2 s. **M13**: the note on statuses in flight is
  nuanced above.
