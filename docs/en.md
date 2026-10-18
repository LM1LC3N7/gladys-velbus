# Velbus for Gladys

This integration connects a **Velbus** home automation bus to Gladys
Assistant, **locally** on your network, through a network gateway: a
**Signum** (TLS, with its password) or a **TCP gateway** (velserv, a USB
interface shared by a TCP server...).

> **Never tested with a real installation.** The protocol comes from the
> [velbus-aio](https://github.com/Cereal2nd/velbus-aio) library (the one of
> the Home Assistant Velbus integration), ported to JavaScript and checked
> against a simulated bus only. Try it first while at home and report what
> goes wrong.
>
> Unofficial integration, not affiliated with Velbus.

## What you need

- A Velbus installation with a network gateway that Gladys can reach:
  - a **Signum** (VMBSIG): choose "Signum (TLS)";
  - or a **TCP gateway**: a VMBRSUSB / VMB1USB shared on the network by a
    program such as velserv or python-velbus-tcp: choose "TCP gateway".
- A USB interface plugged directly into the Gladys machine is **not**
  supported.
- This integration opens **one connection only** to the gateway. Whether
  your gateway also accepts VelbusLink or Home Assistant at the same time
  depends on the gateway (not checked).

## What you get

The integration **scans the bus** (a request to each address, 1 to 254,
about 20 seconds) at its first connection, then reads the names and the
states of the modules. The devices show in the Discovery tab, one device
per channel, named after the module (the names set in VelbusLink).

- **Relays** (VMB4RYLD, VMB1RYNO, VMB4RYNO-20...): a **switch**, or a
  **light** for the relays you list in "Relays that are lights".
- **Dimmers** (VMB4DC, VMBDMI, VMB1DM, VMB4LEDPWM-20...): a **light** with its
  **brightness**. Turning it on brings back the last level when the module
  can.
- **Blinds** (VMB1BLE, VMB2BLE, VMB1BLS, VMB2BLE-10/-20, VMB1BL, VMB2BL): a
  **shutter** (open, close, stop) and, on the modules that report it, its
  **position** (100 = open in Gladys). A blind is never a switch: a "turn
  everything off" does not move it.
- **Thermostats** (VMBGP1/2/4, VMBGPO, VMBEL1/2/4, VMB1TS...): the
  **temperature**, the **set point**, the **mode** (comfort, day, night,
  frost protection), heating or cooling, and whether it runs. Changing them
  from Gladys is **off by default** (see below).
- Modules with a temperature sensor but no thermostat: the temperature.
- **Push buttons** (VMBGP*, VMB8PB, VMB6IN, VMBEL*...): no device, a **scene
  trigger** "Velbus push button" with the module address (hexadecimal, as in
  VelbusLink, e.g. `1A`), the channel and the action (pressed, held,
  released). Leave a field empty to match any value. The scene gets
  `module`, `channel`, `action` and `name`.

Not supported in this version: DALI modules (VMBDALI), counters, analog
inputs, the meteo station, the PIR sensors as motion sensors, the LEDs of the
buttons, the edge lighting of the VMBEL panels, the memo texts, the clock.

## Configuration

1. **Address of the gateway**: the IP address (or name) of the Signum or of
   the TCP gateway. Give it a fixed address in your router.
2. **Port**: 27015 unless your gateway uses another one.
3. **Kind of gateway**: "Signum (TLS)" or "TCP gateway (plain)".
4. **Signum password** (Signum only, if it asks for one): a secret field,
   kept by Gladys in its database, never shown again in the interface, sent
   only to the gateway, never written in the logs. It is **only sent over
   TLS**: with "TCP gateway" it is never sent (the status says so).
5. **Signum certificate fingerprint** (optional, recommended with a
   password): at the first TLS connection, the integration writes the SHA-256
   fingerprint of the Signum certificate in its logs. Copy it here: from then
   on, a gateway with another certificate gets no password and the connection
   stops.
6. **Relays that are lights** (optional), for example `1A-1, 1A-3, 2B-2`
   (address in hexadecimal, channel). Changing the kind of a relay already
   created in Gladys adds a new feature and keeps the old one (and its
   history): delete the old one by hand if you no longer want it.
7. **Allow changing the thermostats from Gladys**: off by default.
8. **Language of the names**: French or English (used when a module gives
   no name).

The **Test the connection** button connects at once when no connection is in
progress, else waits for the one in progress and for the scan, and tells how
many modules and channels were found (and which modules are not supported).

**Scan** in the Discovery tab scans the bus again (new modules, a module
moved to another address). A reconnection does not scan again: it reads the
states of the known modules.

## How commands work

- A command is written on the bus within 3.5 s of the request, or refused
  with "nothing was sent" (bus too busy, gateway not connected).
- The integration then waits for the module to confirm it (a status of that
  channel on the bus) until 4.5 s. Without it, the command is reported "sent,
  without confirmation" and the channel is read again two seconds later: it
  is never reported "not sent".
- The commands of a channel go one at a time; the scan never delays a
  command.
- Every command is written in the integration logs.

## Thermostats

- Changing the set point or the mode **drives the heating**: it is off by
  default. Once allowed, **every Gladys user, every scene and the Gladys app
  can change them**.
- The option is read again right before every send: unchecked while a
  command waits, that command stops ("nothing was sent").
- Before every change, the integration **reads the thermostat from the bus**
  and decides on that read, never on what it holds in memory: already at
  the value, nothing is sent; no answer in time, nothing is sent.
- Set points are accepted from 5 to 30 °C, in half degrees (the Velbus
  step). The set point changed is the one of the current mode.
- The modes: Velbus "comfort" is Gladys **Comfort**, "night" **Night**,
  "safe" **Frost protection**; Velbus "day" (between night and comfort) has
  no twin in Gladys and shows as **Eco**, labelled "Day". When the mode is
  changed, the thermostat keeps its program state (following its program,
  manual, or sleep timer), as velbus-aio does.

## Connection

- After a cut, the new tries are spaced: 10 s, 30 s, 1 min, 2 min, then
  every 5 minutes.
- When nothing comes from the bus for 2 minutes, the integration sends a
  type request to a known module; nothing within 10 s: the connection is cut
  and opened again.
- **If the gateway closes the connection right after the password, twice in
  a row, the integration stops** and does not try again by itself, even after
  a restart (a wrong password is not tried in a loop). Fix the password then
  save, or click "Test the connection". The file `/data/velbus-state.json`
  keeps only the place concerned (`tls://address:port`), never the password.
- The same goes when the certificate is not the pinned one.

## Known limits

- Never tested with a real installation (see above): the frames are the
  ones velbus-aio documents.
- A plain TCP gateway carries everything in clear on your network: any
  device of it can read and send Velbus frames. Prefer a Signum with TLS.
- Without a pinned fingerprint, the TLS certificate of the Signum is not
  checked (it is self-signed): a device of your network could pose as the
  gateway and receive the password. Pin it.
- Channel names are read in plain ASCII (accents are dropped).
- The devices are keyed by address and channel: a module moved to another
  address in VelbusLink gives new devices.

## Privacy

Everything stays on your network: the integration only talks to the
gateway.

## Licence

Apache-2.0. Protocol logic ported from velbus-aio (Maikel Punie, Apache-2.0 /
MIT): see `THIRD_PARTY_NOTICES.md`.
