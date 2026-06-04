const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors());
app.use(express.json());

const NERV_API = 'http://127.0.0.1:3000/api';
const PORT     = 5000;

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// 1. SEARCH
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const url = `${NERV_API}/anizone/anime/search?q=${encodeURIComponent(q)}`;
  console.log(`[SEARCH] -> ${url}`);
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return res.status(response.status).json({ error: 'Search failed' });
    const data = await response.json();
    const results = data.data || data.results || data || [];
    console.log(`[SEARCH] ${results.length} results for "${q}"`);
    res.json(results);
  } catch (err) {
    console.error('[SEARCH]', err.message);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Timeout' });
    res.status(503).json({ error: 'NervHQ unreachable' });
  }
});

// 2. RECENT
app.get('/api/recent', async (req, res) => {
  const url = `${NERV_API}/anizone/anime/recent`;
  console.log(`[RECENT] -> ${url}`);
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return res.status(response.status).json([]);
    const data = await response.json();
    res.json(data.data || data || []);
  } catch (err) {
    console.error('[RECENT]', err.message);
    res.status(503).json([]);
  }
});

// 3. ANIME INFO + EPISODES
app.get('/api/anime/:id', async (req, res) => {
  const id = req.params.id;
  const url = `${NERV_API}/anizone/anime/${encodeURIComponent(id)}`;
  console.log(`[ANIME] -> ${url}`);
  try {
    const response = await fetchWithTimeout(url, {}, 20000);
    if (!response.ok) return res.status(response.status).json({ error: 'Anime info failed' });
    const data = await response.json();
    console.log(`[ANIME] episodes: ${data.providerEpisodes?.length ?? 0}`);
    res.json(data);
  } catch (err) {
    console.error('[ANIME]', err.message);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Timeout' });
    res.status(503).json({ error: 'NervHQ unreachable' });
  }
});

// 4. SOURCES
app.get('/api/sources/:episodeId', async (req, res) => {
  const episodeId = req.params.episodeId;
  const url = `${NERV_API}/anizone/sources/${encodeURIComponent(episodeId)}`;
  console.log(`[SOURCES] -> ${url}`);
  try {
    const response = await fetchWithTimeout(url, {}, 20000);
    if (!response.ok) return res.status(response.status).json({ sources: [], subtitles: [] });
    const data = await response.json();
    const sources   = data.data?.sources   || data.sources   || [];
    const subtitles = data.data?.subtitles || data.subtitles || [];
    console.log(`[SOURCES] ${sources.length} sources`);
    res.json({ sources, subtitles });
  } catch (err) {
    console.error('[SOURCES]', err.message);
    if (err.name === 'AbortError') return res.status(504).json({ sources: [], subtitles: [] });
    res.status(503).json({ sources: [], subtitles: [] });
  }
});

// ─── PROXY HELPER ────────────────────────────
// Resolves a URL that may be relative against a base URL
function resolveUrl(href, base) {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) {
    const u = new URL(base);
    return u.origin + href;
  }
  // relative path
  return base.substring(0, base.lastIndexOf('/') + 1) + href;
}

// Rewrites a single m3u8 line so all URLs go through /api/proxy
function rewriteLine(line, baseUrl) {
  const trimmed = line.trim();
  if (!trimmed) return line;

  // #EXT-X-KEY URI rewrite  e.g. URI="https://..." or URI="/keys/xxx.key"
  if (trimmed.startsWith('#EXT-X-KEY')) {
    return trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
      const abs = resolveUrl(uri, baseUrl);
      return `URI="http://localhost:${PORT}/api/proxy?url=${encodeURIComponent(abs)}"`;
    });
  }

  // #EXT-X-MEDIA URI rewrite (audio/subtitle tracks)
  if (trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('URI="')) {
    return trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
      const abs = resolveUrl(uri, baseUrl);
      return `URI="http://localhost:${PORT}/api/proxy?url=${encodeURIComponent(abs)}"`;
    });
  }

  // Skip other # directives
  if (trimmed.startsWith('#')) return line;

  // Segment / sub-playlist URL
  const abs = resolveUrl(trimmed, baseUrl);
  return `http://localhost:${PORT}/api/proxy?url=${encodeURIComponent(abs)}`;
}

// 5. UNIVERSAL PROXY — handles m3u8, .ts segments, .key files, audio playlists
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  const decoded = decodeURIComponent(url);
  console.log(`[PROXY] -> ${decoded}`);

  try {
    const response = await fetchWithTimeout(decoded, {
      headers: {
        'Referer':    'https://anizone.to/',
        'Origin':     'https://anizone.to',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, 20000);

    if (!response.ok) {
      console.error(`[PROXY] upstream ${response.status} for ${decoded}`);
      return res.status(response.status).send(`Upstream error ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*');

    const isM3u8 = decoded.includes('.m3u8') || contentType.includes('mpegurl');

    if (isM3u8) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const text = await response.text();
      const rewritten = text.split('\n').map(line => rewriteLine(line, decoded)).join('\n');
      console.log(`[PROXY] rewrote m3u8 (${text.split('\n').length} lines)`);
      return res.send(rewritten);
    }

    // Binary: .ts segments, .key files, images
    const ct = contentType || (decoded.includes('.key') ? 'application/octet-stream' : 'video/mp2t');
    res.setHeader('Content-Type', ct);
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.error('[PROXY]', err.message);
    res.status(500).send('Proxy fetch failed');
  }
});

// Keep old /api/proxy/m3u8 route as alias so any cached requests still work
app.get('/api/proxy/m3u8', (req, res) => {
  res.redirect(307, `/api/proxy?url=${req.query.url}`);
});

// HEALTH CHECK
app.get('/api/health', async (req, res) => {
  let nervStatus = 'unknown';
  try {
    const r = await fetchWithTimeout(`${NERV_API}/anizone/anime/search?q=test`, {}, 5000);
    nervStatus = r.ok ? 'online' : `error:${r.status}`;
  } catch {
    nervStatus = 'offline';
  }
  res.json({ bridge: 'online', nerv: nervStatus, provider: 'anizone', port: PORT, ts: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║         ANIWATCH BRIDGE ONLINE           ║
║   http://localhost:${PORT}                  ║
║   Provider : Anizone via NervHQ :3000    ║
╚══════════════════════════════════════════╝
  `);
});
