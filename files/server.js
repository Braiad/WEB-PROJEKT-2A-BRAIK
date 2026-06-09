/**
 * ANIWATCH — server.js (produkce)
 * Multi-provider bridge + MAL OAuth + statický frontend
 *
 * Server plní tři hlavní role:
 * 1. Přeposílá API požadavky na interní NervHQ API (vyhledávání, epizody, streamy)
 * 2. Spravuje OAuth přihlášení přes MyAnimeList (PKCE flow)
 * 3. Slouží statické soubory frontendu
 */

// Načtení potřebných Node.js modulů
const express  = require('express'); // Webový framework pro HTTP server
const cors     = require('cors');    // Middleware pro povolení CORS hlaviček
const crypto   = require('crypto'); // Pro generování náhodných hodnot (PKCE)
const path     = require('path');   // Pro práci s cestami k souborům
const app      = express();         // Vytvoří Express aplikaci

// Povolí CORS požadavky ze všech domén (origin: true) s podporou cookies (credentials)
app.use(cors({ origin: (origin, callback) => callback(null, true), credentials: true }));
// Umožní parsování JSON těla požadavků (req.body)
app.use(express.json());

// Vlastní cookie parser — Express nemá vestavěný.
// Projde hlavičku "Cookie" a rozdělí ji na klíč-hodnota páry do req.cookies.
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) header.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    // Klíč je část před prvním '=', hodnota je zbytek (dekódovaný)
    req.cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  next(); // Předá řízení dalšímu middlewaru
});

// ── Konfigurace z proměnných prostředí (nebo výchozí hodnoty pro lokální vývoj) ──
const NERV_API     = process.env.NERV_API     || 'http://127.0.0.1:3000/api';    // URL interního anime API
const PUBLIC_URL   = process.env.PUBLIC_URL   || 'http://localhost:5000';         // Veřejná URL serveru
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';         // URL frontendu (pro redirect po MAL loginu)
const PORT         = process.env.PORT         || 5000;                             // Port pro naslouchání
const MAL_CLIENT_ID     = process.env.MAL_CLIENT_ID     || '2ecebbcdee03d3687f5070e852f751dc'; // MAL aplikační ID
const MAL_CLIENT_SECRET = process.env.MAL_CLIENT_SECRET || '';                    // MAL tajný klíč (volitelný)
const MAL_REDIRECT = `${PUBLIC_URL}/auth/mal/callback`; // Callback URL po MAL přihlášení
const MAL_API      = 'https://api.myanimelist.net/v2';  // MAL REST API
const MAL_AUTH     = 'https://myanimelist.net/v1/oauth2'; // MAL OAuth endpointy

// In-memory úložiště pro PKCE verifikátory (nyní nevyužíváno — přesunuto do cookies)
const pkceStore = {};

