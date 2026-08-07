// The provider catalog is the single source of truth for what counts as a
// provider. These tests guard the two ways it can silently go wrong: a listed
// provider whose export has been renamed, and a helper module sneaking into the
// provider list (which is how `vidzeecrypto` became a phantom provider).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PROVIDERS, PROVIDER_NAMES, enableFlagFor, enableEnvFor } = require('../providers/catalog');

const PROVIDERS_DIR = path.join(__dirname, '..', 'providers');

test('every catalogued provider exists and exports the named function', () => {
  for (const provider of PROVIDERS) {
    const file = path.join(PROVIDERS_DIR, provider.file);
    assert.ok(fs.existsSync(file), `${provider.file} is catalogued but missing on disk`);
    const module = require(file);
    assert.strictEqual(
      typeof module[provider.export],
      'function',
      `${provider.file} does not export ${provider.export}()`,
    );
  }
});

test('helper modules are not treated as providers', () => {
  const catalogued = new Set(PROVIDERS.map((p) => p.file));
  for (const helper of ['vidzeeCrypto.js', 'catalog.js', 'registry.js', 'vidsrcextractor.js']) {
    assert.ok(!catalogued.has(helper), `${helper} must not be catalogued as a provider`);
  }
  assert.ok(!PROVIDER_NAMES.includes('vidzeecrypto'));
  assert.ok(!PROVIDER_NAMES.includes('catalog'));
});

test('provider names are unique and lowercase', () => {
  assert.strictEqual(new Set(PROVIDER_NAMES).size, PROVIDER_NAMES.length);
  for (const name of PROVIDER_NAMES) assert.strictEqual(name, name.toLowerCase());
});

test('enable flag and env var names match the documented convention', () => {
  assert.strictEqual(enableFlagFor('vidzee'), 'enableVidzeeProvider');
  assert.strictEqual(enableFlagFor('4khdhub'), 'enable4khdhubProvider');
  assert.strictEqual(enableEnvFor('vidzee'), 'ENABLE_VIDZEE_PROVIDER');
  assert.strictEqual(enableEnvFor('mp4hydra'), 'ENABLE_MP4HYDRA_PROVIDER');
});
