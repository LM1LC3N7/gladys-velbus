// VelbusApp with the SDK's fake Gladys (createFakeGladys), the in-memory bus
// (test/helpers/fakeBus.js) and a virtual clock: the whole chain from the bus
// frames to the Gladys devices, states, scene events and commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { VelbusApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakeBus, FakeClock, quietLogger, settle, until } from './helpers/fakeBus.js';

const BASE = { host: '192.0.2.30', language: 'en' };

async function setup(t, { config = {}, bus: busOptions = {}, store, devices, scan = true } = {}) {
  const clock = new FakeClock();
  const gladys = createFakeGladys({ config: { ...BASE, ...config }, devices });
  const bus = new FakeBus(busOptions);
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new VelbusApp({
    gladys,
    logger,
    connect: bus.connect,
    store: memory,
    now: clock.now,
    timers: clock,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  const device = (externalId) =>
    gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  const ids = (kind, key) => gladys.externalIds(kind, key);
  const ctx = {
    gladys,
    bus,
    app,
    clock,
    logger,
    store: memory,
    device,
    ids,
    state: (id) => gladys.fake.lastState(id),
    status: () => gladys.fake.connectionStatus,
    set: (kind, key, feature, value) => {
      const d = device(ids(kind, key).device);
      const f = d.features.find((x) => x.external_id === ids(kind, key).feature(feature));
      return gladys.fake.setValue(d, f, value);
    },
    /** A command while the virtual clock runs (the client paces its frames). */
    command: async (kind, key, feature, value, ms = 6_000) => {
      const pending = ctx.set(kind, key, feature, value);
      await ctx.clock.advance(ms);
      return pending;
    },
  };
  if (scan) await scanned(ctx);
  return ctx;
}

/** Scan (254 requests 60 ms apart, 3 s wait), then the names and states. */
async function scanned(ctx) {
  await until(() => ctx.app.online);
  await ctx.clock.advance(20_000);
  await until(() => !ctx.app.scanning);
  await ctx.clock.advance(15_000);
  await ctx.app.chain;
  await settle();
}

test('the scan: modules, names from the bus, devices, states, unsupported modules', async (t) => {
  const ctx = await setup(t);
  const { gladys, ids } = ctx;
  const found = gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]);
  assert.deepEqual(found.slice(0, 2), [
    [ids('relay', '1a-1').device, 'Cuisine'],
    [ids('relay', '1a-2').device, 'Salon'],
  ]);
  assert.ok(
    found.some(
      ([id, name]) => id === ids('relay', '1a-3').device && name === 'VMB4RYLD 1A relay 3',
    ),
  );
  assert.ok(found.some(([id, name]) => id === ids('dimmer', '2a-1').device && name === 'Bureau'));
  assert.ok(found.some(([id, name]) => id === ids('blind', '30-1').device && name === 'Volet sud'));
  assert.ok(
    found.some(([id, name]) => id === ids('thermostat', '40-10').device && name === 'Sejour'),
  );
  // The sub-address 0x41 is part of the VMBGP4, the DALI module is not supported.
  assert.ok(!found.some(([id]) => id.includes(':41-')));
  assert.ok(!found.some(([id]) => id.includes(':50-')));
  assert.match(ctx.status().message.en, /4 module\(s\).*Not supported: VMBDALI 50/);
  assert.equal(ctx.status().connected, true);
  // Buttons are no devices.
  assert.ok(!found.some(([id]) => /:40-1$/.test(id)));
  // Blinds are shutters, never switches; dimmers lights.
  const blind = ctx.device(ids('blind', '30-1').device);
  assert.deepEqual(
    blind.features.map((f) => [f.category, f.type]),
    [
      ['shutter', 'state'],
      ['shutter', 'position'],
    ],
  );
  assert.deepEqual(
    ctx.device(ids('dimmer', '2a-2').device).features.map((f) => [f.category, f.type]),
    [
      ['light', 'binary'],
      ['light', 'brightness'],
    ],
  );
  const thermostat = ctx.device(ids('thermostat', '40-10').device);
  assert.deepEqual(
    thermostat.features.map((f) => [f.category, f.type, f.unit ?? null]),
    [
      ['temperature-sensor', 'decimal', 'celsius'],
      ['thermostat', 'target-temperature', 'celsius'],
      ['thermostat', 'preset', null],
      ['thermostat', 'mode', null],
      ['thermostat', 'operating-state', null],
    ],
  );
  // States.
  assert.equal(ctx.state(ids('relay', '1a-2').feature('switch')), 1);
  assert.equal(ctx.state(ids('relay', '1a-1').feature('switch')), 0);
  assert.equal(ctx.state(ids('dimmer', '2a-2').feature('brightness')), 40);
  assert.equal(ctx.state(ids('dimmer', '2a-2').feature('binary')), 1);
  assert.equal(ctx.state(ids('blind', '30-1').feature('position')), 100, 'Velbus 0 = open = 100');
  assert.equal(ctx.state(ids('blind', '30-1').feature('state')), 1);
  assert.equal(ctx.state(ids('blind', '30-2').feature('position')), 0);
  assert.equal(ctx.state(ids('thermostat', '40-10').feature('temperature')), 20.5);
  assert.equal(ctx.state(ids('thermostat', '40-10').feature('target')), 21);
  assert.equal(ctx.state(ids('thermostat', '40-10').feature('preset')), 3, 'day = ECO');
  assert.equal(ctx.state(ids('thermostat', '40-10').feature('mode')), 1, 'heating');
  assert.equal(ctx.state(ids('thermostat', '40-10').feature('operating')), 1);
  assert.ok(gladys.fake.transports.every((entry) => entry.transport === 'local'));
});

