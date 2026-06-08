/**
 * ANIWATCH — server.js (production)
 * Multi-provider bridge + MAL OAuth + static frontend
 */

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const path     = require('path');
const app      = express();

app.use(cors({ origin: (origin, callback) => callback(null, true), credentials: true }));
app.use(express.json());

// Cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) header.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    req.cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  next();
});

const NERV_API     = process.env.NERV_API     || 'http://127.0.0.1:3000/api';
const PUBLIC_URL   = process.env.PUBLIC_URL   || 'http://localhost:5000';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
const PORT         = process.env.PORT         || 5000;
const MAL_CLIENT_ID     = process.env.MAL_CLIENT_ID     || '2ecebbcdee03d3687f5070e852f751dc';
const MAL_CLIENT_SECRET = process.env.MAL_CLIENT_SECRET || '';
const MAL_REDIRECT = `${PUBLIC_URL}/auth/mal/callback`;
const MAL_API      = 'https://api.myanimelist.net/v2';
const MAL_AUTH     = 'https://myanimelist.net/v1/oauth2';

const pkceStore = {};

async function fetchT(url, options = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { ...options, signal: ctrl.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

// ─── PROVIDER CONFIG ─────────────────────────
const PROVIDERS = {
  anizone: {
    prefix:      'anizone',
    episodeMode: 'bundled',
    searchMap:   d => (d.data||[]).map(a => ({ id:a.id, name:a.name, poster:a.posterImage, type:a.type, year:a.releaseDate })),
    recentRoute: 'anime/recent',
    recentMap:   d => d.data||d||[],
    infoMap:     d => ({ info:d.data||{}, episodes:d.providerEpisodes||[] }),
    // KEY FIX: episodeId from Anizone is already the full ID like "sousou-no-frieren-mdkytdqp-episode-1"
    episodeMap:  ep => ({ id: ep.episodeId, number: ep.episodeNumber, title: ep.title }),
    sourcesRoute:(epId, ver) => `sources/${encodeURIComponent(epId)}?version=${ver}`,
    sourcesMap:  d => ({ sources: d.data?.sources||d.sources||[], subtitles: d.data?.subtitles||d.subtitles||[] }),
  },
  hianime: {
    prefix:      'hianime',
    episodeMode: 'separate',
    searchMap:   d => (d.data||[]).map(a => ({ id:a.id, name:a.name||a.title, poster:a.poster||a.posterImage, type:a.type })),
    recentRoute: 'anime/recent/updated',
    recentMap:   d => d.data||d||[],
    infoMap:     d => ({ info:d.data||{}, episodes:[] }),
    episodeMap:  ep => ({ id: ep.episodeId||ep.id, number: ep.number||ep.episodeNumber, title: ep.title }),
    sourcesRoute:(epId, ver) => `sources/${encodeURIComponent(epId)}?version=${ver}&server=megacloud`,
    sourcesMap:  d => ({ sources: d.data?.sources||d.sources||[], subtitles: d.data?.subtitles||d.subtitles||[] }),
  },
  kaido: {
    prefix:      'kaido',
    episodeMode: 'separate',
    searchMap:   d => (d.data||[]).map(a => ({ id:a.id, name:a.name||a.title, poster:a.poster||a.posterImage, type:a.type })),
    recentRoute: 'anime/recent/updated',
    recentMap:   d => d.data||d||[],
    infoMap:     d => ({ info:d.data||{}, episodes:[] }),
    episodeMap:  ep => ({ id: ep.episodeId||ep.id, number: ep.number||ep.episodeNumber, title: ep.title }),
    sourcesRoute:(epId, ver) => `sources/${encodeURIComponent(epId)}?version=${ver}&server=vidcloud`,
    sourcesMap:  d => ({ sources: d.data?.sources||d.sources||[], subtitles: d.data?.subtitles||d.subtitles||[] }),
  },
};

function getProvider(name) { return PROVIDERS[name] || PROVIDERS.anizone; }

// ─── API ROUTES (must come BEFORE static middleware) ─────────────────────────

app.get('/api/health', async (req, res) => {
  let nervStatus = 'unknown';
  try {
    const r = await fetchT(`${NERV_API}/anizone/anime/search?q=test`, {}, 5000);
    nervStatus = r.ok ? 'online' : `error:${r.status}`;
  } catch { nervStatus = 'offline'; }
  res.json({ bridge:'online', nerv:nervStatus, port:PORT, env:PUBLIC_URL.includes('railway')?'production':'local', ts:new Date().toISOString() });
});

app.get('/api/search', async (req, res) => {
  const { q, provider='anizone' } = req.query;
  if (!q) return res.json([]);
  const p = getProvider(provider);
  const url = `${NERV_API}/${p.prefix}/anime/search?q=${encodeURIComponent(q)}`;
  console.log(`[SEARCH:${provider}] -> ${url}`);
  try {
    const r = await fetchT(url);
    if (!r.ok) return res.status(r.status).json({ error:'Search failed' });
    const d = await r.json();
    res.json(p.searchMap(d));
  } catch(e) { console.error('[SEARCH]',e.message); res.status(503).json({ error:'NervHQ unreachable' }); }
});

app.get('/api/recent', async (req, res) => {
  const { provider='anizone' } = req.query;
  const p = getProvider(provider);
  const url = `${NERV_API}/${p.prefix}/${p.recentRoute}`;
  console.log(`[RECENT:${provider}] -> ${url}`);
  try {
    const r = await fetchT(url);
    if (!r.ok) return res.json([]);
    const d = await r.json();
    res.json(p.recentMap(d));
  } catch(e) { res.status(503).json([]); }
});

app.get('/api/anime/:id', async (req, res) => {
  const { provider='anizone' } = req.query;
  const p = getProvider(provider);
  const id = req.params.id;
  const url = `${NERV_API}/${p.prefix}/anime/${encodeURIComponent(id)}`;
  console.log(`[ANIME:${provider}] -> ${url}`);
  try {
    const r = await fetchT(url, {}, 20000);
    if (!r.ok) return res.status(r.status).json({ error:'Anime info failed' });
    const d    = await r.json();
    const norm = p.infoMap(d);
    if (p.episodeMode === 'separate') {
      try {
        const er = await fetchT(`${NERV_API}/${p.prefix}/anime/${encodeURIComponent(id)}/episodes`, {}, 20000);
        const ed = await er.json();
        norm.episodes = (ed.data||ed||[]).map(p.episodeMap);
      } catch { norm.episodes = []; }
    } else {
      norm.episodes = norm.episodes.map(p.episodeMap);
    }
    console.log(`[ANIME:${provider}] episodes: ${norm.episodes.length}`);
    res.json(norm);
  } catch(e) { console.error('[ANIME]',e.message); res.status(503).json({ error:'NervHQ unreachable' }); }
});

app.get('/api/sources/:episodeId', async (req, res) => {
  const { provider='anizone', version='sub' } = req.query;
  const p     = getProvider(provider);
  const epId  = req.params.episodeId;
  const route = p.sourcesRoute(epId, version);
  const url   = `${NERV_API}/${p.prefix}/${route}`;
  console.log(`[SOURCES:${provider}] -> ${url}`);
  try {
    const r = await fetchT(url, {}, 20000);
    if (!r.ok) return res.json({ sources:[], subtitles:[] });
    const d      = await r.json();
    const result = p.sourcesMap(d);
    console.log(`[SOURCES:${provider}] ${result.sources.length} sources`);
    res.json(result);
  } catch(e) { console.error('[SOURCES]',e.message); res.status(503).json({ sources:[], subtitles:[] }); }
});

// ─── HLS PROXY ───────────────────────────────
function resolveUrl(href, base) {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) { const u = new URL(base); return u.origin + href; }
  return base.substring(0, base.lastIndexOf('/')+1) + href;
}

function rewriteLine(line, baseUrl) {
  const t = line.trim();
  if (!t) return line;
  if (t.startsWith('#EXT-X-KEY') || (t.startsWith('#EXT-X-MEDIA') && t.includes('URI="'))) {
    return t.replace(/URI="([^"]+)"/, (_, uri) => {
      const abs = resolveUrl(uri, baseUrl);
      return `URI="${PUBLIC_URL}/api/proxy?url=${encodeURIComponent(abs)}"`;
    });
  }
  if (t.startsWith('#')) return line;
  const abs = resolveUrl(t, baseUrl);
  return `${PUBLIC_URL}/api/proxy?url=${encodeURIComponent(abs)}`;
}

