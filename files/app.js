/* =============================================
   ANIWATCH — app.js
   Automaticky detekuje lokální vs. produkční URL API
   ============================================= */

// Zjistí, zda aplikace běží na produkci (Railway) nebo lokálně.
// Na produkci jsou frontend i backend na stejné doméně, takže stačí relativní URL.
const IS_PROD    = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
// Základní URL pro API volání — relativní na produkci, lokální port na vývoji.
const BRIDGE_API = IS_PROD ? '/api' : 'http://localhost:5000/api';
// Základní URL pro autentizaci — prázdný řetězec na produkci (stejná doména), lokální port jinak.
const AUTH_BASE  = IS_PROD ? ''     : 'http://localhost:5000';
// Veřejné Jikan API (neoficiální MAL REST API) pro metadata — skóre, seznam nejlepších atd.
const JIKAN_API  = 'https://api.jikan.moe/v4';
// Klíč pod kterým se ukládá historie sledování do localStorage.
const HISTORY_KEY = 'aniwatch_history';

// Globální stav aplikace:
let currentView      = 'home';      // Která sekce stránky je aktuálně viditelná.
let currentProvider  = 'anizone';   // Aktuálně vybraný zdroj streamů.
let currentAnimeData = null;        // Data o právě otevřeném anime (id, název, poster...).
let currentEpisodes  = [];          // Pole epizod aktuálně otevřeného anime.
let activeEpId       = null;        // ID epizody, která se právě přehrává.
let currentAudio     = 'sub';       // Zvuková stopa — 'sub' (titulky) nebo 'dub' (dabing).
let malUser          = null;        // Data přihlášeného MAL uživatele (nebo null).
let hls              = null;        // Instance HLS.js přehrávače (nebo null).

// Po načtení celého DOM spustí inicializaci aplikace.
document.addEventListener('DOMContentLoaded', () => {
  loadHomePage();            // Načte nedávné a nejlepší anime na domovskou stránku.
  renderContinueWatching();  // Zobrazí sekci "Pokračovat ve sledování" z historie.
  checkMalStatus();          // Zkontroluje, zda je uživatel přihlášen do MAL.
  // Přidá posluchač klávesy Enter na vyhledávací pole v navigaci.
  document.getElementById('searchInput').addEventListener('keydown', e => { if(e.key==='Enter') triggerSearch(); });
  // Přidá posluchač klávesy Enter na vyhledávací pole na hero sekci.
  document.getElementById('heroSearchInput').addEventListener('keydown', e => { if(e.key==='Enter') triggerHeroSearch(); });
});

// Přepne viditelný pohled (sekci stránky). Nejprve skryje všechny sekce,
// pak zobrazí požadovanou. Pokud opouštíme přehrávač, zničí HLS instanci.
function showView(name) {
  ['homeView','searchView','detailView','playerView'].forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById(name).classList.remove('hidden');
  currentView = name;
  if (name !== 'playerView') destroyHls(); // Zastaví stream, pokud se odejde z přehrávače.
}

// Zkratka — zobrazí domovský pohled a znovu vykreslí historii sledování.
function showHome() { showView('homeView'); renderContinueWatching(); }

