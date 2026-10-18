// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { CONNECTIONS, DEFAULT_PORT, LIMITS, RELAY_KINDS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  connection: 'tcp',
  port: DEFAULT_PORT,
  allow_thermostat: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(number)
    ? Math.round(Math.max(min, Math.min(max, number)))
    : fallback;
};

/** `192.168.1.9`, `signum.lan:27015`, `tls://192.168.1.9:27015` -> { host, port?, scheme? }. */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  const scheme = /^([a-z]+):\/\//i.exec(text)?.[1]?.toLowerCase();
  text = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  // `auth@host` (velbus-aio's form for the Signum key) is not taken: the key
  // has its own secret field.
  if (text.includes('@')) return { host: '' };
  const match = /^(\[[0-9a-f:.]+\]|[^:\s]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: port >= 1 && port <= 65535 ? port : undefined,
    scheme: CONNECTIONS.includes(scheme) ? scheme : undefined,
  };
}

/** A SHA-256 certificate fingerprint, any common writing -> 64 lower-case hex digits, '' if absent. */
export function normalizeFingerprint(raw) {
  const text = String(raw ?? '')
    .replace(/^sha-?256\s*[:=]?\s*/i, '')
    .replace(/[\s:-]/g, '')
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : '';
}

/**
 * Relays shown as lights or read only: `1A-1, 1A-3:light, 2B-2:readonly` -> Map("1a-1" -> kind).
 * Addresses in hexadecimal as VelbusLink shows them; an entry without kind is
 * a light (a relay not listed is a switch). Wrong entries are reported, not fatal.
 */
export function parseRelayKinds(raw) {
  const kinds = new Map();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const match = /^(?:0x)?([0-9a-f]{1,2})\s*[-/.]\s*(\d{1,2})(?:\s*[:=]\s*([a-z]+))?$/i.exec(text);
    const address = match ? Number.parseInt(match[1], 16) : NaN;
    const channel = match ? Number(match[2]) : NaN;
    const kind = (match?.[3] ?? 'light').toLowerCase();
    if (
      !match ||
      address < 1 ||
      address > LIMITS.maxAddress ||
      channel < 1 ||
      channel > 8 ||
      !RELAY_KINDS.includes(kind)
    ) {
      errors.push(text);
      continue;
    }
    kinds.set(channelKey(address, channel), kind);
  }
  return { kinds, errors };
}

/** The key of a channel in ids and maps: `1a-3` (address in hex, lower case). */
export const channelKey = (address, channel) =>
  `${address.toString(16).padStart(2, '0')}-${channel}`;

export function normalizeConfig(raw = {}) {
  const { host, port: hostPort, scheme } = parseHost(raw?.host);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const connection = String(raw?.connection ?? DEFAULTS.connection)
    .trim()
    .toLowerCase();
  const typedFingerprint = String(raw?.tls_fingerprint ?? '').trim();
  const relays = parseRelayKinds(raw?.relay_kinds);
  return {
    host,
    // A port typed with the address wins over the port field (which has a default).
    port: hostPort ?? integer(raw?.port, DEFAULTS.port, 1, 65535),
    // `tls://` typed with the address wins too.
    tls:
      (scheme ?? (CONNECTIONS.includes(connection) ? connection : DEFAULTS.connection)) === 'tls',
    // As typed: a space may be part of a Signum key.
    password: typeof raw?.password === 'string' ? raw.password : '',
    fingerprint: normalizeFingerprint(typedFingerprint),
    fingerprintInvalid: typedFingerprint !== '' && normalizeFingerprint(typedFingerprint) === '',
    relayKinds: relays.kinds,
    relayErrors: relays.errors,
    allowThermostat: bool(raw?.allow_thermostat, DEFAULTS.allow_thermostat),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** What the session depends on: a change reconnects (and lifts a stop on a refused password). */
export const sessionKey = (config) =>
  JSON.stringify([config.host, config.port, config.tls, config.password, config.fingerprint]);

/** Where the session goes, without the password: what a persisted stop is tied to. */
export const placeKey = (config) => `${config.tls ? 'tls' : 'tcp'}://${config.host}:${config.port}`;
