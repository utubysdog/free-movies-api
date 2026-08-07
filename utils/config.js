// Configuration: environment variables provide the defaults, utils/user-config.json
// overrides them, and the result is mirrored back into process.env so the older
// provider modules — which read process.env directly — see the same values.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PROVIDER_NAMES, enableFlagFor, enableEnvFor } = require('../providers/catalog');

// Resolved from this file rather than process.cwd(), so the server can be
// started from any directory. user-config.json moved into utils/; the repo-root
// location is still honoured if that's the only one present.
const OVERRIDE_PATH_CURRENT = path.join(__dirname, 'user-config.json');
const OVERRIDE_PATH_LEGACY = path.join(__dirname, '..', 'user-config.json');
const OVERRIDE_PATH =
  fs.existsSync(OVERRIDE_PATH_CURRENT) || !fs.existsSync(OVERRIDE_PATH_LEGACY)
    ? OVERRIDE_PATH_CURRENT
    : OVERRIDE_PATH_LEGACY;

const CONFIG_SCHEMA_VERSION = 1; // Increment when structure / semantics change.

// Flags that are booleans but may arrive as the strings "true"/"false" from env.
const BOOLEAN_FLAGS = [
  'disableCache',
  'enablePStreamApi',
  'disableUrlValidation',
  'disable4khdhubUrlValidation',
  'enableProxy',
];

const BOOLEAN_DEFAULTS = {
  disableCache: false,
  enablePStreamApi: true,
  enableProxy: false,
  disableUrlValidation: false,
  disable4khdhubUrlValidation: false,
};

// --- Parsing helpers ---

