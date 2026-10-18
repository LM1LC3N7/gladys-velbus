// -----------------------------------------------------------------------------
// An in-memory Velbus gateway and bus: no socket, no network. `connect` is
// given to the client in place of net / tls; each call opens a session where
// simulated modules answer the scan, the name and status requests and the
// commands the way velbus-aio expects them (frames built byte by byte here,
// not with the encoders under test), record what the client wrote, and can
// stay silent, close the session, or send any frame.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { FrameReader, encode } from '../../src/velbus/frame.js';

/** Lets every queued delivery and the promise chains behind it run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Settles until `check()` is true (at most `rounds` x 5 turns). */
export async function until(check, rounds = 400) {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await settle(5);
  }
  throw new Error('condition never met');
}

const LOW = 0xfb;
const HIGH = 0xf8;
const bitOf = (channel) => 1 << (channel - 1);
const channelOfBit = (byte) => [1, 2, 3, 4, 5, 6, 7, 8].find((c) => byte === 1 << (c - 1));

class FakeSocket extends EventEmitter {
  constructor(bus, tls) {
    super();
    this.bus = bus;
    this.tls = tls;
    this.destroyed = false;
    this.writableLength = 0;
    this.written = [];
    this.reader = new FrameReader({ onFrame: (frame) => bus.receive(this, frame) });
  }

  setNoDelay() {}

  setKeepAlive() {}

  getPeerCertificate() {
    return { fingerprint256: this.bus.fingerprint };
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    const copy = Buffer.from(bytes);
    this.written.push(copy);
    // The Signum password: raw bytes before any frame.
    if (this.tls && !this.authed && copy[0] !== 0x0f) {
      this.auth = copy.toString('utf8');
      this.authed = true;
      if (this.bus.password && this.auth !== this.bus.password) {
        queueMicrotask(() => this.destroy());
      }
      return true;
    }
    queueMicrotask(() => {
      if (!this.destroyed) this.reader.push(copy);
    });
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }

  /** Bus side: a frame to the client. */
  send(priority, address, data, rtr = false) {
    if (this.destroyed) return;
    const bytes = encode({ priority, address, rtr, data });
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', bytes);
    });
  }

  raw(bytes) {
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', Buffer.from(bytes));
    });
  }
}

/**
 * Modules: { address: { type, serial, build: [year, week], v2, subs: [..],
 * names: { ch: 'name' }, nameVariant: 'bit' | 'index', relays: { ch: on },
 * relayVariant: 'bit' | 'bits' | 'all', dimmers: { ch: level }, blinds:
 * { ch: { motion, position } }, thermostat: { current, target, preset,
 * program, cooling, heater } } }.
 */
export const defaultModules = () => ({
  0x1a: {
    type: 0x10, // VMB4RYLD
    serial: 0x1234,
    names: { 1: 'Cuisine', 2: 'Salon' },
    relays: { 1: false, 2: true, 3: false, 4: false, 5: false },
  },
  0x2a: {
    type: 0x12, // VMB4DC
    serial: 0x2222,
    names: { 1: 'Bureau' },
    dimmers: { 1: 0, 2: 40, 3: 0, 4: 0 },
  },
  0x30: {
    type: 0x1d, // VMB2BLE
    serial: 0x3333,
    names: { 1: 'Volet sud' },
    blinds: { 1: { motion: 0, position: 0 }, 2: { motion: 0, position: 100 } },
  },
  0x40: {
    type: 0x20, // VMBGP4
    serial: 0x4444,
    subs: [0x41],
    nameVariant: 'index',
    names: { 1: 'Entree', 10: 'Sejour' },
    thermostat: { current: 20.5, target: 21, preset: 'day', program: 'run', heater: true },
  },
  0x50: { type: 0x45, serial: 0x5555 }, // VMBDALI, not supported
});

const PRESET_BITS = { safe: 0x00, night: 0x10, day: 0x20, comfort: 0x40 };
const PROGRAM_BITS = { run: 0x00, manual: 0x02, sleep: 0x04, disable: 0x06 };
const PRESET_CODES = { 0xdb: 'comfort', 0xdc: 'day', 0xdd: 'night', 0xde: 'safe' };

