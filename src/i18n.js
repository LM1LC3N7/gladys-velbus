// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

/** An entry whose values are functions -> the entry of their results. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    Object.entries(entry).map(([lang, value]) => [
      lang,
      typeof value === 'function' ? value(...args) : value,
    ]),
  );

/** Default channel names, when the module gives none. */
export const DEVICE_NAMES = {
  relay: { fr: (m, a, c) => `${m} ${a} relais ${c}`, en: (m, a, c) => `${m} ${a} relay ${c}` },
  dimmer: {
    fr: (m, a, c) => `${m} ${a} variateur ${c}`,
    en: (m, a, c) => `${m} ${a} dimmer ${c}`,
  },
  blind: { fr: (m, a, c) => `${m} ${a} volet ${c}`, en: (m, a, c) => `${m} ${a} blind ${c}` },
  temperature: {
    fr: (m, a) => `${m} ${a} température`,
    en: (m, a) => `${m} ${a} temperature`,
  },
  thermostat: {
    fr: (m, a) => `${m} ${a} thermostat`,
    en: (m, a) => `${m} ${a} thermostat`,
  },
};

export const FEATURE_NAMES = {
  switch: { fr: 'Relais', en: 'Relay' },
  light: { fr: 'Lumière', en: 'Light' },
  readonly: { fr: 'État du relais', en: 'Relay state' },
  binary: { fr: 'Allumée', en: 'On' },
  brightness: { fr: 'Luminosité', en: 'Brightness' },
  state: { fr: 'Ouvrir / fermer', en: 'Open / close' },
  position: { fr: 'Position', en: 'Position' },
  temperature: { fr: 'Température', en: 'Temperature' },
  target: { fr: 'Consigne', en: 'Set point' },
  preset: { fr: 'Mode', en: 'Mode' },
  mode: { fr: 'Chauffage ou refroidissement', en: 'Heating or cooling' },
  operating: { fr: 'En marche', en: 'Running' },
};

/** Labels of the preset options (Velbus names, the Gladys value they map to). */
export const PRESET_LABELS = {
  comfort: { fr: 'Confort', en: 'Comfort' },
  day: { fr: 'Jour', en: 'Day' },
  night: { fr: 'Nuit', en: 'Night' },
  safe: { fr: 'Hors gel', en: 'Frost protection' },
};

export const MODE_LABELS = {
  heating: { fr: 'Chauffage', en: 'Heating' },
  cooling: { fr: 'Refroidissement', en: 'Cooling' },
};

export const OPERATING_LABELS = {
  idle: { fr: 'À l’arrêt', en: 'Idle' },
  heating: { fr: 'Chauffe', en: 'Heating' },
  cooling: { fr: 'Refroidit', en: 'Cooling' },
};

const nothing = { fr: " : rien n'a été envoyé.", en: ': nothing was sent.' };

