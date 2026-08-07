// Provider registry: turns the catalog into callable, config-gated providers.

const path = require('path');
const { config } = require('../utils/config');
const { PROVIDERS, enableFlagFor } = require('./catalog');

const moduleCache = new Map();

// Showbox reports how much quota the picked cookie has left; the config panel
// shows the most recent pick. Only Showbox populates this.
let lastCookieStats = {
  selected: null,
  index: null,
  total: 0,
  remainingMB: null,
  timestamp: null,
};

function loadProviderModule(file) {
  if (!moduleCache.has(file)) {
    try {
      moduleCache.set(file, require(path.join(__dirname, file)));
    } catch (e) {
      console.error(`[registry] failed to load ${file}:`, e.message);
      moduleCache.set(file, null);
    }
  }
  return moduleCache.get(file);
}

function effectiveCookies() {
  return Array.isArray(config.febboxCookies) ? config.febboxCookies : [];
}

// Showbox needs a TMDB key plus a FebBox cookie, and reads both off a global
// that it expects to be set for the duration of the call. Kept isolated here so
// the generic path stays a plain function call.
async function callShowbox(fetchStreams, ctx, mediaType) {
  const { getTmdbApiKey } = require('../utils/tmdbKey');
  if (!getTmdbApiKey()) {
    console.warn('[registry] showbox skipped: TMDB API key missing');
    return [];
  }

  const cookies = effectiveCookies();
  const previousConfig = global.currentRequestConfig;
  global.currentRequestConfig = { ...(previousConfig || {}) };

  let selected = null;
  if (cookies.length > 0) {
    const index = Math.floor(Math.random() * cookies.length);
    selected = cookies[index];
    const withPrefix = (c) => (c.startsWith('ui=') ? c : `ui=${c}`);
    global.currentRequestConfig.cookie = withPrefix(selected);
    global.currentRequestConfig.cookies = cookies.map(withPrefix);
    lastCookieStats = {
      selected: `${selected.slice(0, 16)}...`,
      index,
      total: cookies.length,
      remainingMB: null,
      timestamp: Date.now(),
    };
    console.log(`[registry] cookie random pick index=${index} total=${cookies.length}`);
  }

  try {
    return await fetchStreams(mediaType, ctx.tmdbId, ctx.season || null, ctx.episode || null, null, selected);
  } finally {
    if (global.currentRequestUserCookieRemainingMB != null) {
      lastCookieStats.remainingMB = global.currentRequestUserCookieRemainingMB;
    }
    global.currentRequestConfig = previousConfig || {};
  }
}

// Every provider resolves to `fetch(ctx) -> Stream[]`, and never throws: a dead
// scraper must not take down an aggregate request.
function createFetch(provider) {
  return async function fetchStreams(ctx) {
    const module = loadProviderModule(provider.file);
    const fn = module && module[provider.export];
    if (typeof fn !== 'function') {
      console.error(`[registry] ${provider.name} does not export ${provider.export}()`);
      return [];
    }

    const mediaType = ctx.type === 'movie' ? 'movie' : 'tv';
    const startedAt = Date.now();
    try {
      const result =
        provider.name === 'showbox'
          ? await callShowbox(fn, ctx, mediaType)
          : await fn(ctx.tmdbId, mediaType, ctx.season || null, ctx.episode || null);

      console.log(`[registry] ${provider.name} fetch duration ${Date.now() - startedAt}ms`);
      if (!Array.isArray(result)) return [];
      return result.map((s) => ({ ...s, provider: s.provider || provider.name }));
    } catch (e) {
      console.error(`[registry] ${provider.name} fetch error:`, e.message);
      return [];
    }
  };
}

// Providers are gated at startup; a disabled one is absent, not merely flagged.
const providers = PROVIDERS.filter((provider) => {
  const enabled = config[enableFlagFor(provider.name)] !== false;
  console.log(`[registry] ${provider.name} provider ${enabled ? 'enabled' : 'disabled via config'}`);
  return enabled;
}).map((provider) => ({
  name: provider.name,
  enabled: true,
  fetch: createFetch(provider),
}));

function listProviders() {
  return providers.map((p) => ({ name: p.name, enabled: p.enabled }));
}

function getProvider(name) {
  return providers.find((p) => p.name === String(name || '').toLowerCase()) || null;
}

function getCookieStats() {
  return lastCookieStats;
}

module.exports = { listProviders, getProvider, getCookieStats };
