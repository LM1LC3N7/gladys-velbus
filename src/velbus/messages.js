// -----------------------------------------------------------------------------
// Velbus messages: what a frame means for a module, and the frames of the
// requests and commands. Ported from velbus-aio (velbusaio/messages/*.py,
// message_fields.py, module.py, channels.py; Apache-2.0 / MIT, see
// THIRD_PARTY_NOTICES.md), the variants chosen per module type as velbus-aio
// does (`CommandToClass` of its module descriptions).
//
// decode() is pure: (module description, frame, channel offset of the
// address it came from) -> a list of updates. A frame too short, with a
// channel byte that does not name exactly one channel, or for a channel the
// module does not have, gives nothing (velbus-aio drops it the same way).
// -----------------------------------------------------------------------------

import { PRIORITY } from './frame.js';

export const CMD = {
  PUSH_BUTTON: 0x00,
  RELAY_OFF: 0x01,
  RELAY_ON: 0x02,
  BLIND_STOP: 0x04,
  BLIND_UP: 0x05,
  BLIND_DOWN: 0x06,
  SET_DIMMER: 0x07,
  SLIDER_STATUS: 0x0f,
  RESTORE_DIMMER: 0x11,
  BLIND_POSITION: 0x1c,
  DIM_VALUES: 0xa5,
  SUB_TYPE: 0xb0,
  SUB_TYPE_2: 0xa7,
  SUB_TYPE_3: 0xa6,
  DIMMER_CHANNEL_STATUS: 0xb8,
  COMFORT: 0xdb,
  DAY: 0xdc,
  NIGHT: 0xdd,
  SAFE: 0xde,
  SET_TEMPERATURE: 0xe4,
  SENSOR_TEMPERATURE: 0xe6,
  THERMOSTAT_STATUS: 0xea,
  BLIND_STATUS: 0xec,
  DIMMER_STATUS: 0xee,
  NAME_REQUEST: 0xef,
  NAME_1: 0xf0,
  NAME_2: 0xf1,
  NAME_3: 0xf2,
  STATUS_REQUEST: 0xfa,
  RELAY_STATUS: 0xfb,
  MODULE_TYPE: 0xff,
};

/** Velbus thermostat presets (TempSensorStatusMessage `mode`), frozen: scenes compare them. */
export const PRESETS = ['comfort', 'day', 'night', 'safe'];
const PRESET_BITS = new Map([
  [0x00, 'safe'],
  [0x10, 'night'],
  [0x20, 'day'],
  [0x40, 'comfort'],
]);
const PRESET_COMMANDS = new Map([
  ['comfort', CMD.COMFORT],
  ['day', CMD.DAY],
  ['night', CMD.NIGHT],
  ['safe', CMD.SAFE],
]);
const PROGRAMS = new Map([
  [0x00, 'run'],
  [0x02, 'manual'],
  [0x04, 'sleep'],
  [0x06, 'disable'],
]);
const MOTIONS = new Map([
  [0, 'stopped'],
  [1, 'up'],
  [2, 'down'],
]);

/** Module types that send no serial number in their type answer (velbus-aio). */
const WITHOUT_SERIAL = new Set([0x01, 0x02, 0x03, 0x05, 0x07, 0x08, 0x09, 0x0c, 0x0e, 0x0f, 0x14]);

/** The one channel a bitmask byte names (1-8), undefined when it names 0 or several. */
export function bitChannel(byte) {
  if (byte === 0 || (byte & (byte - 1)) !== 0) return undefined;
  return 31 - Math.clz32(byte) + 1;
}

/** The channels a bitmask byte names. */
export const bitChannels = (byte) => [1, 2, 3, 4, 5, 6, 7, 8].filter((c) => byte & (1 << (c - 1)));

/** One byte, two's complement, in half degrees -> degrees. */
const halfDegrees = (byte) => (byte & 0x80 ? byte - 256 : byte) / 2;

/** velbus-aio's TemperatureField: 16 bits, 1/512 degree (its odd negative form kept). */
function preciseTemperature(high, low) {
  const raw = (high << 8) | low;
  return raw >> 15 ? -127 + (raw / 32) * 0.0625 : (raw / 32) * 0.0625;
}

/** The answer to a module type request (rtr): { type, serial, memoryMap, build }. */
export function decodeModuleType(data, variant = 'ModuleTypeMessage') {
  if (data.length < 2 || data[0] !== CMD.MODULE_TYPE) return undefined;
  const d = data.subarray(1);
  const type = d[0];
  const serial = !WITHOUT_SERIAL.has(type) && d.length >= 3 ? (d[1] << 8) | d[2] : 0;
  const memoryMap = !WITHOUT_SERIAL.has(type) && d.length >= 4 ? d[3] : 0;
  const v2 = variant === 'ModuleType2Message';
  const at = (i) => (d.length + i >= 1 ? d[d.length + i] : undefined);
  const year = v2 ? at(-3) : at(-2);
  const week = v2 ? at(-2) : at(-1);
  return { type, serial, memoryMap, build: d.length >= 3 ? `${year}.${week}` : '' };
}

