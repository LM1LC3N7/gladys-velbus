// -----------------------------------------------------------------------------
// Velbus frames, ported from velbus-aio (velbusaio/raw_message.py, util.py,
// const.py; Apache-2.0 / MIT, see THIRD_PARTY_NOTICES.md):
//
//   0x0F  priority  address  RTR|length  data[0..8]  checksum  0x04
//
// - priority: 0xF8 high, 0xF9 firmware, 0xFA third party, 0xFB low, 0xFC;
// - RTR (0x40) marks a request without data (the module type scan);
// - the checksum is the two's complement of the sum of every byte before it.
//
// Changed from velbus-aio: the stream is cut by one forward pass, a byte at a
// time, into a buffer of 14 bytes at most (a frame is never longer); a byte
// that cannot start or continue a frame is dropped and the reader looks for
// the next start among the bytes it holds, never further back. Bits of the
// length byte other than RTR and the length must be zero.
// -----------------------------------------------------------------------------

export const START = 0x0f;
export const END = 0x04;
export const RTR = 0x40;
export const PRIORITY = { HIGH: 0xf8, FIRMWARE: 0xf9, THIRD_PARTY: 0xfa, LOW: 0xfb, WEIRD: 0xfc };
const PRIORITIES = new Set(Object.values(PRIORITY));
export const MAX_DATA = 8;
export const MAX_FRAME = 4 + MAX_DATA + 2;

/** Two's complement of the sum of the bytes (the velbus-aio checksum). */
export function checksum(bytes) {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xff;
  return (256 - sum) & 0xff;
}

/** A frame to the bus: { priority, address, rtr, data } -> bytes. */
export function encode({ priority = PRIORITY.LOW, address, rtr = false, data = [] }) {
  if (!Number.isInteger(address) || address < 0 || address > 255) {
    throw new RangeError(`Velbus address out of range: ${address}`);
  }
  if (!PRIORITIES.has(priority)) throw new RangeError(`Velbus priority unknown: ${priority}`);
  if (data.length > MAX_DATA) throw new RangeError('Velbus frame longer than 8 data bytes');
  for (const byte of data) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new RangeError(`Velbus data byte out of range: ${byte}`);
    }
  }
  const head = [START, priority, address, (rtr ? RTR : 0) | data.length, ...data];
  return Buffer.from([...head, checksum(head), END]);
}

/** 'more' while a candidate frame is incomplete, 'bad', or its length once complete and valid. */
function check(buffer) {
  const n = buffer.length;
  if (n >= 2 && !PRIORITIES.has(buffer[1])) return 'bad';
  if (n >= 4 && ((buffer[3] & 0xb0) !== 0 || (buffer[3] & 0x0f) > MAX_DATA)) return 'bad';
  if (n < 4) return 'more';
  const total = 4 + (buffer[3] & 0x0f) + 2;
  if (n < total) return 'more';
  if (buffer[total - 1] !== END) return 'bad';
  if (checksum(buffer.slice(0, total - 2)) !== buffer[total - 2]) return 'bad';
  return total;
}

/**
 * Cuts the byte stream into frames. Each byte is read once on arrival; on a
 * wrong byte the candidate frame (14 bytes at most) is searched for the next
 * start byte, so the work per byte is bounded.
 */
export class FrameReader {
  constructor({ onFrame, onDrop = () => undefined }) {
    this.onFrame = onFrame;
    this.onDrop = onDrop;
    this.buffer = [];
  }

  reset() {
    this.buffer = [];
  }

  push(chunk) {
    for (const byte of chunk) this.add(byte);
  }

  add(byte) {
    if (this.buffer.length === 0 && byte !== START) return;
    this.buffer.push(byte);
    // The buffer never holds more than MAX_FRAME bytes, and each round
    // removes at least one of them or stops: a bounded work per byte.
    while (this.buffer.length > 0) {
      if (this.buffer[0] !== START) {
        const next = this.buffer.indexOf(START);
        this.buffer = next < 0 ? [] : this.buffer.slice(next);
        continue;
      }
      const state = check(this.buffer);
      if (state === 'more') return;
      if (typeof state === 'number') {
        const b = this.buffer.slice(0, state);
        // Bytes after it (left by a resync) are read next, in order.
        this.buffer = this.buffer.slice(state);
        this.onFrame({
          priority: b[1],
          address: b[2],
          rtr: (b[3] & RTR) === RTR,
          data: Buffer.from(b.slice(4, 4 + (b[3] & 0x0f))),
        });
      } else {
        this.onDrop('invalid frame');
        const next = this.buffer.indexOf(START, 1);
        this.buffer = next < 0 ? [] : this.buffer.slice(next);
      }
    }
  }
}
