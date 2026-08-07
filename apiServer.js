// TMDB Embed REST API: aggregates stream providers behind a small HTTP surface,
// and serves the login + config UI from public/.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { config, saveConfigPatch, OVERRIDE_PATH } = require('./utils/config');
const { authenticate, issueSession, requireAuth, getSession, updatePassword } = require('./utils/auth');
const { listProviders, getProvider, getCookieStats } = require('./providers/registry');
const { createProxyRoutes, processStreamsForProxy } = require('./proxy/proxyServer');
const { resolveImdbId } = require('./utils/tmdb');
const { applyFilters } = require('./utils/streamFilters');

const PUBLIC_DIR = path.join(__dirname, 'public');
const RESTART_MARKER = path.join(__dirname, 'restart.trigger');
const NO_STORE = { 'Cache-Control': 'no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' };

const app = express();

// Proxy routes must mount before anything that might return a stream URL.
if (config.enableProxy) {
  console.log('[startup] enableProxy flag active: mounting proxy routes');
  createProxyRoutes(app);
} else {
  console.log('[startup] enableProxy flag disabled: proxy routes not mounted');
}

app.use(cors());
app.use(express.json());

// --- Metrics (in-memory) ---

const metrics = {
  startTime: Date.now(),
  requestsTotal: 0,
  streamRequests: 0,
  providerCalls: {},
  lastRequestAt: null,
  lastError: null,
  streamsReturned: 0,
  tmdbToImdbLookups: 0,
};

function metricsSnapshot() {
  return {
    uptimeSeconds: Math.round((Date.now() - metrics.startTime) / 1000),
    requestsTotal: metrics.requestsTotal,
    streamRequests: metrics.streamRequests,
    providerCalls: metrics.providerCalls,
    streamsReturned: metrics.streamsReturned,
    tmdbToImdbLookups: metrics.tmdbToImdbLookups,
    lastRequestAt: metrics.lastRequestAt,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

app.use((req, res, next) => {
  metrics.requestsTotal++;
  metrics.lastRequestAt = Date.now();
  next();
});

// --- Login throttling ---
//
// Per-IP, in memory: five failures inside the window, then an exponential lock.

const MAX_ATTEMPTS_WINDOW = 5;
const WINDOW_MS = 10 * 60 * 1000;
const BASE_LOCK_MS = 5 * 60 * 1000;
const MAX_LOCK_MULTIPLIER = 8;

const loginAttempts = new Map(); // ip -> { count, first, last, lockedUntil }

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
}

function canAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (now - entry.first > WINDOW_MS) {
    loginAttempts.delete(ip);
  }
  return { allowed: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) {
    const fresh = { count: 1, first: now, last: now, lockedUntil: 0 };
    loginAttempts.set(ip, fresh);
    return fresh;
  }

  const windowExpired = now - entry.first > WINDOW_MS && now > entry.lockedUntil;
  if (windowExpired) {
    entry.count = 1;
    entry.first = now;
  } else {
    entry.count++;
  }
  entry.last = now;

  if (entry.count > MAX_ATTEMPTS_WINDOW) {
    const over = entry.count - MAX_ATTEMPTS_WINDOW;
    entry.lockedUntil = now + BASE_LOCK_MS * Math.min(MAX_LOCK_MULTIPLIER, 2 ** (over - 1));
  }
  return entry;
}