/** A sub-address answer (B0, A7, A6): Map(sub number -> address), 0xFF left out. */
export function decodeSubAddresses(data) {
  const offsets = new Map([
    [CMD.SUB_TYPE, 0],
    [CMD.SUB_TYPE_2, 4],
    [CMD.SUB_TYPE_3, 8],
  ]);
  if (data.length < 1 || !offsets.has(data[0])) return undefined;
  const d = data.subarray(1);
  const subs = new Map();
  for (let i = 0; i < 4; i += 1) {
    const address = d[3 + i];
    if (address !== undefined && address !== 0xff) subs.set(offsets.get(data[0]) + i + 1, address);
  }
  return subs;
}

function nameChannel(variant, byte) {
  if (variant === 'ChannelNamePart1Message2') return byte;
  if (variant === 'ChannelNamePart1Message3') return (byte & 0x06) >> 1;
  return bitChannel(byte);
}

/** Printable ASCII only, as velbus-aio keeps (0x00 and 0xFF are empty bytes). */
const nameText = (bytes) =>
  String.fromCharCode(...[...bytes].filter((b) => b >= 0x20 && b <= 0x7e));

/**
 * What a frame from a module says: [{ kind, channel, ... }]. `offset` is 8
 * per sub-address (velbus-aio's calc_channel_offset).
 */
