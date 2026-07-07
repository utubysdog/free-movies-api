// VidZee -> MP4 streaming API.
//
//   GET /movie/<tmdbId>                -> video/mp4 (movie)
//   GET /tv/<tmdbId>/<season>/<ep>     -> video/mp4 (episode)
//     ?sr=<n>        force a specific VidZee server
//     ?download=1    send as an attachment instead of inline
//
// VidZee serves HLS; ffmpeg remuxes (-c copy, no re-encode) into a fragmented
// MP4 streamed to the client. Uses only Node builtins + axios so it needs no
// local install. See docs/superpowers/specs for the design.

const http = require('http');
const { spawn } = require('child_process');
const axios = require('axios');
const { getServerStreams, UA, STREAM_REFERER } = require('./providers/vidzeeCrypto');

const PORT = Number(process.env.MP4_PORT) || 6150;
const HOST = process.env.MP4_HOST || '0.0.0.0';

// Try Vietnamese/dubbed-heavy servers last so English wins when available.
const SERVER_ORDER = [1, 2, 3, 4, 6, 7, 8, 9, 10, 5];

function isEnglishish(language) {
  const l = String(language || '').trim().toLowerCase();
  if (!l || l === 'unknown' || l === 'original' || l === 'default') return true;
  return /english|^en$|^eng$/.test(l);
}

function sendJson(res, code, obj) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Cheap reachability probe: fetch the playlist with the CDN's expected headers.
async function isOpenable(url) {
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: STREAM_REFERER },
      timeout: 8000,
      maxContentLength: 4 * 1024 * 1024,
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return typeof resp.data === 'string' && resp.data.includes('#EXTM3U');
  } catch {
    return false;
  }
}

// Walk servers in English-preferred order; return the first openable source,
// preferring English but falling back to any openable one.
async function selectStream({ tmdbId, type, season, episode, srOverride }) {
  const order = srOverride ? [srOverride] : SERVER_ORDER;
  let fallback = null;
  for (const sr of order) {
    let streams = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      streams = await getServerStreams({ tmdbId, type, season, episode, sr });
    } catch {
      streams = [];
    }
    for (const s of streams) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await isOpenable(s.url))) continue;
      if (isEnglishish(s.language)) return s;
      if (!fallback) fallback = s;
    }
  }
  return fallback;
}

// Spawn ffmpeg, remux HLS -> fragmented MP4, pipe to the response.
function streamRemux(res, url, { download, filename }) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-user_agent', UA,
    '-referer', STREAM_REFERER,
    '-i', url,
    '-c', 'copy',
    // HLS carries AAC as ADTS; MP4 needs raw ASC. Without this the muxer
    // rejects audio packets ("Operation not permitted") and ffmpeg aborts.
    '-bsf:a', 'aac_adtstoasc',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let started = false;
  let stderr = '';
  ff.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  // Commit a 200 only once ffmpeg actually produces output.
  ff.stdout.once('data', (chunk) => {
    started = true;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-store');
    if (download) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write(chunk); // flushes 200 + headers
    ff.stdout.pipe(res);
  });

  ff.on('error', (e) => {
    if (!res.headersSent) sendJson(res, 502, { error: 'ffmpeg spawn failed', detail: e.message });
  });

  ff.on('close', (code) => {
    if (!started) {
      sendJson(res, 502, { error: 'remux failed', detail: stderr.slice(-400).trim() });
    } else if (!res.writableEnded) {
      res.end();
    }
    if (code) console.warn(`[mp4] ffmpeg exited code=${code} ${stderr.slice(-200).trim()}`);
  });

  // Client aborted -> kill ffmpeg so no orphans linger.
  const kill = () => {
    if (ff.exitCode === null && !ff.killed) ff.kill('SIGKILL');
  };
  res.on('close', kill);
}

async function handle(req, res, type, params, query) {
  const { tmdbId, season, episode } = params;
  if (!/^\d+$/.test(tmdbId || '')) {
    return sendJson(res, 400, { error: 'tmdbId must be numeric' });
  }
  if (type === 'tv' && (!/^\d+$/.test(season || '') || !/^\d+$/.test(episode || ''))) {
    return sendJson(res, 400, { error: 'tv requires numeric season and episode' });
  }
  const srOverride = query.sr && /^\d+$/.test(query.sr) ? Number(query.sr) : null;
  const download = query.download === '1' || query.download === 'true';
  const filename =
    type === 'tv' ? `tv-${tmdbId}-s${season}e${episode}.mp4` : `movie-${tmdbId}.mp4`;

  try {
    const chosen = await selectStream({ tmdbId, type, season, episode, srOverride });
    if (!chosen) return sendJson(res, 404, { error: 'no playable source' });
    console.log(
      `[mp4] ${type}/${tmdbId}${type === 'tv' ? ` s${season}e${episode}` : ''} -> sr=${chosen.sr} lang=${chosen.language} (${chosen.name})`,
    );
    return streamRemux(res, chosen.url, { download, filename });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error', detail: e.message });
    return undefined;
  }
}

function requestListener(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'bad url' });
  }
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(parsed.searchParams);

  if (parts.length === 1 && parts[0] === 'health') {
    return sendJson(res, 200, { ok: true, service: 'vidzee-mp4' });
  }
  if (parts.length === 2 && parts[0] === 'movie') {
    return handle(req, res, 'movie', { tmdbId: parts[1] }, query);
  }
  if (parts.length === 4 && parts[0] === 'tv') {
    return handle(req, res, 'tv', { tmdbId: parts[1], season: parts[2], episode: parts[3] }, query);
  }
  return sendJson(res, 404, { error: 'not found', usage: '/movie/<id>  |  /tv/<id>/<season>/<episode>' });
}

function createServer() {
  return http.createServer(requestListener);
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`VidZee MP4 API listening on http://${HOST}:${PORT}`);
    console.log('  GET /movie/:tmdbId');
    console.log('  GET /tv/:tmdbId/:season/:episode   (?sr=<n>, ?download=1)');
  });
}

module.exports = { createServer, requestListener, selectStream, isEnglishish };
