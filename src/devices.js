// -----------------------------------------------------------------------------
// The bus model -> Gladys devices and states (pure).
//
// One device per channel, keyed by the module address and the channel number
// as VelbusLink shows them (`ext:<selector>:<kind>:1a-3`): the platform has
// no other id that every module gives (old modules have no serial number),
// and a Velbus installation is wired by address. Kinds:
// - `relay`: one feature `switch` (switch/binary) or `light` (light/binary),
//   by configuration; the feature key is the kind, so changing it adds a
//   feature and keeps the old one with its history;
// - `dimmer`: `binary` (light/binary) and `brightness` (light/brightness);
// - `blind`: `state` (shutter/state: open, close, stop) and, on the modules
//   that report it, `position` (shutter/position, 100 = open): never a switch;
// - `temperature`: the temperature; `thermostat`: the temperature, the set
//   point, the preset (comfort, day, night, frost protection), heating or
//   cooling and whether it runs.
// Buttons are no device: they are scene triggers.
//
// A device published again never loses a feature the user created (Gladys
// would mark it changed, and "Update" would drop its history): the features
// of the created device that the bus no longer gives are kept.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { channelKey } from './config.js';
import {
  COVER_STATE,
  LIMITS,
  PRESET_TO_GLADYS,
  THERMOSTAT_MODE,
  THERMOSTAT_OPERATING_STATE,
} from './constants.js';
import {
  DEVICE_NAMES,
  FEATURE_NAMES,
  MODE_LABELS,
  OPERATING_LABELS,
  PRESET_LABELS,
  word,
} from './i18n.js';
import { CMD, PRESETS } from './velbus/messages.js';
import { addressText } from './velbus/modules.js';

const command = (category, type, extra = {}) => ({
  category,
  type,
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...extra,
});

const reading = (category, type, extra = {}) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

/** Feature definitions by key (the last part of their external id). Keys are forever. */
export const RELAY_FEATURES = {
  switch: command(C.SWITCH, T.SWITCH.BINARY, { min: 0, max: 1 }),
  light: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1 }),
  // A state only: no voice assistant, scene or "turn everything off" can drive it.
  readonly: reading(C.UNKNOWN, T.SENSOR.BINARY, { min: 0, max: 1 }),
};

export const DIMMER_FEATURES = {
  binary: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1 }),
  brightness: command(C.LIGHT, T.LIGHT.BRIGHTNESS, { min: 0, max: 100 }),
};

export const BLIND_FEATURES = {
  state: command(C.SHUTTER, T.SHUTTER.STATE, {
    min: COVER_STATE.CLOSE,
    max: COVER_STATE.OPEN,
    keep_history: false,
  }),
  position: command(C.SHUTTER, T.SHUTTER.POSITION, { min: 0, max: 100 }),
};

const options = (entries, language) =>
  entries.map(([value, label], i) => ({ value, label: word(label, language), sort_order: i }));

export function temperatureFeatures(thermostat, language) {
  const features = {
    temperature: reading(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
      unit: U.CELSIUS,
      min: -40,
      max: 80,
    }),
  };
  if (!thermostat) return features;
  return {
    ...features,
    target: command(C.THERMOSTAT, T.THERMOSTAT.TARGET_TEMPERATURE, {
      unit: U.CELSIUS,
      min: LIMITS.minSetpoint,
      max: LIMITS.maxSetpoint,
    }),
    preset: command(C.THERMOSTAT, T.THERMOSTAT.PRESET, {
      min: 0,
      max: 5,
      keep_history: false,
      supported_options: options(
        PRESETS.map((p) => [PRESET_TO_GLADYS.get(p), PRESET_LABELS[p]]),
        language,
      ),
    }),
    mode: reading(C.THERMOSTAT, T.THERMOSTAT.MODE, {
      min: 0,
      max: 3,
      keep_history: false,
      supported_options: options(
        [
          [THERMOSTAT_MODE.HEATING, MODE_LABELS.heating],
          [THERMOSTAT_MODE.COOLING, MODE_LABELS.cooling],
        ],
        language,
      ),
    }),
    operating: reading(C.THERMOSTAT, T.THERMOSTAT.OPERATING_STATE, {
      min: 0,
      max: 2,
      supported_options: options(
        [
          [THERMOSTAT_OPERATING_STATE.IDLE, OPERATING_LABELS.idle],
          [THERMOSTAT_OPERATING_STATE.HEATING, OPERATING_LABELS.heating],
          [THERMOSTAT_OPERATING_STATE.COOLING, OPERATING_LABELS.cooling],
        ],
        language,
      ),
    }),
  };
}

/** The Gladys device kind of a channel of a module, undefined if not shown. */
export function deviceKind(spec, channel) {
  if (channel.kind === 'temperature') return spec.thermostat ? 'thermostat' : 'temperature';
  if (['relay', 'dimmer', 'blind'].includes(channel.kind)) return channel.kind;
  return undefined;
}

export const hasPosition = (spec) => spec.variant(CMD.BLIND_POSITION) === 'CoverPosMessage';

export const ids = (gladys, kind, address, channel) =>
  gladys.externalIds(kind, channelKey(address, channel));

/** `ext:sel:dimmer:1a-3:brightness` -> { kind, address, channel, key }. */
export function parseFeatureId(externalId) {
  const match =
    /:(relay|dimmer|blind|temperature|thermostat):([0-9a-f]{2})-(\d{1,2}):([a-z]+)$/.exec(
      String(externalId ?? ''),
    );
  if (!match) return undefined;
  return {
    kind: match[1],
    address: Number.parseInt(match[2], 16),
    channel: Number(match[3]),
    key: match[4],
  };
}