// Přepne poskytovatele (zdroj) anime. Aktualizuje aktivní tlačítko v UI,
// a pokud jsme na domovské nebo vyhledávací stránce, znovu načte obsah.
function switchProvider(name, btn) {
  currentProvider = name;
  // Odstraní třídu 'active' ze všech tlačítek poskytovatele.
  document.querySelectorAll('.provider-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); // Označí kliknuté tlačítko jako aktivní.
  if (currentView === 'home') loadHomePage(); // Znovu načte domovskou stránku s novým poskytovatelem.
  else if (currentView === 'searchView') { const q=document.getElementById('searchInput').value.trim(); if(q) performSearch(q); } // Znovu vyhledá.
  toast(`// PROVIDER: ${name.toUpperCase()}`); // Zobrazí notifikaci o změně zdroje.
}

// Přepne poskytovatele přímo z přehrávače (select element v player info baru).
// Synchronizuje aktivní tlačítko v navigaci a přenačte epizody pro nový zdroj.
function switchPlayerProvider(name) {
  currentProvider = name;
  document.querySelectorAll('.provider-btn').forEach(b => b.classList.toggle('active', b.dataset.provider===name));
  if (activeEpId && currentAnimeData) reloadAnimeForProvider(currentAnimeData.name, activeEpId);
}

// Asynchronně přenačte anime data a epizody po přepnutí poskytovatele v přehrávači.
// Vyhledá anime podle názvu na novém poskytovateli a přehraje první epizodu.
async function reloadAnimeForProvider(animeName, oldEpId) {
  showPlayerOverlay(`// SWITCHING TO ${currentProvider.toUpperCase()}...`); // Zobrazí překryvnou vrstvu s textem.
  try {
    // Vyhledá anime u nového poskytovatele (použije jen první část názvu před ':').
    const res     = await fetch(`${BRIDGE_API}/search?q=${encodeURIComponent(animeName.split(':')[0])}&provider=${currentProvider}`);
    const results = await res.json();
    if (!results.length) { showPlayerOverlay('// NOT FOUND ON THIS PROVIDER'); return; }
    const match = results[0]; // Vezme první výsledek vyhledávání.
    // Aktualizuje globální data anime — zachová původní poster pokud nový nemá.
    currentAnimeData = { ...currentAnimeData, id:match.id, name:match.name, poster:match.poster||currentAnimeData.poster };
    // Načte detailní info (včetně epizod) pro nalezené anime.
    const infoRes = await fetch(`${BRIDGE_API}/anime/${encodeURIComponent(match.id)}?provider=${currentProvider}`);
    const info    = await infoRes.json();
    currentEpisodes = info.episodes||[];
    renderSidebarEpisodes(null); // Vykreslí seznam epizod v postranním panelu.
    const newEp = currentEpisodes[0];
    if (newEp) playEpisode(newEp.id, newEp.number); // Přehraje první epizodu.
  } catch(e) { showPlayerOverlay('// PROVIDER SWITCH FAILED'); toast('// Switch failed',true); }
}

// Zobrazí krátkodobou notifikaci (toast) v pravém dolním rohu.
// isError=true přidá červenou barvu (chybový styl).
function toast(msg, isError=false) {
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast show'+(isError?' error':'');
  // Zruší předchozí timeout a nastaví nový — zpráva zmizí po 3,5 sekundách.
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'),3500);
}

// Aktualizuje stavový text v navigační liště (vedle pulzující tečky).
function setStatus(msg) { document.getElementById('statusText').textContent=msg; }

// Načte obsah domovské stránky — zobrazí aktuální sezónu a spustí paralelní
// načítání nedávných a nejlépe hodnocených anime.
async function loadHomePage() {
  const now=new Date(), seasons=['WINTER','SPRING','SUMMER','FALL'];
  // Vypočítá aktuální sezónu z měsíce (0-2=WINTER, 3-5=SPRING, 6-8=SUMMER, 9-11=FALL).
  document.getElementById('seasonBadge').textContent=`${seasons[Math.floor(now.getMonth()/3)]} ${now.getFullYear()}`;
  // Spustí obě načítání zároveň pro rychlejší odezvu.
  await Promise.all([loadRecent(), loadTopRated()]);
}

// Načte sekci "Nedávno aktualizováno". Nejprve zkusí aktuálního poskytovatele,
// při selhání použije záložní Jikan API.
async function loadRecent() {
  setStatus('FETCHING RECENT...');
  try {
    const res=await fetch(`${BRIDGE_API}/recent?provider=${currentProvider}`);
    const data=await res.json();
    if (data && data.length) {
      // Zjistí, zda jsou data ve formátu epizod (mají episodeId nebo episodeNumber).
      const isEpisodeList = data[0] && (data[0].episodeId || data[0].episodeNumber);
      if (isEpisodeList) {
        // Deduplikuje epizody na anime — každé anime zobrazí jen jednou.
        const seen=new Set(), animes=[];
        for (const ep of data) {
          const id=ep.animeId||ep.episodeId?.replace(/-episode-\d+$/,'')||ep.episodeId;
          const name=ep.animeName||ep.animeTitle||id;
          const poster=ep.animePoster||ep.thumbnail||'';
          if (!seen.has(id)) { seen.add(id); animes.push({id,name,poster,posterImage:poster}); }
        }
        if (animes.length) { renderCards(animes,'airingGrid'); setStatus('SYSTEM ONLINE'); return; }
      } else { renderCards(data,'airingGrid'); setStatus('SYSTEM ONLINE'); return; }
    }
  } catch(e) {}
  // Záloha: použije Jikan API (MAL) pro aktuálně vysílané anime.
  try {
    const res=await fetch(`${JIKAN_API}/seasons/now?limit=18`);
    const data=await res.json();
    renderJikanCards(data.data||[],'airingGrid');
    setStatus('SYSTEM ONLINE');
  } catch(e) {
    // Pokud selže i záloha, zobrazí chybovou zprávu přímo v gridu.
    document.getElementById('airingGrid').innerHTML='<p style="color:var(--text-muted);font-family:var(--font-mono);font-size:.75rem;padding:20px 0">// FEED UNAVAILABLE</p>';
    setStatus('PARTIAL ERROR');
  }
}

// Načte sekci "Nejlépe hodnoceno" přes Jikan API — top TV seriály dle MAL skóre.
async function loadTopRated() {
  try { const res=await fetch(`${JIKAN_API}/top/anime?limit=18&type=tv`); const data=await res.json(); renderJikanCards(data.data||[],'topGrid'); } catch(e) {}
}

// Vykreslí karty anime do gridu. Každá karta je klikací a otevře detail anime.
// Používá se pro data z vlastního API (ne Jikan).
function renderCards(items, gridId) {
  const grid=document.getElementById(gridId);
  if (!items.length) { grid.innerHTML='<p style="color:var(--text-muted);font-family:var(--font-mono);font-size:.75rem;padding:20px 0">// NO DATA</p>'; return; }
  grid.innerHTML=items.map(item => {
    const title=item.name||item.title||'', poster=item.poster||item.posterImage||'', type=item.type||'', id=item.id||'';
    // Každá karta obsahuje: obrázek s fallback SVG při chybě, overlay tlačítko a info pásek.
    return `<div class="anime-card" onclick="openAnime('${escQ(id)}','${escQ(title)}','${escQ(poster)}')">
      <div class="card-poster-wrap">
        <img src="${escQ(poster)}" alt="${escQ(title)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22160%22 height=%22240%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%231e2029%22/><text x=%2250%25%22 y=%2250%25%22 fill=%22%236b7080%22 text-anchor=%22middle%22 font-size=%2212%22>NO IMG</text></svg>'" />
        <div class="card-overlay"><div class="card-play-btn">// VIEW</div></div>
      </div>
      <div class="card-info"><div class="card-title">${title}</div><div class="card-meta">${type}</div></div>
    </div>`;
  }).join('');
}

// Vykreslí karty anime z Jikan API dat do gridu.
// Navíc zobrazuje skóre a rok vydání. Kliknutí spustí openJikanAnime.
function renderJikanCards(items, gridId) {
  const grid=document.getElementById(gridId);
  if (!items.length) return;
  grid.innerHTML=items.map(item => {
    const title=item.title_english||item.title||'', poster=item.images?.jpg?.large_image_url||'';
    const score=item.score?item.score.toFixed(1):'', year=item.year||'', type=item.type||'', malId=item.mal_id;
    return `<div class="anime-card" onclick="openJikanAnime(${malId},'${escQ(title)}','${escQ(poster)}')">
      <div class="card-poster-wrap">
        <img src="${escQ(poster)}" alt="${escQ(title)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22160%22 height=%22240%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%231e2029%22/><text x=%2250%25%22 y=%2250%25%22 fill=%22%236b7080%22 text-anchor=%22middle%22 font-size=%2212%22>NO IMG</text></svg>'" />
        ${score?`<div class="card-score-badge">★ ${score}</div>`:''} <!-- Odznak se skóre — zobrazí se jen když skóre existuje -->
        <div class="card-overlay"><div class="card-play-btn">// VIEW</div></div>
      </div>
      <div class="card-info"><div class="card-title">${title}</div><div class="card-meta">${[type,year].filter(Boolean).join(' · ')}</div></div>
    </div>`;
  }).join('');
}

// Spustí vyhledávání z hero sekce — zkopíruje dotaz do nav vyhledávacího pole.
function triggerHeroSearch() { const q=document.getElementById('heroSearchInput').value.trim(); if(!q)return; document.getElementById('searchInput').value=q; performSearch(q); }
// Spustí vyhledávání z nav vyhledávacího pole.
function triggerSearch() { const q=document.getElementById('searchInput').value.trim(); if(!q)return; performSearch(q); }

// Provede vyhledávání: přepne na searchView, zobrazí skeleton placeholder,
// zavolá API a vykreslí výsledky (nebo prázdný stav při neúspěchu).
async function performSearch(query) {
  showView('searchView');
  document.getElementById('searchQueryLabel').textContent=`// "${query}"`;
  // Zobrazí 8 skeleton karet během načítání.
  document.getElementById('searchGrid').innerHTML=`<div class="skeleton-grid">${Array(8).fill('<div class="skeleton-card"></div>').join('')}</div>`;
  document.getElementById('searchEmpty').classList.add('hidden');
  setStatus('SEARCHING...');
  try {
    const res=await fetch(`${BRIDGE_API}/search?q=${encodeURIComponent(query)}&provider=${currentProvider}`);
    const data=await res.json();
    if (!data.length) { document.getElementById('searchGrid').innerHTML=''; document.getElementById('searchEmpty').classList.remove('hidden'); }
    else renderCards(data,'searchGrid');
    setStatus('SYSTEM ONLINE');
  } catch(e) {
    // Při chybě serveru zobrazí informaci o výpadku.
    document.getElementById('searchGrid').innerHTML='';
    document.getElementById('searchEmpty').innerHTML='<div class="empty-icon">// 500</div><p>Bridge offline.</p>';
    document.getElementById('searchEmpty').classList.remove('hidden');
    setStatus('BRIDGE OFFLINE'); toast('// SERVER OFFLINE',true);
  }
}

// Otevře detail anime z karet poskytovatele (ne Jikan).
// Uloží globální data a ihned zobrazí základní info, pak dotáhne epizody.
async function openAnime(id, name, poster, malId=null) {
  currentAnimeData={id,name,poster,malId};
  showDetailView({title:name,poster}); // Okamžitě zobrazí detail s dostupnými daty.
  await loadAnimeInfo(id);             // Asynchronně dotáhne epizody a doplní info.
}

// Otevře detail anime kliknutého z Jikan karet (přes MAL ID).
// Musí nejprve vyhledat anime u poskytovatele pro streamovací ID.
async function openJikanAnime(malId, title, poster) {
  setStatus('RESOLVING...');
  try {
    const searchTitle=title.split(':')[0].trim(); // Odstraní podtitulek za ':' pro lepší hledání.
    // Vyhledá anime u aktuálního poskytovatele.
    const res=await fetch(`${BRIDGE_API}/search?q=${encodeURIComponent(searchTitle)}&provider=${currentProvider}`);
    const results=await res.json();
    let jikanDetail={};
    // Zároveň načte podrobná metadata z Jikan API (synopsis, studio, typ...).
    try { const jr=await fetch(`${JIKAN_API}/anime/${malId}`); const jd=await jr.json(); jikanDetail=jd.data||{}; } catch{}
    if (!results.length) {
      // Anime nenalezeno u poskytovatele — zobrazí detail jen s MAL metadaty, bez epizod.
      toast(`// "${searchTitle}" not found on ${currentProvider}`,true);
      showDetailView({title:jikanDetail.title_english||title,poster,synopsis:jikanDetail.synopsis,type:jikanDetail.type,year:jikanDetail.year,score:jikanDetail.score,episodes:jikanDetail.episodes,studio:jikanDetail.studios?.[0]?.name,status:jikanDetail.status});
      currentAnimeData={id:null,name:title,poster,malId};
      loadMalTracker(malId); return;
    }
    const match=results[0]; // Vezme první shodu od poskytovatele.
    currentAnimeData={id:match.id,name:match.name,poster:match.poster||poster,malId};
    // Kombinuje data z Jikan (metadata) a od poskytovatele (stream ID).
    showDetailView({title:jikanDetail.title_english||match.name,poster:match.poster||poster,synopsis:jikanDetail.synopsis,type:match.type||jikanDetail.type,year:jikanDetail.year,score:jikanDetail.score,episodes:jikanDetail.episodes,studio:jikanDetail.studios?.[0]?.name,status:jikanDetail.status});
    await loadAnimeInfo(match.id); // Načte epizody od poskytovatele.
    loadMalTracker(malId);         // Načte MAL tracker (stav sledování).
    setStatus('SYSTEM ONLINE');
  } catch(e) { toast('// Failed to resolve anime',true); setStatus('ERROR'); }
}

// Načte epizody a doplňující info pro anime ze serveru.
// Zobrazí loading indikátor, pak vykreslí epizody do gridu.
async function loadAnimeInfo(id) {
  document.getElementById('epLoading').classList.remove('hidden'); // Zobrazí "FETCHING EPISODE DATA".
  document.getElementById('episodeGrid').innerHTML='';
  try {
    const res=await fetch(`${BRIDGE_API}/anime/${encodeURIComponent(id)}?provider=${currentProvider}`);
    const data=await res.json();
    const info=data.info||{};
    // Doplní dostupná metadata (přepisuje jen pokud existují nová data).
    if(info.description||info.synopsis) document.getElementById('detailSynopsis').textContent=info.description||info.synopsis;
    if(info.status) document.getElementById('detailStatus').textContent=info.status;
    if(info.totalEpisodes||info.episodes) document.getElementById('detailEps').textContent=info.totalEpisodes||info.episodes||'?';
    if(info.type) document.getElementById('detailType').textContent=info.type;
    currentEpisodes=data.episodes||[];
    document.getElementById('epLoading').classList.add('hidden'); // Skryje loading indikátor.
    if(!currentEpisodes.length) { document.getElementById('episodeGrid').innerHTML='<p style="color:var(--text-muted);font-family:var(--font-mono);font-size:.75rem">// NO EPISODES FOUND</p>'; return; }
    renderEpisodes(currentEpisodes); // Vykreslí tlačítka epizod.
  } catch(e) { document.getElementById('epLoading').textContent='// FAILED TO LOAD EPISODES'; toast('// Episode fetch failed',true); }
}

// Naplní detail view (pohled s posterem, názvem, synopsí...) daty.
// Volá se okamžitě při kliknutí, i před dokončením načítání epizod.
function showDetailView(info) {
  showView('detailView');
  document.getElementById('detailPoster').src=info.poster||'';
  document.getElementById('detailTitle').textContent=info.title||'';
  document.getElementById('detailSynopsis').textContent=info.synopsis||'// No synopsis available.';
  document.getElementById('detailType').textContent=info.type||'ANIME';
  document.getElementById('detailYear').textContent=info.year||'';
  document.getElementById('detailStatus').textContent=info.status||'';
  document.getElementById('detailScore').textContent=info.score?`★ ${info.score}`:'—';
  document.getElementById('detailEps').textContent=info.episodes||'?';
  document.getElementById('detailStudio').textContent=info.studio||'—';
  // Nastaví rozmazaný poster jako pozadí hero sekce detailu.
  document.getElementById('detailHeroBg').style.backgroundImage=`url('${info.poster||''}')`;
  document.getElementById('episodeGrid').innerHTML='';
  document.getElementById('epLoading').classList.remove('hidden');
  // Skryje MAL tracker a přihlašovací výzvu, dokud se znovu nenačtou.
  document.getElementById('malTracker').classList.add('hidden');
  document.getElementById('malLoginPrompt').classList.add('hidden');
  window.scrollTo({top:0,behavior:'smooth'}); // Odscrolluje na začátek stránky.
}

// Vykreslí tlačítka epizod do gridu. Epizody označené jako zhlédnuté
// mají třídu 'watched' (zelená fajfka v CSS).
function renderEpisodes(episodes) {
  const watched=getWatched(currentAnimeData?.id); // Načte seznam zhlédnutých epizod z localStorage.
  document.getElementById('episodeGrid').innerHTML=episodes.map(ep => {
    const id=ep.id, num=ep.number||'?', isW=watched.includes(String(id));
    return `<button class="ep-btn${isW?' watched':''}" id="epbtn-${CSS.escape(id)}" onclick="playEpisode('${escQ(id)}',${num})">EP ${num}</button>`;
  }).join('');
}

// Filtruje zobrazené tlačítka epizod podle textu v search poli.
// Skryje ta tlačítka, jejichž text neobsahuje hledaný výraz.
function filterEpisodes() {
  const q=document.getElementById('epSearch').value.trim().toLowerCase();
  document.querySelectorAll('.ep-btn').forEach(b=>{b.style.display=b.textContent.toLowerCase().includes(q)?'':'none';});
}

// Hlavní funkce přehrávání epizody. Nastaví aktivní epizodu, přepne na playerView,
// načte streamy ze serveru, vybere nejlepší kvalitu a spustí přehrávání.
async function playEpisode(epId, epNum) {
  activeEpId=epId;
  // Odstraní třídu 'active' ze všech ep tlačítek a označí právě přehrávanou.
  document.querySelectorAll('.ep-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById(`epbtn-${CSS.escape(epId)}`)?.classList.add('active');
  showView('playerView');
  document.getElementById('playerAnimeTitle').textContent=currentAnimeData?.name||'';
  document.getElementById('playerEpTitle').textContent=`// EPISODE ${epNum}`;
  document.getElementById('qualitySelector').innerHTML=''; // Vymaže předchozí tlačítka kvality.
  document.getElementById('playerProviderSelect').value=currentProvider; // Synchronizuje select s aktuálním poskytovatelem.
  showPlayerOverlay('// FETCHING STREAM...');
  renderSidebarEpisodes(epId); // Vykreslí postranní panel s epizodami a označí aktivní.
  try {
    // Načte dostupné stream zdroje pro danou epizodu a zvukovou stopu.
    const res=await fetch(`${BRIDGE_API}/sources/${encodeURIComponent(epId)}?provider=${currentProvider}&version=${currentAudio}`);
    const result=await res.json();
    const sources=result.sources||[];
    if(!sources.length){showPlayerOverlay('// NO SOURCES AVAILABLE');toast('// No stream sources',true);return;}
    renderQualityButtons(sources); // Zobrazí tlačítka pro výběr kvality (1080p, 720p...).
    // Preferuje 1080p, pak 720p, jinak bere první dostupný zdroj.
    const best=sources.find(s=>s.quality==='1080p')||sources.find(s=>s.quality==='720p')||sources[0];
    loadStream(best.url);                            // Načte a přehraje stream.
    markWatched(currentAnimeData?.id,epId);          // Uloží epizodu jako zhlédnutou do localStorage.
    markWatchedUI(epId);                             // Vizuálně označí epizodu jako zhlédnutou.
    // Uloží do historie sledování (pro sekci "Pokračovat ve sledování").
    saveHistory({id:currentAnimeData?.id,name:currentAnimeData?.name,poster:currentAnimeData?.poster,malId:currentAnimeData?.malId,epId,epNum});
    // Automaticky aktualizuje průběh na MAL, pokud je uživatel přihlášen.
    if(malUser?.loggedIn && currentAnimeData?.malId) autoUpdateMal(currentAnimeData.malId,epNum);
  } catch(e){showPlayerOverlay('// STREAM FETCH FAILED');toast('// Source fetch failed',true);}
}

// Přepne mezi SUB (titulky) a DUB (dabing) a restartuje přehrávání aktuální epizody.
function switchAudio(v) {
  currentAudio=v;
  document.getElementById('btnSub').classList.toggle('active',v==='sub');
  document.getElementById('btnDub').classList.toggle('active',v==='dub');
  // Pokud se přehrává epizoda, znovu ji načte s novou zvukovou stopou.
  if(activeEpId){const n=document.getElementById('playerEpTitle').textContent.replace('// EPISODE ','').trim();playEpisode(activeEpId,n);}
}

// Vykreslí tlačítka pro výběr kvality streamu (1080p, 720p, AUTO...).
// První tlačítko je automaticky označeno jako aktivní.
function renderQualityButtons(sources) {
  document.getElementById('qualitySelector').innerHTML=sources.map((s,i)=>
    `<button class="quality-btn${i===0?' active':''}" onclick="switchQuality(this,'${escQ(s.url)}')">${s.quality||'AUTO'}</button>`
  ).join('');
}

// Přepne stream na jinou kvalitu — odstraní 'active' ze všech, označí kliknuté a načte URL.
function switchQuality(btn,url){document.querySelectorAll('.quality-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');loadStream(url);}

// Načte a přehraje video stream. Rozlišuje HLS (.m3u8) a přímé video soubory.
// HLS streamy jsou přesměrovány přes vlastní proxy (aby obešly CORS omezení).
function loadStream(url) {
  hidePlayerOverlay();
  const video=document.getElementById('videoPlayer');
  destroyHls(); // Zničí předchozí HLS instanci, pokud existuje.
  if(!url){showPlayerOverlay('// INVALID STREAM URL');return;}
  // Na produkci je proxy na stejné doméně, lokálně na portu 5000.
  const proxyBase = IS_PROD ? '/api/proxy' : 'http://localhost:5000/api/proxy';
  // HLS streamy (.m3u8) prochází přes proxy — přímé zdroje se přehrávají přímo.
  const streamUrl = url.includes('.m3u8') ? `${proxyBase}?url=${encodeURIComponent(url)}` : url;
  if(url.includes('.m3u8')&&Hls.isSupported()){
    // Použije HLS.js pro prohlížeče, které nepodporují nativní HLS (Chrome, Firefox).
    hls=new Hls({enableWorker:true});
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{})); // Spustí přehrávání po načtení manifestu.
    hls.on(Hls.Events.ERROR,(_,d)=>{if(d.fatal){showPlayerOverlay('// HLS ERROR — TRY ANOTHER QUALITY');toast('// HLS failed',true);}}); // Zobrazí chybu při fatálním HLS erroru.
  } else if(video.canPlayType('application/vnd.apple.mpegurl')&&url.includes('.m3u8')){
    // Safari podporuje HLS nativně — použije přímý src.
    video.src=streamUrl;video.play().catch(()=>{});
  } else{
    // Ostatní formáty (MP4 apod.) — přiřadí přímo jako src.
    video.src=url;video.play().catch(()=>{});
  }
}