export class FakeBus {
  constructor({ modules = defaultModules(), password = '', fingerprint = 'AB:CD' } = {}) {
    this.modules = modules;
    this.password = password;
    this.fingerprint = fingerprint;
    this.sockets = [];
    /** Every frame the client wrote: { session, priority, address, rtr, data: [..] }. */
    this.log = [];
    /** (frame) -> true: that frame gets no answer. */
    this.hold = () => false;
    this.refuseConnections = 0;
    this.connect = this.connect.bind(this);
  }

  connect(options) {
    this.options = options;
    const socket = new FakeSocket(this, options.tls);
    socket.session = this.sockets.length + 1;
    this.sockets.push(socket);
    if (this.refuseConnections > 0) {
      this.refuseConnections -= 1;
      queueMicrotask(() => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        socket.emit('error', err);
      });
      return socket;
    }
    queueMicrotask(() => socket.emit(options.tls ? 'secureConnect' : 'connect'));
    return socket;
  }

  get current() {
    return this.sockets.at(-1);
  }

  /** What the client wrote, rtr type requests (the scan) left out. */
  get commands() {
    return this.log.filter((f) => !f.rtr).map((f) => [f.address, ...f.data]);
  }

  receive(socket, frame) {
    const entry = { session: socket.session, ...frame, data: [...frame.data] };
    this.log.push(entry);
    if (this.hold(entry)) return;
    this.respond(socket, entry);
  }

  respond(socket, { address, rtr, data }) {
    const module = this.modules[address];
    if (rtr) {
      if (module) this.sendType(socket, address, module);
      // A sub-address answers the type request too.
      for (const [primary, m] of Object.entries(this.modules)) {
        if ((m.subs ?? []).includes(address)) this.sendType(socket, address, m, Number(primary));
      }
      return;
    }
    if (!module) return;
    const [command] = data;
    if (command === 0xef) return this.sendNames(socket, address, module);
    if (command === 0xfa) return this.sendStatus(socket, address, module);
    if (command === 0x01 || command === 0x02) {
      const channel = module.relayVariant === 'all' ? data[1] : channelOfBit(data[1]);
      if (module.relays?.[channel] === undefined) return;
      module.relays[channel] = command === 0x02;
      return this.sendRelay(socket, address, module, channel);
    }
    if (command === 0x07 || command === 0x11) {
      const channel = channelOfBit(data[1]);
      if (module.dimmers?.[channel] === undefined) return;
      if (command === 0x07) {
        if (data[2] > 0) module.lastLevel = data[2];
        module.dimmers[channel] = data[2];
      } else {
        module.dimmers[channel] = module.lastLevel ?? 100;
      }
      return this.sendDimmer(socket, address, channel, module.dimmers[channel]);
    }
    if ([0x04, 0x05, 0x06, 0x1c].includes(command)) {
      const channel = channelOfBit(data[1]);
      const blind = module.blinds?.[channel];
      if (!blind) return;
      if (command === 0x05) blind.motion = 1;
      if (command === 0x06) blind.motion = 2;
      if (command === 0x04) blind.motion = 0;
      if (command === 0x1c) {
        blind.motion = data[2] > blind.position ? 2 : 1;
        blind.position = data[2];
      }
      return this.sendBlind(socket, address, channel, blind);
    }
    if (command === 0xe4 && module.thermostat) {
      const raw = data[2];
      module.thermostat.target = (raw & 0x80 ? raw - 256 : raw) / 2;
      return this.sendThermostat(socket, address, module.thermostat);
    }
    if (PRESET_CODES[command] && module.thermostat) {
      module.thermostat.preset = PRESET_CODES[command];
      module.thermostat.sleep = (data[1] << 8) | data[2];
      return this.sendThermostat(socket, address, module.thermostat);
    }
  }

  sendType(socket, address, module, primary = address) {
    const [year, week] = module.build ?? [24, 10];
    const serial = module.serial ?? 0;
    const data = [0xff, module.type, serial >> 8, serial & 0xff, 0x01, year, week];
    socket.send(LOW, address, data);
    if (address === primary && module.subs) {
      const subs = [...module.subs, 0xff, 0xff, 0xff, 0xff].slice(0, 4);
      socket.send(LOW, address, [0xb0, module.type, serial >> 8, serial & 0xff, ...subs]);
    }
  }

  sendNames(socket, address, module) {
    for (const [ch, name] of Object.entries(module.names ?? {})) {
      const channel = Number(ch);
      const byte = module.nameVariant === 'index' ? channel : bitOf(channel);
      const text = [...Buffer.from(name.padEnd(16, '\xff'), 'latin1')];
      socket.send(LOW, address, [0xf0, byte, ...text.slice(0, 6)]);
      socket.send(LOW, address, [0xf1, byte, ...text.slice(6, 12)]);
      socket.send(LOW, address, [0xf2, byte, ...text.slice(12, 16)]);
    }
  }

  sendStatus(socket, address, module) {
    for (const ch of Object.keys(module.relays ?? {}))
      this.sendRelay(socket, address, module, Number(ch));
    for (const [ch, level] of Object.entries(module.dimmers ?? {})) {
      this.sendDimmer(socket, address, Number(ch), level);
    }
    for (const [ch, blind] of Object.entries(module.blinds ?? {})) {
      this.sendBlind(socket, address, Number(ch), blind);
    }
    if (module.thermostat) this.sendThermostat(socket, address, module.thermostat);
  }

  sendRelay(socket, address, module, channel) {
    if (module.relayVariant === 'all') {
      let bits = 0;
      for (const [ch, on] of Object.entries(module.relays)) if (on) bits |= bitOf(Number(ch));
      return socket.send(LOW, address, [0xfb, bits, 0, 0, 0, 0, 0, 0]);
    }
    const on = module.relays[channel];
    return socket.send(LOW, address, [0xfb, bitOf(channel), 0x00, on ? 1 : 0, 0, 0, 0, 0]);
  }

  sendDimmer(socket, address, channel, level) {
    socket.send(LOW, address, [0xb8, bitOf(channel), 0x00, level, 0, 0, 0, 0]);
  }

  sendBlind(socket, address, channel, blind) {
    socket.send(LOW, address, [0xec, bitOf(channel), 0x0f, blind.motion, 0, blind.position, 0, 0]);
  }

  sendThermostat(socket, address, t) {
    const half = (v) => Math.round(v * 2) & 0xff;
    const status =
      PRESET_BITS[t.preset] | PROGRAM_BITS[t.program ?? 'run'] | (t.cooling ? 0x80 : 0);
    const outputs = (t.heater ? 0x01 : 0) | (t.cooler ? 0x08 : 0);
    const sleep = t.sleep ?? 0;
    socket.send(LOW, address, [
      0xea,
      status,
      0x00,
      outputs,
      half(t.current),
      half(t.target),
      sleep >> 8,
      sleep & 0xff,
    ]);
  }

  /** A push button from a module (closed, opened, long bitmasks). */
  button(address, { closed = 0, opened = 0, long = 0 }) {
    this.current.send(HIGH, address, [0x00, closed, opened, long]);
  }

  /** Any frame on the bus. */
  frame(priority, address, data) {
    this.current.send(priority, address, data);
  }

  drop() {
    this.current.destroy();
  }
}