test('relays: switch by default, light by configuration, on and off confirmed', async (t) => {
  const ctx = await setup(t, { config: { relay_kinds: '1A-2, 1a-3:switch, zz-1, 1A-9' } });
  const light = ctx.device(ctx.ids('relay', '1a-2').device);
  assert.deepEqual([light.features[0].category, light.features[0].type], ['light', 'binary']);
  assert.match(ctx.logger.lines.join('\n'), /Relay kinds not understood: zz-1, 1A-9/);
  const ack = await ctx.command('relay', '1a-1', 'switch', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x1a, 0x02, 0x01]);
  await settle();
  assert.equal(ctx.state(ctx.ids('relay', '1a-1').feature('switch')), 1);
  const off = await ctx.command('relay', '1a-2', 'light', '0');
  assert.equal(off.success, true, off.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x1a, 0x01, 0x02]);
  // Strict values: null, '' and 2 are not 0 or 1, nothing sent.
  const before = ctx.bus.log.length;
  for (const value of [null, '', 2, 'on']) {
    const bad = await ctx.command('relay', '1a-1', 'switch', value, 100);
    assert.equal(bad.success, false);
    assert.match(bad.error, /nothing was sent/);
  }
  assert.equal(ctx.bus.log.length, before);
});

test('a command the module does not confirm: "sent, without confirmation", read back', async (t) => {
  const ctx = await setup(t);
  ctx.bus.hold = (f) => f.address === 0x1a && (f.data[0] === 0x02 || f.data[0] === 0xfa);
  const ack = await ctx.command('relay', '1a-1', 'switch', 1, 5_000);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent to the bus.*without confirmation.*read again/);
  assert.match(ctx.logger.lines.join('\n'), /Command sent, NOT confirmed/);
  await ctx.clock.advance(3_000);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x1a, 0xfa, 0b11111], 'the read back');
});

test('dimmers: brightness, on (restore), off', async (t) => {
  const ctx = await setup(t);
  let ack = await ctx.command('dimmer', '2a-1', 'brightness', 55);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x2a, 0x07, 0x01, 55, 0, 0]);
  ack = await ctx.command('dimmer', '2a-1', 'binary', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x2a, 0x07, 0x01, 0, 0, 0]);
  ack = await ctx.command('dimmer', '2a-1', 'binary', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x2a, 0x11, 0x01, 0, 0, 0]);
  await settle();
  assert.equal(ctx.state(ctx.ids('dimmer', '2a-1').feature('brightness')), 55);
  const bad = await ctx.command('dimmer', '2a-1', 'brightness', 120, 100);
  assert.equal(bad.success, false);
});

