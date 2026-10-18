// The connection: two bounded queues, deadlines, answers that belong to their
// request, the watchdog, the scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { VelbusClient, VelbusError } from '../src/velbus/client.js';
import { relayCommand, statusRequest } from '../src/velbus/messages.js';
import { specOf } from '../src/velbus/modules.js';
import { FakeBus, FakeClock, settle, until } from './helpers/fakeBus.js';

const RELAYS = specOf(0x10);

async function setup(t, busOptions = {}) {
  const clock = new FakeClock();
  const bus = new FakeBus(busOptions);
  const client = new VelbusClient({ connect: bus.connect, timers: clock, now: clock.now });
  client.configure({ host: '192.0.2.1', port: 27015, tls: false });
  const frames = [];
  client.on('frame', (f) => frames.push(f));
  client.start();
  t.after(() => client.stop());
  await until(() => client.connected);
  return { clock, bus, client, frames };
}

const relayStatus = (channel) => (frame) =>
  frame.address === 0x1a && frame.data[0] === 0xfb && frame.data[1] === 1 << (channel - 1)
    ? frame.data[3]
    : undefined;

test('the scan finds the modules; a command goes before the scan frames', async (t) => {
  const { clock, bus, client } = await setup(t);
  const scan = client.scan();
  await clock.advance(1_000);
  const sentBefore = bus.log.length;
  const command = client.send(relayCommand(RELAYS, 0x1a, 1, true), { urgent: true });
  await clock.advance(100);
  await command;
  const order = bus.log.slice(sentBefore).map((f) => (f.rtr ? 'scan' : 'command'));
  assert.equal(order.indexOf('command') <= 1, true, order.slice(0, 4).join(','));
  await clock.advance(20_000);
  const { found, subs } = await scan;
  assert.deepEqual(
    [...found.keys()].sort((a, b) => a - b),
    [0x1a, 0x2a, 0x30, 0x40, 0x41, 0x50],
  );
  assert.equal(subs.get(0x40).length, 1);
  assert.equal(bus.log.filter((f) => f.rtr).length, LIMITS.maxAddress);
  // The frames are paced.
  const scanFrames = bus.log.filter((f) => f.rtr).length;
  assert.equal(scanFrames, 254);
});

test('an answer belongs to its request: only frames after the write count', async (t) => {
  const { clock, bus, client } = await setup(t);
  // A status of channel 1 already on the wire before the request is written.
  bus.hold = (f) => f.data[0] === 0xfa;
  bus.frame(0xfb, 0x1a, [0xfb, 0x01, 0, 1, 0, 0, 0, 0]);
  await settle();
  const read = client
    .send(statusRequest(RELAYS, 0x1a), {
      urgent: true,
      wait: { match: relayStatus(1), timeout: 1_000 },
    })
    .catch((err) => err);
  await clock.advance(1_500);
  const err = await read;
  assert.ok(err instanceof VelbusError && err.kind === 'timeout' && err.sent);
  // The answer after the write is taken.
  bus.hold = () => false;
  const again = client.send(statusRequest(RELAYS, 0x1a), {
    urgent: true,
    wait: { match: relayStatus(2), timeout: 1_000 },
  });
  await clock.advance(200);
  assert.equal(await again, 1, 'relay 2 is on');
});

test('deadlines, bounded queue, withdrawn before the write', async (t) => {
  const { clock, client } = await setup(t);
  const late = client.send(relayCommand(RELAYS, 0x1a, 1, true), {
    urgent: true,
    sendBy: clock.now() - 1,
  });
  await assert.rejects(late, (err) => err.kind === 'late' && !err.sent);
  const withdrawn = client
    .send(relayCommand(RELAYS, 0x1a, 1, true), { urgent: true, check: () => false })
    .catch((err) => err);
  await clock.advance(100);
  const why = await withdrawn;
  assert.ok(why.kind === 'withdrawn' && !why.sent);
  // Distinct background frames (identical ones are merged, see below).
  const many = [];
  for (let i = 0; i < LIMITS.maxQueue + 5; i += 1) {
    const frame = { priority: 0xfb, address: 1 + (i % 254), data: [0xfa, Math.floor(i / 254)] };
    many.push(client.send(frame).catch((err) => err.kind));
  }
  // The first one is written at once: the queue holds maxQueue of the others.
  const kinds = await Promise.race([
    Promise.all(many.slice(LIMITS.maxQueue + 1)),
    new Promise((r) => setTimeout(r, 1_000, 'stuck')),
  ]);
  assert.deepEqual(kinds, new Array(4).fill('full'));
  // The background queue full: a command still goes, before it.
  const command = client.send(relayCommand(RELAYS, 0x1a, 2, true), { urgent: true });
  await clock.advance(100);
  assert.deepEqual(await command, { written: true });
  // An identical background request waiting: merged, one frame for both.
  const before = client.background.length;
  const a = client.send(statusRequest(RELAYS, 0x30)).catch((err) => err.kind);
  const b = client.send(statusRequest(RELAYS, 0x30)).catch((err) => err.kind);
  assert.equal(client.background.length, before, 'the queue is full: both refused together');
  assert.deepEqual([await a, await b], ['full', 'full']);
  client.stop();
  // Stopped: the written one resolved, every waiting one fails "not sent".
  const results = await Promise.all(many.slice(0, 50));
  assert.deepEqual(results[0], { written: true });
  assert.ok(results.slice(1).every((kind) => kind === 'offline'));
});

