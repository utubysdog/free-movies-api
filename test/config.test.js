// normalizeConfig turns the raw env+override merge into the shape the rest of
// the app reads. The TMDB-key rules in particular are subtle enough to pin.

const test = require('node:test');
const assert = require('node:assert');

const { normalizeConfig, parseCookies } = require('../utils/config');
const { PROVIDER_NAMES, enableFlagFor } = require('../providers/catalog');

test('providers default to enabled, and "false" from env disables them', () => {
  const cfg = normalizeConfig({ enableVidzeeProvider: 'false' });
  assert.strictEqual(cfg.enableVidzeeProvider, false);
  for (const name of PROVIDER_NAMES.filter((n) => n !== 'vidzee')) {
    assert.strictEqual(cfg[enableFlagFor(name)], true, `${name} should default to enabled`);
  }
});

test('no flag is invented for helper modules', () => {
  const cfg = normalizeConfig({});
  assert.ok(!('enableVidzeecryptoProvider' in cfg));
});

test('string booleans from env are coerced, real booleans pass through', () => {
  const cfg = normalizeConfig({ disableCache: 'true', enableProxy: 'false', enablePStreamApi: true });
  assert.strictEqual(cfg.disableCache, true);
  assert.strictEqual(cfg.enableProxy, false);
  assert.strictEqual(cfg.enablePStreamApi, true);
});

test('boolean flags fall back to their documented defaults', () => {
  const cfg = normalizeConfig({});
  assert.strictEqual(cfg.disableCache, false);
  assert.strictEqual(cfg.enablePStreamApi, true);
  assert.strictEqual(cfg.enableProxy, false);
  assert.strictEqual(cfg.disableUrlValidation, false);
  assert.strictEqual(cfg.disable4khdhubUrlValidation, false);
});

test('the legacy single TMDB key seeds the key list and is not re-exposed', () => {
  const cfg = normalizeConfig({ tmdbApiKey: 'legacy-key' });
  assert.deepStrictEqual(cfg.tmdbApiKeys, ['legacy-key']);
  assert.ok(!('tmdbApiKey' in cfg), 'legacy field must not appear in merged output');
});

test('an explicitly emptied key list is not repopulated from the legacy key', () => {
  const cfg = normalizeConfig({ tmdbApiKeys: [], tmdbApiKey: 'legacy-key' });
  assert.deepStrictEqual(cfg.tmdbApiKeys, []);
});

test('TMDB keys accept a delimited string and are trimmed and deduped', () => {
  const cfg = normalizeConfig({ tmdbApiKeys: 'a, b\nc;a' });
  assert.deepStrictEqual(cfg.tmdbApiKeys, ['a', 'b', 'c']);
});

test('minQualities accepts JSON or a bare value', () => {
  assert.deepStrictEqual(normalizeConfig({ minQualitiesRaw: '{"vidzee":"720p"}' }).minQualities, {
    vidzee: '720p',
  });
  assert.deepStrictEqual(normalizeConfig({ minQualitiesRaw: '1080p' }).minQualities, { default: '1080p' });
  assert.strictEqual(normalizeConfig({}).minQualities, null);
});

test('parseCookies handles JSON, delimited text, the ui= prefix and duplicates', () => {
  assert.deepStrictEqual(parseCookies('["ui=abc","def"]'), ['abc', 'def']);
  assert.deepStrictEqual(parseCookies('abc, def\nghi'), ['abc', 'def', 'ghi']);
  assert.deepStrictEqual(parseCookies('ui=abc;abc'), ['abc']);
  assert.deepStrictEqual(parseCookies(''), []);
  assert.deepStrictEqual(parseCookies(null), []);
});