test('blinds: open, close, stop, position (100 = open in Gladys)', async (t) => {
  const ctx = await setup(t);
  let ack = await ctx.command('blind', '30-1', 'state', -1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x30, 0x06, 0x01, 0, 0, 0]);
  ack = await ctx.command('blind', '30-1', 'state', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x30, 0x04, 0x01]);
  ack = await ctx.command('blind', '30-2', 'position', 30);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x30, 0x1c, 0x02, 70]);
  await settle();
  assert.equal(ctx.state(ctx.ids('blind', '30-2').feature('position')), 30);
  // Fully closed: "down", as velbus-aio does (some modules ignore position 100).
  ack = await ctx.command('blind', '30-2', 'position', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x30, 0x06, 0x02, 0, 0, 0]);
  ack = await ctx.command('blind', '30-1', 'state', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x30, 0x05, 0x01, 0, 0, 0]);
  const bad = await ctx.command('blind', '30-1', 'state', 5, 100);
  assert.equal(bad.success, false);
});

test('thermostats are off by default: nothing sent, not even a read', async (t) => {
  const ctx = await setup(t);
  const before = ctx.bus.log.length;
  for (const [feature, value] of [
    ['target', 22],
    ['preset', 5],
  ]) {
    const ack = await ctx.command('thermostat', '40-10', feature, value, 100);
    assert.equal(ack.success, false);
    assert.match(ack.error, /disabled in the configuration: nothing was sent/);
  }
  assert.equal(ctx.bus.log.length, before);
  assert.match(ctx.logger.lines.join('\n'), /Thermostat command REFUSED/);
});

test('set point: decided on the thermostat read from the bus just before', async (t) => {
  const ctx = await setup(t, { config: { allow_thermostat: true } });
  let ack = await ctx.command('thermostat', '40-10', 'target', 22.4);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.slice(-2), [
    [0x40, 0xfa, 0xff],
    [0x40, 0xe4, 0x00, 45],
  ]);
  await settle();
  assert.equal(ctx.state(ctx.ids('thermostat', '40-10').feature('target')), 22.5);
  // Changed on the module meanwhile, without a frame: memory says 22.5, the bus 19.
  ctx.bus.modules[0x40].thermostat.target = 19;
  ack = await ctx.command('thermostat', '40-10', 'target', 22.5);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x40, 0xe4, 0x00, 45], 'sent: the bus said 19');
  // Already there: read, nothing sent.
  const count = ctx.bus.commands.length;
  ack = await ctx.command('thermostat', '40-10', 'target', 22.5);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.slice(count), [[0x40, 0xfa, 0xff]]);
  // Out of range: refused before anything.
  ack = await ctx.command('thermostat', '40-10', 'target', 45, 100);
  assert.match(ack.error, /between 5 and 30.*nothing was sent/);
});

test('set point: no fresh status in time, nothing sent', async (t) => {
  const ctx = await setup(t, { config: { allow_thermostat: true } });
  ctx.bus.hold = (f) => f.address === 0x40 && f.data[0] === 0xfa;
  const ack = await ctx.command('thermostat', '40-10', 'target', 23);
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not be read.*nothing was sent/);
  assert.ok(!ctx.bus.commands.some((c) => c[1] === 0xe4));
});

test('set point: the option switched off while the command waits stops it before the write', async (t) => {
  const ctx = await setup(t, { config: { allow_thermostat: true } });
  ctx.bus.hold = (f) => f.address === 0x40 && f.data[0] === 0xfa;
  // The read is answered late by hand, after the option went off.
  const pending = ctx.set('thermostat', '40-10', 'target', 23);
  await ctx.clock.advance(200);
  ctx.app.config = { ...ctx.app.config, allowThermostat: false };
  ctx.bus.sendThermostat(ctx.bus.current, 0x40, ctx.bus.modules[0x40].thermostat);
  await ctx.clock.advance(5_000);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /disabled in the configuration: nothing was sent/);
  assert.ok(!ctx.bus.commands.some((c) => c[1] === 0xe4));
});

test('the option is checked once more right before the socket write', async (t) => {
  const ctx = await setup(t, { config: { allow_thermostat: true } });
  // The set point is queued behind a slow background frame: the option goes
  // off between the queueing and the write.
  const pending = ctx.set('thermostat', '40-10', 'target', 24);
  // Let the fresh read through, then switch off just before the write.
  const realSend = ctx.app.client.send.bind(ctx.app.client);
  ctx.app.client.send = (frame, options) => {
    if (frame.data[0] === 0xe4) ctx.app.config = { ...ctx.app.config, allowThermostat: false };
    return realSend(frame, options);
  };
  await ctx.clock.advance(5_000);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /disabled in the configuration: nothing was sent/);
  assert.ok(!ctx.bus.commands.some((c) => c[1] === 0xe4));
});