/**
 * A virtual clock for the client and the app (`timers` and `now`): nothing
 * waits for real; advance() runs the timers due, in order, letting the
 * promises settle between them.
 */
export class FakeClock {
  constructor(start = 1_000_000) {
    this.time = start;
    this.entries = new Map();
    this.ids = 0;
    this.now = () => this.time;
    this.setTimeout = (fn, ms) => this.add(fn, ms, undefined);
    this.setInterval = (fn, ms) => this.add(fn, ms, ms);
    this.clearTimeout = (id) => this.entries.delete(id);
    this.clearInterval = (id) => this.entries.delete(id);
  }

  add(fn, ms, every) {
    this.ids += 1;
    this.entries.set(this.ids, { at: this.time + Math.max(0, ms || 0), fn, every });
    return this.ids;
  }

  get pending() {
    return this.entries.size;
  }

  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      await settle(3);
      let next;
      for (const [id, entry] of this.entries) {
        if (entry.at <= end && (!next || entry.at < next[1].at)) next = [id, entry];
      }
      if (!next) break;
      const [id, entry] = next;
      this.time = Math.max(this.time, entry.at);
      if (entry.every) entry.at = this.time + entry.every;
      else this.entries.delete(id);
      entry.fn();
    }
    this.time = end;
    await settle();
  }
}

export const quietLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
};