// --- Auth routes (registered before static, so they win over public/) ---

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const ip = getClientIp(req);

  const attemptState = canAttempt(ip);
  if (!attemptState.allowed) {
    res.setHeader('Retry-After', String(attemptState.retryAfter));
    return res.status(429).json({ success: false, error: 'TOO_MANY_ATTEMPTS', retryAfter: attemptState.retryAfter });
  }
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'MISSING_CREDENTIALS' });
  }

  if (!authenticate(username, password)) {
    const entry = recordLoginFailure(ip);
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
      const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, error: 'LOCKED', retryAfter });
    }
    return res.status(401).json({
      success: false,
      error: 'INVALID_CREDENTIALS',
      remaining: Math.max(0, MAX_ATTEMPTS_WINDOW - entry.count),
    });
  }

  loginAttempts.delete(ip);
  const token = issueSession(username);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 60 * 60}`);
  res.json({ success: true, username });
});

app.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ success: true });
});

app.get('/auth/session', (req, res) => {
  const sess = getSession(req);
  res.json(sess ? { authenticated: true, username: sess.u } : { authenticated: false });
});

app.post('/auth/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ success: false, error: 'MISSING_FIELDS' });
  if (!authenticate(req.session.u, oldPassword)) {
    return res.status(401).json({ success: false, error: 'INVALID_OLD_PASSWORD' });
  }
  if (newPassword.length < 8) return res.status(400).json({ success: false, error: 'PASSWORD_TOO_SHORT' });
  if (!updatePassword(req.session.u, newPassword)) {
    return res.status(500).json({ success: false, error: 'UPDATE_FAILED' });
  }
  res.json({ success: true, message: 'PASSWORD_UPDATED' });
});

// --- UI ---

// Both pages are served explicitly so they can be marked no-store; the config
// page additionally requires a session.
app.get('/config.html', (req, res) => {
  if (!getSession(req)) return res.redirect(302, '/');
  res.set(NO_STORE).sendFile(path.join(PUBLIC_DIR, 'config.html'));
});

app.get('/', (req, res) => {
  res.set(NO_STORE).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use(express.static(PUBLIC_DIR));

// --- Config API (session-gated: exposes TMDB keys and accepts writes) ---

app.get('/api/config', requireAuth, (req, res) => {
  let override = {};
  try {
    if (fs.existsSync(OVERRIDE_PATH)) override = JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf8'));
  } catch {
    // Unreadable or malformed override: report the merged config on its own.
  }
  res.json({ success: true, merged: config, override, overridePath: OVERRIDE_PATH });
});

app.post('/api/config', requireAuth, (req, res) => {
  const patch = req.body || {};
  if (patch.port !== undefined) {
    const port = Number(patch.port);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return res.status(400).json({ success: false, error: 'INVALID_PORT' });
    }
    patch.port = port;
  }
  if (patch.defaultProviders && !Array.isArray(patch.defaultProviders)) {
    return res.status(400).json({ success: false, error: 'DEFAULT_PROVIDERS_NOT_ARRAY' });
  }
  res.json({ success: saveConfigPatch(patch), merged: config });
});

// Restart by exiting; nodemon watches restart.trigger and brings us back up.
app.post('/api/restart', requireAuth, (req, res) => {
  res.json({ success: true, message: 'RESTARTING' });
  setTimeout(() => {
    try {
      fs.writeFileSync(RESTART_MARKER, String(Date.now()));
    } catch (e) {
      console.warn('[control] failed to write restart marker:', e.message);
    }
    console.warn('[control] restarting process by exit(0)');
    process.exit(0);
  }, 300);
});

// --- Informational endpoints ---

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'tmdb-embed-api', time: new Date().toISOString() });
});

app.get('/api/metrics', (req, res) => {
  res.json({
    ...metricsSnapshot(),
    loadAvg: os.loadavg ? os.loadavg() : [],
    nodeVersion: process.version,
    configDefaults: {
      region: config.defaultRegion,
      providers: config.defaultProviders,
      minQualities: config.minQualities ? Object.keys(config.minQualities).length : 0,
      excludeCodecs: config.excludeCodecs
        ? Object.keys(config.excludeCodecs).filter((k) => config.excludeCodecs[k]).length
        : 0,
      febboxCookies: config.febboxCookies.length,
    },
  });
});

// Only Showbox needs a FebBox cookie; the UI greys it out when none is set.
const COOKIE_REQUIRED_PROVIDERS = new Set(['showbox']);

app.get('/api/status', (req, res) => {
  const providers = listProviders().map((p) => {
    const cookieRequired = COOKIE_REQUIRED_PROVIDERS.has(p.name);
    return {
      name: p.name,
      enabled: p.enabled,
      cookieRequired,
      cookieOk: !cookieRequired || (config.febboxCookies && config.febboxCookies.length > 0),
    };
  });
  res.json({
    success: true,
    metrics: metricsSnapshot(),
    endpoints: [
      'GET /api/health',
      'GET /api/metrics',
      'GET /api/status',
      'GET /api/providers',
      'GET /api/providers/:name',
      'GET /api/streams/:type/:tmdbId',
      'GET /api/streams/:provider/:type/:tmdbId',
      'POST /api/config',
      'GET /api/config',
    ],
    providers,
  });
});

app.get('/api/providers', (req, res) => {
  res.json({ success: true, providers: listProviders() });
});

app.get('/api/providers/:name', (req, res) => {
  const provider = getProvider(req.params.name);
  if (!provider) return res.status(404).json({ success: false, error: 'PROVIDER_NOT_FOUND' });
  res.json({ success: true, provider: { name: provider.name, enabled: provider.enabled } });
});

app.get('/api/debug/env', requireAuth, (req, res) => {
  res.json({
    port: config.port,
    defaultProviders: config.defaultProviders,
    febboxCookieCount: config.febboxCookies.length,
    showboxCacheDir: process.env.SHOWBOX_CACHE_DIR || '(os tmp)',
    nodeVersion: process.version,
    cookieStats: getCookieStats(),
  });
});

// --- Streams ---

function parseStreamRequest(req) {
  const { type, tmdbId } = req.params;
  if (!['movie', 'series'].includes(type)) return { error: 'INVALID_TYPE' };
  return {
    ctx: {
      tmdbId,
      type,
      season: req.query.season ? Number(req.query.season) : null,
      episode: req.query.episode ? Number(req.query.episode) : null,
    },
  };
}

// Run one provider, recording its call count and wall time. Never throws.
async function runProvider(provider, ctx, timings) {
  metrics.providerCalls[provider.name] = (metrics.providerCalls[provider.name] || 0) + 1;
  const startedAt = Date.now();
  try {
    console.log(`[api] invoking provider ${provider.name} for tmdbId=${ctx.tmdbId}`);
    const streams = await provider.fetch(ctx);
    timings[provider.name] = Date.now() - startedAt;
    console.log(`[api] provider ${provider.name} returned ${Array.isArray(streams) ? streams.length : 0} streams`);
    return Array.isArray(streams) ? streams : [];
  } catch (e) {
    console.error(`[api] provider ${provider.name} failed:`, e.message);
    timings[provider.name] = null;
    return [];
  }
}

// When proxying, stream URLs are rewritten through our own proxy and the
// upstream header hints are dropped so they aren't leaked to clients.
function applyProxy(streams, req) {
  if (!config.enableProxy) return streams;
  const serverUrl = `${req.protocol}://${req.get('host')}`;
  return processStreamsForProxy(streams, serverUrl).map((s) => {
    if (!s || typeof s !== 'object') return s;
    const { headers, ...rest } = s;
    return rest;
  });
}

