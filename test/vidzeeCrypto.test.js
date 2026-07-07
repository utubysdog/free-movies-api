// Deterministic tests for VidZee decryption — no network.
// The fixture is a frozen real (api-key blob, link, url) triple: the blob
// decrypts to the rotating key, which decrypts the link to the url. Because
// it's all deterministic, this pins the whole chain against real data forever.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const { decryptApiKeyBlob, decryptLink } = require('../providers/vidzeeCrypto');
const { isEnglishish } = require('../vidzee-mp4');
const fixture = require(path.join(__dirname, 'fixtures', 'vidzee-sample.json'));

test('decryptApiKeyBlob recovers the rotating key from a real blob', () => {
  assert.strictEqual(decryptApiKeyBlob(fixture.apiKeyBlobBase64), fixture.rotatingKey);
});

test('decryptApiKeyBlob tolerates whitespace in the blob', () => {
  const spaced = fixture.apiKeyBlobBase64.replace(/(.{8})/g, '$1\n');
  assert.strictEqual(decryptApiKeyBlob(spaced), fixture.rotatingKey);
});

test('decryptLink decrypts a real link with the rotating key', () => {
  assert.strictEqual(decryptLink(fixture.sampleLink, fixture.rotatingKey), fixture.expectedUrl);
});

test('decryptLink round-trips a synthetic link', () => {
  const url = 'https://example.com/path/index.m3u8?a=1';
  const key = 'A7kP9xM2Qv8Lr4Nz1Ht6Yc3Bw5Jf0Ds';
  const iv = crypto.randomBytes(16);
  const keyBuf = Buffer.alloc(32);
  Buffer.from(key, 'utf8').copy(keyBuf);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
  const ct = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  const link = Buffer.from(`${iv.toString('base64')}:${ct.toString('base64')}`, 'binary').toString('base64');
  assert.strictEqual(decryptLink(link, key), url);
});

test('decryptLink returns an already-plain URL unchanged', () => {
  assert.strictEqual(decryptLink('https://x.test/a.m3u8', 'whatever'), 'https://x.test/a.m3u8');
});

test('decryptLink returns null on garbage / wrong key', () => {
  assert.strictEqual(decryptLink('not-base64-@@@', fixture.rotatingKey), null);
  assert.strictEqual(decryptLink(fixture.sampleLink, 'wrong-key-wrong-key-wrong-key-00'), null);
  assert.strictEqual(decryptLink('', fixture.rotatingKey), null);
});

test('isEnglishish prefers English/original, rejects other languages', () => {
  assert.strictEqual(isEnglishish('English'), true);
  assert.strictEqual(isEnglishish(''), true);
  assert.strictEqual(isEnglishish('unknown'), true);
  assert.strictEqual(isEnglishish('Vietnamese'), false);
  assert.strictEqual(isEnglishish('Hindi'), false);
});
