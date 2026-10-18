# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
- The frame stream is read in one forward pass with a 14-byte buffer; the
  write queues are bounded, a write buffer over 64 KB cuts the session;
  bursts of frames are published once; button events over 120 per minute
  are dropped.

[Unreleased]: https://github.com/LM1LC3N7/gladys-velbus/commits/main