async function collectStreams({ req, res, providers, filterLabel }) {
  const { ctx, error } = parseStreamRequest(req);
  if (error) {
    res.status(400).json({ success: false, error });
    return null;
  }

  metrics.streamRequests++;
  const imdbId = await resolveImdbId(ctx.type === 'movie' ? 'movie' : 'tv', ctx.tmdbId);
  if (imdbId) metrics.tmdbToImdbLookups++;

  const providerTimings = {};
  const fetchCtx = { ...ctx, imdbId, filters: {} };
  const results = await Promise.all(providers.map((p) => runProvider(p, fetchCtx, providerTimings)));

  let streams = applyFilters(results.flat(), filterLabel, config.minQualities, config.excludeCodecs);
  metrics.streamsReturned += streams.length;
  streams = applyProxy(streams, req);

  return { tmdbId: ctx.tmdbId, imdbId, providerTimings, streams };
}

// Aggregate across every enabled provider (or config.defaultProviders).
app.get('/api/streams/:type/:tmdbId', async (req, res) => {
  try {
    const names = config.defaultProviders.length
      ? config.defaultProviders
      : listProviders().map((p) => p.name);
    const providers = names.map(getProvider).filter((p) => p && p.enabled);

    const result = await collectStreams({ req, res, providers, filterLabel: 'aggregate' });
    if (!result) return undefined;
    return res.json({ success: true, ...result, count: result.streams.length });
  } catch (e) {
    metrics.lastError = e.message;
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
  }
});

// A single named provider.
app.get('/api/streams/:provider/:type/:tmdbId', async (req, res) => {
  const provider = getProvider(req.params.provider);
  if (!provider) return res.status(404).json({ success: false, error: 'PROVIDER_NOT_FOUND' });
  if (!provider.enabled) return res.status(503).json({ success: false, error: 'PROVIDER_DISABLED' });

  try {
    const result = await collectStreams({ req, res, providers: [provider], filterLabel: provider.name });
    if (!result) return undefined;
    return res.json({ success: true, provider: provider.name, ...result, count: result.streams.length });
  } catch (e) {
    metrics.lastError = e.message;
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
  }
});

// --- Startup ---

process.on('uncaughtException', (err) => console.error('[diagnostic] uncaughtException', err));
process.on('unhandledRejection', (reason) => console.error('[diagnostic] unhandledRejection', reason));

const PORT = config.port;
const HOST = process.env.BIND_HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`TMDB Embed REST API listening on http://${HOST}:${PORT}`);
  if (HOST !== 'localhost') console.log(`Local access (if running on your machine): http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log('  GET  /api/health');
  console.log('  GET  /api/metrics');
  console.log('  GET  /api/providers');
  console.log('  GET  /api/streams/:type/:tmdbId');
  console.log('  GET  /api/streams/:provider/:type/:tmdbId');
  if (!config.febboxCookies || config.febboxCookies.length === 0) {
    console.warn(
      '[startup][warning] No FEBBOX_COOKIES configured. Showbox / PStream related streams may be unavailable. Set FEBBOX_COOKIES in your environment to enable these sources.',
    );
  }
});

server.on('error', (err) => console.error('[diagnostic] server error', err));

module.exports = { app, server };