// Zničí HLS.js instanci a uvolní paměť — volá se při přepnutí pohledu.
function destroyHls(){if(hls){hls.destroy();hls=null;}}
// Zobrazí překryvnou vrstvu přehrávače se zprávou (loading, error...).
function showPlayerOverlay(msg){document.getElementById('playerOverlayText').textContent=msg;document.getElementById('playerOverlay').classList.remove('hidden');}
// Skryje překryvnou vrstvu přehrávače.
function hidePlayerOverlay(){document.getElementById('playerOverlay').classList.add('hidden');}

// Vykreslí seznam epizod v postranním panelu přehrávače.
// Označí aktivní epizodu a zhlédnuté epizody. Po vykreslení odscrolluje na aktivní.
function renderSidebarEpisodes(activeId) {
  const watched=getWatched(currentAnimeData?.id);
  document.getElementById('sidebarEpisodes').innerHTML=currentEpisodes.map(ep=>{
    const id=ep.id,num=ep.number||'?',isW=watched.includes(String(id)),isA=String(id)===String(activeId);
    return `<button class="sidebar-ep-btn${isA?' active':''}${isW?' watched':''}" id="sidebar-ep-${CSS.escape(id)}" onclick="playEpisode('${escQ(id)}',${num})"><span>EP ${num}</span></button>`;
  }).join('');
  // Počká 100ms a pak odscrolluje na aktivní tlačítko (smooth scroll).
  setTimeout(()=>document.querySelector('.sidebar-ep-btn.active')?.scrollIntoView({block:'center',behavior:'smooth'}),100);
}

