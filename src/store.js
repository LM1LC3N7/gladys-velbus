// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the stop after the gateway refused the password (or its
// certificate changed), with the place it belongs to, so a restart never
// sends a refused password again. Never the password itself, nor anything
// derived from it. The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';

export const STATE_FILE = '/data/velbus-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** In-memory store, for the tests. */
export function memoryStore(initial = null) {
  let data = initial;
  return {
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(next) {
      data = JSON.parse(JSON.stringify(next));
    },
    get data() {
      return data;
    },
  };
}

export const STOP_KINDS = ['password_refused', 'no_frames', 'certificate_changed'];

/** The persisted state, repaired: { stop: { place, kind, at } | null }. */
export function normalizeMemory(raw) {
  const stop = raw?.stop;
  const valid =
    typeof stop?.place === 'string' &&
    stop.place.length > 0 &&
    stop.place.length <= 300 &&
    STOP_KINDS.includes(stop.kind);
  return {
    stop: valid
      ? {
          place: stop.place,
          kind: stop.kind,
          at: Number.isFinite(stop.at) ? stop.at : 0,
          ...(typeof stop.presented === 'string' && /^[0-9a-f]{64}$/.test(stop.presented)
            ? { presented: stop.presented }
            : {}),
        }
      : null,
  };
}