/**
 * The kind of a relay: the configured one, else a switch. A relay channel over
 * 8 (the "Output" relays of the VMBEL and VMBGP-20 panels) is read only: the
 * commands carry the channel as a bitmask of 8.
 */
export const relayKind = (config, address, channel) =>
  channel > 8 ? 'readonly' : (config.relayKinds.get(channelKey(address, channel)) ?? 'switch');

/** What a discovered feature declares (a created one also has ids, values, dates). */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
  'supported_options',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => f?.external_id && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

const sortedModules = (model) => [...model.modules.values()].sort((a, b) => a.address - b.address);

/** Every channel shown, in order: [module, channel description, Gladys kind]. */
export function* shownChannels(model) {
  for (const module of sortedModules(model)) {
    for (const channel of module.spec.channels.values()) {
      const kind = deviceKind(module.spec, channel);
      if (kind) yield [module, channel, kind];
    }
  }
}

function featureSet(config, module, channel, kind) {
  const { language } = config;
  if (kind === 'relay') {
    const key = relayKind(config, module.address, channel.num);
    return { [key]: RELAY_FEATURES[key] };
  }
  if (kind === 'dimmer') return DIMMER_FEATURES;
  if (kind === 'blind') {
    return hasPosition(module.spec) ? BLIND_FEATURES : { state: BLIND_FEATURES.state };
  }
  return temperatureFeatures(kind === 'thermostat', language);
}

export function buildDevices(gladys, config, model, created = gladys.devices) {
  const { language } = config;
  const devices = [];
  for (const [module, channel, kind] of shownChannels(model)) {
    const deviceIds = ids(gladys, kind, module.address, channel.num);
    const address = addressText(module.address);
    const busName = module.names.get(channel.num);
    const name =
      busName || word(DEVICE_NAMES[kind], language)(module.spec.name, address, channel.num);
    const features = Object.entries(featureSet(config, module, channel, kind)).map(
      ([key, definition]) => ({
        name: word(FEATURE_NAMES[key], language),
        external_id: deviceIds.feature(key),
        ...definition,
      }),
    );
    devices.push({
      name,
      external_id: deviceIds.device,
      model: module.spec.name,
      should_poll: false,
      params: [
        { name: 'address', value: address },
        { name: 'channel', value: String(channel.num) },
        ...(module.serial ? [{ name: 'serial', value: String(module.serial) }] : []),
        ...(module.build ? [{ name: 'build', value: module.build }] : []),
      ],
      features,
    });
  }
  return keepCreatedFeatures(devices, created);
}

const flag = (value) => (value ? 1 : 0);
const round2 = (value) => Math.round(value * 100) / 100;

/** Gladys position (100 = open) from the Velbus one (0 = up). */
export const gladysPosition = (velbus) => 100 - velbus;

export function blindState(state) {
  if (state.motion === 'up') return COVER_STATE.OPEN;
  if (state.motion === 'down') return COVER_STATE.CLOSE;
  if (state.position === 0) return COVER_STATE.OPEN;
  if (state.position === 100) return COVER_STATE.CLOSE;
  return state.motion === 'stopped' ? COVER_STATE.STOP : undefined;
}

/** Every known state: `[{ device_feature_external_id, state }]`. */
export function buildStates(gladys, config, model, created = gladys.devices) {
  const states = [];
  const createdKeys = new Map(
    (created ?? []).map((device) => [
      device.external_id,
      (device.features ?? []).map((f) =>
        String(f?.external_id ?? '')
          .split(':')
          .at(-1),
      ),
    ]),
  );
  for (const [module, channel, kind] of shownChannels(model)) {
    const state = module.channels.get(channel.num);
    if (!state) continue;
    const deviceIds = ids(gladys, kind, module.address, channel.num);
    const push = (key, value) => {
      if (value === undefined || value === null || Number.isNaN(value)) return;
      states.push({ device_feature_external_id: deviceIds.feature(key), state: value });
    };
    if (kind === 'relay') {
      if (state.on !== undefined) {
        // The kind of now, and the older relay features the user kept.
        const keys = new Set([relayKind(config, module.address, channel.num)]);
        for (const key of createdKeys.get(deviceIds.device) ?? []) {
          if (Object.hasOwn(RELAY_FEATURES, key)) keys.add(key);
        }
        for (const key of keys) push(key, flag(state.on));
      }
    } else if (kind === 'dimmer') {
      if (state.level !== undefined) {
        const scale = module.spec.sliderScale || 100;
        push('binary', flag(state.level > 0));
        push('brightness', Math.max(0, Math.min(100, Math.round((state.level * 100) / scale))));
      }
    } else if (kind === 'blind') {
      push('state', blindState(state));
      if (hasPosition(module.spec) && state.position !== undefined) {
        push('position', gladysPosition(state.position));
      }
    } else {
      if (state.current !== undefined) push('temperature', round2(state.current));
      if (kind === 'thermostat') {
        if (state.target !== undefined) push('target', state.target);
        if (state.preset !== undefined) push('preset', PRESET_TO_GLADYS.get(state.preset));
        if (state.cooling !== undefined) {
          push('mode', state.cooling ? THERMOSTAT_MODE.COOLING : THERMOSTAT_MODE.HEATING);
        }
        if (state.heater !== undefined) {
          push(
            'operating',
            state.heater
              ? THERMOSTAT_OPERATING_STATE.HEATING
              : state.cooler
                ? THERMOSTAT_OPERATING_STATE.COOLING
                : THERMOSTAT_OPERATING_STATE.IDLE,
          );
        }
      }
    }
  }
  return states;
}
