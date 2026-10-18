// -----------------------------------------------------------------------------
// The Velbus module types (src/velbus/module-table.js, generated from
// velbus-aio's module descriptions), as read-only lookups. Maps only: a type,
// a channel or a command read from the bus never reaches an object key.
// -----------------------------------------------------------------------------

import { MODULE_SPECS } from './module-table.js';

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

function build(entry) {
  const channels = new Map();
  for (const [num, kind, name, editable] of entry.channels) {
    channels.set(num, Object.freeze({ num, kind, name, editable }));
  }
  const spec = {
    type: entry.type,
    name: entry.name,
    supported: entry.supported,
    channels,
    classes: new Map(Object.entries(entry.classes)),
    allChannelStatus: entry.allChannelStatus,
    temperatureChannel: entry.temperatureChannel,
    thermostat: entry.thermostat && entry.temperatureChannel !== null,
    nameMap: new Map(entry.nameMap),
    sliderScale: entry.sliderScale,
  };
  /** The message variant of a command (`'FB'` -> `'RelayStatusMessage2'`), undefined if none. */
  spec.variant = (command) => spec.classes.get(hex2(command));
  /** A channel number told by a message -> the channel of the description (velbus-aio's name map). */
  spec.translate = (channel) => spec.nameMap.get(channel) ?? channel;
  return Object.freeze(spec);
}

const SPECS = new Map(MODULE_SPECS.map((entry) => [entry.type, build(entry)]));

/** The description of a module type, undefined when velbus-aio does not know it. */
export const specOf = (type) => SPECS.get(type);

/** The name of a module type (`VMB4RYLD`), `type 0x..` when unknown. */
export const typeName = (type) => SPECS.get(type)?.name ?? `type 0x${hex2(type)}`;

/** Every known type, for the tests. */
export const allSpecs = () => [...SPECS.values()];

/** `0x1a` -> `1A`: how VelbusLink shows an address. */
export const addressText = hex2;
