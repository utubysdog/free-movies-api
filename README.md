# 🍿 TMDB Embed API — VidZee fork

> Give it a TMDB id, get back a playable stream — or the movie itself as an MP4.

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-brightgreen?style=flat" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat" />
  <img src="https://img.shields.io/badge/Version-1.0.11-informational?style=flat" />
  <img src="https://img.shields.io/badge/ffmpeg-required-orange?style=flat" />
</p>

A fork of [neilbauman21-hub/free-moveis-api](https://github.com/neilbauman21-hub/free-moveis-api) that has drifted a long way from upstream in two respects:

1. Works out of the box (at least with openSUSE Tumbleweed 20261014)

2. Has rife interpolation support

---

## 🧭 The two servers

This repo runs two independent processes. You can run either on its own.

| | `apiServer.js` | `vidzee-mp4.js` |
|---|---|---|
| **Default port** | `8787` | `6150` |
| **Returns** | JSON list of stream URLs | the video itself, as `video/mp4` |
| **Start** | `npm start` | `npm run start:mp4` |
| **Needs ffmpeg** | no | **yes** |
| **Admin UI** | yes, at `/` | no |
| **Use it for** | feeding a player/addon that wants source URLs | watching or downloading directly |

---

## 📦 Requirements

- **Node.js 18+**
- **ffmpeg + ffprobe** on `PATH` — only for the MP4 API. Ubuntu/Debian: `sudo apt install ffmpeg`
```bash
zypper in ffmpeg
```
- A **TMDB API key** is optional; VidZee is keyed by TMDB id but needs no key of your own.
  Keys only matter for the IMDb resolution and the (dead) Showbox provider.

```bash
npm install
```

---

## 🎬 MP4 / Download API (`:6150`)

The centerpiece of this fork. Resolves a VidZee source, then remuxes its HLS stream into
a fragmented MP4.

```bash
npm run start:mp4          # or: node vidzee-mp4.js
```

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /movie/<tmdbId>` | the movie as `video/mp4` |
| `GET /tv/<tmdbId>/<season>/<episode>` | the episode as `video/mp4` |
| `GET /health` | `{ ok: true, service: "vidzee-mp4" }` |

| Query         | Purpose                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `?download=1` | send `Content-Disposition: attachment` — saves instead of playing in-browser |
| `?sr=<name>`  | force a specific VidZee server instead of auto-selecting                     |
| `?rife=1`     | use rife interpolation at 40FPS                                              |

### Examples

```bash
# Stream Fight Club in your player
vlc http://localhost:6150/movie/550

# Save it to disk (filename comes from Content-Disposition)
curl -OJ "http://localhost:6150/movie/550?download=1"

# Breaking Bad S01E01
mpv http://localhost:6150/tv/1396/1/1

# Force a particular source
curl -o out.mp4 "http://localhost:6150/movie/550?sr=dcloud"
```

Or just open `http://localhost:6150/movie/550` in a browser and it plays inline.

### How a source gets picked

1. Walk VidZee's servers in order — `dcloud`, `tik`, `ipcloud`, `v6:Hindi` — with the
   Hindi dub last so English wins when it's available. `?sr=` skips straight to one.
2. For each candidate, **probe that it's actually playable**: fetch the playlist, follow a
   master playlist to its first media segment, and sniff the magic bytes. This is not
   paranoia — the `ipcloud` server wraps its MPEG-TS segments in a 70-byte 1×1 PNG header,
   which ffmpeg decodes as a still image before aborting with *"Output file does not
   contain any stream"*. Image-wrapped sources are skipped.
3. Use the first English source that passes; otherwise fall back to the first playable
   source in any language.

Servers come and go per title — a dead one answers `502`, and it's normal for only one or
two of the four to work for any given film.

### Errors

| Status | Meaning |
|--------|---------|
| `400` | non-numeric tmdbId, or a TV request missing season/episode |
| `404` | no server produced a playable source |
| `502` | a source was selected but ffmpeg couldn't remux it |

### Known limitations

- **Seeking is limited.** The output is a live fragmented-MP4 pipe with no known total
  length. Playback from the start and full downloads work; scrubbing to an arbitrary
  position is unreliable. True seeking would mean producing the whole file first.
- One `ffmpeg` process per active stream. Fine for personal use, not a public service.
- Clients that abort get their `ffmpeg` child killed, so no orphans accumulate.

### Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `MP4_PORT` | `6150` | listen port |
| `MP4_HOST` | `0.0.0.0` | bind address |

---

## 📡 Aggregator API (`:8787`)

The inherited upstream server: queries every enabled provider in parallel and returns a
merged, filtered list of stream URLs as JSON. In this fork that means "returns VidZee's
streams", since nothing else resolves.

```bash
npm start                  # nodemon, restarts on the admin-UI restart button
node apiServer.js          # plain single run
```

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | heartbeat |
| `GET /api/metrics` | runtime counters |
| `GET /api/status` | metrics + providers + endpoint list |
| `GET /api/providers` | provider list |
| `GET /api/providers/:name` | single provider status |
| `GET /api/streams/:type/:tmdbId` | aggregate streams (`type` = `movie` \| `series`) |
| `GET /api/streams/:provider/:type/:tmdbId` | one provider only |
| `GET /api/config` | `{ merged, override }` — **requires a session** |
| `POST /api/config` | apply an override patch — **requires a session** |
| `POST /api/restart` | restart the process — **requires a session** |

TV uses `?season=` and `?episode=`:

```bash
curl "http://localhost:8787/api/streams/movie/550"
curl "http://localhost:8787/api/streams/series/1396?season=1&episode=1"
curl "http://localhost:8787/api/streams/vidzee/movie/550"
```

### Stream object

```json
{
  "name":  "VidZee dcloud - 720p - Auto",
  "title": "VidZee dcloud - 720p - Auto",
  "url":   "https://cdn2.1shows.app/movie/…/index.m3u8",
  "quality": "720p",
  "provider": "VidZee",
  "headers": { "Referer": "https://player.vidzee.wtf/" }
}
```

> The `headers` must be sent when fetching `url`, or the CDN returns `403`.
> When `enableProxy` is on, URLs are rewritten through the internal proxy and `headers`
> is omitted (the proxy applies them for you).

### Admin UI

Served at `/` behind a login. Provider toggles, TMDB keys, quality/codec filters, live
metrics and a merged-config view. Inherited from upstream and unchanged.

<p align="center">
  <img src="screenshots/Screenshot 2025-09-16 174931.png" width="46%" />
  <img src="screenshots/Screenshot 2025-09-16 175020.png" width="46%" />
</p>

---

## 🔌 Providers

Providers are declared in **`providers/catalog.js`** — the single source of truth for
which modules are providers and what each exports. `providers/registry.js` (runtime wiring) and
`utils/config.js` (enable flags) both read from it.

| Provider | Status |
|----------|--------|
| `vidzee` | ✅ **working** — the only one that returns streams |
| `4khdhub` | ⚠️ inherited, returns nothing |
| `moviesmod` | ⚠️ inherited, returns nothing |
| `mp4hydra` | ⚠️ inherited, returns nothing |
| `uhdmovies` | ⚠️ inherited, returns nothing |
| `vixsrc` | ⚠️ inherited, returns nothing |
| `showbox` | ⚠️ inherited; also needs a FebBox cookie, which isn't configured |

The dead ones are left enabled because they fail fast and harmlessly (a failing provider
can't break an aggregate request). Turn them off in the Advanced panel to shave a few
hundred ms off each call.

### Adding a provider

1. Create `providers/yourprovider.js` exporting
   `getYourproviderStreams(tmdbId, mediaType, season, episode)`.
2. Declare it in `providers/catalog.js`:
   ```js
   { name: 'yourprovider', file: 'yourprovider.js', export: 'getYourproviderStreams' },
   ```
3. It appears in the admin UI with a toggle and gets an `enableYourproviderProvider` flag,
   defaulting to enabled.

Return the unified stream shape shown above, or filtering and aggregation won't apply.

> Registration is explicit on purpose. The catalog used to be inferred by scanning
> `providers/*.js` minus a deny-list, so any helper module dropped in the folder became a
> phantom provider — `providers/vidzeeCrypto.js` showed up in `/api/providers`, gained a config
> flag, and errored on every aggregate request.

---

## 🔓 How the VidZee provider works

VidZee rotates its scheme every few months, and each rotation breaks this fork. The
current (2026-08) shape, in `providers/vidzeeCrypto.js`:

```
GET core.vidzee.wtf/streams/movie/<tmdbId>?s=<server>&e=<0|1>
GET core.vidzee.wtf/streams/tv/<tmdbId>/<season>/<episode>?s=<server>&e=<0|1>
```

`e` selects the response encoding, and it's the client's choice:

- `e=1` → `{"c":"<blob>"}`, which the browser player decrypts in WebAssembly
- `e=0` → `{"url":"…","language":"…","headers":{}}` in plaintext

So this fork asks for `e=0` and skips the crypto entirely. Servers are named ids
(`dcloud`, `tik`, `ipcloud`, `v6:Hindi`), not the numbers `1..10` older versions used.

Stream requests need `Referer: https://player.vidzee.wtf/` — the *player* origin.
`cdn1.1shows.app` returns `403` for the older `core.vidzee.wtf` value.

**When it breaks again:** the endpoints will start returning `404`. Pull
`player.vidzee.wtf/embed/movie/550`, grab the `/assets/*.js` bundles it preloads, and look
in the lazy `Ads-*.js` chunk — that's where the stream fetch lives. It's packed with
obfuscator.io's RC4 string table, so you'll need to eval the decoder to read it. Check for
a plaintext opt-out like `e=0` before reimplementing any crypto. The constants to update
all sit at the top of `providers/vidzeeCrypto.js`.

---

## 🛠 Configuration

Environment variables provide defaults; `utils/user-config.json` overrides them; the
result is mirrored back into `process.env` so older provider code sees the same values.
The admin UI writes only changed keys — clearing a field removes the override.

Start from the template:

```bash
cp utils/user-config.example.json utils/user-config.json
```

| Variable | Purpose | Notes |
|----------|---------|-------|
| `API_PORT` | aggregator port | default `8787` |
| `MP4_PORT` | MP4 API port | default `6150` |
| `TMDB_API_KEY` | single TMDB key (legacy) | optional |
| `TMDB_API_KEYS` | JSON array of keys | rotated randomly; overrides the single key |
| `BIND_HOST` | aggregator bind address | default `0.0.0.0` |

> Upstream's README also lists `ADMIN_USERNAME` and `PASSWORD_HASH`. Neither is read by
> any code in this repo — the admin user is hardcoded to `admin` and created on first
> start. They're omitted here rather than documented as working.

### Quality & codec filtering

Presets `all`, `480p`, `720p`, `1080p`, `1440p`, `2160p`, or per-provider JSON:

```json
{ "default": "900p", "4khdhub": "1080p" }
{ "excludeDV": true, "excludeHDR": false }
```

### Optional proxy layer

`enableProxy` mounts `/m3u8-proxy`, `/ts-proxy` and `/sub-proxy`, and rewrites stream URLs
through them so playlists, segments and subtitles are served with uniform headers. Off by
default. `/ts-proxy` accepts range-negotiation flags (`clampOpen`, `openChunkKB`,
`progressiveOpen`, `initChunkKB`, `noSynth`, `force200`, `tailPrefetch`, `tailPrefetchKB`)
— see `proxy/proxyServer.js` for the details and defaults.

---

## 🔐 Authentication & security

The aggregator's root (`/`) serves a login page; a successful login issues an HttpOnly
`session` cookie valid 12h. Repeated failures trigger exponential lockouts with a
`Retry-After` header.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/auth/login` | POST | `{ username, password }` |
| `/auth/logout` | POST | destroy session |
| `/auth/session` | GET | check session status |
| `/auth/change-password` | POST | requires a session; min 8 characters |

- **Change the default password.** First start creates `admin` / `change-me` in
  `utils/auth-users.json`. That file isn't committed, but any deployment left on the
  default is wide open.
- `/api/config`, `/api/debug/env` and `/api/restart` require a session — they expose TMDB
  keys and accept writes.
- `utils/auth-users.json`, `utils/user-config.json` and `.env` are gitignored: they hold
  per-deployment credentials and state.

> **Neither server authenticates its stream endpoints**, and the MP4 API has no auth at
> all. Don't expose either to the public internet — keep them on a LAN or VPN, or behind a
> reverse proxy that requires auth.

---

## 🚀 Deployment

### systemd (the MP4 API)

`run.sh` installs a `movapi` service that runs `vidzee-mp4.js` on `:6150`. It's
idempotent — re-run it to update the unit and restart.

```bash
sudo bash run.sh          # install + enable + start
bash run.sh --dry-run     # print what it would do, no root needed
```

It resolves `node` through the invoking user's login shell (so nvm works), verifies
ffmpeg is present, and runs as the invoking user rather than root.

```bash
systemctl status movapi
journalctl -u movapi -f
```

### Docker (the aggregator)

```bash
docker build -t tmdb-embed-api .
docker run --name tmdb-embed -p 8787:8787 \
  -v "$(pwd)/utils/user-config.json:/app/utils/user-config.json" \
  tmdb-embed-api
```

Or `docker compose up -d --build`. Mounting `utils/user-config.json` persists admin-UI settings
across restarts. The container healthcheck hits `GET /api/health`.

The Dockerfile builds the aggregator only — it doesn't include ffmpeg, so the MP4 API
won't run in it unmodified.

### Notes

| Aspect | Recommendation |
|--------|---------------|
| Node | 18+ LTS |
| TLS | terminate at nginx and forward to the API port |
| Persistence | mount `utils/user-config.json` |
| Scaling | single instance; the MP4 API is one ffmpeg process per stream |

---

## 🧪 Tests

```bash
npm test      # node --test
npm run lint  # eslint
```

25 tests, no network required. They cover VidZee URL construction and response
normalisation, the provider catalog's integrity (every catalogued export exists; helpers
aren't providers), config normalisation, and the playability heuristics that keep
PNG-wrapped sources away from ffmpeg.

---

## 💡 Troubleshooting

| Symptom | Cause / fix |
|---------|------------|
| `Cannot find module 'express'` | `npm install` hasn't been run in this directory |
| MP4 API returns `404 no playable source` | every VidZee server is down or blocked for that title; try `?sr=` to test individually |
| MP4 API returns `502 remux failed` | a source was picked but ffmpeg couldn't open it — check ffmpeg is installed |
| Aggregate returns `count: 0` | expected for titles VidZee doesn't have; the other providers return nothing |
| Streams give `403` when fetched | you dropped the `headers` from the stream object — `Referer` is required |
| `/api/config` returns `401` | log in first; it's session-gated |
| Everything 404s from VidZee | they rotated again — see [How the VidZee provider works](#-how-the-vidzee-provider-works) |

