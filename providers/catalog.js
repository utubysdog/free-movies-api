// The provider catalog: the single source of truth for which modules in this
// directory are stream providers, and which function each one exports.
//
// This used to be inferred by scanning `providers/*.js` and subtracting a
// hand-maintained deny-list, in two places (registry.js and utils/config.js).
// Any helper module dropped in here therefore became a phantom provider — which
// is exactly what happened to vidzeeCrypto.js: it showed up in /api/providers,
// gained an `enableVidzeecryptoProvider` config flag, and logged an error on
// every aggregate request. Helpers are simply absent from this list.

const PROVIDERS = [
  { name: '4khdhub', file: '4khdhub.js', export: 'get4KHDHubStreams' },
  { name: 'moviesmod', file: 'moviesmod.js', export: 'getMoviesModStreams' },
  { name: 'mp4hydra', file: 'MP4Hydra.js', export: 'getMP4HydraStreams' },
  { name: 'showbox', file: 'Showbox.js', export: 'getStreamsFromTmdbId' },
  { name: 'uhdmovies', file: 'uhdmovies.js', export: 'getUHDMoviesStreams' },
  { name: 'vidzee', file: 'VidZee.js', export: 'getVidZeeStreams' },
  { name: 'vixsrc', file: 'vixsrc.js', export: 'getVixsrcStreams' },
];

const PROVIDER_NAMES = PROVIDERS.map((p) => p.name);

// Config flag for a provider: 'vidzee' -> 'enableVidzeeProvider'.
function enableFlagFor(name) {
  return `enable${name.charAt(0).toUpperCase()}${name.slice(1)}Provider`;
}

// Environment variable for a provider: 'vidzee' -> 'ENABLE_VIDZEE_PROVIDER'.
function enableEnvFor(name) {
  return `ENABLE_${name.toUpperCase()}_PROVIDER`;
}

module.exports = { PROVIDERS, PROVIDER_NAMES, enableFlagFor, enableEnvFor };
