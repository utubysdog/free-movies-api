// VidZee -> MP4 streaming API.
//
//   GET /movie/<tmdbId>                -> video/mp4 (movie)
//   GET /tv/<tmdbId>/<season>/<ep>     -> video/mp4 (episode)
//     ?sr=<name>     force a specific VidZee server (e.g. dcloud, v6:Hindi)
//     ?download=1    send as an attachment instead of inline
//
// VidZee serves HLS; ffmpeg remuxes (-c copy, no re-encode) into a fragmented
// MP4 streamed to the client. Uses only Node builtins + axios so it needs no
// local install. See docs/superpowers/specs for the design.

const http = require('http');
const { spawn } = require('child_process');
const axios = require('axios');
const {
  getServerStreams,
  UA,
  STREAM_REFERER,
  DEFAULT_SERVERS,
} = require('./providers/vidzeeCrypto');

const PORT = Number(process.env.MP4_PORT) || 6150;
const HOST = process.env.MP4_HOST || '0.0.0.0';

// Already ordered with the dubbed server last, so English wins when available.
const SERVER_ORDER = DEFAULT_SERVERS;

function isEnglishish(language) {
  const l = String(language || '').trim().toLowerCase();
  // "auto" is what the dcloud server reports for its English audio.
  if (!l || l === 'unknown' || l === 'original' || l === 'default' || l === 'auto') return true;
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

// First non-comment line of an m3u8, resolved against the playlist's own URL.
function firstPlaylistEntry(text, baseUrl) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    try {
      return new URL(entry, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

// The `ipcloud` server hides MPEG-TS behind a 70-byte 1x1 PNG header. ffmpeg
// decodes the PNG, finds no media and aborts, so such a source is unplayable
// for us even though its playlist fetches fine.
const IMAGE_MAGIC = [
  Buffer.from('89504e470d0a1a0a', 'hex'), // PNG
  Buffer.from('ffd8ff', 'hex'), // JPEG
  Buffer.from('GIF87a', 'ascii'),
  Buffer.from('GIF89a', 'ascii'),
];

function looksLikeImage(buf) {
  if (!buf || !buf.length) return false;
  const head = Buffer.from(buf);
  return IMAGE_MAGIC.some((magic) => head.subarray(0, magic.length).equals(magic));
}

async function fetchText(url, extraHeaders) {
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: STREAM_REFERER, ...extraHeaders },
    timeout: 8000,
    maxContentLength: 4 * 1024 * 1024,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return typeof resp.data === 'string' ? resp.data : '';
}

// Reachability probe: fetch the playlist with the CDN's expected headers, then
// sniff the first media segment so we never hand ffmpeg a source it can't open.
async function isOpenable(url, extraHeaders = {}) {
  try {
    let playlist = await fetchText(url, extraHeaders);
    if (!playlist.includes('#EXTM3U')) return false;

    let entryUrl = firstPlaylistEntry(playlist, url);
    if (!entryUrl) return false;

    // A master playlist points at a variant; follow one level to the segments.
    if (playlist.includes('#EXT-X-STREAM-INF')) {
      playlist = await fetchText(entryUrl, extraHeaders);
      if (!playlist.includes('#EXTM3U')) return false;
      entryUrl = firstPlaylistEntry(playlist, entryUrl);
      if (!entryUrl) return false;
    }

    const seg = await axios.get(entryUrl, {
      headers: { 'User-Agent': UA, Referer: STREAM_REFERER, Range: 'bytes=0-15', ...extraHeaders },
      timeout: 8000,
      responseType: 'arraybuffer',
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return !looksLikeImage(Buffer.from(seg.data));
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
      if (!(await isOpenable(s.url, s.headers))) continue;
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
  // Server ids are names now ("dcloud", "v6:Hindi"), not numbers.
  const srOverride = typeof query.sr === 'string' && query.sr.trim() ? query.sr.trim() : null;
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
    console.log('  GET /tv/:tmdbId/:season/:episode   (?sr=<name>, ?download=1)');
  });
}

module.exports = {
  createServer,
  requestListener,
  selectStream,
  isEnglishish,
  firstPlaylistEntry,
  looksLikeImage,
};