test('the watchdog: a silent bus gets a probe, no frame cuts the session', async (t) => {
  const { clock, bus, client } = await setup(t);
  client.probeAddress = () => 0x1a;
  const downs = [];
  client.on('down', (info) => downs.push(info));
  // An answering bus: the probe brings a frame, nothing happens.
  await clock.advance(TIMINGS.idleProbe + TIMINGS.tick);
  assert.ok(bus.log.some((f) => f.rtr && f.address === 0x1a));
  assert.equal(downs.length, 0);
  // A silent bus: cut, then a reconnection 10 s later.
  bus.hold = () => true;
  await clock.advance(TIMINGS.idleProbe + TIMINGS.tick + TIMINGS.probeTimeout);
  assert.equal(downs.length, 1);
  assert.equal(downs[0].reason, 'no answer from the bus');
  assert.equal(downs[0].retryIn, 10_000);
});

test('a flood of bytes waiting to be written cuts the session', async (t) => {
  const { clock, bus, client } = await setup(t);
  const downs = [];
  client.on('down', (info) => downs.push(info));
  bus.current.writableLength = LIMITS.maxPendingWrite + 1;
  await assert.rejects(client.send(statusRequest(RELAYS, 0x1a)), (err) => err.sent);
  await clock.advance(10);
  assert.equal(downs[0].reason, 'write buffer full');
});

test('identical background requests are merged; a command keeps the pause after a name request', async (t) => {
  const { clock, bus, client } = await setup(t);
  const name = { priority: 0xfb, address: 0x1a, data: [0xef, 0x1f] };
  await client.send(name, { gap: TIMINGS.nameGap });
  const a = client.send(statusRequest(RELAYS, 0x30));
  const b = client.send(statusRequest(RELAYS, 0x30));
  assert.equal(client.background.length, 1, 'one frame for both');
  // A command during the pause: written at once, the pause still holds.
  await clock.advance(100);
  await client.send(relayCommand(RELAYS, 0x1a, 1, true), { urgent: true });
  await clock.advance(500);
  assert.equal(bus.log.filter((f) => f.address === 0x30).length, 0, 'still in the pause');
  await clock.advance(TIMINGS.nameGap);
  await Promise.all([a, b]);
  assert.equal(bus.log.filter((f) => f.address === 0x30).length, 1);
});

test('the watchdog wants a module frame: an RTR echo does not count', async (t) => {
  const { clock, bus, client } = await setup(t);
  client.probeAddress = () => 0x1a;
  const downs = [];
  client.on('down', (info) => downs.push(info));
  // The gateway echoes the request but no module answers.
  bus.hold = (f) => {
    if (f.rtr) bus.current.send(f.priority, f.address, [], true);
    return true;
  };
  await clock.advance(TIMINGS.idleProbe + TIMINGS.tick + TIMINGS.probeTimeout);
  assert.equal(downs[0]?.reason, 'no answer from the bus');
});

test('invalid bytes: counted, one warning per minute', async (t) => {
  const clock = new FakeClock();
  const bus = new FakeBus();
  const lines = [];
  const logger = { debug() {}, info() {}, error() {}, warn: (m) => lines.push(m) };
  const client = new VelbusClient({ connect: bus.connect, timers: clock, now: clock.now, logger });
  client.configure({ host: '192.0.2.1', port: 27015, tls: false });
  client.start();
  t.after(() => client.stop());
  await until(() => client.connected);
  for (let i = 0; i < 100; i += 1) bus.current.raw([0x0f, 0x00]);
  await settle();
  assert.equal(lines.filter((l) => /invalid frames dropped/.test(l)).length, 1);
  await clock.advance(TIMINGS.dropLog);
  bus.current.raw([0x0f, 0x00]);
  await settle();
  assert.equal(lines.filter((l) => /invalid frames dropped \(101/.test(l)).length, 1);
});