// Vrátí se z přehrávače zpět na detail view.
// Znovu vykreslí epizody a MAL tracker.
function backToDetail(){
  if(!currentAnimeData){showHome();return;}
  showView('detailView');
  renderEpisodes(currentEpisodes);
  if(currentAnimeData.malId) loadMalTracker(currentAnimeData.malId); // Znovu načte MAL status.
}

// ─── MAL (MyAnimeList) integrace ─────────────────────────────────────────────

// Přesměruje uživatele na MAL OAuth přihlašovací stránku.
function malLogin(){window.location.href=`${AUTH_BASE}/auth/mal/login`;}

// Odhlásí uživatele z MAL — zavolá server endpoint (smaže cookie),
// vynuluje lokální stav a aktualizuje UI.
async function malLogout(){
  await fetch(`${AUTH_BASE}/auth/mal/logout`,{method:'POST',credentials:'include'});
  malUser=null;
  document.getElementById('malLoggedIn').classList.add('hidden');
  document.getElementById('malLoggedOut').classList.remove('hidden');
  toast('// MAL: Logged out');
}

// Zkontroluje přihlášení do MAL při startu aplikace.
// Pokud je uživatel přihlášen, zobrazí avatar a uživatelské jméno v navigaci.
async function checkMalStatus(){
  try{
    const res=await fetch(`${AUTH_BASE}/auth/mal/status`,{credentials:'include'});
    const data=await res.json();
    malUser=data;
    if(data.loggedIn){
      document.getElementById('malLoggedOut').classList.add('hidden');
      document.getElementById('malLoggedIn').classList.remove('hidden');
      document.getElementById('malUsername').textContent=data.name;
      if(data.picture) document.getElementById('malAvatar').src=data.picture;
    }
  }catch(e){}
}

