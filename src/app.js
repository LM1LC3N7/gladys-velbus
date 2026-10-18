// -----------------------------------------------------------------------------
// The integration: one connection to the Velbus bus (src/velbus/client.js),
// the modules the scan found and what the bus says about them, the Gladys
// devices and states (src/devices.js), the button scene events, the
// commands. index.js only wires the SDK handlers to it.
//
// - The model changes when the client emits a frame, in the order of the
//   bus; Gladys gets the result once per turn of the event loop, however many
//   frames came in it (a burst costs one publication).
// - A command is written within 3.5 s of the request or not at all, waits
//   for the module to confirm it (a status of that channel received after the
//   write) until 4.5 s, and is otherwise "sent, without confirmation" with a
//   read back: never "not sent" once it may have left. Its ack never waits
//   for the publication of the states.
// - Thermostats (set point, preset) only when the configuration allows it
//   (off by default); the option is checked when asked, before the fresh
//   read, and right before the write; the decision is taken on the
//   thermostat status read from the bus just before, never on memory.
// - The password is never logged.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { channelKey, normalizeConfig, placeKey, sessionKey } from './config.js';
import { COVER_STATE, LIMITS, PRESET_FROM_GLADYS, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import {
  RELAY_FEATURES,
  buildDevices,
  buildStates,
  hasPosition,
  parseFeatureId,
  relayKind,
  shownChannels,
} from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { VelbusClient, VelbusError } from './velbus/client.js';
import {
  CMD,
  blindCommand,
  blindPositionCommand,
  decode,
  decodeModuleType,
  decodeSubAddresses,
  dimmerCommand,
  presetCommand,
  relayCommand,
  restoreDimmerCommand,
  setTemperatureCommand,
  sleepFor,
  statusRequest,
  thermostatRequest,
  nameRequest,
} from './velbus/messages.js';
import { addressText, specOf, typeName } from './velbus/modules.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A command refused before anything was sent to the bus. */
export class Refused extends Error {}

const colons = (hex) => (hex ? hex.match(/../g).join(':') : '?');

const SUB_COMMANDS = new Set([CMD.SUB_TYPE, CMD.SUB_TYPE_2, CMD.SUB_TYPE_3]);

const emptyModel = () => ({ modules: new Map() });

function newModule(address, type, spec) {
  return {
    address,
    type,
    spec,
    serial: 0,
    build: '',
    /** sub number -> address (velbus-aio's sub_address). */
    subs: new Map(),
    /** channel -> name read from the module. */
    names: new Map(),
    /** channel -> Map(part -> text), until the three parts came. */
    nameParts: new Map(),
    /** channel -> what the bus said (relay { on }, dimmer { level }...). */
    channels: new Map(),
  };
}

/**
 * velbus-aio's maybe_update_temperature: a reading at a lower precision does
 * not replace a better one it agrees with.
 */
export function mergeTemperature(state, value, precision) {
  if (state.current !== undefined) {
    const floor = Math.floor(state.current / precision) * precision;
    if (floor === value) return false;
    if (
      floor - precision <= value &&
      value < floor &&
      state.precision !== undefined &&
      state.precision < precision
    ) {
      value = floor - state.precision;
    }
  }
  const changed = state.current !== value;
  state.current = value;
  state.precision = precision;
  return changed;
}

/** A strict 0 / 1 (null, '' and the rest are not 0). */
function binaryOf(value) {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  return undefined;
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export class VelbusApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'velbus' }),
    client,
    connect,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = client ?? new VelbusClient({ connect, timers, now, logger });
    this.client.probeAddress = () => this.model.modules.keys().next().value;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.key = undefined;
    this.model = emptyModel();
    /** address -> { module, offset }: the primary address and the sub-addresses. */
    this.index = new Map();
    this.unsupported = new Map();
    this.online = false;
    this.scanning = undefined;
    this.scanError = undefined;
    this.memory = undefined;
    this.lastStatus = undefined;
    this.lastTransport = undefined;
    this.published = undefined;
    this.started = false;
    this.sweeper = undefined;
    this.chains = new Map();
    this.readBacks = new Set();
    this.starting = Promise.resolve();
    this.pendingEvents = [];
    this.flushScheduled = false;
    this.certificateLogged = undefined;
    this.client.on('up', (info) => {
      this.online = true;
      this.guard(() => this.onUp(info));
    });
    this.client.on('down', (info) => {
      const wasOnline = this.online;
      this.online = false;
      this.guard(() => this.onDown(info, wasOnline));
    });
    this.client.on('alive', () => this.guard(() => this.onAlive()));
    // Applied at once, in the order of the bus.
    this.client.on('frame', (frame) => this.applyFrame(frame));
  }

  /** What talks to Gladys runs one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`Velbus event failed: ${err.message}`));
    return this.chain;
  }

  get language() {
    return this.config.language;
  }

  error(entry, cause) {
    return new Error(word(entry, this.language), cause ? { cause } : undefined);
  }

  refused(entry) {
    return new Refused(word(entry, this.language));
  }

  // --- Lifecycle -------------------------------------------------------------

  async loadMemory() {
    if (this.memory) return this.memory;
    try {
      this.memory = normalizeMemory(await this.store.load());
    } catch {
      this.memory = normalizeMemory(null);
    }
    return this.memory;
  }

  async saveMemory() {
    try {
      await this.store.save(this.memory);
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
    }
  }

  /** Starts (or restarts); two starts never overlap (no leaked timer). */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    const next = normalizeConfig(raw);
    if (placeKey(next) !== placeKey(this.config)) {
      // Another bus, maybe: what we knew no longer holds.
      this.model = emptyModel();
      this.reindex();
      this.unsupported = new Map();
    }
    this.config = next;
    this.key = sessionKey(next);
    this.online = false;
    if (next.relayErrors.length > 0) {
      this.logger.warn(`Relay kinds not understood: ${next.relayErrors.join(', ')}`);
    }
    if (next.password && !next.tls) {
      this.logger.warn(
        'Velbus: a password is set but the connection is plain TCP: it is never sent',
      );
    }
    const memory = await this.loadMemory();
    await this.publishDevices();
    await this.publishStates();
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    if (memory.stop && memory.stop.place === placeKey(next)) {
      this.logger.warn(
        `Velbus: stopped before (${memory.stop.kind}): no connection until the configuration changes or "Test the connection" is clicked`,
      );
      await this.setStatus(false, this.stopMessage(memory.stop.kind));
      return;
    }
    await this.setStatus(false, T.connecting);
    this.connect();
    this.startSweeper();
  }

  stopMessage(kind, presented, pinned) {
    if (kind === 'certificate_changed') {
      return fill(T.certificate, colons(presented), colons(pinned ?? this.config.fingerprint));
    }
    return kind === 'no_frames' ? T.silent : T.refused;
  }

  connect() {
    this.client.configure({
      host: this.config.host,
      port: this.config.port,
      tls: this.config.tls,
      // Never on plain TCP: anyone on the network would read it.
      password: this.config.tls ? this.config.password : '',
      fingerprint: this.config.fingerprint,
    });
    this.client.start();
  }

  startSweeper() {
    if (this.sweeper) this.timers.clearInterval(this.sweeper);
    this.sweeper = this.timers.setInterval(
      () => this.guard(() => this.publishStates()),
      TIMINGS.sweep,
    );
  }

  stop() {
    this.client.stop();
    this.online = false;
    this.publisher.stop();
    if (this.sweeper) {
      this.timers.clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    for (const timer of this.readBacks) this.timers.clearTimeout(timer);
    this.readBacks.clear();
    this.cancelNames();
    this.stopScanStatus();
  }

  configProblem() {
    if (!this.config.host) return T.noHost;
    if (this.config.fingerprintInvalid) return T.badFingerprint;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status and the discovered devices in memory.
    this.published = undefined;
    this.lastTransport = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    if (status && this.lastStatus === undefined) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports(
      this.online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    );
  }

  /** A new place, password or pin reconnects (and lifts a stop); the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== this.key) {
      // The thermostat option holds at once, even while the restart waits.
      this.config = { ...this.config, allowThermostat: next.allowThermostat };
      await this.liftStop();
      return this.start(raw);
    }
    this.config = next;
    await this.publishDevices();
    await this.publishStates();
    if (this.online && !this.scanning) await this.setStatus(true, this.onlineMessage());
    return undefined;
  }

  async liftStop() {
    const memory = await this.loadMemory();
    if (!memory.stop) return;
    memory.stop = null;
    await this.saveMemory();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** "Connected to the bus" only once a Velbus frame came in this session. */
  onlineMessage() {
    return this.client.receivedAny ? this.connectedMessage() : T.waitingBus;
  }

  connectedMessage() {
    let channels = 0;
    for (const entry of shownChannels(this.model)) if (entry) channels += 1;
    const extras = [];
    if (this.unsupported.size > 0) {
      const list = [...this.unsupported.entries()]
        .slice(0, 5)
        .map(([address, name]) => `${name} ${addressText(address)}`)
        .join(', ');
      extras.push(fill(T.unsupported, this.unsupported.size > 5 ? `${list}…` : list));
    }
    if (this.config.password && !this.config.tls) extras.push(T.passwordIgnored);
    const extra = Object.fromEntries(
      ['en', 'fr'].map((lang) => [lang, extras.map((e) => word(e, lang)).join('')]),
    );
    if (this.scanError) return fill(T.scanFailed, this.scanError);
    return {
      en: word(T.connected, 'en')(this.model.modules.size, channels, extra.en),
      fr: word(T.connected, 'fr')(this.model.modules.size, channels, extra.fr),
    };
  }

  // --- Client events ---------------------------------------------------------

  async onUp({ fingerprint }) {
    if (
      this.config.tls &&
      !this.config.fingerprint &&
      fingerprint &&
      this.certificateLogged !== fingerprint
    ) {
      this.certificateLogged = fingerprint;
      this.logger.info(
        `Velbus: certificate of the gateway, SHA-256 ${fingerprint.match(/../g).join(':')}: enter it in the configuration to pin it`,
      );
    }
    await this.publishTransports(DEVICE_TRANSPORTS.LOCAL);
    if (this.model.modules.size === 0) {
      // The scan runs outside the event chain: frames and commands go on meanwhile.
      this.runScan();
      return;
    }
    this.loadModules({ names: false });
    await this.setStatus(true, this.onlineMessage());
  }

  /** The first Velbus frame of a session: now the bus is known to answer. */
  async onAlive() {
    if (this.client.connected && !this.scanning)
      await this.setStatus(true, this.connectedMessage());
  }

  async onDown({ reason, retryIn, refused, silent, certificate, presented, pinned }, wasOnline) {
    const seconds = Math.round((retryIn ?? 0) / 1000);
    if (refused || silent || certificate) {
      const kind = certificate ? 'certificate_changed' : silent ? 'no_frames' : 'password_refused';
      this.logger.error(`Velbus: connection stopped (${reason}), no new try`);
      const memory = await this.loadMemory();
      memory.stop = { place: placeKey(this.config), kind, at: this.now() };
      await this.saveMemory();
      await this.setStatus(false, this.stopMessage(kind, presented, pinned));
    } else {
      this.logger.warn(`Velbus: ${reason}; next try in ${seconds} s`);
      await this.setStatus(false, fill(T.unreachable, reason, seconds));
    }
    if (wasOnline || this.lastTransport !== undefined) {
      await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
    }
  }

  /** The scan of the bus, one at a time; the model is replaced when it ends. */
  runScan() {
    if (this.scanning) return this.scanning;
    const run = (async () => {
      await this.setStatus(true, fill(T.scanning, 0, LIMITS.maxAddress));
      this.scanStatus = this.timers.setInterval(() => {
        const progress = this.client.progress;
        if (progress)
          this.guard(() => this.setStatus(true, fill(T.scanning, progress.sent, progress.of)));
      }, TIMINGS.scanStatus);
      let result;
      try {
        result = await this.client.scan();
        this.scanError = undefined;
      } catch (err) {
        this.logger.warn(`Velbus: the scan of the bus failed: ${err.message}`);
        if (this.client.connected) this.scanError = err.message;
        return;
      }
      this.applyScan(result);
      // Published at once: a name republication waiting is part of it.
      this.cancelNames();
      await this.guard(async () => {
        await this.publishDevices();
        await this.publishStates();
        await this.publishTransports(DEVICE_TRANSPORTS.LOCAL, { force: true });
      });
      this.loadModules({ names: true });
    })();
    this.scanning = run.finally(async () => {
      this.scanning = undefined;
      this.stopScanStatus();
      if (this.client.connected) await this.guard(() => this.setStatus(true, this.onlineMessage()));
    });
    return this.scanning;
  }

  stopScanStatus() {
    if (this.scanStatus) this.timers.clearInterval(this.scanStatus);
    this.scanStatus = undefined;
  }

  /**
   * New channel names: the Discovery is published again once they stop
   * coming for 2 s, 10 s after the first one at most (a module sends its names
   * one by one).
   */
  scheduleDevices() {
    const now = this.now();
    if (this.namesFirst === undefined) this.namesFirst = now;
    if (this.namesTimer) this.timers.clearTimeout(this.namesTimer);
    const delay = Math.max(
      0,
      Math.min(TIMINGS.namesQuiet, this.namesFirst + TIMINGS.namesMax - now),
    );
    this.namesTimer = this.timers.setTimeout(() => {
      this.namesTimer = undefined;
      this.namesFirst = undefined;
      this.guard(() => this.publishDevices());
    }, delay);
  }

  cancelNames() {
    if (this.namesTimer) this.timers.clearTimeout(this.namesTimer);
    this.namesTimer = undefined;
    this.namesFirst = undefined;
  }

  /** The modules of a finished scan (synchronous: no frame comes in between). */
  applyScan({ found, subs }) {
    const subsOf = (address) => {
      const map = new Map();
      for (const data of subs.get(address) ?? []) {
        for (const [num, sub] of decodeSubAddresses(data) ?? []) map.set(num, sub);
      }
      return map;
    };
    // A sub-address answers the type request too: it is not a module of its own.
    const subAddresses = new Set();
    for (const address of found.keys())
      for (const sub of subsOf(address).values()) subAddresses.add(sub);
    const modules = new Map();
    const unsupported = new Map();
    for (const address of [...found.keys()].sort((a, b) => a - b)) {
      if (subAddresses.has(address)) continue;
      let info = decodeModuleType(found.get(address));
      if (!info) continue;
      const spec = specOf(info.type);
      if (!spec?.supported) {
        unsupported.set(address, typeName(info.type));
        continue;
      }
      if (spec.variant(CMD.MODULE_TYPE) === 'ModuleType2Message') {
        info = decodeModuleType(found.get(address), 'ModuleType2Message');
      }
      const old = this.model.modules.get(address);
      const module = old && old.type === info.type ? old : newModule(address, info.type, spec);
      module.serial = info.serial;
      module.build = info.build;
      for (const [num, sub] of subsOf(address)) module.subs.set(num, sub);
      modules.set(address, module);
    }
    for (const address of this.model.modules.keys()) {
      if (!modules.has(address))
        this.logger.warn(`Velbus: module ${addressText(address)} not found any more`);
    }
    this.model.modules = modules;
    this.unsupported = unsupported;
    this.reindex();
    this.logger.info(
      `Velbus: ${modules.size} module(s) found${unsupported.size ? `, ${unsupported.size} not supported` : ''}`,
    );
  }

  reindex() {
    const index = new Map();
    for (const module of this.model.modules.values())
      index.set(module.address, { module, offset: 0 });
    for (const module of this.model.modules.values()) {
      for (const [num, address] of module.subs) {
        if (!index.has(address)) index.set(address, { module, offset: 8 * num });
      }
    }
    this.index = index;
  }

  /** The names (after a scan) and the states of every module, in the background. */
  loadModules({ names }) {
    const quiet = () => undefined;
    for (const module of this.model.modules.values()) {
      if (names && module.names.size === 0) {
        const request = nameRequest(module.spec, module.address);
        if (request) this.client.send(request, { gap: TIMINGS.nameGap }).catch(quiet);
      }
      this.client.send(statusRequest(module.spec, module.address)).catch(quiet);
      if (module.spec.thermostat && !module.spec.allChannelStatus) {
        this.client.send(thermostatRequest(module.address)).catch(quiet);
      }
    }
  }

  /** A frame of the bus, applied to the model at once; what it changes goes to Gladys once per turn. */
  applyFrame(frame) {
    const entry = this.index.get(frame.address);
    if (!entry) return;
    const { module, offset } = entry;
    if (!frame.rtr && SUB_COMMANDS.has(frame.data[0])) {
      if (offset !== 0) return;
      let changed = false;
      for (const [num, address] of decodeSubAddresses(frame.data) ?? []) {
        if (module.subs.get(num) !== address) {
          module.subs.set(num, address);
          changed = true;
        }
      }
      if (changed) this.reindex();
      return;
    }
    const updates = decode(module.spec, frame, offset);
    if (updates.length === 0) return;
    const events = [];
    let changed = false;
    for (const update of updates) {
      const { channel } = update;
      if (update.kind === 'button') {
        // Bounded at the entry: over the budget of the minute, refused here,
        // never queued (a flood costs a counter, not memory).
        if (this.publisher.reserveEvent()) events.push({ module, channel, action: update.action });
        continue;
      }
      if (update.kind === 'name') {
        if (this.applyName(module, update)) this.scheduleDevices();
        continue;
      }
      if (!module.channels.has(channel)) module.channels.set(channel, {});
      const state = module.channels.get(channel);
      changed = true;
      if (update.kind === 'relay') state.on = update.on;
      else if (update.kind === 'dimmer') state.level = update.level;
      else if (update.kind === 'blind') {
        state.motion = update.motion;
        if (update.position !== undefined) state.position = update.position;
      } else if (update.kind === 'temperature') {
        mergeTemperature(state, update.value, 1 / 64);
      } else if (update.kind === 'thermostat') {
        for (const key of [
          'target',
          'preset',
          'program',
          'cooling',
          'heater',
          'cooler',
          'sleepTimer',
        ]) {
          if (update[key] !== undefined) state[key] = update[key];
        }
        mergeTemperature(state, update.current, 1 / 2);
      }
    }
    if (changed || events.length > 0) this.noteChange(events);
  }

  /** A part of a channel name; true when a whole new name is known. */
  applyName(module, { channel, part, text }) {
    if (!module.nameParts.has(channel)) module.nameParts.set(channel, new Map());
    const parts = module.nameParts.get(channel);
    parts.set(part, text);
    if (parts.size < 3) return false;
    module.nameParts.delete(channel);
    const name = `${parts.get(1)}${parts.get(2)}${parts.get(3)}`.trim().slice(0, 32);
    if (!name || module.names.get(channel) === name) return false;
    module.names.set(channel, name);
    return true;
  }

  noteChange(events) {
    this.pendingEvents.push(...events);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.guard(() => this.flushChanges());
    });
  }

  async flushChanges() {
    const events = this.pendingEvents.splice(0);
    await this.publishStates();
    for (const event of events) await this.buttonEvent(event);
  }

  async buttonEvent({ module, channel, action }) {
    const name = module.names.get(channel) || module.spec.channels.get(channel)?.name || '';
    await this.publisher.sceneEvent(
      SCENE_TRIGGERS.BUTTON,
      { module: addressText(module.address), channel, action, name },
      { reserved: true },
    );
  }

  // --- Gladys ----------------------------------------------------------------

  async publishDevices({ force = false } = {}) {
    if (this.model.modules.size === 0) return;
    const devices = buildDevices(this.gladys, this.config, this.model);
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    if (this.model.modules.size === 0) return Promise.resolve();
    return this.publisher.publish(buildStates(this.gladys, this.config, this.model));
  }

  async publishTransports(transport, { force = false } = {}) {
    if (transport === this.lastTransport && !force) return;
    if (this.model.modules.size === 0) return;
    const devices = buildDevices(this.gladys, this.config, this.model);
    const entries = devices.map((device) => ({ external_id: device.external_id, transport }));
    try {
      // At most 100 entries per request.
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
      this.lastTransport = transport;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  /** "Scan" in Gladys: the bus is scanned again (in the background), the devices sent again. */
  async scan() {
    await this.publishDevices({ force: true });
    if (this.client.connected) this.runScan();
  }

  /** The user created or updated a device: Gladys has none of its states yet, send them again. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  // --- Commands --------------------------------------------------------------

  /** One turn at a time per channel; a failed one never blocks the next. */
  serial(key, fn) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /**
   * One command of a channel. `prepare` runs in the channel's turn, decides
   * (fresh read included) and gives the job, or nothing to send. The turn
   * ends as soon as the frame is written or refused: the confirmation is
   * awaited outside it, so a stop or an off never waits for the
   * confirmation of the command before it.
   */
  async command(key, prepare) {
    let job;
    await this.serial(key, async () => {
      const next = await prepare();
      if (!next) return;
      job = this.write(next);
      await job.written;
    });
    if (job) await job.done;
  }

  async setValue(_device, feature, value) {
    const target = parseFeatureId(feature?.external_id);
    if (!target) throw new Error(`${feature?.external_id} is not a Velbus feature`);
    const asked = this.now();
    const module = this.model.modules.get(target.address);
    const channel = module?.spec.channels.get(target.channel);
    if (!channel) throw this.refused(T.unknownChannel);
    const id = `${addressText(module.address)}-${channel.num}`;
    const { kind, key } = target;
    if (kind === 'relay' && Object.hasOwn(RELAY_FEATURES, key)) {
      // Whatever feature it comes from (an older switch or light kept), a
      // relay read only takes no command.
      if (channel.num > 8) throw this.refused(T.unsupportedCommand);
      if (
        key === 'readonly' ||
        relayKind(this.config, module.address, channel.num) === 'readonly'
      ) {
        this.logger.warn(`Relay ${id} REFUSED: read only in the configuration`);
        throw this.refused(T.readOnly);
      }
      const on = binaryOf(value);
      if (on === undefined) throw this.refused(fill(T.badValue, JSON.stringify(value)));
      return this.relay(module, channel.num, on === 1, asked, id);
    }
    if (kind === 'dimmer' && key === 'binary') {
      const on = binaryOf(value);
      if (on === undefined) throw this.refused(fill(T.badValue, JSON.stringify(value)));
      return this.dimmer(module, channel.num, on === 1 ? 'on' : 0, asked, id);
    }
    if (kind === 'dimmer' && key === 'brightness') {
      const level = numberOf(value);
      if (level === undefined || level < 0 || level > 100) {
        throw this.refused(fill(T.badValue, JSON.stringify(value)));
      }
      return this.dimmer(module, channel.num, Math.round(level), asked, id);
    }
    if (kind === 'blind' && key === 'state') {
      const state = numberOf(value);
      const motion =
        state === COVER_STATE.OPEN
          ? 'up'
          : state === COVER_STATE.CLOSE
            ? 'down'
            : state === COVER_STATE.STOP
              ? 'stop'
              : undefined;
      if (motion === undefined) throw this.refused(fill(T.badValue, JSON.stringify(value)));
      return this.blind(module, channel.num, motion, asked, id);
    }
    if (kind === 'blind' && key === 'position' && hasPosition(module.spec)) {
      const position = numberOf(value);
      if (position === undefined || position < 0 || position > 100) {
        throw this.refused(fill(T.badValue, JSON.stringify(value)));
      }
      return this.blind(module, channel.num, Math.round(position), asked, id);
    }
    if (kind === 'thermostat' && key === 'target') {
      const degrees = numberOf(value);
      if (degrees === undefined) throw this.refused(fill(T.badValue, JSON.stringify(value)));
      return this.setpoint(module, channel.num, degrees, asked, id);
    }
    if (kind === 'thermostat' && key === 'preset') {
      const preset = PRESET_FROM_GLADYS.get(numberOf(value));
      if (preset === undefined) throw this.refused(fill(T.badValue, JSON.stringify(value)));
      return this.preset(module, channel.num, preset, asked, id);
    }
    throw new Error(`${feature.external_id} is read-only`);
  }

  /** frame -> the first update of this module that `predicate` accepts. */
  matcher(module, predicate) {
    return (frame) => {
      const entry = this.index.get(frame.address);
      if (entry?.module !== module) return undefined;
      return decode(module.spec, frame, entry.offset).find(predicate);
    };
  }

  /**
   * Queues a command frame. `written` resolves once it is on the socket, or
   * rejects with Refused when nothing was sent; `done` resolves when the
   * module confirms it, or rejects ("sent, without confirmation").
   */
  write({ what, asked, frame, confirm, module, check }) {
    const label = word(what, 'en');
    if (!frame) throw this.refused(T.unsupportedCommand);
    if (!this.client.connected) {
      this.logger.warn(`Command NOT sent (${label}): not connected`);
      throw this.refused(T.offline);
    }
    if (this.now() > asked + TIMINGS.sendBy) {
      this.logger.warn(`Command NOT sent (${label}): too late`);
      throw this.refused(this.scanning ? T.busyScanning : T.tooLate);
    }
    let markWritten;
    const writtenSignal = new Promise((resolve) => {
      markWritten = resolve;
    });
    const done = this.client
      .send(frame, {
        urgent: true,
        sendBy: asked + TIMINGS.sendBy,
        check,
        label,
        ticket: { onWritten: () => markWritten() },
        wait: { match: this.matcher(module, confirm), until: asked + TIMINGS.answerBy },
      })
      .then(
        () => this.logger.info(`Command confirmed by the module (${label})`),
        (err) => {
          throw this.sendError(err, { label, what, module });
        },
      );
    // Rejections are read by the caller (written, then done): none unhandled.
    done.catch(() => undefined);
    return { written: Promise.race([writtenSignal, done]), done };
  }

  sendError(err, { label, what, module }) {
    if (err instanceof VelbusError && !err.sent) {
      this.logger.warn(`Command NOT sent (${label}): ${err.message}`);
      if (err.kind === 'withdrawn') return this.refused(T.thermostatRefused);
      if ((err.kind === 'late' || err.kind === 'full') && this.scanning) {
        return this.refused(T.busyScanning);
      }
      if (err.kind === 'late') return this.refused(T.tooLate);
      if (err.kind === 'full') return this.refused(T.queueFull);
      return this.refused(T.offline);
    }
    this.logger.warn(`Command sent, NOT confirmed (${label}): ${err.message}`);
    this.scheduleReadBack(module);
    return this.error(fill(T.unconfirmed, word(what, this.language)), err);
  }

  scheduleReadBack(module) {
    const timer = this.timers.setTimeout(() => {
      this.readBacks.delete(timer);
      if (!this.client.connected) return;
      const request = module.spec.thermostat
        ? thermostatRequest(module.address)
        : statusRequest(module.spec, module.address);
      this.client.send(request).catch(() => undefined);
    }, TIMINGS.readBack);
    this.readBacks.add(timer);
  }

  relay(module, channel, on, asked, id) {
    const what = fill(COMMAND_NAMES.relay, id, on);
    return this.command(channelKey(module.address, channel), async () => {
      this.logger.info(`Relay from Gladys: ${word(what, 'en')}`);
      return {
        what,
        asked,
        module,
        frame: relayCommand(module.spec, module.address, channel, on),
        confirm: (u) => u.kind === 'relay' && u.channel === channel && u.on === on,
      };
    });
  }

  /** `level`: 0 to 100, or 'on' (back to the last level when the module can). */
  dimmer(module, channel, level, asked, id) {
    const { spec, address } = module;
    const scale = spec.sliderScale || 100;
    const what = fill(COMMAND_NAMES.dimmer, id, level === 'on' ? 'on' : level);
    return this.command(channelKey(address, channel), async () => {
      let frame;
      let confirm;
      if (level === 'on') {
        frame =
          restoreDimmerCommand(spec, address, channel) ??
          dimmerCommand(spec, address, channel, scale);
        confirm = (u) => u.kind === 'dimmer' && u.channel === channel && u.level > 0;
      } else {
        const raw = Math.round((level * scale) / 100);
        frame = dimmerCommand(spec, address, channel, raw);
        const tolerance = Math.ceil(scale / 100);
        confirm = (u) =>
          u.kind === 'dimmer' && u.channel === channel && Math.abs(u.level - raw) <= tolerance;
      }
      this.logger.info(`Dimmer from Gladys: ${word(what, 'en')}`);
      return { what, asked, module, frame, confirm };
    });
  }

  /** `target`: 'up', 'down', 'stop', or a Gladys position (100 = open). */
  blind(module, channel, target, asked, id) {
    const { spec, address } = module;
    const what = fill(COMMAND_NAMES.blind, id, target);
    return this.command(channelKey(address, channel), async () => {
      let frame;
      let confirm;
      const mine = (u) => u.kind === 'blind' && u.channel === channel;
      if (typeof target === 'number') {
        const velbus = 100 - target;
        // velbus-aio: some modules ignore a position of 100, "down" does it.
        frame =
          velbus === 100
            ? blindCommand(spec, address, channel, 'down')
            : blindPositionCommand(spec, address, channel, velbus);
        // A movement, or the blind already within 2 % of the position asked.
        confirm = (u) =>
          mine(u) &&
          (u.motion !== 'stopped' ||
            (u.position !== undefined && Math.abs(u.position - velbus) <= 2));
      } else {
        frame = blindCommand(spec, address, channel, target);
        const motion = { up: 'up', down: 'down', stop: 'stopped' }[target];
        confirm = (u) =>
          mine(u) &&
          (u.motion === motion ||
            (target !== 'stop' &&
              u.motion === 'stopped' &&
              u.position === (target === 'up' ? 0 : 100)));
      }
      this.logger.info(`Blind from Gladys: ${word(what, 'en')}`);
      return { what, asked, module, frame, confirm };
    });
  }

  allowed() {
    return Boolean(this.config.allowThermostat);
  }

  /** The option, read again now; refused (nothing sent) once switched off. */
  checkAllowed(what) {
    if (this.allowed()) return;
    this.logger.warn(
      `Thermostat command REFUSED (${word(what, 'en')}): disabled in the configuration`,
    );
    throw this.refused(T.thermostatRefused);
  }

  /**
   * The thermostat status read from the bus now (a status frame received
   * after the request was written); refused, nothing sent, when it does not
   * come in time.
   */
  async freshThermostat(module, channel, asked) {
    if (!this.client.connected) throw this.refused(T.offline);
    const sendBy = asked + TIMINGS.sendBy;
    if (sendBy - this.now() < 200) throw this.refused(T.tooLate);
    try {
      return await this.client.send(thermostatRequest(module.address), {
        urgent: true,
        sendBy,
        wait: {
          match: this.matcher(module, (u) => u.kind === 'thermostat' && u.channel === channel),
          until: Math.min(this.now() + TIMINGS.readBefore, sendBy),
        },
      });
    } catch (err) {
      if (err instanceof VelbusError && err.kind === 'late') throw this.refused(T.tooLate);
      if (err instanceof VelbusError && err.kind === 'offline') throw this.refused(T.offline);
      if (err instanceof VelbusError && err.kind === 'full') throw this.refused(T.queueFull);
      throw this.refused(T.stateUnknown);
    }
  }

  setpoint(module, channel, degrees, asked, id) {
    const what = fill(COMMAND_NAMES.setpoint, id, degrees);
    this.checkAllowed(what);
    if (degrees < LIMITS.minSetpoint || degrees > LIMITS.maxSetpoint) {
      throw this.refused(fill(T.setpointRange, LIMITS.minSetpoint, LIMITS.maxSetpoint));
    }
    // Velbus counts in half degrees.
    const value = Math.round(degrees * 2) / 2;
    return this.command(channelKey(module.address, channel), async () => {
      this.checkAllowed(what);
      const fresh = await this.freshThermostat(module, channel, asked);
      if (fresh.target === value) {
        this.logger.info(`Thermostat ${id} already at ${value} °C: nothing sent`);
        return undefined;
      }
      this.checkAllowed(what);
      this.logger.info(`SET POINT from Gladys: ${word(what, 'en')} (was ${fresh.target} °C)`);
      return {
        what,
        asked,
        module,
        frame: setTemperatureCommand(module.spec, module.address, value),
        confirm: (u) => u.kind === 'thermostat' && u.channel === channel && u.target === value,
        check: () => this.allowed(),
      };
    });
  }

  preset(module, channel, preset, asked, id) {
    const what = fill(COMMAND_NAMES.preset, id, preset);
    this.checkAllowed(what);
    return this.command(channelKey(module.address, channel), async () => {
      this.checkAllowed(what);
      const fresh = await this.freshThermostat(module, channel, asked);
      if (fresh.preset === preset) {
        this.logger.info(`Thermostat ${id} already in ${preset}: nothing sent`);
        return undefined;
      }
      if (fresh.program === undefined) throw this.refused(T.stateUnknown);
      this.checkAllowed(what);
      this.logger.info(
        `PRESET from Gladys: ${word(what, 'en')} (was ${fresh.preset}, ${fresh.program})`,
      );
      return {
        what,
        asked,
        module,
        frame: presetCommand(
          module.spec,
          module.address,
          preset,
          sleepFor(fresh.program, fresh.sleepTimer),
        ),
        confirm: (u) => u.kind === 'thermostat' && u.channel === channel && u.preset === preset,
        check: () => this.allowed(),
      };
    });
  }

  // --- Configuration button ----------------------------------------------------

  /** Waits for the connection to come up or go down, at most `timeout` ms. */
  waitForLink(timeout) {
    if (this.client.connected) return Promise.resolve('up');
    return new Promise((resolve) => {
      const done = (result) => {
        this.client.off('up', onUp);
        this.client.off('down', onDown);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const onDown = () => done('down');
      const timer = this.timers.setTimeout(() => done('timeout'), timeout);
      this.client.on('up', onUp);
      this.client.on('down', onDown);
    });
  }

  /**
   * "Test the connection": lifts a stop; connects only when no connection is
   * open (stopped, or waiting for its next try), else waits for the one in
   * progress; tells what the scan found.
   */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    const until = this.now() + TIMINGS.testWait;
    if (!this.client.connected && !this.client.busy) {
      await this.liftStop();
      await this.setStatus(false, T.connecting);
      this.connect();
      if (!this.sweeper) this.startSweeper();
    }
    const result = await this.waitForLink(TIMINGS.testWait);
    await this.chain;
    if (result === 'timeout') throw this.error(T.stillConnecting);
    if (result !== 'up') {
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(message ?? T.offline);
    }
    if (this.scanning) {
      let timer;
      const left = Math.max(0, until - this.now());
      const outcome = await Promise.race([
        this.scanning.then(() => 'done'),
        new Promise((resolve) => {
          timer = this.timers.setTimeout(() => resolve('timeout'), left);
        }),
      ]);
      this.timers.clearTimeout(timer);
      if (outcome === 'timeout') {
        const progress = this.client.progress ?? { sent: 0, of: LIMITS.maxAddress };
        throw this.error(fill(T.stillScanning, progress.sent, progress.of));
      }
    }
    return this.connectedMessage();
  }
}