app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  const decoded = decodeURIComponent(url);
  try {
    const r = await fetchT(decoded, {
      headers: { 'Referer':'https://anizone.to/', 'Origin':'https://anizone.to', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, 20000);
    if (!r.ok) return res.status(r.status).send(`Upstream ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (decoded.includes('.m3u8') || ct.includes('mpegurl')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const text = await r.text();
      return res.send(text.split('\n').map(l => rewriteLine(l, decoded)).join('\n'));
    }
    res.setHeader('Content-Type', ct || (decoded.includes('.key') ? 'application/octet-stream' : 'video/mp2t'));
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch(e) { res.status(500).send('Proxy failed'); }
});

// ─── MAL OAUTH ───────────────────────────────
function base64url(buf) { return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
function generateVerifier() { return base64url(crypto.randomBytes(32)); }
function generateChallenge(v) { return base64url(crypto.createHash('sha256').update(v).digest()); }

app.get('/auth/mal/login', (req, res) => {
  const verifier  = generateVerifier();
  const challenge = generateChallenge(verifier);
  const state     = base64url(crypto.randomBytes(16));
  pkceStore[state] = verifier;
  setTimeout(() => delete pkceStore[state], 10*60*1000);
  const params = new URLSearchParams({
    response_type:'code', client_id:MAL_CLIENT_ID,
    redirect_uri:MAL_REDIRECT, state,
    code_challenge:challenge, code_challenge_method:'S256',
  });
  res.redirect(`${MAL_AUTH}/authorize?${params}`);
});

app.get('/auth/mal/callback', async (req, res) => {
  const { code, state } = req.query;
  const verifier = pkceStore[state];
  if (!verifier) return res.status(400).send('Invalid state. Try logging in again.');
  delete pkceStore[state];
  try {
    const body = new URLSearchParams({
      client_id:MAL_CLIENT_ID, grant_type:'authorization_code',
      code, redirect_uri:MAL_REDIRECT, code_verifier:verifier,
    });
    if (MAL_CLIENT_SECRET) body.append('client_secret', MAL_CLIENT_SECRET);
    const r = await fetchT(`${MAL_AUTH}/token`, {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:body.toString(),
    });
    if (!r.ok) { const err=await r.text(); console.error('[MAL] Token error:',err); return res.status(400).send('MAL auth failed: '+err); }
    const tokens = await r.json();
    const secure = PUBLIC_URL.startsWith('https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `mal_access_token=${tokens.access_token}; HttpOnly; SameSite=Lax; Max-Age=${tokens.expires_in||3600}; Path=/${secure}`,
      `mal_refresh_token=${tokens.refresh_token}; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*30}; Path=/${secure}`,
    ]);
    res.redirect(FRONTEND_URL);
  } catch(e) { console.error('[MAL] Callback error:',e.message); res.status(500).send('Internal error.'); }
});

app.post('/auth/mal/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    'mal_access_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/',
    'mal_refresh_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/',
  ]);
  res.json({ ok:true });
});

app.get('/auth/mal/status', async (req, res) => {
  const token = req.cookies.mal_access_token;
  if (!token) return res.json({ loggedIn:false });
  try {
    const r = await fetchT(`${MAL_API}/users/@me?fields=name,picture`, { headers:{ Authorization:`Bearer ${token}` } });
    if (!r.ok) return res.json({ loggedIn:false });
    const user = await r.json();
    res.json({ loggedIn:true, name:user.name, picture:user.picture });
  } catch { res.json({ loggedIn:false }); }
});

async function refreshToken(req, res) {
  const refresh = req.cookies.mal_refresh_token;
  if (!refresh) return null;
  try {
    const body = new URLSearchParams({ client_id:MAL_CLIENT_ID, grant_type:'refresh_token', refresh_token:refresh });
    if (MAL_CLIENT_SECRET) body.append('client_secret', MAL_CLIENT_SECRET);
    const r = await fetchT(`${MAL_AUTH}/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString() });
    if (!r.ok) return null;
    const tokens = await r.json();
    const secure = PUBLIC_URL.startsWith('https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `mal_access_token=${tokens.access_token}; HttpOnly; SameSite=Lax; Max-Age=${tokens.expires_in||3600}; Path=/${secure}`,
      `mal_refresh_token=${tokens.refresh_token}; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*30}; Path=/${secure}`,
    ]);
    return tokens.access_token;
  } catch { return null; }
}