/** Connection status and command messages. */
export const T = {
  noHost: {
    en: 'Enter the address of the Velbus gateway (TCP gateway or Signum) in the configuration.',
    fr: "Saisissez l'adresse de la passerelle Velbus (passerelle TCP ou Signum) dans la configuration.",
  },
  badFingerprint: {
    en: 'The certificate fingerprint must be 64 hexadecimal digits (SHA-256), or empty.',
    fr: "L'empreinte du certificat doit compter 64 chiffres hexadécimaux (SHA-256), ou rester vide.",
  },
  connecting: { en: 'Connecting to the Velbus gateway…', fr: 'Connexion à la passerelle Velbus…' },
  scanning: {
    en: (sent, of) => `Connected to the gateway; scanning the Velbus bus (${sent}/${of})…`,
    fr: (sent, of) =>
      `Connecté à la passerelle ; recherche des modules sur le bus Velbus (${sent}/${of})…`,
  },
  connected: {
    en: (modules, channels, extra) =>
      `Connected to the Velbus bus: ${modules} module(s), ${channels} channel(s).${extra}`,
    fr: (modules, channels, extra) =>
      `Connecté au bus Velbus : ${modules} module(s), ${channels} canal(aux).${extra}`,
  },
  unsupported: {
    en: (list) => ` Not supported: ${list}.`,
    fr: (list) => ` Non pris en charge : ${list}.`,
  },
  passwordIgnored: {
    en: ' The password is ignored: it is only sent over TLS (Signum).',
    fr: ' Le mot de passe est ignoré : il n’est envoyé qu’en TLS (Signum).',
  },
  scanFailed: {
    en: (reason) =>
      `Connected, but the scan of the bus failed (${reason}); it is tried again at the next connection or with Scan.`,
    fr: (reason) =>
      `Connecté, mais la recherche des modules a échoué (${reason}) ; nouvel essai à la prochaine connexion ou avec Scanner.`,
  },
  unreachable: {
    en: (reason, seconds) => `Velbus gateway unreachable (${reason}), next try in ${seconds} s.`,
    fr: (reason, seconds) =>
      `Passerelle Velbus injoignable (${reason}), nouvel essai dans ${seconds} s.`,
  },
  refused: {
    en: 'The gateway closed the connection right after the password, twice: the password is probably wrong. Connection stopped, no new try. Fix it, then save, or click "Test the connection".',
    fr: 'La passerelle a fermé la connexion juste après le mot de passe, deux fois : il est sans doute faux. Connexion arrêtée, sans nouvel essai. Corrigez-le puis enregistrez, ou cliquez sur « Tester la connexion ».',
  },
  certificate: {
    en: (presented, pinned) =>
      `The certificate of the gateway (SHA-256 ${presented}) is not the pinned one (${pinned}): connection stopped, the password was not sent. If the Signum was reset, check it on a connection without password, enter its new fingerprint, then save.`,
    fr: (presented, pinned) =>
      `Le certificat de la passerelle (SHA-256 ${presented}) n'est pas celui épinglé (${pinned}) : connexion arrêtée, le mot de passe n'a pas été envoyé. Si le Signum a été réinitialisé, vérifiez-le sur une connexion sans mot de passe, saisissez sa nouvelle empreinte, puis enregistrez.`,
  },
  silent: {
    en: 'The gateway took the password but sent no Velbus frame, twice: the password may be wrong, or it is not a Velbus gateway. Connection stopped, no new try. Check, then save, or click "Test the connection".',
    fr: "La passerelle a pris le mot de passe mais n'a envoyé aucune trame Velbus, deux fois : le mot de passe est peut-être faux, ou ce n'est pas une passerelle Velbus. Connexion arrêtée, sans nouvel essai. Vérifiez puis enregistrez, ou cliquez sur « Tester la connexion ».",
  },
  waitingBus: {
    en: 'Connected to the gateway, but no Velbus frame received yet.',
    fr: "Connecté à la passerelle, mais aucune trame Velbus reçue pour l'instant.",
  },
  readOnly: {
    en: `This relay is read only in the configuration${nothing.en}`,
    fr: `Ce relais est en lecture seule dans la configuration${nothing.fr}`,
  },
  busyScanning: {
    en: `The scan of the bus is in progress and the bus is busy; try again in a moment${nothing.en}`,
    fr: `La recherche des modules est en cours et le bus est occupé ; réessayez dans un instant${nothing.fr}`,
  },
  offline: {
    en: `The Velbus gateway is not connected${nothing.en}`,
    fr: `La passerelle Velbus n'est pas connectée${nothing.fr}`,
  },
  thermostatRefused: {
    en: `Changing the thermostats from Gladys is disabled in the configuration${nothing.en}`,
    fr: `Le réglage des thermostats depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  unknownChannel: {
    en: `This channel is not on the bus any more (scan again)${nothing.en}`,
    fr: `Ce canal n'est plus sur le bus (relancez une recherche)${nothing.fr}`,
  },
  badValue: {
    en: (value) => `Value ${value} not understood${nothing.en}`,
    fr: (value) => `Valeur ${value} non comprise${nothing.fr}`,
  },
  setpointRange: {
    en: (min, max) => `The set point must be between ${min} and ${max} °C${nothing.en}`,
    fr: (min, max) => `La consigne doit être comprise entre ${min} et ${max} °C${nothing.fr}`,
  },
  unsupportedCommand: {
    en: `This module does not take this command${nothing.en}`,
    fr: `Ce module ne prend pas cette commande${nothing.fr}`,
  },
  stateUnknown: {
    en: `The current state of the thermostat could not be read from the bus${nothing.en}`,
    fr: `L'état actuel du thermostat n'a pas pu être relu sur le bus${nothing.fr}`,
  },
  tooLate: {
    en: `The bus was too busy to send the command in time${nothing.en}`,
    fr: `Le bus était trop occupé pour envoyer la commande à temps${nothing.fr}`,
  },
  queueFull: {
    en: `Too many frames are waiting for the bus${nothing.en}`,
    fr: `Trop de trames attendent le bus${nothing.fr}`,
  },
  unconfirmed: {
    en: (what) =>
      `Sent to the bus (${what}), without confirmation from the module in time: the state is read again in 2 s.`,
    fr: (what) =>
      `Envoyé sur le bus (${what}), sans confirmation du module dans les temps : l'état est relu dans 2 s.`,
  },
  stillScanning: {
    en: (sent, of) =>
      `Connected; the scan of the bus is still running (${sent}/${of}). Try again in a moment.`,
    fr: (sent, of) =>
      `Connecté ; la recherche des modules est encore en cours (${sent}/${of}). Réessayez dans un instant.`,
  },
  stillConnecting: {
    en: 'The gateway does not answer yet; try again in a moment.',
    fr: 'La passerelle ne répond pas encore ; réessayez dans un instant.',
  },
};

/** What a command does, for the logs and the messages. */
export const COMMAND_NAMES = {
  relay: {
    en: (id, on) => `${id} ${on ? 'on' : 'off'}`,
    fr: (id, on) => `${id} ${on ? 'allumé' : 'éteint'}`,
  },
  dimmer: { en: (id, level) => `${id} to ${level} %`, fr: (id, level) => `${id} à ${level} %` },
  blind: {
    en: (id, what) => `${id} ${what}`,
    fr: (id, what) =>
      `${id} ${{ up: 'ouvrir', down: 'fermer', stop: 'arrêter' }[what] ?? `position ${what}`}`,
  },
  setpoint: { en: (id, t) => `${id} set point ${t} °C`, fr: (id, t) => `${id} consigne ${t} °C` },
  preset: { en: (id, p) => `${id} mode ${p}`, fr: (id, p) => `${id} mode ${p}` },
};