// Načte stav sledování anime z MAL účtu a zobrazí ho v tracker panelu.
// Pokud uživatel není přihlášen, zobrazí výzvu k přihlášení.
async function loadMalTracker(malId){
  if(!malId)return;
  if(!malUser?.loggedIn){document.getElementById('malLoginPrompt').classList.remove('hidden');return;}
  document.getElementById('malTracker').classList.remove('hidden');
  document.getElementById('malProgress').textContent='// LOADING...';
  try{
    const res=await fetch(`${AUTH_BASE}/api/mal/anime/${malId}`,{credentials:'include'});
    const data=await res.json();
    if(data.listed){
      // Anime je v seznamu — předvyplní status a skóre z MAL.
      document.getElementById('malStatus').value=data.status||'watching';
      document.getElementById('malScore').value=String(data.score||0);
      document.getElementById('malProgress').textContent=`// PROGRESS: ${data.progress}/${data.total||'?'} EPS`;
    }else{
      // Anime zatím v seznamu není — nastaví výchozí hodnoty.
      document.getElementById('malStatus').value='plan_to_watch';
      document.getElementById('malScore').value='0';
      document.getElementById('malProgress').textContent='// NOT IN YOUR LIST YET';
    }
  }catch(e){document.getElementById('malProgress').textContent='// MAL FETCH FAILED';}
}

