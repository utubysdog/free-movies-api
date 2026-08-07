// Deterministic tests for VidZee stream resolution — no network.
//
// VidZee dropped the api-key/AES scheme entirely (see providers/vidzeeCrypto.js).
// What's left to pin down is URL construction and response normalisation, both
// pure. Payload fixtures below are verbatim real responses.

const test = require('node:test');
const assert = require('node:assert');

const { buildStreamUrl, normalizeStreams, DEFAULT_SERVERS } = require('../providers/vidzeeCrypto');
const { isEnglishish, firstPlaylistEntry, looksLikeImage } = require('../vidzee-mp4');

test('buildStreamUrl builds a movie URL with plaintext mode', () => {
  assert.strictEqual(
    buildStreamUrl({ tmdbId: 550, type: 'movie', sr: 'dcloud' }),
    'https://core.vidzee.wtf/streams/movie/550?s=dcloud&e=0',
  );
});

test('buildStreamUrl builds a tv URL with season and episode', () => {
  assert.strictEqual(
    buildStreamUrl({ tmdbId: 1396, type: 'tv', season: 1, episode: 1, sr: 'dcloud' }),
    'https://core.vidzee.wtf/streams/tv/1396/1/1?s=dcloud&e=0',
  );
});

test('buildStreamUrl percent-encodes server ids containing a colon', () => {
  assert.strictEqual(
    buildStreamUrl({ tmdbId: 550, type: 'movie', sr: 'v6:Hindi' }),
    'https://core.vidzee.wtf/streams/movie/550?s=v6%3AHindi&e=0',
  );
});

test('normalizeStreams maps a real plaintext payload to a stream', () => {
  const payload = {
    language: 'Auto',
    url: 'https://cdn2.1shows.app/movie/abc._K4xLdHx/index.m3u8',
    headers: {},
  };
  assert.deepStrictEqual(normalizeStreams(payload, 'dcloud'), [
    {
      sr: 'dcloud',
      name: 'VidZee dcloud',
      language: 'Auto',
      type: 'hls',
      url: 'https://cdn2.1shows.app/movie/abc._K4xLdHx/index.m3u8',
      headers: {},
    },
  ]);
});

test('normalizeStreams passes through upstream-required headers', () => {
  const payload = {
    language: 'hindi',
    url: 'https://img1.hvncw.com/hls/x/720/index_309.m3u8?auth_key=k',
    headers: { Origin: 'https://example.test' },
  };
  const [s] = normalizeStreams(payload, 'v6:Hindi');
  assert.deepStrictEqual(s.headers, { Origin: 'https://example.test' });
  assert.strictEqual(s.language, 'hindi');
});

test('normalizeStreams defaults a missing language to unknown', () => {
  const [s] = normalizeStreams({ url: 'https://x.test/a.m3u8' }, 'tik');
  assert.strictEqual(s.language, 'unknown');
  assert.deepStrictEqual(s.headers, {});
});

test('normalizeStreams returns [] for error and malformed payloads', () => {
  // What the API actually returns for a bad server id, and for still-encrypted
  // responses (e=1) that this client no longer asks for.
  assert.deepStrictEqual(normalizeStreams({ error: 'Unknown server' }, 'nope'), []);
  assert.deepStrictEqual(normalizeStreams({ c: 'JHd/O54eLA5vxsCt' }, 'dcloud'), []);
  assert.deepStrictEqual(normalizeStreams({ url: 'not-a-url' }, 'dcloud'), []);
  assert.deepStrictEqual(normalizeStreams({ url: '' }, 'dcloud'), []);
  assert.deepStrictEqual(normalizeStreams(null, 'dcloud'), []);
  assert.deepStrictEqual(normalizeStreams('nonsense', 'dcloud'), []);
});

test('DEFAULT_SERVERS lists the current server ids, dubbed last', () => {
  assert.deepStrictEqual(DEFAULT_SERVERS, ['dcloud', 'tik', 'ipcloud', 'v6:Hindi']);
});

test('firstPlaylistEntry resolves the first entry, relative or absolute', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1441498,RESOLUTION=1280x720',
    'index-v1-a1.m3u8',
  ].join('\n');
  assert.strictEqual(
    firstPlaylistEntry(master, 'https://cdn1.1shows.app/e/Abc/master.m3u8'),
    'https://cdn1.1shows.app/e/Abc/index-v1-a1.m3u8',
  );

  const variant = ['#EXTM3U', '', '#EXTINF:10.010,', 'https://p1.ipstatp.com/origin/x/abc'].join('\n');
  assert.strictEqual(
    firstPlaylistEntry(variant, 'https://cdn1.1shows.app/e/Abc/index-v1-a1.m3u8'),
    'https://p1.ipstatp.com/origin/x/abc',
  );
});

test('firstPlaylistEntry returns null when a playlist has no entries', () => {
  assert.strictEqual(firstPlaylistEntry('#EXTM3U\n#EXT-X-ENDLIST\n', 'https://x.test/a.m3u8'), null);
  assert.strictEqual(firstPlaylistEntry('', 'https://x.test/a.m3u8'), null);
});

test('looksLikeImage spots the PNG-wrapped segments ipcloud serves', () => {
  // Real 1x1 PNG header; the MPEG-TS payload starts at byte 70.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.strictEqual(looksLikeImage(png), true);
  assert.strictEqual(looksLikeImage(Buffer.from('ffd8ffe000104a46', 'hex')), true); // JPEG
  // A bare MPEG-TS packet must pass: 0x47 sync, PAT PID.
  assert.strictEqual(looksLikeImage(Buffer.from('474000100000b00d', 'hex')), false);
  assert.strictEqual(looksLikeImage(Buffer.alloc(0)), false);
  assert.strictEqual(looksLikeImage(null), false);
});

test('isEnglishish prefers English/original, rejects other languages', () => {
  assert.strictEqual(isEnglishish('English'), true);
  assert.strictEqual(isEnglishish(''), true);
  assert.strictEqual(isEnglishish('unknown'), true);
  // The dcloud server reports "Auto" for its English audio.
  assert.strictEqual(isEnglishish('Auto'), true);
  assert.strictEqual(isEnglishish('Vietnamese'), false);
  assert.strictEqual(isEnglishish('Hindi'), false);
});
