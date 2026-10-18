// What frames mean per module type, and the frames of the commands, as
// velbus-aio builds and reads them (its message classes and the variant its
// module descriptions choose).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bitChannel,
  blindCommand,
  blindPositionCommand,
  decode,
  decodeModuleType,
  decodeSubAddresses,
  dimmerCommand,
  nameRequest,
  presetCommand,
  relayCommand,
  restoreDimmerCommand,
  setTemperatureCommand,
  sleepFor,
  statusRequest,
  typeRequest,
} from '../src/velbus/messages.js';
import { allSpecs, specOf, typeName } from '../src/velbus/modules.js';

const frame = (data, extra = {}) => ({
  priority: 0xfb,
  address: 0x10,
  rtr: false,
  data: Buffer.from(data),
  ...extra,
});

const VMB4RYLD = specOf(0x10);
const VMB4RY = specOf(0x08);
const VMB4RYLD20 = specOf(0x26);
const VMB4DC = specOf(0x12);
const VMB1DM = specOf(0x07);
const VMB2BLE = specOf(0x1d);
const VMB2BLE20 = specOf(0x61);
const VMB2BL = specOf(0x09);
const VMBGP4 = specOf(0x20);
const VMBGPO = specOf(0x21);

test('the module table: known types, maps only, DALI left out', () => {
  assert.equal(VMB4RYLD.name, 'VMB4RYLD');
  assert.equal(typeName(0x45), 'VMBDALI');
  assert.equal(specOf(0x45).supported, false);
  assert.equal(typeName(0xee), 'type 0xEE');
  assert.equal(specOf('__proto__'), undefined);
  assert.equal(specOf('constructor'), undefined);
  assert.ok(allSpecs().filter((s) => s.supported).length > 70);
  // Every variant the decoder or the encoders meet is one they know.
  const known = new Set([
    'PushButtonStatusMessage',
    'SwitchRelayOffMessage',
    'SwitchRelayOffMessage20',
    'SwitchRelayOnMessage',
    'SwitchRelayOnMessage20',
    'CoverOffMessage',
    'CoverOffMessage2',
    'CoverUpMessage',
    'CoverUpMessage2',
    'CoverDownMessage',
    'CoverDownMessage2',
    'SetDimmerMessage',
    'SetDimmerMessage2',
    'SliderStatusMessage',
    'RestoreDimmerMessage',
    'RestoreDimmerMessage2',
    'CoverPosMessage',
    'DimValueStatus',
    'ModuleSubTypeMessage',
    'DimmerChannelStatusMessage',
    'SetTemperatureMessage',
    'SensorTemperatureMessage',
    'TempSensorStatusMessage',
    'BlindStatusMessage',
    'BlindStatusNgMessage',
    'BlindStatusNg20Message',
    'DimmerStatusMessage',
    'ChannelNameRequestMessage',
    'ChannelNameRequestMessage2',
    'ChannelNamePart1Message',
    'ChannelNamePart1Message2',
    'ChannelNamePart1Message3',
    'RelayStatusMessage',
    'RelayStatusMessage2',
    'RelayStatusMessage3',
    'ModuleTypeMessage',
    'ModuleType2Message',
    'SwitchToComfortMessage',
    'SwitchToDayMessage',
    'SwitchToNightMessage',
    'SwitchToSafeMessage',
  ]);
  for (const spec of allSpecs().filter((s) => s.supported)) {
    for (const variant of spec.classes.values())
      assert.ok(known.has(variant), `${spec.name}: ${variant}`);
  }
});

test('the type answer and the sub-addresses', () => {
  assert.deepEqual(decodeModuleType(Buffer.from([0xff, 0x10, 0x12, 0x34, 0x01, 24, 10])), {
    type: 0x10,
    serial: 0x1234,
    memoryMap: 1,
    build: '24.10',
  });
  // Old modules give no serial.
  assert.equal(decodeModuleType(Buffer.from([0xff, 0x08, 0x00, 0x00, 24, 10])).serial, 0);
  assert.equal(
    decodeModuleType(Buffer.from([0xff, 0x61, 0, 1, 2, 25, 3, 9]), 'ModuleType2Message').build,
    '25.3',
  );
  assert.equal(decodeModuleType(Buffer.from([0xfb, 1])), undefined);
  assert.deepEqual(
    [...decodeSubAddresses(Buffer.from([0xb0, 0x21, 0, 0, 0x41, 0x42, 0xff, 0x44]))],
    [
      [1, 0x41],
      [2, 0x42],
      [4, 0x44],
    ],
  );
  assert.deepEqual([...decodeSubAddresses(Buffer.from([0xa7, 0x45, 0, 0, 0x50]))], [[5, 0x50]]);
});