export function decode(spec, frame, offset = 0) {
  const { data, rtr } = frame;
  if (!spec || rtr || data.length === 0) return [];
  const command = data[0];
  const d = data.subarray(1);
  const channelOf = (n) => (n === undefined ? undefined : spec.translate(n));
  const has = (channel, kind) => spec.channels.get(channel)?.kind === kind;
  const out = [];
  const variant = spec.variant(command);

  switch (command) {
    case CMD.PUSH_BUTTON: {
      if (d.length < 3) return [];
      for (let id = 1; id <= 8; id += 1) {
        const bit = 1 << (id - 1);
        const channel = channelOf(id + offset);
        const kind = spec.channels.get(channel)?.kind;
        if (kind === 'button') {
          if (d[0] & bit) out.push({ kind: 'button', channel, action: 'pressed' });
          if (d[2] & bit) out.push({ kind: 'button', channel, action: 'long_pressed' });
          if (d[1] & bit) out.push({ kind: 'button', channel, action: 'released' });
        } else if (kind === 'relay') {
          // A relay module tells its relay changes this way too (velbus-aio).
          if (d[0] & bit) out.push({ kind: 'relay', channel, on: true });
          if (d[1] & bit) out.push({ kind: 'relay', channel, on: false });
        }
      }
      return out;
    }
    case CMD.RELAY_STATUS: {
      if (d.length < 7) return [];
      if (variant === 'RelayStatusMessage3') {
        for (let c = 1; c <= 8; c += 1) {
          if (has(c, 'relay'))
            out.push({ kind: 'relay', channel: c, on: Boolean(d[0] & (1 << (c - 1))) });
        }
        return out;
      }
      if (variant !== 'RelayStatusMessage' && variant !== 'RelayStatusMessage2') return [];
      const channel = channelOf(bitChannel(d[0]));
      if (!has(channel, 'relay')) return [];
      const on =
        variant === 'RelayStatusMessage2' ? ((d[2] >> (channel - 1)) & 1) !== 0 : d[2] === 0x01;
      return [{ kind: 'relay', channel, on }];
    }
    case CMD.DIMMER_CHANNEL_STATUS: {
      if (variant !== 'DimmerChannelStatusMessage' || d.length < 7) return [];
      const channel = channelOf(bitChannel(d[0]));
      return has(channel, 'dimmer') ? [{ kind: 'dimmer', channel, level: d[2] }] : [];
    }
    case CMD.DIMMER_STATUS: {
      if (variant !== 'DimmerStatusMessage' || d.length < 7) return [];
      const channel = channelOf(1);
      return has(channel, 'dimmer') ? [{ kind: 'dimmer', channel, level: d[1] }] : [];
    }
    case CMD.SLIDER_STATUS: {
      if (variant !== 'SliderStatusMessage' || d.length < 3) return [];
      const channel = channelOf(bitChannel(d[0]));
      return has(channel, 'dimmer') ? [{ kind: 'dimmer', channel, level: d[1] }] : [];
    }
    case CMD.DIM_VALUES: {
      if (variant !== 'DimValueStatus' || d.length < 2) return [];
      for (let i = 1; i < d.length; i += 1) {
        const channel = d[0] + i - 1;
        if (has(channel, 'dimmer')) out.push({ kind: 'dimmer', channel, level: d[i] });
      }
      return out;
    }
    case CMD.BLIND_STATUS: {
      if (d.length < 7) return [];
      if (variant === 'BlindStatusNg20Message') {
        const statuses = [d[0] & 0x03, (d[0] >> 4) & 0x03];
        for (const [i, channel] of [1, 2].entries()) {
          if (!has(channel, 'blind') || !MOTIONS.has(statuses[i])) continue;
          out.push({
            kind: 'blind',
            channel,
            motion: MOTIONS.get(statuses[i]),
            position: d[1 + i] <= 100 ? d[1 + i] : undefined,
          });
        }
        return out;
      }
      if (variant === 'BlindStatusNgMessage') {
        const channel = channelOf(bitChannel(d[0]));
        if (!has(channel, 'blind') || !MOTIONS.has(d[2])) return [];
        return [
          {
            kind: 'blind',
            channel,
            motion: MOTIONS.get(d[2]),
            position: d[4] <= 100 ? d[4] : undefined,
          },
        ];
      }
      if (variant === 'BlindStatusMessage') {
        const channel = channelOf(((d[0] >> 1) & 0x03) === 1 ? 1 : 2);
        const status = (d[2] >> ((channel - 1) * 2)) & 0x03;
        if (!has(channel, 'blind') || !MOTIONS.has(status)) return [];
        return [{ kind: 'blind', channel, motion: MOTIONS.get(status) }];
      }
      return [];
    }
    case CMD.THERMOSTAT_STATUS: {
      if (variant !== 'TempSensorStatusMessage' || d.length < 7) return [];
      const channel = channelOf(spec.temperatureChannel ?? undefined);
      if (!has(channel, 'temperature')) return [];
      return [
        {
          kind: 'thermostat',
          channel,
          current: halfDegrees(d[3]),
          target: halfDegrees(d[4]),
          preset: PRESET_BITS.get(d[0] & 0x70),
          program: PROGRAMS.get(d[0] & 0x06),
          cooling: (d[0] & 0x80) !== 0,
          heater: (d[2] & 0x01) !== 0,
          cooler: (d[2] & 0x08) !== 0,
          sleepTimer: (d[5] << 8) | d[6],
        },
      ];
    }
    case CMD.SENSOR_TEMPERATURE: {
      if (variant !== 'SensorTemperatureMessage' || d.length < 6) return [];
      const channel = channelOf(spec.temperatureChannel ?? undefined);
      if (!has(channel, 'temperature')) return [];
      return [{ kind: 'temperature', channel, value: preciseTemperature(d[0], d[1]) }];
    }
    case CMD.NAME_1:
    case CMD.NAME_2:
    case CMD.NAME_3: {
      const nameVariant = spec.variant(CMD.NAME_1);
      if (!nameVariant || d.length < 2) return [];
      const channel = channelOf(nameChannel(nameVariant, d[0]));
      if (!spec.channels.has(channel)) return [];
      return [
        { kind: 'name', channel, part: command - CMD.NAME_1 + 1, text: nameText(d.subarray(1)) },
      ];
    }
    default:
      return [];
  }
}

// --- Frames to the bus ---------------------------------------------------------

const bit = (channel) => {
  if (!Number.isInteger(channel) || channel < 1 || channel > 8) {
    throw new RangeError(`Velbus channel out of range: ${channel}`);
  }
  return 1 << (channel - 1);
};

/** The module type request of the bus scan (velbus-aio ModuleTypeRequestMessage). */
export const typeRequest = (address) => ({ priority: PRIORITY.LOW, address, rtr: true, data: [] });

/** The status of the module's channels (ModuleStatusRequestMessage, as velbus-aio chooses them). */
export function statusRequest(spec, address) {
  let channels = 0xff;
  if (!spec.allChannelStatus) {
    channels = 0;
    for (const channel of spec.channels.values()) {
      if (channel.num <= 8 && ['blind', 'dimmer', 'relay'].includes(channel.kind)) {
        channels |= bit(channel.num);
      }
    }
  }
  return { priority: PRIORITY.LOW, address, data: [CMD.STATUS_REQUEST, channels] };
}

/** The thermostat status (the module answers a status request of every channel with it). */
export const thermostatRequest = (address) => ({
  priority: PRIORITY.LOW,
  address,
  data: [CMD.STATUS_REQUEST, 0xff],
});