// Obalí fetch() voláním s timeoutem — zruší požadavek po uplynutí ms.
// Vrátí Response nebo vyhodí chybu při překročení limitu.
async function fetchT(url, options = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms); // Nastaví timeout
  try { const r = await fetch(url, { ...options, signal: ctrl.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

// ─── KONFIGURACE POSKYTOVATELŮ ─────────────────────────────────────────────────
// Každý poskytovatel (anizone, hianime, animepahe) má vlastní:
//   prefix:       Část URL cesty pro daný zdroj v NervHQ API
//   episodeMode:  'bundled' = epizody jsou součástí info endpointu,
//                 'separate' = epizody jsou na zvláštním endpointu
//   searchMap:    Funkce pro normalizaci výsledků vyhledávání do jednotného formátu
//   recentRoute:  Část URL pro endpoint nedávných anime
//   recentMap:    Funkce pro normalizaci dat nedávných anime
//   infoMap:      Funkce pro normalizaci dat detailu anime
//   episodeMap:   Funkce pro normalizaci dat jednotlivé epizody
//   sourcesRoute: Funkce vracející URL cestu k zdrojům streamu
//   sourcesMap:   Funkce pro normalizaci dat zdrojů streamu
const PROVIDERS = {
  anizone: {
    prefix:      'anizone',
    episodeMode: 'bundled', // Epizody jsou součástí /anime/:id odpovědi
    searchMap:   d => (d.data||[]).map(a => ({ id:a.id, name:a.name, poster:a.posterImage, type:a.type, year:a.releaseDate })),
    recentRoute: 'anime/recent',
    recentMap:   d => d.data||d||[],
    infoMap:     d => ({ info:d.data||{}, episodes:d.providerEpisodes||[] }),
    // Anizone vrací plné episodeId (např. "sousou-no-frieren-mdkytdqp-episode-1")
    episodeMap:  ep => ({ id: ep.episodeId, number: ep.episodeNumber, title: ep.title }),
    sourcesRoute:(epId, ver) => `sources/${encodeURIComponent(epId)}?version=${ver}`,
    sourcesMap:  d => ({ sources: d.data?.sources||d.sources||[], subtitles: d.data?.subtitles||d.subtitles||[] }),
  },
  hianime: {
    prefix:      'hianime',
    episodeMode: 'separate', // Epizody na zvláštním endpointu /anime/:id/episodes
    searchMap:   d => (d.data||[]).map(a => ({ id:a.id, name:a.name||a.title, poster:a.poster||a.posterImage, type:a.type })),
    recentRoute: 'anime/category/airing',
    recentMap:   d => d.data||d||[],
    infoMap:     d => ({ info:d.data||{}, episodes:[] }), // Epizody se načtou zvlášť
    episodeMap:  ep => ({ id: ep.episodeId||ep.id, number: ep.number||ep.episodeNumber, title: ep.title }),
    sourcesRoute:(epId, ver) => `sources/${encodeURIComponent(epId)}?version=${ver}&server=megacloud`, // Preferuje megacloud server
    sourcesMap:  d => ({ sources: d.data?.sources||d.sources||[], subtitles: d.data?.subtitles||d.subtitles||[] }),
  },
  kaido: {
    prefix:      'kaido',
    episodeMode: 'separate',
    searchMap:   d => (d.data||[]).map(a => ({ id:a.id, name:a.name||a.title, poster:a.poster||a.posterImage, type:a.type })),
    recentRoute: 'anime/category/airing',
    recentMap:   d => d.data||d||[],
    infoMap:     d => ({ info:d.data||{}, episodes:[] }),
    episodeMap:  ep => ({ id: ep.episodeId||ep.id, number: ep.number||ep.episodeNumber, title: ep.title }),
    sourcesRoute:(epId, ver) => `sources/${encodeURIComponent(epId)}?version=${ver}&server=vidcloud`, // Preferuje vidcloud server
    sourcesMap:  d => ({ sources: d.data?.sources||d.sources||[], subtitles: d.data?.subtitles||d.subtitles||[] }),
  },
  animepahe: {
    prefix:      'animepahe',
    episodeMode: 'separate',
    // Animepahe používá 'session' jako ID místo slug
    searchMap:   d => (d.data||d.results||[]).map(a => ({ id:a.session||a.id, name:a.title||a.name, poster:a.poster||a.image||a.posterImage, type:a.type||'TV', year:a.year })),
    recentRoute: 'episodes/recent',
    recentMap:   d => (d.data||d||[]).map(ep => ({ id:ep.animeSession||ep.session, name:ep.animeTitle||ep.title, poster:ep.snapshot||ep.poster||'', episodeId:ep.session, episodeNumber:ep.episode })),
    infoMap:     d => ({ info:d.data||d||{}, episodes:[] }),
    episodeMap:  ep => ({ id: ep.session||ep.episodeId||ep.id, number: ep.episode||ep.episodeNumber||ep.number, title: ep.title||`Episode ${ep.episode||ep.number}` }),
    sourcesRoute:(epId, ver) => `sources/${encodeURIComponent(epId)}?version=${ver}`,
    sourcesMap:  d => ({ sources: d.data?.sources||d.sources||[], subtitles: d.data?.subtitles||d.subtitles||[] }),
  },
};

// Vrátí konfiguraci poskytovatele podle názvu, nebo výchozí (anizone) pokud nenalezen
function getProvider(name) { return PROVIDERS[name] || PROVIDERS.anizone; }

// ─── API ROUTY (musí být PŘED statickými soubory) ─────────────────────────────

// Health check — zkontroluje dostupnost NervHQ API a vrátí stav systému.
app.get('/api/health', async (req, res) => {
  let nervStatus = 'unknown';
  try {
    const r = await fetchT(`${NERV_API}/anizone/anime/search?q=test`, {}, 5000);
    nervStatus = r.ok ? 'online' : `error:${r.status}`;
  } catch { nervStatus = 'offline'; }
  res.json({ bridge:'online', nerv:nervStatus, port:PORT, env:PUBLIC_URL.includes('railway')?'production':'local', ts:new Date().toISOString() });
});

// Vyhledávání anime. Přeposílá dotaz na NervHQ a normalizuje výsledky.
// Query parametry: q (hledaný výraz), provider (poskytovatel)
app.get('/api/search', async (req, res) => {
  const { q, provider='anizone' } = req.query;
  if (!q) return res.json([]); // Vrátí prázdné pole při chybějícím dotazu
  const p = getProvider(provider);
  const url = `${NERV_API}/${p.prefix}/anime/search?q=${encodeURIComponent(q)}`;
  console.log(`[SEARCH:${provider}] -> ${url}`);
  try {
    const r = await fetchT(url);
    if (!r.ok) return res.status(r.status).json({ error:'Search failed' });
    const d = await r.json();
    res.json(p.searchMap(d)); // Normalizuje data poskytovatele do jednotného formátu
  } catch(e) { console.error('[SEARCH]',e.message); res.status(503).json({ error:'NervHQ unreachable' }); }
});

// Nedávno aktualizovaná anime. Přeposílá na příslušný endpoint NervHQ.
app.get('/api/recent', async (req, res) => {
  const { provider='anizone' } = req.query;
  const p = getProvider(provider);
  const url = `${NERV_API}/${p.prefix}/${p.recentRoute}`;
  console.log(`[RECENT:${provider}] -> ${url}`);
  try {
    const r = await fetchT(url);
    if (!r.ok) return res.json([]); // Při chybě vrátí prázdné pole (tiché selhání)
    const d = await r.json();
    res.json(p.recentMap(d)); // Normalizuje data
  } catch(e) { res.status(503).json([]); }
});

// Detail anime + epizody. Načte info a podle episodeMode buď
// použije bundlované epizody, nebo načte epizody ze zvláštního endpointu.
app.get('/api/anime/:id', async (req, res) => {
  const { provider='anizone' } = req.query;
  const p = getProvider(provider);
  const id = req.params.id;
  const url = `${NERV_API}/${p.prefix}/anime/${encodeURIComponent(id)}`;
  console.log(`[ANIME:${provider}] -> ${url}`);
  try {
    const r = await fetchT(url, {}, 20000); // Delší timeout — info požadavky mohou trvat déle
    if (!r.ok) return res.status(r.status).json({ error:'Anime info failed' });
    const d    = await r.json();
    const norm = p.infoMap(d); // Normalizuje info data
    if (p.episodeMode === 'separate') {
      try {
        // Načte epizody ze zvláštního endpointu (/anime/:id/episodes)
        const epUrl = `${NERV_API}/${p.prefix}/anime/${encodeURIComponent(id)}/episodes`;
        const er = await fetchT(epUrl, {}, 20000);
        const ed = await er.json();
        norm.episodes = (ed.data||ed||[]).map(p.episodeMap); // Normalizuje každou epizodu
      } catch { norm.episodes = []; } // Při selhání vrátí prázdné pole epizod
    } else {
      // Bundlované epizody — jsou již v norm.episodes, jen normalizuj formát
      norm.episodes = norm.episodes.map(p.episodeMap);
    }
    console.log(`[ANIME:${provider}] episodes: ${norm.episodes.length}`);
    res.json(norm);
  } catch(e) { console.error('[ANIME]',e.message); res.status(503).json({ error:'NervHQ unreachable' }); }
});

// Zdroje streamu pro konkrétní epizodu.
// Parametry: episodeId (v URL), provider, version (sub/dub)
app.get('/api/sources/:episodeId', async (req, res) => {
  const { provider='anizone', version='sub' } = req.query;
  const p     = getProvider(provider);
  const epId  = req.params.episodeId;
  const route = p.sourcesRoute(epId, version); // Sestaví cestu endpointu (liší se dle poskytovatele)
  const url   = `${NERV_API}/${p.prefix}/${route}`;
  console.log(`[SOURCES:${provider}] -> ${url}`);
  try {
    const r = await fetchT(url, {}, 20000);
    if (!r.ok) return res.json({ sources:[], subtitles:[] }); // Při chybě vrátí prázdné pole
    const d      = await r.json();
    const result = p.sourcesMap(d); // Normalizuje seznam zdrojů a titulků
    console.log(`[SOURCES:${provider}] ${result.sources.length} sources`);
    res.json(result);
  } catch(e) { console.error('[SOURCES]',e.message); res.status(503).json({ sources:[], subtitles:[] }); }
});

// ─── HLS PROXY ────────────────────────────────────────────────────────────────

// Převede relativní URL na absolutní podle základní URL streamu.
// Ošetří: absolutní URL (http/https), protokol-relativní (//...), 
// root-relativní (/...) a relativní cesty.
function resolveUrl(href, base) {
  if (href.startsWith('http://') || href.startsWith('https://')) return href; // Již absolutní
  if (href.startsWith('//')) return 'https:' + href; // Doplní protokol
  if (href.startsWith('/')) { const u = new URL(base); return u.origin + href; } // Root-relativní
  return base.substring(0, base.lastIndexOf('/')+1) + href; // Relativní k adresáři base URL
}

// Přepíše jeden řádek HLS manifestu (.m3u8) tak, aby URL procházely přes proxy.
// Ošetřuje:
//   - #EXT-X-KEY: šifrovací klíče segmentů — přepíše URI
//   - #EXT-X-MEDIA s URI: alternativní mediální stopy — přepíše URI
//   - Komentáře (#...) — ponechá beze změny
//   - Segmentové URL — přepíše na proxy URL
function rewriteLine(line, baseUrl) {
  const t = line.trim();
  if (!t) return line; // Prázdný řádek — vrátí bez změny
  // Přepíše URI v šifrovacích klíčích a mediálních deskriptorech
  if (t.startsWith('#EXT-X-KEY') || (t.startsWith('#EXT-X-MEDIA') && t.includes('URI="'))) {
    return t.replace(/URI="([^"]+)"/, (_, uri) => {
      const abs = resolveUrl(uri, baseUrl);
      return `URI="${PUBLIC_URL}/api/proxy?url=${encodeURIComponent(abs)}"`;
    });
  }
  if (t.startsWith('#')) return line; // Ostatní HLS direktivy — vrátí beze změny
  // Segmentové URL (řádky bez '#') — přepíše na proxy URL
  const abs = resolveUrl(t, baseUrl);
  return `${PUBLIC_URL}/api/proxy?url=${encodeURIComponent(abs)}`;
}