app.get('/api/mal/anime/:malId', async (req, res) => {
  let token = req.cookies.mal_access_token;
  if (!token) return res.json({ listed:false });
  try {
    let r = await fetchT(`${MAL_API}/anime/${req.params.malId}?fields=my_list_status,num_episodes,title,mean`, { headers:{ Authorization:`Bearer ${token}` } });
    if (r.status===401) { token=await refreshToken(req,res); if(!token) return res.json({listed:false}); r=await fetchT(`${MAL_API}/anime/${req.params.malId}?fields=my_list_status,num_episodes,title,mean`,{headers:{Authorization:`Bearer ${token}`}}); }
    if (!r.ok) return res.json({ listed:false });
    const data = await r.json();
    res.json({ listed:!!data.my_list_status, status:data.my_list_status?.status||null, score:data.my_list_status?.score||0, progress:data.my_list_status?.num_episodes_watched||0, total:data.num_episodes||0, title:data.title, mean:data.mean });
  } catch(e) { res.status(500).json({ error:'MAL fetch failed' }); }
});

app.post('/api/mal/anime/:malId', async (req, res) => {
  let token = req.cookies.mal_access_token;
  if (!token) return res.status(401).json({ error:'Not logged in' });
  const { status, score, num_watched_episodes } = req.body;
  const body = new URLSearchParams();
  if (status) body.append('status', status);
  if (score !== undefined) body.append('score', String(score));
  if (num_watched_episodes !== undefined) body.append('num_watched_episodes', String(num_watched_episodes));
  try {
    let r = await fetchT(`${MAL_API}/anime/${req.params.malId}/my_list_status`, { method:'PATCH', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/x-www-form-urlencoded' }, body:body.toString() });
    if (r.status===401) { token=await refreshToken(req,res); if(!token) return res.status(401).json({error:'Session expired'}); r=await fetchT(`${MAL_API}/anime/${req.params.malId}/my_list_status`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()}); }
    if (!r.ok) return res.status(r.status).json({ error:await r.text() });
    res.json({ ok:true, data:await r.json() });
  } catch(e) { res.status(500).json({ error:'MAL update failed' }); }
});

// ─── STATIC FILES (MUST be AFTER all API routes) ─────────────────────────────
app.use(express.static(path.join(__dirname)));

// SPA fallback — only for non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(404).json({ error:'Not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`
╔══════════════════════════════════════════╗
║         ANIWATCH BRIDGE ONLINE           ║
║   ${String(PUBLIC_URL).padEnd(40)}║
║   NervHQ: ${String(NERV_API).padEnd(31)}║
╚══════════════════════════════════════════╝
`));