function parseJsonMaybe(val) {
  if (!val) return null;
  const trimmed = String(val).trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function splitList(text) {
  return String(text)
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Cookies arrive as a JSON array, or as a delimited string. Stored without the
// `ui=` prefix; consumers add it back.
function parseCookies(raw) {
  if (!raw) return [];
  const json = parseJsonMaybe(raw);
  const list = Array.isArray(json) ? json : splitList(raw);
  return [...new Set(list.map((c) => String(c).replace(/^ui=/, '').trim()).filter(Boolean))];
}

function readOverrideFile() {
  try {
    if (!fs.existsSync(OVERRIDE_PATH)) return {};
    const data = JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    console.warn('[config] failed to read override file:', e.message);
    return {};
  }
}

function writeOverrideFile(obj) {
  try {
    fs.writeFileSync(OVERRIDE_PATH, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.error('[config] failed to write override file:', e.message);
    return false;
  }
}

// --- Normalisation ---

// One or many TMDB keys. `tmdbApiKey` is the legacy single-key field; it seeds
// the list, except when the user has deliberately saved an empty array, which
// must not be silently repopulated from the legacy value.
function normalizeTmdbKeys(cfg, base) {
  const clearedByUser =
    Array.isArray(base.tmdbApiKeys) &&
    base.tmdbApiKeys.length === 0 &&
    Object.prototype.hasOwnProperty.call(base, 'tmdbApiKeys');

  let keys = cfg.tmdbApiKeys;
  if (keys && !Array.isArray(keys)) keys = typeof keys === 'string' ? splitList(keys) : [];
  if (!keys || !keys.length) keys = !clearedByUser && cfg.tmdbApiKey ? [cfg.tmdbApiKey] : [];

  cfg.tmdbApiKeys = [...new Set(keys.map((k) => String(k).trim()).filter(Boolean))];
  // The legacy single-key field is never part of the merged output.
  delete cfg.tmdbApiKey;
}

function normalizeConfig(base) {
  const cfg = { ...base };
  if (!cfg.configVersion) cfg.configVersion = CONFIG_SCHEMA_VERSION;

  cfg.minQualities =
    parseJsonMaybe(cfg.minQualitiesRaw) || (cfg.minQualitiesRaw ? { default: cfg.minQualitiesRaw } : null);
  cfg.excludeCodecs = parseJsonMaybe(cfg.excludeCodecsRaw) || null;
  cfg.febboxCookies = Array.isArray(cfg.febboxCookies) ? cfg.febboxCookies : parseCookies(cfg.febboxCookies);

  normalizeTmdbKeys(cfg, base);

  const providerFlags = PROVIDER_NAMES.map(enableFlagFor);
  for (const flag of [...providerFlags, ...BOOLEAN_FLAGS]) {
    if (cfg[flag] === 'true') cfg[flag] = true;
    else if (cfg[flag] === 'false') cfg[flag] = false;
  }
  for (const flag of providerFlags) {
    if (cfg[flag] === undefined) cfg[flag] = true; // Providers default to enabled.
  }
  for (const [flag, fallback] of Object.entries(BOOLEAN_DEFAULTS)) {
    if (cfg[flag] === undefined) cfg[flag] = fallback;
  }
  return cfg;
}

// --- process.env mirroring ---

function setOrDelete(name, value) {
  if (value) process.env[name] = String(value);
  else delete process.env[name];
}

function applyConfigToEnv(cfg) {
  if (cfg.port) process.env.API_PORT = String(cfg.port);
  setOrDelete('TMDB_API_KEY', cfg.tmdbApiKeys && cfg.tmdbApiKeys.length ? cfg.tmdbApiKeys[0] : null);
  if (cfg.defaultProviders) process.env.DEFAULT_PROVIDERS = cfg.defaultProviders.join(',');
  setOrDelete('MIN_QUALITIES', cfg.minQualitiesRaw);
  setOrDelete('EXCLUDE_CODECS', cfg.excludeCodecsRaw);
  setOrDelete('FEBBOX_COOKIES', cfg.febboxCookies && cfg.febboxCookies.length ? cfg.febboxCookies.join(',') : null);
  setOrDelete('DEFAULT_REGION', cfg.defaultRegion);
  setOrDelete('FEBBOX_REGION', cfg.defaultRegion); // alias
  setOrDelete('SHOWBOX_CACHE_DIR', cfg.showboxCacheDir);

  for (const name of PROVIDER_NAMES) {
    process.env[enableEnvFor(name)] = cfg[enableFlagFor(name)] ? 'true' : 'false';
  }

  process.env.DISABLE_CACHE = cfg.disableCache ? 'true' : 'false';
  process.env.ENABLE_PSTREAM_API = cfg.enablePStreamApi ? 'true' : 'false';
  process.env.DISABLE_URL_VALIDATION = cfg.disableUrlValidation ? 'true' : 'false';
  process.env.DISABLE_4KHDHUB_URL_VALIDATION = cfg.disable4khdhubUrlValidation ? 'true' : 'false';
  process.env.ENABLE_PROXY = cfg.enableProxy ? 'true' : 'false';

  // Proxy support was removed; scrub any stale values a previous version left.
  for (const stale of [
    'SHOWBOX_USE_ROTATING_PROXY',
    'SHOWBOX_PROXY_URL_VALUE',
    'SHOWBOX_PROXY_URL_ALTERNATE',
    'VIDZEE_PROXY_URL',
    'VIDSRC_PROXY_URL',
    'MOVIESMOD_PROXY_URL',
  ]) {
    delete process.env[stale];
  }
}

// --- Load / save ---

function envConfig() {
  const cfg = {
    port: Number(process.env.API_PORT) || 8787,
    defaultRegion: process.env.DEFAULT_REGION || process.env.FEBBOX_REGION || null,
    defaultProviders: (process.env.DEFAULT_PROVIDERS || '')
      .split(/[\s,]+/)
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
    minQualitiesRaw: process.env.MIN_QUALITIES || null,
    excludeCodecsRaw: process.env.EXCLUDE_CODECS || null,
    tmdbApiKey: process.env.TMDB_API_KEY || null,
    tmdbApiKeys: parseJsonMaybe(process.env.TMDB_API_KEYS) || null,
    febboxCookies: parseCookies(process.env.FEBBOX_COOKIES),
    disableCache: process.env.DISABLE_CACHE,
    enablePStreamApi: process.env.ENABLE_PSTREAM_API,
    showboxCacheDir: process.env.SHOWBOX_CACHE_DIR || null,
    disableUrlValidation: process.env.DISABLE_URL_VALIDATION,
    disable4khdhubUrlValidation: process.env.DISABLE_4KHDHUB_URL_VALIDATION,
  };
  for (const name of PROVIDER_NAMES) {
    cfg[enableFlagFor(name)] = process.env[enableEnvFor(name)];
  }
  return cfg;
}

function loadConfig() {
  const normalized = normalizeConfig({ ...envConfig(), ...readOverrideFile() });
  applyConfigToEnv(normalized);
  return normalized;
}

const config = loadConfig();

function reloadConfig() {
  return Object.assign(config, loadConfig());
}

function saveConfigPatch(patch) {
  const updated = { ...readOverrideFile(), ...patch };
  if (!updated.configVersion) updated.configVersion = CONFIG_SCHEMA_VERSION;
  // A null means "forget this override and fall back to env".
  for (const key of Object.keys(updated)) {
    if (updated[key] === null) delete updated[key];
  }
  if (!writeOverrideFile(updated)) return false;
  reloadConfig();
  return true;
}

module.exports = {
  config,
  reloadConfig,
  saveConfigPatch,
  normalizeConfig,
  parseCookies,
  OVERRIDE_PATH,
  CONFIG_SCHEMA_VERSION,
};