// Uloží aktuální stav sledování a skóre na MAL prostřednictvím serveru.
async function saveMalStatus(){
  if(!currentAnimeData?.malId){toast('// No MAL ID for this anime',true);return;}
  if(!malUser?.loggedIn){toast('// Not logged in to MAL',true);return;}
  const status=document.getElementById('malStatus').value;
  const score=parseInt(document.getElementById('malScore').value)||0;
  try{
    const res=await fetch(`${AUTH_BASE}/api/mal/anime/${currentAnimeData.malId}`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,score})});
    const data=await res.json();
    if(data.ok) toast('// MAL: Updated ✓');
    else toast('// MAL update failed',true);
  }catch(e){toast('// MAL update failed',true);}
}

// Automaticky aktualizuje počet zhlédnutých epizod na MAL po přehrání epizody.
// Tiše selže — žádná chybová notifikace, aby nerušila přehrávání.
async function autoUpdateMal(malId,epNum){
  try{await fetch(`${AUTH_BASE}/api/mal/anime/${malId}`,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'watching',num_watched_episodes:epNum})});}catch(e){}
}

// ─── HISTORIE SLEDOVÁNÍ ───────────────────────────────────────────────────────

// Načte historii sledování z localStorage (záloha: cookie).
function getHistory(){try{const r=localStorage.getItem(HISTORY_KEY);return r?JSON.parse(r):[]}catch{return getCookieHistory();}}