test('preset: the program state read just before is kept (manual -> 0xFFFF)', async (t) => {
  const ctx = await setup(t, { config: { allow_thermostat: true } });
  ctx.bus.modules[0x40].thermostat.program = 'manual';
  let ack = await ctx.command('thermostat', '40-10', 'preset', 5);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.bus.commands.at(-1), [0x40, 0xdb, 0xff, 0xff]);
  await settle();
  assert.equal(ctx.state(ctx.ids('thermostat', '40-10').feature('preset')), 5);
  ack = await ctx.command('thermostat', '40-10', 'preset', 2, 100);
  assert.equal(ack.success, false, 'AWAY has no Velbus twin');
});

test('push buttons: scene events, with the module, channel, action and name', async (t) => {
  const ctx = await setup(t);
  ctx.bus.button(0x40, { closed: 0x01 });
  ctx.bus.button(0x40, { opened: 0x01 });
  await settle();
  await ctx.app.chain;
  assert.deepEqual(ctx.gladys.fake.sceneEvents.slice(-2), [
    { key: 'button', data: { module: '40', channel: 1, action: 'pressed', name: 'Entree' } },
    { key: 'button', data: { module: '40', channel: 1, action: 'released', name: 'Entree' } },
  ]);
  // Unknown address, or a relay module: no button event.
  ctx.bus.button(0x77, { closed: 0x01 });
  ctx.bus.button(0x1a, { closed: 0x04 });
  await settle();
  await ctx.app.chain;
  assert.equal(ctx.gladys.fake.sceneEvents.length, 2);
  assert.equal(ctx.state(ctx.ids('relay', '1a-3').feature('switch')), 1, 'the relay said it is on');
});

test('frames apply in the order of the bus; a burst is one publication', async (t) => {
  const ctx = await setup(t);
  const publications = () => ctx.gladys.fake.bodies('POST', '/state').length;
  const before = publications();
  for (let i = 0; i < 200; i += 1) {
    ctx.bus.frame(0xfb, 0x1a, [0xfb, 0x01, 0, i % 2, 0, 0, 0, 0]);
  }
  ctx.bus.frame(0xfb, 0x1a, [0xfb, 0x01, 0, 1, 0, 0, 0, 0]);
  await settle(40);
  await ctx.app.chain;
  assert.equal(ctx.state(ctx.ids('relay', '1a-1').feature('switch')), 1, 'the last frame wins');
  assert.ok(publications() - before <= 2, `${publications() - before} publications`);
});

test('the ack of a command never waits for the publication of the states', async (t) => {
  const ctx = await setup(t);
  ctx.gladys.publishStates = () => new Promise(() => undefined);
  const ack = await ctx.command('relay', '1a-1', 'switch', 1);
  assert.equal(ack.success, true, ack.error);
});

test('nothing reaches Object.prototype from the bus or the configuration', async (t) => {
  const ctx = await setup(t, { config: { relay_kinds: '__proto__:light, constructor-1' } });
  // A name "__proto__" and frames for odd channels.
  ctx.bus.frame(0xfb, 0x1a, [0xf0, 0x01, ...Buffer.from('__prot')]);
  ctx.bus.frame(0xfb, 0x1a, [0xf1, 0x01, ...Buffer.from('o__')]);
  ctx.bus.frame(0xfb, 0x1a, [0xf2, 0x01, 0, 0, 0, 0]);
  ctx.bus.frame(0xfb, 0x1a, [0xfb, 0x80, 0, 1, 0, 0, 0, 0]);
  await settle();
  await ctx.app.chain;
  assert.equal({}.light, undefined);
  assert.equal(Object.prototype.on, undefined);
  assert.equal(ctx.device(ctx.ids('relay', '1a-1').device).name, '__proto__');
});

test('offline: commands refused, nothing sent; reconnection spaced, statuses read again', async (t) => {
  const ctx = await setup(t);
  ctx.bus.refuseConnections = 2;
  ctx.bus.drop();
  await settle();
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /unreachable.*next try in 10 s/);
  assert.ok(ctx.gladys.fake.transports.some((entry) => entry.transport === 'unreachable'));
  const ack = await ctx.command('relay', '1a-1', 'switch', 1, 100);
  assert.equal(ack.success, false);
  assert.match(ack.error, /not connected: nothing was sent/);
  await ctx.clock.advance(10_000);
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /next try in 30 s/);
  await ctx.clock.advance(30_000);
  await ctx.clock.advance(60_000);
  await ctx.clock.advance(5_000);
  await ctx.app.chain;
  assert.equal(ctx.app.online, true);
  // No new scan: the statuses of the known modules are read again.
  const session = ctx.bus.current.session;
  const frames = ctx.bus.log.filter((f) => f.session === session);
  assert.ok(!frames.some((f) => f.rtr));
  assert.ok(frames.some((f) => f.address === 0x1a && f.data[0] === 0xfa));
  assert.equal(ctx.status().connected, true);
});

