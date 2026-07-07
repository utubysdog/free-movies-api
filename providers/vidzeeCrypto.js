// VidZee link decryption + stream resolution.
//
// VidZee's current scheme (recovered from player.vidzee.wtf's client bundle):
//   1. GET core.vidzee.wtf/api-key -> base64 [12b IV][16b GCM tag][ciphertext].
//      AES-256-GCM decrypt with key = SHA256(EM) yields a *rotating* CBC key.
//   2. Each stream `link` = base64 of "ivBase64:cipherBase64"; AES-256-CBC
//      decrypt with the rotating key (UTF-8 bytes, null-padded to 32) -> real URL.
//
// If VidZee rotates EM or the endpoints again, update the constants below.

const axios = require('axios');
const crypto = require('crypto');

const EM = 'c4a8f1d7e2b9a6c3d0f5e8a1b7c4d9e2';
const API_KEY_URL = 'https://core.vidzee.wtf/api-key';
const SERVER_API_BASE = 'https://player.vidzee.wtf/api/server';
const EMBED_ORIGIN = 'https://player.vidzee.wtf';
// Header the CDNs expect on the real stream requests.
const STREAM_REFERER = 'https://core.vidzee.wtf/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const KEY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SERVERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

let cachedKey = null;
let cachedKeyAt = 0;

// --- Pure crypto helpers (no network; exported for tests) ---

// Decrypt the api-key blob into the rotating CBC key.
function decryptApiKeyBlob(blobBase64) {
  const t = Buffer.from(String(blobBase64).replace(/\s+/g, ''), 'base64');
  if (t.length <= 28) throw new Error('api-key blob too short');
  const iv = t.subarray(0, 12);
  const tag = t.subarray(12, 28);
  const ciphertext = t.subarray(28);
  const key = crypto.createHash('sha256').update(EM, 'utf8').digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const k = out.toString('utf8').trim();
  if (!k) throw new Error('empty rotating key');
  return k;
}

// Decrypt a single stream `link` with the rotating key. Returns a URL or null.
function decryptLink(link, key) {
  try {
    if (typeof link !== 'string' || !link) return null;
    if (/^https?:\/\//i.test(link)) return link.trim(); // already plain
    const raw = Buffer.from(link, 'base64').toString('binary');
    const idx = raw.indexOf(':');
    if (idx < 0) return null;
    const iv = Buffer.from(raw.slice(0, idx), 'base64');
    if (iv.length !== 16) return null; // AES-CBC IV must be 16 bytes
    const ciphertext = Buffer.from(raw.slice(idx + 1), 'base64');
    const keyBuf = Buffer.alloc(32);
    Buffer.from(String(key), 'utf8').copy(keyBuf);
    const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
    const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (!/^https?:\/\//i.test(out)) return null;
    return out.trim();
  } catch {
    return null;
  }
}

// --- Networked helpers ---

async function fetchRotatingKey() {
  const resp = await axios.get(API_KEY_URL, {
    headers: { 'User-Agent': UA, Referer: `${EMBED_ORIGIN}/` },
    timeout: 12000,
    responseType: 'text',
    transformResponse: [(d) => d],
  });
  return decryptApiKeyBlob(resp.data);
}

// Rotating key with a short in-memory TTL. `force` bypasses the cache.
async function getRotatingKey(force = false) {
  const now = Date.now();
  if (!force && cachedKey && now - cachedKeyAt < KEY_TTL_MS) return cachedKey;
  cachedKey = await fetchRotatingKey();
  cachedKeyAt = now;
  return cachedKey;
}

async function fetchServer({ tmdbId, type, season, episode, sr }) {
  let url = `${SERVER_API_BASE}?id=${encodeURIComponent(tmdbId)}&sr=${sr}`;
  if (type === 'tv') {
    url += `&ss=${encodeURIComponent(season)}&ep=${encodeURIComponent(episode)}`;
  }
  const referer = `${EMBED_ORIGIN}/embed/${type}/${tmdbId}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: referer },
    timeout: 9000,
  });
  return resp.data;
}

function decryptItems(items, key, sr, data) {
  const out = [];
  for (const it of items) {
    const url = decryptLink(it.link, key);
    if (!url) continue;
    out.push({
      sr,
      name: it.name || data.provider || 'VidZee',
      language: it.lang || (data.serverInfo && data.serverInfo.language) || 'unknown',
      type: it.type || 'hls',
      url,
    });
  }
  return out;
}

// Resolve decrypted streams from a single VidZee server. Returns [] on failure.
async function getServerStreams(opts) {
  let data;
  try {
    data = await fetchServer(opts);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const items = Array.isArray(data.url) ? data.url : data.link ? [data] : [];
  if (!items.length) return [];

  let key = await getRotatingKey();
  let streams = decryptItems(items, key, opts.sr, data);
  if (!streams.length) {
    // Links present but none decrypted -> key may have rotated; retry once.
    key = await getRotatingKey(true);
    streams = decryptItems(items, key, opts.sr, data);
  }
  return streams;
}

// Resolve decrypted streams across many servers (used by the aggregator provider).
async function getAllStreams({ tmdbId, type, season, episode, servers = DEFAULT_SERVERS }) {
  const nested = await Promise.all(
    servers.map((sr) => getServerStreams({ tmdbId, type, season, episode, sr })),
  );
  return nested.flat();
}

module.exports = {
  EM,
  UA,
  STREAM_REFERER,
  DEFAULT_SERVERS,
  decryptApiKeyBlob,
  decryptLink,
  getRotatingKey,
  getServerStreams,
  getAllStreams,
};