// HLS proxy endpoint — obejde CORS omezení původních serverů.
// Stáhne .m3u8 manifest nebo video segment a přepošle ho klientovi.
// Pro .m3u8 soubory přepíše všechny URL v manifestu přes tuto proxy.
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  const decoded = decodeURIComponent(url); // Dekóduje URL z query parametru
  try {
    // Stáhne obsah s hlavičkami simulujícími prohlížeč (obejde ochranu proti scrapingu)
    const r = await fetchT(decoded, {
      headers: { 'Referer':'https://anizone.to/', 'Origin':'https://anizone.to', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, 20000);
    if (!r.ok) return res.status(r.status).send(`Upstream ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*'); // Povolí CORS pro frontend
    if (decoded.includes('.m3u8') || ct.includes('mpegurl')) {
      // HLS manifest — přepíše URL segmentů a klíčů přes proxy
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const text = await r.text();
      return res.send(text.split('\n').map(l => rewriteLine(l, decoded)).join('\n'));
    }
    // Video segmenty (.ts) nebo šifrovací klíče (.key) — přepošle jako binární data
    res.setHeader('Content-Type', ct || (decoded.includes('.key') ? 'application/octet-stream' : 'video/mp2t'));
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch(e) { res.status(500).send('Proxy failed'); }
});

// ─── MAL OAUTH (přihlašování přes MyAnimeList) ──────────────────────────────

// Pomocné funkce pro PKCE (Proof Key for Code Exchange) — bezpečnější OAuth flow.
// Převede Buffer na base64url (URL-bezpečná varianta base64 bez =, +, /)
function base64url(buf) { return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
// Vygeneruje náhodný PKCE verifikátor (32 náhodných bytů jako base64url)
function generateVerifier() { return base64url(crypto.randomBytes(32)); }
// Vygeneruje PKCE challenge: SHA-256 hash verifikátoru jako base64url
function generateChallenge(v) { return base64url(crypto.createHash('sha256').update(v).digest()); }

// Spustí MAL OAuth flow — vygeneruje PKCE verifikátor a přesměruje na MAL.
// Verifikátor a stav se ukládají do HttpOnly cookies (bezpečnější než memory,
// funguje i při více instancích serveru na Railway).
app.get('/auth/mal/login', (req, res) => {
  const verifier  = generateVerifier();          // Náhodný řetězec
  const challenge = generateChallenge(verifier); // SHA-256 hash verifikátoru
  const state     = base64url(crypto.randomBytes(16)); // Ochrana proti CSRF útokům
  const secure    = PUBLIC_URL.startsWith('https') ? '; Secure' : ''; // Secure flag jen na HTTPS
  // Uloží verifikátor a stav do cookies platných 10 minut
  res.setHeader('Set-Cookie', [
    `mal_pkce_verifier=${verifier}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/${secure}`,
    `mal_pkce_state=${state}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/${secure}`,
  ]);
  // Sestaví URL pro přesměrování na MAL autorizační stránku
  const params = new URLSearchParams({
    response_type:'code', client_id:MAL_CLIENT_ID,
    redirect_uri:MAL_REDIRECT, state,
    code_challenge:challenge, code_challenge_method:'S256', // PKCE metoda
  });
  res.redirect(`${MAL_AUTH}/authorize?${params}`);
});

// Callback po přihlášení na MAL — vymění autorizační kód za přístupový token.
// MAL přesměruje sem s 'code' a 'state' parametry.
app.get('/auth/mal/callback', async (req, res) => {
  const { code, state } = req.query;
  // Načte verifikátor a stav uložené v cookies (z /auth/mal/login)
  const verifier      = req.cookies.mal_pkce_verifier;
  const storedState   = req.cookies.mal_pkce_state;
  // Ověří stav — ochrana proti CSRF (útočník nemůže podvrhnout callback)
  if (!verifier || storedState !== state) return res.status(400).send('Invalid state. Try logging in again.');
  // Smaže PKCE cookies — již nejsou potřeba
  res.setHeader('Set-Cookie', [
    'mal_pkce_verifier=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/',
    'mal_pkce_state=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/',
  ]);
  try {
    // Sestaví požadavek na výměnu kódu za token
    const body = new URLSearchParams({
      client_id:MAL_CLIENT_ID, grant_type:'authorization_code',
      code, redirect_uri:MAL_REDIRECT, code_verifier:verifier, // Verifikátor potvrdí identitu
    });
    if (MAL_CLIENT_SECRET) body.append('client_secret', MAL_CLIENT_SECRET); // Volitelný tajný klíč
    const r = await fetchT(`${MAL_AUTH}/token`, {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:body.toString(),
    });
    if (!r.ok) { const err=await r.text(); console.error('[MAL] Token error:',err); return res.status(400).send('MAL auth failed: '+err); }
    const tokens = await r.json();
    const secure = PUBLIC_URL.startsWith('https') ? '; Secure' : '';
    // Uloží přístupový a obnovovací token do HttpOnly cookies
    // Přístupový token vyprší za expires_in (obvykle 3600s), obnovovací za 30 dní
    res.setHeader('Set-Cookie', [
      `mal_access_token=${tokens.access_token}; HttpOnly; SameSite=Lax; Max-Age=${tokens.expires_in||3600}; Path=/${secure}`,
      `mal_refresh_token=${tokens.refresh_token}; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*30}; Path=/${secure}`,
    ]);
    res.redirect(FRONTEND_URL); // Přesměruje zpět na frontend
  } catch(e) { console.error('[MAL] Callback error:',e.message); res.status(500).send('Internal error.'); }
});

// Odhlásí uživatele z MAL — smaže token cookies nastavením Max-Age=0.
app.post('/auth/mal/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    'mal_access_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/',
    'mal_refresh_token=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/',
  ]);
  res.json({ ok:true });
});

// Zkontroluje stav přihlášení — zavolá MAL API s tokenem z cookie.
// Vrátí { loggedIn:true, name, picture } nebo { loggedIn:false }.
app.get('/auth/mal/status', async (req, res) => {
  const token = req.cookies.mal_access_token;
  if (!token) return res.json({ loggedIn:false }); // Žádný token = nepřihlášen
  try {
    const r = await fetchT(`${MAL_API}/users/@me?fields=name,picture`, { headers:{ Authorization:`Bearer ${token}` } });
    if (!r.ok) return res.json({ loggedIn:false }); // Token neplatný nebo expirovaný
    const user = await r.json();
    res.json({ loggedIn:true, name:user.name, picture:user.picture });
  } catch { res.json({ loggedIn:false }); }
});

// Obnoví expirovaný přístupový token pomocí obnovovacího tokenu.
// Vrátí nový přístupový token nebo null při selhání.
async function refreshToken(req, res) {
  const refresh = req.cookies.mal_refresh_token;
  if (!refresh) return null; // Žádný obnovovací token
  try {
    const body = new URLSearchParams({ client_id:MAL_CLIENT_ID, grant_type:'refresh_token', refresh_token:refresh });
    if (MAL_CLIENT_SECRET) body.append('client_secret', MAL_CLIENT_SECRET);
    const r = await fetchT(`${MAL_AUTH}/token`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString() });
    if (!r.ok) return null;
    const tokens = await r.json();
    const secure = PUBLIC_URL.startsWith('https') ? '; Secure' : '';
    // Aktualizuje cookies s novými tokeny
    res.setHeader('Set-Cookie', [
      `mal_access_token=${tokens.access_token}; HttpOnly; SameSite=Lax; Max-Age=${tokens.expires_in||3600}; Path=/${secure}`,
      `mal_refresh_token=${tokens.refresh_token}; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*30}; Path=/${secure}`,
    ]);
    return tokens.access_token; // Vrátí nový přístupový token
  } catch { return null; }
}

// Načte stav sledování anime z MAL účtu uživatele.
// Pokud token expiroval (401), pokusí se ho obnovit a zopakuje požadavek.
app.get('/api/mal/anime/:malId', async (req, res) => {
  let token = req.cookies.mal_access_token;
  if (!token) return res.json({ listed:false });
  try {
    // Načte info o anime včetně stavu v uživatelském seznamu
    let r = await fetchT(`${MAL_API}/anime/${req.params.malId}?fields=my_list_status,num_episodes,title,mean`, { headers:{ Authorization:`Bearer ${token}` } });
    if (r.status===401) {
      // Token expiroval — zkusí obnovit
      token=await refreshToken(req,res);
      if(!token) return res.json({listed:false});
      r=await fetchT(`${MAL_API}/anime/${req.params.malId}?fields=my_list_status,num_episodes,title,mean`,{headers:{Authorization:`Bearer ${token}`}});
    }
    if (!r.ok) return res.json({ listed:false });
    const data = await r.json();
    // Vrátí normalizovaná data: stav v seznamu, skóre, průběh, celkový počet epizod
    res.json({ listed:!!data.my_list_status, status:data.my_list_status?.status||null, score:data.my_list_status?.score||0, progress:data.my_list_status?.num_episodes_watched||0, total:data.num_episodes||0, title:data.title, mean:data.mean });
  } catch(e) { res.status(500).json({ error:'MAL fetch failed' }); }
});

// Aktualizuje stav sledování anime v MAL seznamu (metoda PATCH).
// Tělo požadavku může obsahovat: status, score, num_watched_episodes.
// Automaticky obnoví token při 401 chybě.
app.post('/api/mal/anime/:malId', async (req, res) => {
  let token = req.cookies.mal_access_token;
  if (!token) return res.status(401).json({ error:'Not logged in' });
  const { status, score, num_watched_episodes } = req.body;
  // Sestaví form-encoded tělo požadavku (MAL API vyžaduje tento formát)
  const body = new URLSearchParams();
  if (status) body.append('status', status);
  if (score !== undefined) body.append('score', String(score));
  if (num_watched_episodes !== undefined) body.append('num_watched_episodes', String(num_watched_episodes));
  try {
    // PATCH — aktualizuje pouze zadaná pole
    let r = await fetchT(`${MAL_API}/anime/${req.params.malId}/my_list_status`, { method:'PATCH', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/x-www-form-urlencoded' }, body:body.toString() });
    if (r.status===401) {
      // Token expiroval — zkusí obnovit a zopakovat
      token=await refreshToken(req,res);
      if(!token) return res.status(401).json({error:'Session expired'});
      r=await fetchT(`${MAL_API}/anime/${req.params.malId}/my_list_status`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
    }
    if (!r.ok) return res.status(r.status).json({ error:await r.text() });
    res.json({ ok:true, data:await r.json() }); // Vrátí potvrzení o úspěšné aktualizaci
  } catch(e) { res.status(500).json({ error:'MAL update failed' }); }
});

// ─── STATICKÉ SOUBORY (MUSÍ být AŽ ZA všemi API routami) ─────────────────────
// Slouží statické soubory z aktuálního adresáře (index.html, app.js, style.css...)
app.use(express.static(path.join(__dirname)));

// SPA fallback — pro všechny neznámé URL (kromě /api/ a /auth/) vrátí index.html.
// Umožní klientskému routování (React/Vue SPA) zpracovat URL samo.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(404).json({ error:'Not found' }); // API routy bez shody vrátí 404
  }
  res.sendFile(path.join(__dirname, 'index.html')); // Všechno ostatní → SPA
});

// Spustí HTTP server na nastaveném portu a vypíše uvítací zprávu do konzole.
app.listen(PORT, () => console.log(`
╔══════════════════════════════════════════╗
║         ANIWATCH BRIDGE ONLINE           ║
║   ${String(PUBLIC_URL).padEnd(40)}║
║   NervHQ: ${String(NERV_API).padEnd(31)}║
╚══════════════════════════════════════════╝
`));