/** The channel names (ChannelNameRequestMessage and its VMB2BL form). */
export function nameRequest(spec, address) {
  const variant = spec.variant(CMD.NAME_REQUEST);
  if (variant === 'ChannelNameRequestMessage2') {
    let byte = 0;
    if (spec.channels.has(1)) byte |= 0x03;
    if (spec.channels.has(2)) byte |= 0x0c;
    return { priority: PRIORITY.LOW, address, data: [CMD.NAME_REQUEST, byte] };
  }
  if (variant !== 'ChannelNameRequestMessage') return undefined;
  let byte = 0xff;
  if (!spec.allChannelStatus) {
    byte = 0;
    for (const num of spec.channels.keys()) if (num <= 8) byte |= bit(num);
  }
  return { priority: PRIORITY.LOW, address, data: [CMD.NAME_REQUEST, byte] };
}

/** Relay on or off (the -20 modules take the channel number, the others a bitmask). */
export function relayCommand(spec, address, channel, on) {
  const command = on ? CMD.RELAY_ON : CMD.RELAY_OFF;
  const variant = spec.variant(command);
  if (!variant) return undefined;
  const byte = variant.endsWith('20') ? channel : bit(channel);
  return { priority: PRIORITY.HIGH, address, data: [command, byte] };
}

/** Dimmer to a raw level (0 to the module's scale), over `transition` seconds. */
export function dimmerCommand(spec, address, channel, level, transition = 0) {
  const variant = spec.variant(CMD.SET_DIMMER);
  if (!variant) return undefined;
  const byte = variant === 'SetDimmerMessage2' ? channel : bit(channel);
  return {
    priority: PRIORITY.HIGH,
    address,
    data: [CMD.SET_DIMMER, byte, level & 0xff, (transition >> 8) & 0xff, transition & 0xff],
  };
}

/** Dimmer back to its last level, undefined when the module has no such command. */
export function restoreDimmerCommand(spec, address, channel) {
  const variant = spec.variant(CMD.RESTORE_DIMMER);
  if (!variant) return undefined;
  const byte = variant === 'RestoreDimmerMessage2' ? channel : bit(channel);
  return { priority: PRIORITY.HIGH, address, data: [CMD.RESTORE_DIMMER, byte, 0, 0, 0] };
}

/** Blind up, down or stop (VMB1BL / VMB2BL encode the channel 0x03 / 0x0C). */
export function blindCommand(spec, address, channel, motion) {
  const command = { up: CMD.BLIND_UP, down: CMD.BLIND_DOWN, stop: CMD.BLIND_STOP }[motion];
  const variant = command === undefined ? undefined : spec.variant(command);
  if (!variant) return undefined;
  const byte = variant.endsWith('Message2') ? (channel === 1 ? 0x03 : 0x0c) : bit(channel);
  // Up and down carry a 24-bit delay: 0 = the time set in the module.
  const data = command === CMD.BLIND_STOP ? [command, byte] : [command, byte, 0, 0, 0];
  return { priority: PRIORITY.HIGH, address, data };
}

/** Blind to a position, Velbus scale (0 = up, 100 = down). */
export function blindPositionCommand(spec, address, channel, position) {
  if (spec.variant(CMD.BLIND_POSITION) !== 'CoverPosMessage') return undefined;
  return {
    priority: PRIORITY.HIGH,
    address,
    data: [CMD.BLIND_POSITION, bit(channel), position & 0xff],
  };
}

/** The set point of the current preset, in half degrees (SetTemperatureMessage). */
export function setTemperatureCommand(spec, address, degrees) {
  if (spec.variant(CMD.SET_TEMPERATURE) !== 'SetTemperatureMessage') return undefined;
  return {
    priority: PRIORITY.LOW,
    address,
    data: [CMD.SET_TEMPERATURE, 0x00, Math.round(degrees * 2) & 0xff],
  };
}

/**
 * A preset; `sleep` keeps the program state as velbus-aio does: 0 when the
 * thermostat follows its program, 0xFFFF in manual, the timer in sleep.
 */
export function presetCommand(spec, address, preset, sleep) {
  const command = PRESET_COMMANDS.get(preset);
  if (command === undefined || !spec.variant(command)) return undefined;
  return {
    priority: PRIORITY.LOW,
    address,
    data: [command, (sleep >> 8) & 0xff, sleep & 0xff],
  };
}

/** The `sleep` of a preset command for a program state (velbus-aio _switch_mode). */
export function sleepFor(program, sleepTimer) {
  if (program === 'manual') return 0xffff;
  if (program === 'sleep') return sleepTimer ?? 0;
  return 0;
}