// Uloží záznam do historie. Odstraní případný duplicitní záznam stejného anime,
// přidá nový na začátek a ořízne na maximálně 20 položek.
function saveHistory(entry){let h=getHistory().filter(x=>x.id!==entry.id);h.unshift({...entry,ts:Date.now()});h=h.slice(0,20);try{localStorage.setItem(HISTORY_KEY,JSON.stringify(h));}catch{setCookieHistory(h);}renderContinueWatching();}

// Smaže celou historii sledování (localStorage i cookie) a znovu vykreslí sekci.
function clearHistory(){localStorage.removeItem(HISTORY_KEY);setCookieHistory([]);renderContinueWatching();toast('// HISTORY CLEARED');}

// Vykreslí sekci "Pokračovat ve sledování" z uložené historie.
// Pokud je historie prázdná, skryje celou sekci.
function renderContinueWatching(){
  const history=getHistory(),section=document.getElementById('continueSection'),grid=document.getElementById('continueGrid');
  if(!history.length){section.style.display='none';return;}
  section.style.display='block';
  // Každá karta obsahuje miniaturní poster, název, číslo epizody a progress bar.
  grid.innerHTML=history.map(h=>`
    <div class="continue-card" onclick="resumeAnime('${escQ(h.id)}','${escQ(h.name)}','${escQ(h.poster||'')}','${escQ(h.epId)}',${h.epNum},${h.malId||'null'})">
      <img class="continue-thumb" src="${escQ(h.poster||'')}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2252%22 height=%2272%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%231e2029%22/></svg>'" />
      <div class="continue-info">
        <div class="continue-title">${h.name}</div>
        <div class="continue-ep">// EP ${h.epNum}</div>
        <div class="continue-progress"><div class="continue-progress-fill" style="width:30%"></div></div>
      </div>
    </div>`).join('');
}

