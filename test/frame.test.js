// The frame layer: checksums and frames byte for byte against velbus-aio's
// own RawMessage.to_bytes() (run once with the portable Python of this PC),
// and a reader that stays linear and bounded on a hostile stream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameReader, MAX_FRAME, checksum, encode } from '../src/velbus/frame.js';

// velbus-aio 2026.9.0: RawMessage(priority, address, rtr, data).to_bytes().hex()
const VECTORS = [
  [{ priority: 0xfb, address: 0x1a, rtr: true, data: [] }, '0ffb1a409c04'],
  [{ priority: 0xf8, address: 0x1a, data: [0x02, 0x04] }, '0ff81a020204d704'],
  [
    { priority: 0xfb, address: 0x1a, data: [0xfb, 0x01, 0x00, 0x01, 0, 0, 0, 0] },
    '0ffb1a08fb01000100000000d704',
  ],
  [
    { priority: 0xfb, address: 0x40, data: [0xea, 0x20, 0x00, 0x01, 0x2b, 0x2c, 0, 0] },
    '0ffb4008ea2000012b2c00004c04',
  ],
  [
    { priority: 0xf8, address: 0x2a, data: [0x07, 0x01, 0x32, 0x00, 0x00] },
    '0ff82a0507013200009004',
  ],
];

const read = (bytes) => {
  const frames = [];
  let drops = 0;
  const reader = new FrameReader({ onFrame: (f) => frames.push(f), onDrop: () => (drops += 1) });
  reader.push(Buffer.from(bytes));
  return { frames, drops, reader };
};

test('frames are the bytes of velbus-aio', () => {
  for (const [frame, hex] of VECTORS) {
    assert.equal(encode(frame).toString('hex'), hex);
    const { frames } = read(Buffer.from(hex, 'hex'));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].address, frame.address);
    assert.equal(frames[0].rtr, Boolean(frame.rtr));
    assert.deepEqual([...frames[0].data], frame.data);
  }
  assert.equal(checksum([0x0f, 0xfb, 0x1a, 0x40]), 0x9c);
});

test('encode refuses what is not a frame', () => {
  assert.throws(() => encode({ address: 256 }), RangeError);
  assert.throws(() => encode({ address: 1, data: new Array(9).fill(0) }), RangeError);
  assert.throws(() => encode({ address: 1, data: [256] }), RangeError);
  assert.throws(() => encode({ address: 1, priority: 0x00 }), RangeError);
});

test('the reader cuts frames split anywhere and glued together', () => {
  const all = Buffer.concat(VECTORS.map(([, hex]) => Buffer.from(hex, 'hex')));
  const frames = [];
  const reader = new FrameReader({ onFrame: (f) => frames.push(f) });
  for (const byte of all) reader.push([byte]);
  assert.equal(frames.length, VECTORS.length);
  assert.deepEqual(read(all).frames.length, VECTORS.length);
});

test('garbage, a wrong checksum or end byte: dropped, the next frame is found', () => {
  const good = Buffer.from(VECTORS[1][1], 'hex');
  const badSum = Buffer.from(good);
  badSum[badSum.length - 2] ^= 0xff;
  const badEnd = Buffer.from(good);
  badEnd[badEnd.length - 1] = 0x05;
  const { frames, drops } = read(
    Buffer.concat([Buffer.from([0, 0xff, 0x0f, 0x00]), badSum, badEnd, good]),
  );
  assert.equal(frames.length, 1);
  assert.ok(drops >= 3);
  // A length over 8, or stray bits in the length byte, is no frame.
  assert.equal(read([0x0f, 0xfb, 0x01, 0x09, ...good]).frames.length, 1);
  assert.equal(read([0x0f, 0xfb, 0x01, 0x82, ...good]).frames.length, 1);
});

test('a start byte inside a broken frame is tried as a new start', () => {
  // The data of a broken frame holds a whole valid frame: it is found.
  const good = Buffer.from(VECTORS[0][1], 'hex');
  const { frames } = read([0x0f, 0xfb, 0x02, 0x08, ...good, 0x00, 0x00, 0x00, 0x00, ...good]);
  assert.deepEqual(
    frames.map((f) => f.address),
    [0x1a, 0x1a],
  );
});

test('the reader holds 14 bytes at most and reads each byte a bounded number of times', () => {
  const reader = new FrameReader({ onFrame: () => undefined });
  // A hostile stream: every byte a start byte, then a stream of near-frames.
  const hostile = Buffer.alloc(100_000, 0x0f);
  const started = process.hrtime.bigint();
  reader.push(hostile);
  for (let i = 0; i < 20_000; i += 1) reader.push([0x0f, 0xfb, 0x01, 0x08, 1, 2, 3]);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(reader.buffer.length <= MAX_FRAME);
  assert.ok(ms < 2_000, `${ms} ms`);
});
