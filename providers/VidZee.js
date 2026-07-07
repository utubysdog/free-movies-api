// VidZee provider: resolves streams for a TMDB id via VidZee.
// Link decryption + server resolution live in ./vidzeeCrypto (VidZee rotated
// their old AES-CBC "qrincywincyspider" scheme; the new GCM+CBC chain is there).

const { getAllStreams, STREAM_REFERER } = require('./vidzeeCrypto');

const getVidZeeStreams = async (tmdbId, mediaType, seasonNum, episodeNum) => {
  if (!tmdbId) {
    console.error('[VidZee] Error: TMDB ID (tmdbId) is required.');
    return [];
  }

  if (!mediaType || (mediaType !== 'movie' && mediaType !== 'tv')) {
    console.error('[VidZee] Error: mediaType is required and must be either "movie" or "tv".');
    return [];
  }

  if (mediaType === 'tv') {
    if (!seasonNum) {
      console.error('[VidZee] Error: Season (seasonNum) is required for TV shows.');
      return [];
    }
    if (!episodeNum) {
      console.error('[VidZee] Error: Episode (episodeNum) is required for TV shows.');
      return [];
    }
  }

  let resolved = [];
  try {
    resolved = await getAllStreams({
      tmdbId,
      type: mediaType,
      season: seasonNum,
      episode: episodeNum,
    });
  } catch (e) {
    console.error('[VidZee] Error resolving streams:', e.message);
    return [];
  }

  const streams = resolved.map((s) => {
    // VidZee no longer exposes a reliable quality label; default to 720p.
    const quality = '720p';
    return {
      name: `VidZee Server${s.sr} - ${quality} - ${s.language}`,
      title: `VidZee Server${s.sr} - ${quality} - ${s.language}`,
      url: s.url,
      quality,
      provider: 'VidZee',
      headers: { Referer: STREAM_REFERER },
    };
  });

  console.log(`[VidZee] Found a total of ${streams.length} streams.`);
  return streams;
};

module.exports = { getVidZeeStreams };