test('Signum: TLS, the password first, never logged; never sent over plain TCP', async (t) => {
  const tls = await setup(t, {
    config: { connection: 'tls', password: 's3cret-key' },
    bus: { password: 's3cret-key' },
  });
  assert.equal(tls.bus.options.tls, true);
  assert.equal(tls.bus.current.auth, 's3cret-key');
  assert.equal(tls.bus.current.written[0].toString('utf8'), 's3cret-key');
  assert.ok(!tls.logger.lines.join('\n').includes('s3cret-key'));
  assert.match(tls.logger.lines.join('\n'), /SHA-256 ab:cd: enter it in the configuration/);

  const tcp = await setup(t, { config: { password: 'other-key' } });
  assert.equal(tcp.bus.options.tls, false);
  assert.ok(
    tcp.bus.current.written.every((bytes) => bytes[0] === 0x0f),
    'only frames',
  );
  assert.match(tcp.status().message.en, /password is ignored: it is only sent over TLS/);
  assert.ok(!tcp.logger.lines.join('\n').includes('other-key'));
});

test('a refused password stops the connection, also after a restart', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, {
    config: { connection: 'tls', password: 'wrong' },
    bus: { password: 'right' },
    store,
    scan: false,
  });
  await ctx.clock.advance(1_000);
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /next try in 10 s/);
  await ctx.clock.advance(11_000);
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /password is probably wrong.*no new try/);
  assert.equal(store.data.stop.kind, 'password_refused');
  assert.ok(!JSON.stringify(store.data).includes('wrong'));
  const sessions = ctx.bus.sockets.length;
  await ctx.clock.advance(600_000);
  assert.equal(ctx.bus.sockets.length, sessions, 'no loop');
  // A restart with the same place: still stopped.
  await ctx.app.start({ ...BASE, connection: 'tls', password: 'wrong' });
  assert.equal(ctx.bus.sockets.length, sessions);
  // A new password lifts it.
  await ctx.gladys.fake.configUpdated({ ...BASE, connection: 'tls', password: 'right' });
  await ctx.clock.advance(1_000);
  assert.equal(ctx.app.online, true);
  assert.equal(store.data.stop, null);
});

test('a pinned certificate that differs: stopped, the password never sent', async (t) => {
  const ctx = await setup(t, {
    config: { connection: 'tls', password: 'key', tls_fingerprint: '00'.repeat(32) },
    bus: { password: 'key', fingerprint: 'AB:CD' },
    scan: false,
  });
  await ctx.clock.advance(1_000);
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /not the pinned one.*password was not sent/);
  assert.equal(ctx.bus.current.written.length, 0);
  assert.equal(ctx.store.data.stop.kind, 'certificate_changed');
  // The right pin connects.
  const pinned = await setup(t, {
    config: { connection: 'tls', password: 'key', tls_fingerprint: 'ab:cd'.padEnd(95, ':00') },
    bus: { password: 'key', fingerprint: `AB:CD${':00'.repeat(30)}` },
  });
  assert.equal(pinned.app.online, true);
  // A malformed pin is a configuration problem.
  const bad = await setup(t, { config: { tls_fingerprint: 'xyz' }, scan: false });
  assert.match(bad.status().message.en, /64 hexadecimal digits/);
});

test('"Test the connection" waits for the scan and tells what it found', async (t) => {
  const ctx = await setup(t, { scan: false });
  const pending = ctx.gladys.fake.action('test_connection');
  await ctx.clock.advance(20_000);
  const ack = await pending;
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /4 module\(s\)/);
});

test('Gladys reconnects: devices, states and status sent again', async (t) => {
  const ctx = await setup(t);
  const count = ctx.gladys.fake.bodies('POST', '/discovered_device').length;
  await ctx.gladys.disconnect();
  await ctx.gladys.connect();
  await ctx.app.chain;
  assert.ok(ctx.gladys.fake.bodies('POST', '/discovered_device').length > count);
  assert.equal(ctx.status().connected, true);
});
