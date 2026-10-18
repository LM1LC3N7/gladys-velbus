// -----------------------------------------------------------------------------
// One connection to a Velbus bus through a network gateway: a plain TCP
// gateway (velserv, a VMBRSUSB behind a TCP server...) or a Signum (TLS, with
// its password). Ported from velbus-aio (velbusaio/controller.py,
// protocol.py, handler.py; Apache-2.0 / MIT, see THIRD_PARTY_NOTICES.md):
// the connection, the Signum password written first, the frames paced 60 ms
// apart (2 s after a channel name request), the bus scan (a type request to
// every address 1 to 254, then 3 s for the answers and the sub-addresses).
//
// Changed from velbus-aio:
// - USB / serial is left out: network gateways only;
// - one connection, reconnections spaced 10 s, 30 s, 1 min, 2 min, then 5 min;
// - the Signum certificate can be pinned (SHA-256); without a pin it is
//   accepted, as velbus-aio does, and its fingerprint is logged;
// - the password is only ever written on TLS; two sessions in a row closed
//   by the gateway right after it, before any frame, stop the connection
//   (no loop with a wrong password);
// - two queues: commands go before the scan and the background reads, are
//   never written after their deadline, and their option is checked right
//   before the write; both queues are bounded;
// - an answer is awaited only for a frame received after the request was
//   written (a status from that channel or module), never taken from memory;
// - a watchdog: after 2 minutes without any frame, a type request to a known
//   module must bring a frame within 10 s, else the session is cut.
//
// Events, emitted in the order of the bus: 'up' { fingerprint }, 'frame'
// { priority, address, rtr, data }, 'down' { reason, retryIn, refused,
// certificate, wasUp }. The password is never logged.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createConnection, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { LIMITS, TIMINGS } from '../constants.js';
import { FrameReader, encode } from './frame.js';
import { CMD, typeRequest } from './messages.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * kind: `offline` (nothing sent), `late` (too late, nothing sent),
 * `withdrawn` (its option was switched off before the write, nothing sent),
 * `full` (the queue is full, nothing sent), `timeout` (written, no answer in
 * time), `lost` (the connection ended: `sent` tells whether it was written).
 */
export class VelbusError extends Error {
  constructor(message, kind, { sent = false } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
  }
}

/** `AB:CD:...` (Node's fingerprint256) -> `abcd...`. */
export const fingerprintOf = (certificate) =>
  String(certificate?.fingerprint256 ?? '')
    .replace(/:/g, '')
    .toLowerCase();

function defaultConnect({ host, port, tls }) {
  if (!tls) return createConnection({ host, port });
  // The Signum certificate is self-signed: it is checked against the pin
  // (if any) once connected, never against a CA.
  return tlsConnect({
    host,
    port,
    rejectUnauthorized: false,
    ...(isIP(host) ? {} : { servername: host }),
  });
}

export class VelbusClient extends EventEmitter {
  constructor({
    connect = defaultConnect,
    timers = globalThis,
    now = Date.now,
    logger = silent,
  } = {}) {
    super();
    this.connectFn = connect;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.options = { host: '', port: 27015, tls: false, password: '', fingerprint: '' };
    this.socket = undefined;
    this.generation = 0;
    this.running = false;
    this.ready = false;
    this.failures = 0;
    this.authDrops = 0;
    this.urgent = [];
    this.background = [];
    this.waiters = new Set();
    this.collectors = new Set();
    this.reconnectTimer = undefined;
    this.connectTimer = undefined;
    this.pumpTimer = undefined;
    this.ticker = undefined;
    this.lastWriteAt = -Infinity;
    this.nextWriteAt = -Infinity;
    this.scanning = undefined;
    this.progress = undefined;
    this.probing = false;
    /** () -> an address that answers a type request (a known module), set by the app. */
    this.probeAddress = () => undefined;
  }

  configure({ host, port, tls, password, fingerprint }) {
    this.options = {
      host,
      port,
      tls: Boolean(tls),
      password: password ?? '',
      fingerprint: fingerprint ?? '',
    };
  }