test('relay status: the three variants', () => {
  assert.deepEqual(decode(VMB4RYLD, frame([0xfb, 0x04, 0, 0x01, 0, 0, 0, 0])), [
    { kind: 'relay', channel: 3, on: true },
  ]);
  // Interval timer (3) is not "on" for velbus-aio's RelayStatusMessage.
  assert.equal(decode(VMB4RYLD, frame([0xfb, 0x04, 0, 0x03, 0, 0, 0, 0]))[0].on, false);
  // VMB4RY: the status byte is a bitmask.
  assert.equal(decode(VMB4RY, frame([0xfb, 0x02, 0, 0x02, 0, 0, 0, 0]))[0].on, true);
  // -20: every channel in one frame.
  assert.deepEqual(
    decode(VMB4RYLD20, frame([0xfb, 0b0101, 0, 0, 0, 0, 0, 0])).map((u) => u.on),
    [true, false, true, false, false, false, false, false],
  );
  // A channel byte naming several channels, a short frame: nothing.
  assert.deepEqual(decode(VMB4RYLD, frame([0xfb, 0x03, 0, 1, 0, 0, 0, 0])), []);
  assert.deepEqual(decode(VMB4RYLD, frame([0xfb, 0x01, 0, 1])), []);
  assert.deepEqual(decode(VMB4RYLD, frame([0xfb, 0x01, 0, 1, 0, 0, 0, 0], { rtr: true })), []);
});

test('push buttons: buttons give actions, relays their state, offsets per sub-address', () => {
  assert.deepEqual(decode(VMBGP4, frame([0x00, 0x01, 0x00, 0x00])), [
    { kind: 'button', channel: 1, action: 'pressed' },
  ]);
  assert.deepEqual(decode(VMBGP4, frame([0x00, 0x00, 0x02, 0x02])), [
    { kind: 'button', channel: 2, action: 'long_pressed' },
    { kind: 'button', channel: 2, action: 'released' },
  ]);
  // VMBGPO: the third sub-address (offset 24) holds buttons 25 to 32.
  assert.deepEqual(decode(VMBGPO, frame([0x00, 0x01, 0, 0]), 24), [
    { kind: 'button', channel: 25, action: 'pressed' },
  ]);
  assert.deepEqual(decode(VMB4RYLD, frame([0x00, 0x02, 0x01, 0x00])), [
    { kind: 'relay', channel: 1, on: false },
    { kind: 'relay', channel: 2, on: true },
  ]);
});

test('dimmers, blinds, thermostats', () => {
  assert.deepEqual(decode(VMB4DC, frame([0xb8, 0x02, 0, 55, 0, 0, 0, 0])), [
    { kind: 'dimmer', channel: 2, level: 55 },
  ]);
  assert.deepEqual(decode(VMB1DM, frame([0xee, 0x02, 80, 0, 0, 0, 0, 0])), [
    { kind: 'dimmer', channel: 1, level: 80 },
  ]);
  assert.deepEqual(decode(VMB4DC, frame([0x0f, 0x01, 30, 0])), [
    { kind: 'dimmer', channel: 1, level: 30 },
  ]);
  assert.deepEqual(decode(VMB2BLE, frame([0xec, 0x02, 0x0f, 0x02, 0, 40, 0, 0])), [
    { kind: 'blind', channel: 2, motion: 'down', position: 40 },
  ]);
  assert.deepEqual(decode(VMB2BLE20, frame([0xec, 0x21, 10, 90, 0, 0, 0, 0])), [
    { kind: 'blind', channel: 1, motion: 'up', position: 10 },
    { kind: 'blind', channel: 2, motion: 'down', position: 90 },
  ]);
  // VMB2BL: channel 2 is 0x0C, its status in bits 2-3, no position.
  assert.deepEqual(decode(VMB2BL, frame([0xec, 0x0c, 0x0f, 0b0100, 0, 0, 0, 0])), [
    { kind: 'blind', channel: 2, motion: 'up' },
  ]);
  const [t] = decode(VMBGP4, frame([0xea, 0x40 | 0x02, 0, 0x01, 41, 44, 0x00, 0x05]));
  assert.deepEqual(t, {
    kind: 'thermostat',
    channel: 10,
    current: 20.5,
    target: 22,
    preset: 'comfort',
    program: 'manual',
    cooling: false,
    heater: true,
    cooler: false,
    sleepTimer: 5,
  });
  // Negative half degrees.
  assert.equal(decode(VMBGP4, frame([0xea, 0, 0, 0, 0xfc, 0, 0, 0]))[0].current, -2);
  // An unknown preset bit pattern: no preset, never a wrong one.
  assert.equal(decode(VMBGP4, frame([0xea, 0x30, 0, 0, 0, 0, 0, 0]))[0].preset, undefined);
  const [precise] = decode(VMBGP4, frame([0xe6, 0x29, 0x40, 0, 0, 0, 0]));
  assert.equal(precise.value, 20.625);
});

