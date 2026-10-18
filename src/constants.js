// -----------------------------------------------------------------------------
// Fixed values: manifest keys, Gladys value enums, protocol limits and timings.
// The SDK exports the Gladys categories and types, not the state values: the
// ones used here mirror server/utils/constants.js of the core.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them in scenes and dashboards. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_TRIGGERS = {
  BUTTON: 'button',
};

/** What a push button did (frozen: scenes compare them). */
export const BUTTON_ACTIONS = ['pressed', 'long_pressed', 'released'];

/** How the integration reaches the bus (frozen: stored in the configuration). */
export const CONNECTIONS = ['tcp', 'tls'];

/** How a relay shows in Gladys (frozen: stored in the configuration, and the feature key). */
export const RELAY_KINDS = ['switch', 'light', 'readonly'];

/** Gladys core values (server/utils/constants.js). */
export const STATE = { OFF: 0, ON: 1 };
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };
export const THERMOSTAT_OPERATING_STATE = { IDLE: 0, HEATING: 1, COOLING: 2 };
export const THERMOSTAT_PRESET = { SCHEDULE: 0, FROST: 1, AWAY: 2, ECO: 3, NIGHT: 4, COMFORT: 5 };

/**
 * Velbus preset -> Gladys preset. `safe` is the frost protection of Velbus;
 * Velbus `day` (between night and comfort) has no twin in Gladys: ECO, the
 * reduced temperature, is the closest (the label says "Day").
 */
export const PRESET_TO_GLADYS = new Map([
  ['comfort', THERMOSTAT_PRESET.COMFORT],
  ['day', THERMOSTAT_PRESET.ECO],
  ['night', THERMOSTAT_PRESET.NIGHT],
  ['safe', THERMOSTAT_PRESET.FROST],
]);
export const PRESET_FROM_GLADYS = new Map([...PRESET_TO_GLADYS].map(([v, g]) => [g, v]));

/** Velbus TCP gateways and Signum listen on 27015 unless changed. */
export const DEFAULT_PORT = 27015;

export const LIMITS = {
  /** Highest address on a Velbus bus (0 and 255 are not modules). */
  maxAddress: 254,
  /** Set points accepted from Gladys, in degrees (Velbus encodes -64 to 63.5). */
  minSetpoint: 5,
  maxSetpoint: 30,
  /** Background frames waiting (a scan is 254 of them): more are refused, nothing sent. */
  maxQueue: 600,
  /** Commands waiting, a cap of their own: a full background queue never refuses one. */
  maxUrgent: 20,
  /** Bytes waiting in the socket write buffer before the session is cut. */
  maxPendingWrite: 64 * 1024,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Part of it only the commanded features (not the temperatures) may use. */
  priorityStates: 60,
  /** Scene events per minute (the core admits 300): button presses over it are dropped. */
  eventsPerMinute: 120,
  /** Sessions closed by the gateway right after the password, in a row: a refusal. */
  authDrops: 2,
};

export const TIMINGS = {
  /** TCP (and TLS) connection to the gateway. */
  connectTimeout: 10_000,
  /** Waits before reconnecting, in a row (the last one repeats), never under 10 s. */
  backoff: [10_000, 30_000, 60_000, 120_000, 300_000],
  /** Between two frames written (velbus-aio: 60 ms). */
  frameGap: 60,
  /** After a channel name request: up to 99 answers come (velbus-aio: 33 x 60 ms). */
  nameGap: 2_000,
  /** The scan waits this long for the last type answers (velbus-aio: 3 s). */
  scanWait: 3_000,
  /** Nothing received for this long while connected: a probe is sent. */
  idleProbe: 120_000,
  /** The probe (a type request to a known module) must get any frame within this. */
  probeTimeout: 10_000,
  /** How often the watchdog looks. */
  tick: 15_000,
  /** A session closed this soon after the password counts as a refusal. */
  authWindow: 10_000,
  /** With a password, a valid Velbus frame must come this soon, else the session ends. */
  firstFrame: 30_000,
  /** At most one warning this often about the invalid frames dropped. */
  dropLog: 60_000,
  /** Discovery republished for new channel names: after this quiet time? */
  namesQuiet: 2_000,
  /** ?and never later than this after the first name. */
  namesMax: 10_000,
  /** The scan progress in the status, this often. */
  scanStatus: 2_000,
  /**
   * Gladys waits 5 s for a set_value ack. A command is written by sendBy
   * after it was asked (else refused, nothing sent); its confirmation by the
   * module is awaited until answerBy (then "sent, without confirmation").
   */
  sendBy: 3_500,
  answerBy: 4_500,
  /** The fresh read of a thermostat before a command, at most. */
  readBefore: 1_500,
  /** The channel is read again this long after an unconfirmed command. */
  readBack: 2_000,
  /** How often the unchanged states get their heartbeat checked. */
  sweep: 60_000,
  /** An unchanged state is sent again this often… */
  stateHeartbeat: 30 * 60_000,
  /** …plus a per-feature offset within this spread. */
  heartbeatSpread: 5 * 60_000,
  /** "Test the connection" waits this long for the session (the manifest allows 30 s). */
  testWait: 25_000,
};