  get connected() {
    return this.ready;
  }

  /** A socket is open (connecting or up). */
  get busy() {
    return Boolean(this.socket);
  }

  start() {
    this.stop();
    this.running = true;
    this.failures = 0;
    this.authDrops = 0;
    this.open();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.close();
  }

  clearTimers() {
    for (const name of ['connectTimer', 'pumpTimer']) {
      if (this[name]) {
        this.timers.clearTimeout(this[name]);
        this[name] = undefined;
      }
    }
    if (this.ticker) {
      this.timers.clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /** Ends the socket; every waiting request fails (written or not, as it was). */
  close() {
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.probing = false;
    this.progress = undefined;
    for (const waiter of [...this.waiters]) {
      waiter.fail(new VelbusError('The connection to the bus ended', 'lost', { sent: true }));
    }
    for (const entry of [...this.urgent.splice(0), ...this.background.splice(0)]) {
      entry.reject(new VelbusError('Not connected to the bus', 'offline'));
    }
    if (!socket) return;
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    socket.destroy();
  }

  // --- Connection -------------------------------------------------------------

  open() {
    const generation = this.generation;
    const { host, port, tls } = this.options;
    this.reader = new FrameReader({
      onFrame: (frame) => {
        if (generation === this.generation) this.frame(frame);
      },
      onDrop: () => {
        this.dropped = (this.dropped ?? 0) + 1;
      },
    });
    this.receivedAny = false;
    this.authAt = undefined;
    this.logger.debug(
      `Connecting to the Velbus gateway at ${host}:${port} (${tls ? 'TLS' : 'TCP'})`,
    );
    let socket;
    try {
      socket = this.connectFn({ host, port, tls });
    } catch (err) {
      this.lost(generation, `connection failed: ${err.message}`);
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 30_000);
    this.connectTimer = this.timers.setTimeout(
      () => this.lost(generation, 'connection timed out'),
      TIMINGS.connectTimeout,
    );
    socket.on(tls ? 'secureConnect' : 'connect', () => {
      if (generation !== this.generation) return;
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.session(generation, socket);
    });
    socket.on('data', (chunk) => {
      if (generation !== this.generation) return;
      this.lastReceived = this.now();
      this.reader.push(chunk);
    });
    socket.on('error', (err) => this.lost(generation, err.code ?? err.message));
    socket.on('close', () => this.lost(generation, 'connection closed by the gateway'));
  }

  session(generation, socket) {
    const { tls, password, fingerprint } = this.options;
    let seen = '';
    if (tls) {
      seen = fingerprintOf(socket.getPeerCertificate?.());
      if (fingerprint && seen !== fingerprint) {
        this.logger.error(
          'Velbus: the certificate of the gateway is not the pinned one: connection stopped',
        );
        this.lost(generation, 'certificate not the pinned one', { certificate: true });
        return;
      }
    }
    if (tls && password) {
      // Signum: the password goes first, as is (velbus-aio write_auth_key).
      try {
        socket.write(Buffer.from(password, 'utf8'));
      } catch (err) {
        this.lost(generation, err.message);
        return;
      }
      this.authAt = this.now();
      this.logger.debug('Velbus <- password (hidden)');
    }
    this.ready = true;
    this.lastReceived = this.now();
    this.ticker = this.timers.setInterval(() => this.tick(generation), TIMINGS.tick);
    this.emit('up', { fingerprint: seen });
    this.pump();
  }

  /** The session ended: reconnect later, unless stopped or refused. */
  lost(generation, reason, { certificate = false } = {}) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.ready;
    // Closed right after the password, before the bus said anything: the
    // gateway probably refused it.
    const authDrop =
      wasUp &&
      this.authAt !== undefined &&
      !this.receivedAny &&
      this.now() - this.authAt < TIMINGS.authWindow;
    this.close();
    if (!this.running) return;
    let refused = false;
    if (authDrop) {
      this.authDrops += 1;
      refused = this.authDrops >= LIMITS.authDrops;
      if (refused) reason = 'connection closed right after the password, twice';
    } else if (wasUp) {
      this.authDrops = 0;
    }
    let retryIn;
    if (refused || certificate) {
      // Never again by itself: a refused password is not tried in a loop, a
      // password is never sent to a gateway that is not the pinned one.
      this.running = false;
    } else {
      this.failures = wasUp && !authDrop ? 1 : this.failures + 1;
      retryIn = TIMINGS.backoff[Math.min(this.failures - 1, TIMINGS.backoff.length - 1)];
      this.reconnectTimer = this.timers.setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.running) this.open();
      }, retryIn);
    }
    this.emit('down', { reason, retryIn, refused, certificate, wasUp });
  }

  tick(generation) {
    if (generation !== this.generation || !this.ready || this.probing) return;
    if (this.now() - this.lastReceived < TIMINGS.idleProbe) return;
    const address = this.probeAddress();
    if (address === undefined) return;
    this.probing = true;
    this.send(typeRequest(address), {
      urgent: true,
      wait: { match: () => true, timeout: TIMINGS.probeTimeout },
    }).then(
      () => {
        this.probing = false;
      },
      (err) => {
        this.probing = false;
        if (generation !== this.generation) return;
        if (err instanceof VelbusError && err.kind === 'timeout') {
          this.logger.warn('Velbus: nothing received from the bus for too long, reconnecting');
          this.lost(generation, 'no answer from the bus');
        }
      },
    );
  }

  // --- Frames -----------------------------------------------------------------

  /** A frame from the bus: to the app first (its model follows the bus order), then the waiters. */
  frame(frame) {
    this.receivedAny = true;
    for (const collect of this.collectors) collect(frame);
    this.emit('frame', frame);
    for (const waiter of [...this.waiters]) {
      let value;
      try {
        value = waiter.match(frame);
      } catch {
        value = undefined;
      }
      if (value !== undefined && value !== false) waiter.done(value);
    }
  }

  // --- Writing ----------------------------------------------------------------

  /**
   * Queues a frame; resolves once written (with the matched value when
   * `wait` is given: { match(frame) -> value | undefined, timeout | until }, only
   * frames received after the write count). `urgent`: before the scan and the
   * background reads. `sendBy` (a time): never written after it. `check`:
   * called right before the write, false withdraws it. `ticket` gets
   * `written`. `gap`: the pause after this frame before the next background one.
   */
  send(
    frame,
    { urgent = false, sendBy, check, ticket = {}, wait, gap = TIMINGS.frameGap, label } = {},
  ) {
    return new Promise((resolve, reject) => {
      ticket.written = false;
      if (!this.socket || !this.ready) {
        reject(new VelbusError('Not connected to the bus', 'offline'));
        return;
      }
      if (this.urgent.length + this.background.length >= LIMITS.maxQueue) {
        reject(new VelbusError('Too many frames waiting for the bus', 'full'));
        return;
      }
      let bytes;
      try {
        bytes = encode(frame);
      } catch (err) {
        reject(new VelbusError(err.message, 'offline'));
        return;
      }
      const entry = { bytes, frame, sendBy, check, ticket, wait, gap, resolve, reject, label };
      (urgent ? this.urgent : this.background).push(entry);
      this.pump();
    });
  }

  pump() {
    if (this.pumpTimer) {
      this.timers.clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
    if (!this.socket || !this.ready) return;
    const now = this.now();
    // Commands too late are dropped before anything else: never written.
    for (const queue of [this.urgent, this.background]) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i].sendBy !== undefined && now > queue[i].sendBy) {
          const [late] = queue.splice(i, 1);
          late.reject(new VelbusError('Not written in time', 'late'));
        }
      }
    }
    const urgent = this.urgent.length > 0;
    const queue = urgent ? this.urgent : this.background;
    if (queue.length === 0) return;
    // A command waits the frame gap only, never the long pause after a name request.
    const at = urgent ? this.lastWriteAt + TIMINGS.frameGap : this.nextWriteAt;
    if (at > now) {
      this.pumpTimer = this.timers.setTimeout(() => {
        this.pumpTimer = undefined;
        this.pump();
      }, at - now);
      return;
    }
    const entry = queue.shift();
    // Last look before the socket: a command whose option was switched off
    // while it waited is withdrawn, never written.
    if (entry.check && !entry.check()) {
      entry.reject(new VelbusError('Withdrawn: not allowed any more', 'withdrawn'));
      this.pump();
      return;
    }
    const generation = this.generation;
    entry.ticket.written = true;
    try {
      this.socket.write(entry.bytes);
    } catch (err) {
      entry.reject(new VelbusError(err.message, 'lost', { sent: true }));
      this.lost(generation, err.message);
      return;
    }
    if (entry.label) this.logger.debug(`Velbus <- ${entry.label}`);
    this.lastWriteAt = this.now();
    this.nextWriteAt = this.lastWriteAt + entry.gap;
    if ((this.socket?.writableLength ?? 0) > LIMITS.maxPendingWrite) {
      this.logger.warn('Velbus: too much data waiting to be written, session cut');
      entry.reject(new VelbusError('Write buffer full', 'lost', { sent: true }));
      this.lost(generation, 'write buffer full');
      return;
    }
    if (entry.wait) this.await(entry);
    else entry.resolve({ written: true });
    this.pump();
  }

  /** Waits for the answer of a written request: frames after the write only. */
  await(entry) {
    const waiter = {
      match: entry.wait.match,
      done: (value) => {
        this.timers.clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        entry.resolve(value);
      },
      fail: (err) => {
        this.timers.clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        entry.reject(err);
      },
    };
    // `until` (a time) bounds the wait whenever the frame was written; `timeout` counts from the write.
    const ms = entry.wait.until !== undefined ? entry.wait.until - this.now() : entry.wait.timeout;
    waiter.timer = this.timers.setTimeout(
      () =>
        waiter.fail(new VelbusError('No answer from the bus in time', 'timeout', { sent: true })),
      Math.max(0, ms),
    );
    this.waiters.add(waiter);
  }

  // --- Scan ---------------------------------------------------------------------

  /**
   * The bus scan: a type request to every address, then TIMINGS.scanWait for
   * the answers. Resolves with { found: Map(address -> data of the type
   * answer), subs: Map(address -> Map(sub number -> address)) }; rejects if
   * the connection ends. One scan at a time.
   */
  scan() {
    if (this.scanning) return this.scanning;
    const generation = this.generation;
    const found = new Map();
    const subs = new Map();
    const collect = (frame) => {
      if (frame.rtr || frame.address < 1 || frame.address > LIMITS.maxAddress) return;
      const command = frame.data[0];
      if (command === CMD.MODULE_TYPE) found.set(frame.address, Buffer.from(frame.data));
      if ([CMD.SUB_TYPE, CMD.SUB_TYPE_2, CMD.SUB_TYPE_3].includes(command)) {
        if (!subs.has(frame.address)) subs.set(frame.address, []);
        subs.get(frame.address).push(Buffer.from(frame.data));
      }
    };
    this.collectors.add(collect);
    const run = (async () => {
      this.progress = { sent: 0, of: LIMITS.maxAddress };
      const writes = [];
      for (let address = 1; address <= LIMITS.maxAddress; address += 1) {
        writes.push(
          this.send(typeRequest(address)).then(() => {
            if (this.progress) this.progress.sent += 1;
          }),
        );
      }
      await Promise.all(writes);
      await new Promise((resolve) => {
        this.timers.setTimeout(resolve, TIMINGS.scanWait);
      });
      if (generation !== this.generation) {
        throw new VelbusError('The connection ended during the scan', 'lost');
      }
      return { found, subs };
    })();
    this.scanning = run.finally(() => {
      this.collectors.delete(collect);
      this.scanning = undefined;
      this.progress = undefined;
    });
    return this.scanning;
  }
}
