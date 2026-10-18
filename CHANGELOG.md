# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-18

### Added

- Connection to a Velbus bus through a network gateway: a Signum (TLS, with
  its password) or a plain TCP gateway, port 27015 by default, with the
  protocol of velbus-aio 2026.9.0 (frames, checksum, priorities, pacing).
- Bus scan (addresses 1 to 254, sub-addresses), channel names and states of
  83 module types; DALI modules reported as not supported.
- Relays as switches, or lights by configuration; dimmers as lights with
  brightness (restore to the last level when the module can); blinds as
  shutters with their position where the module reports it.
- Thermostats: temperature, set point, mode (comfort, day, night, frost
  protection), heating or cooling, running.
- Push buttons as a scene trigger `button` (module, channel, action, name).
- A "Test the connection" button; "Scan" scans the bus again.
- French and English names, messages and guides.
- Relays can be read only (`readonly` in "Relays: lights and read only"): a
  state, no command; the "Output" relay 18 of the VMBEL and VMBGP-20 panels
  is always read only.
- The connection status shows the scan progress.

### Security

- Changing the thermostats from Gladys is off by default; the option is read
  when asked, before the fresh read and right before the write; the decision
  is taken on the thermostat status read from the bus just before.
- The Signum password is only written on TLS, never on plain TCP, never
  logged; two sessions closed right after it stop the connection, kept
  across restarts in `/data` (the place only, never the password).
- Optional SHA-256 pin of the Signum certificate: another certificate stops
  the connection before the password is sent.
- Commands written within 3.5 s or not at all, confirmed by the module within
  4.5 s or reported "sent, without confirmation" with a read back; an answer
  only taken from a frame received after its request.
- Docs and configuration: a switch or a light obeys voice assistants, the
  MCP and the scenes; how to make a relay read only.
- A certificate that is not the pinned one is shown with both fingerprints.
- With a password, a session without any Velbus frame (twice) stops the
  connection; the status never says "connected to the bus" before a frame.
- Button events over the budget are refused at the entry; invalid frames
  are counted with one warning per minute; the watchdog wants a module frame.
- The frame stream is read in one forward pass with a 14-byte buffer; the
  write queues are bounded, a write buffer over 64 KB cuts the session;
  bursts of frames are published once; button events over 120 per minute
  are dropped.

### Fixed

- A stop or an off no longer waits for the confirmation of the command
  before it: the channel is free as soon as a frame is written.
- A command never shortens the pause after a channel name request; identical
  background requests are merged; commands have a queue cap of their own.
- A blind position is confirmed only by a movement or a position near the
  target; a relay state is published on every relay feature it has.
- The Discovery is republished once for a batch of channel names.
- The password is no longer trimmed; the thermostat option applies at once.
- The command queue holds as many commands as the bus can write before their
  deadline (59), no longer 20; a command for a channel missing during the scan
  says "scan in progress"; the fingerprint of a refused certificate stays in
  the status after a restart.

[Unreleased]: https://github.com/LM1LC3N7/gladys-velbus/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-velbus/releases/tag/v0.1.1