// Obnoví sledování anime z historie — znovu načte epizody a spustí konkrétní epizodu.
async function resumeAnime(id,name,poster,epId,epNum,malId){
  currentAnimeData={id,name,poster,malId:malId||null};
  setStatus('LOADING...');
  try{const res=await fetch(`${BRIDGE_API}/anime/${encodeURIComponent(id)}?provider=${currentProvider}`);const data=await res.json();currentEpisodes=data.episodes||[];playEpisode(epId,epNum);}
  catch{toast('// Failed to resume',true);}
}

// Načte seznam zhlédnutých epizod pro dané anime z localStorage.
function getWatched(id){if(!id)return[];try{const r=localStorage.getItem(`watched_${id}`);return r?JSON.parse(r):[]}catch{return[];}}

// Označí epizodu jako zhlédnutou v localStorage (přidá ID do pole, pokud tam ještě není).
function markWatched(id,epId){if(!id)return;const w=getWatched(id);if(!w.includes(String(epId))){w.push(String(epId));try{localStorage.setItem(`watched_${id}`,JSON.stringify(w));}catch{}}}

// Vizuálně označí epizodu jako zhlédnutou v UI — přidá třídu 'watched'
// jak na tlačítko v gridu, tak na tlačítko v postranním panelu.
function markWatchedUI(epId){document.getElementById(`epbtn-${CSS.escape(epId)}`)?.classList.add('watched');document.getElementById(`sidebar-ep-${CSS.escape(epId)}`)?.classList.add('watched');}

// Uloží historii sledování do cookie (záloha pro případ, že localStorage není dostupný).
// Cookie vyprší za 1 rok.
function setCookieHistory(d){document.cookie=`${HISTORY_KEY}=${encodeURIComponent(JSON.stringify(d))}; max-age=${60*60*24*365}; path=/; SameSite=Lax`;}

// Načte historii sledování z cookie (záloha za localStorage).
function getCookieHistory(){const m=document.cookie.match(new RegExp(`(?:^|; )${HISTORY_KEY}=([^;]*)`));if(!m)return[];try{return JSON.parse(decodeURIComponent(m[1]));}catch{return[];}}

// Pomocná funkce pro escapování řetězců vkládaných do HTML atributů onclick="...".
// Ošetří zpětná lomítka, jednoduché uvozovky a dvojité uvozovky.
function escQ(s){return String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');}