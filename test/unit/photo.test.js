import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffImage, PHOTO_MAX_BYTES } from '../../photo.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSjAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(4),
]);

test('sniffImage accepts JPEG, PNG and WebP and rejects other bytes', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(WEBP), 'image/webp');
  assert.equal(sniffImage(Buffer.from('not-an-image')), null);
  assert.equal(sniffImage(Buffer.from('')), null);
  assert.ok(PHOTO_MAX_BYTES >= 1024 * 1024);
});