test('channel names: bitmask, index and VMB2BL forms, printable only', () => {
  assert.deepEqual(decode(VMB4RYLD, frame([0xf1, 0x02, 0x4c, 0x61, 0x6d, 0x70, 0x00, 0xff])), [
    { kind: 'name', channel: 2, part: 2, text: 'Lamp' },
  ]);
  assert.deepEqual(decode(VMBGP4, frame([0xf0, 10, 0x53, 0x0a, 0x61]))[0], {
    kind: 'name',
    channel: 10,
    part: 1,
    text: 'Sa',
  });
  assert.equal(decode(VMB2BL, frame([0xf0, 0x0c, 0x41, 0x42]))[0].channel, 2);
  // A channel the module does not have: nothing.
  assert.deepEqual(decode(VMBGP4, frame([0xf0, 30, 0x41])), []);
});

test('the frames of the requests and commands', () => {
  assert.deepEqual(typeRequest(0x1a), { priority: 0xfb, address: 0x1a, rtr: true, data: [] });
  assert.deepEqual(statusRequest(VMB4RYLD, 0x1a).data, [0xfa, 0b11111]);
  assert.deepEqual(statusRequest(VMBGP4, 0x40).data, [0xfa, 0xff]);
  assert.deepEqual(nameRequest(VMB4RYLD, 0x1a).data, [0xef, 0b11111]);
  assert.deepEqual(nameRequest(VMB2BL, 0x09).data, [0xef, 0x0f]);
  assert.deepEqual(relayCommand(VMB4RYLD, 0x1a, 3, true), {
    priority: 0xf8,
    address: 0x1a,
    data: [0x02, 0x04],
  });
  assert.deepEqual(relayCommand(VMB4RYLD20, 0x1b, 3, false).data, [0x01, 3]);
  assert.deepEqual(dimmerCommand(VMB4DC, 0x2a, 2, 50).data, [0x07, 0x02, 50, 0, 0]);
  assert.deepEqual(dimmerCommand(specOf(0x15), 0x2b, 1, 254).data, [0x07, 1, 254, 0, 0]);
  assert.deepEqual(restoreDimmerCommand(VMB4DC, 0x2a, 1).data, [0x11, 0x01, 0, 0, 0]);
  assert.deepEqual(blindCommand(VMB2BLE, 0x30, 2, 'up').data, [0x05, 0x02, 0, 0, 0]);
  assert.deepEqual(blindCommand(VMB2BLE, 0x30, 1, 'stop').data, [0x04, 0x01]);
  assert.deepEqual(blindCommand(VMB2BL, 0x09, 2, 'down').data, [0x06, 0x0c, 0, 0, 0]);
  assert.deepEqual(blindPositionCommand(VMB2BLE, 0x30, 1, 70).data, [0x1c, 0x01, 70]);
  assert.equal(blindPositionCommand(VMB2BL, 0x09, 1, 70), undefined);
  assert.deepEqual(setTemperatureCommand(VMBGP4, 0x40, 21.5).data, [0xe4, 0x00, 43]);
  assert.deepEqual(presetCommand(VMBGP4, 0x40, 'night', 0xffff).data, [0xdd, 0xff, 0xff]);
  assert.equal(presetCommand(VMBGP4, 0x40, 'unknown', 0), undefined);
  assert.equal(relayCommand(VMB4DC, 0x2a, 1, true), undefined);
  assert.throws(() => relayCommand(VMB4RYLD, 0x1a, 9, true), RangeError);
  assert.equal(sleepFor('run', 9), 0);
  assert.equal(sleepFor('manual', 9), 0xffff);
  assert.equal(sleepFor('sleep', 9), 9);
  assert.equal(bitChannel(0x80), 8);
  assert.equal(bitChannel(0x81), undefined);
});
