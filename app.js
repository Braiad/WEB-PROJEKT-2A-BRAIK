/* =============================================
   ANIWATCH — app.js  (Anizone provider)
   ============================================= */

const BRIDGE_API  = 'http://localhost:5000/api';
const JIKAN_API   = 'https://api.jikan.moe/v4';
const HISTORY_KEY = 'aniwatch_history';

let currentView      = 'home';
let currentAnimeData = null;
let currentEpisodes  = [];
let currentSources   = [];
let activeEpId       = null;
let currentAudio     = 'sub';
let hls              = null;

document.addEventListener('DOMContentLoaded', () => {
  loadHomePage();
  renderContinueWatching();
  document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') triggerSearch();
  });
  document.getElementById('heroSearchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') triggerHeroSearch();
  });
});

function showView(name) {
  ['homeView','searchView','detailView','playerView'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  document.getElementById(name).classList.remove('hidden');
  currentView = name;
  if (name !== 'playerView') destroyHls();
}

function showHome() {
  showView('homeView');
  renderContinueWatching();
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3500);
}

function setStatus(msg) {
  document.getElementById('statusText').textContent = msg;
}

async function loadHomePage() {
  const now     = new Date();
  const seasons = ['WINTER','SPRING','SUMMER','FALL'];
  document.getElementById('seasonBadge').textContent =
    `${seasons[Math.floor(now.getMonth()/3)]} ${now.getFullYear()}`;
  await Promise.all([loadRecentFromAnizone(), loadTopRated()]);
}

async function loadRecentFromAnizone() {
  setStatus('FETCHING RECENT...');
  try {
    const res  = await fetch(`${BRIDGE_API}/recent`);
    const data = await res.json();
    if (data && data.length) {
      const seen = new Set(), animes = [];
      for (const ep of data) {
        const animeId = ep.animeId || ep.episodeId?.replace(/-episode-\d+$/,'') || ep.episodeId;
        const name    = ep.animeName || ep.animeTitle || animeId;
        const poster  = ep.animePoster || ep.thumbnail || '';
        if (!seen.has(animeId)) { seen.add(animeId); animes.push({id:animeId,name,posterImage:poster}); }
      }
      if (animes.length) { renderCards(animes,'airingGrid'); setStatus('SYSTEM ONLINE'); return; }
    }
  } catch(e) {}
  try {
    const res  = await fetch(`${JIKAN_API}/seasons/now?limit=18`);
    const data = await res.json();
    renderJikanCards(data.data||[],'airingGrid');
    setStatus('SYSTEM ONLINE');
  } catch(e) {
    document.getElementById('airingGrid').innerHTML =
      '<p style="color:var(--text-muted);font-family:var(--font-mono);font-size:.75rem;padding:20px 0">// FEED UNAVAILABLE</p>';
    setStatus('PARTIAL ERROR');
  }
}

async function loadTopRated() {
  try {
    const res  = await fetch(`${JIKAN_API}/top/anime?limit=18&type=tv`);
    const data = await res.json();
    renderJikanCards(data.data||[],'topGrid');
  } catch(e) {}
}

function renderCards(items, gridId) {
  const grid = document.getElementById(gridId);
  if (!items.length) { grid.innerHTML='<p style="color:var(--text-muted);font-family:var(--font-mono);font-size:.75rem;padding:20px 0">// NO DATA</p>'; return; }
  grid.innerHTML = items.map(item => {
    const title=item.name||item.title||'', poster=item.posterImage||item.poster||'', type=item.type||'', id=item.id||'';
    return `<div class="anime-card" onclick="openAnime('${escQ(id)}','${escQ(title)}','${escQ(poster)}')">
        <div class="card-poster-wrap">
          <img src="${escQ(poster)}" alt="${escQ(title)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22160%22 height=%22240%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%231e2029%22/><text x=%2250%25%22 y=%2250%25%22 fill=%22%236b7080%22 text-anchor=%22middle%22 font-size=%2212%22>NO IMG</text></svg>'" />
          <div class="card-overlay"><div class="card-play-btn">// VIEW</div></div>
        </div>
        <div class="card-info"><div class="card-title">${title}</div><div class="card-meta">${type}</div></div>
      </div>`;
  }).join('');
}

function renderJikanCards(items, gridId) {
  const grid = document.getElementById(gridId);
  if (!items.length) return;
  grid.innerHTML = items.map(item => {
    const title=item.title_english||item.title||'', poster=item.images?.jpg?.large_image_url||'';
    const score=item.score?item.score.toFixed(1):'', year=item.year||'', type=item.type||'', malId=item.mal_id;
    return `<div class="anime-card" onclick="openJikanAnime(${malId},'${escQ(title)}','${escQ(poster)}')">
        <div class="card-poster-wrap">
          <img src="${escQ(poster)}" alt="${escQ(title)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22160%22 height=%22240%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%231e2029%22/><text x=%2250%25%22 y=%2250%25%22 fill=%22%236b7080%22 text-anchor=%22middle%22 font-size=%2212%22>NO IMG</text></svg>'" />
          ${score?`<div class="card-score-badge">★ ${score}</div>`:''}
          <div class="card-overlay"><div class="card-play-btn">// VIEW</div></div>
        </div>
        <div class="card-info"><div class="card-title">${title}</div><div class="card-meta">${[type,year].filter(Boolean).join(' · ')}</div></div>
      </div>`;
  }).join('');
}

function triggerHeroSearch() {
  const q = document.getElementById('heroSearchInput').value.trim();
  if (!q) return;
  document.getElementById('searchInput').value = q;
  performSearch(q);
}

function triggerSearch() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  performSearch(q);
}

async function performSearch(query) {
  showView('searchView');
  document.getElementById('searchQueryLabel').textContent = `// "${query}"`;
  document.getElementById('searchGrid').innerHTML =
    `<div class="skeleton-grid">${Array(8).fill('<div class="skeleton-card"></div>').join('')}</div>`;
  document.getElementById('searchEmpty').classList.add('hidden');
  setStatus('SEARCHING...');
  try {
    const res  = await fetch(`${BRIDGE_API}/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!data.length) {
      document.getElementById('searchGrid').innerHTML='';
      document.getElementById('searchEmpty').classList.remove('hidden');
    } else {
      renderCards(data,'searchGrid');
    }
    setStatus('SYSTEM ONLINE');
  } catch(e) {
    document.getElementById('searchGrid').innerHTML='';
    document.getElementById('searchEmpty').innerHTML='<div class="empty-icon">// 500</div><p>Bridge offline. Is server.js running on :5000?</p>';
    document.getElementById('searchEmpty').classList.remove('hidden');
    setStatus('BRIDGE OFFLINE');
    toast('// SERVER OFFLINE: Run node server.js',true);
  }
}

async function openAnime(id, name, poster) {
  currentAnimeData = {id,name,poster};
  showDetailView({title:name,poster});
  await loadAnimeInfo(id);
}

async function openJikanAnime(malId, title, poster) {
  setStatus('RESOLVING...');
  try {
    const searchTitle = title.split(':')[0].trim();
    const res     = await fetch(`${BRIDGE_API}/search?q=${encodeURIComponent(searchTitle)}`);
    const results = await res.json();
    let jikanDetail = {};
    try { const jr=await fetch(`${JIKAN_API}/anime/${malId}`); const jd=await jr.json(); jikanDetail=jd.data||{}; } catch{}
    if (!results.length) {
      toast(`// "${searchTitle}" not found on Anizone`,true);
      showDetailView({title:jikanDetail.title_english||title,poster,synopsis:jikanDetail.synopsis,type:jikanDetail.type,year:jikanDetail.year,score:jikanDetail.score,episodes:jikanDetail.episodes,studio:jikanDetail.studios?.[0]?.name,status:jikanDetail.status,noSource:true});
      return;
    }
    const match = results[0];
    currentAnimeData = {id:match.id,name:match.name,poster:match.posterImage||poster};
    showDetailView({title:jikanDetail.title_english||match.name,poster:match.posterImage||poster,synopsis:jikanDetail.synopsis,type:match.type||jikanDetail.type,year:jikanDetail.year,score:jikanDetail.score,episodes:jikanDetail.episodes,studio:jikanDetail.studios?.[0]?.name,status:jikanDetail.status});
    await loadAnimeInfo(match.id);
    setStatus('SYSTEM ONLINE');
  } catch(e) { toast('// Failed to resolve anime',true); setStatus('ERROR'); }
}

async function loadAnimeInfo(id) {
  document.getElementById('epLoading').classList.remove('hidden');
  document.getElementById('episodeGrid').innerHTML='';
  try {
    const res  = await fetch(`${BRIDGE_API}/anime/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (data.data) {
      const info=data.data;
      if (info.description)   document.getElementById('detailSynopsis').textContent=info.description;
      if (info.status)        document.getElementById('detailStatus').textContent=info.status;
      if (info.totalEpisodes) document.getElementById('detailEps').textContent=info.totalEpisodes;
      if (info.type)          document.getElementById('detailType').textContent=info.type;
    }
    currentEpisodes = data.providerEpisodes||[];
    document.getElementById('epLoading').classList.add('hidden');
    if (!currentEpisodes.length) {
      document.getElementById('episodeGrid').innerHTML='<p style="color:var(--text-muted);font-family:var(--font-mono);font-size:.75rem">// NO EPISODES FOUND</p>';
      return;
    }
    renderEpisodes(currentEpisodes);
  } catch(e) { document.getElementById('epLoading').textContent='// FAILED TO LOAD EPISODES'; toast('// Episode fetch failed',true); }
}

function showDetailView(info) {
  showView('detailView');
  document.getElementById('detailPoster').src           = info.poster  ||'';
  document.getElementById('detailTitle').textContent    = info.title   ||'';
  document.getElementById('detailSynopsis').textContent = info.synopsis||'// No synopsis available.';
  document.getElementById('detailType').textContent     = info.type    ||'ANIME';
  document.getElementById('detailYear').textContent     = info.year    ||'';
  document.getElementById('detailStatus').textContent   = info.status  ||'';
  document.getElementById('detailScore').textContent    = info.score   ?`★ ${info.score}`:'—';
  document.getElementById('detailEps').textContent      = info.episodes||'?';
  document.getElementById('detailStudio').textContent   = info.studio  ||'—';
  document.getElementById('detailHeroBg').style.backgroundImage=`url('${info.poster||''}')`;
  document.getElementById('episodeGrid').innerHTML='';
  document.getElementById('epLoading').classList.remove('hidden');
  window.scrollTo({top:0,behavior:'smooth'});
}

function renderEpisodes(episodes) {
  const watched = getWatched(currentAnimeData?.id);
  document.getElementById('episodeGrid').innerHTML = episodes.map(ep => {
    const epId=ep.episodeId, num=ep.episodeNumber||'?', isW=watched.includes(String(epId));
    return `<button class="ep-btn${isW?' watched':''}" id="epbtn-${CSS.escape(epId)}" onclick="playEpisode('${escQ(epId)}',${num})">EP ${num}</button>`;
  }).join('');
}

function filterEpisodes() {
  const q = document.getElementById('epSearch').value.trim().toLowerCase();
  document.querySelectorAll('.ep-btn').forEach(btn => {
    btn.style.display = btn.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

async function playEpisode(epId, epNum) {
  activeEpId = epId;
  document.querySelectorAll('.ep-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById(`epbtn-${CSS.escape(epId)}`)?.classList.add('active');
  showView('playerView');
  document.getElementById('playerAnimeTitle').textContent = currentAnimeData?.name||'';
  document.getElementById('playerEpTitle').textContent    = `// EPISODE ${epNum}`;
  document.getElementById('qualitySelector').innerHTML    = '';
  showPlayerOverlay('// FETCHING STREAM...');
  renderSidebarEpisodes(epId);
  try {
    const res    = await fetch(`${BRIDGE_API}/sources/${encodeURIComponent(epId)}?version=${currentAudio}`);
    const result = await res.json();
    currentSources = result.sources||[];
    if (!currentSources.length) { showPlayerOverlay('// NO SOURCES AVAILABLE'); toast('// No stream sources returned',true); return; }
    renderQualityButtons(currentSources);
    const best = currentSources.find(s=>s.quality==='1080p')||currentSources.find(s=>s.quality==='720p')||currentSources[0];
    loadStream(best.url);
    markWatched(currentAnimeData?.id,epId);
    markWatchedUI(epId);
    saveHistory({id:currentAnimeData?.id,name:currentAnimeData?.name,poster:currentAnimeData?.poster,epId,epNum});
  } catch(e) { showPlayerOverlay('// STREAM FETCH FAILED — IS BRIDGE RUNNING?'); toast('// Source fetch failed',true); }
}

function switchAudio(version) {
  currentAudio = version;
  document.getElementById('btnSub').classList.toggle('active', version==='sub');
  document.getElementById('btnDub').classList.toggle('active', version==='dub');
  if (activeEpId) {
    const epNum = document.getElementById('playerEpTitle').textContent.replace('// EPISODE ','').trim();
    playEpisode(activeEpId, epNum);
  }
}

function renderQualityButtons(sources) {
  document.getElementById('qualitySelector').innerHTML = sources.map((s,i) =>
    `<button class="quality-btn${i===0?' active':''}" onclick="switchQuality(this,'${escQ(s.url)}')">${s.quality||'AUTO'}</button>`
  ).join('');
}

function switchQuality(btn, url) {
  document.querySelectorAll('.quality-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  loadStream(url);
}

function loadStream(url) {
  hidePlayerOverlay();
  const video = document.getElementById('videoPlayer');
  destroyHls();
  if (!url) { showPlayerOverlay('// INVALID STREAM URL'); return; }
  const streamUrl = url.includes('.m3u8')
    ? `http://localhost:5000/api/proxy?url=${encodeURIComponent(url)}`
    : url;
  if (url.includes('.m3u8') && Hls.isSupported()) {
    hls = new Hls({enableWorker:true});
    hls.loadSource(streamUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, ()=>video.play().catch(()=>{}));
    hls.on(Hls.Events.ERROR, (_,data)=>{ if(data.fatal){ showPlayerOverlay('// HLS ERROR — TRY ANOTHER QUALITY'); toast('// HLS playback failed',true); }});
  } else if (video.canPlayType('application/vnd.apple.mpegurl') && url.includes('.m3u8')) {
    video.src = streamUrl; video.play().catch(()=>{});
  } else {
    video.src = url; video.play().catch(()=>{});
  }
}

function destroyHls() { if(hls){hls.destroy();hls=null;} }
function showPlayerOverlay(msg) { document.getElementById('playerOverlayText').textContent=msg; document.getElementById('playerOverlay').classList.remove('hidden'); }
function hidePlayerOverlay() { document.getElementById('playerOverlay').classList.add('hidden'); }

function renderSidebarEpisodes(activeId) {
  const watched = getWatched(currentAnimeData?.id);
  document.getElementById('sidebarEpisodes').innerHTML = currentEpisodes.map(ep => {
    const id=ep.episodeId, num=ep.episodeNumber||'?';
    const isW=watched.includes(String(id)), isA=String(id)===String(activeId);
    return `<button class="sidebar-ep-btn${isA?' active':''}${isW?' watched':''}" id="sidebar-ep-${CSS.escape(id)}" onclick="playEpisode('${escQ(id)}',${num})"><span>EP ${num}</span></button>`;
  }).join('');
  setTimeout(()=>{ document.querySelector('.sidebar-ep-btn.active')?.scrollIntoView({block:'center',behavior:'smooth'}); },100);
}

function backToDetail() {
  if (!currentAnimeData) { showHome(); return; }
  showView('detailView');
  renderEpisodes(currentEpisodes);
}

function getHistory() {
  try { const raw=localStorage.getItem(HISTORY_KEY); return raw?JSON.parse(raw):[]; }
  catch { return getCookieHistory(); }
}

function saveHistory(entry) {
  let h = getHistory().filter(x=>x.id!==entry.id);
  h.unshift({...entry,ts:Date.now()});
  h = h.slice(0,20);
  try { localStorage.setItem(HISTORY_KEY,JSON.stringify(h)); } catch { setCookieHistory(h); }
  renderContinueWatching();
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  setCookieHistory([]);
  renderContinueWatching();
  toast('// HISTORY CLEARED');
}

function renderContinueWatching() {
  const history=getHistory(), section=document.getElementById('continueSection'), grid=document.getElementById('continueGrid');
  if (!history.length) { section.style.display='none'; return; }
  section.style.display='block';
  grid.innerHTML = history.map(h=>`
    <div class="continue-card" onclick="resumeAnime('${escQ(h.id)}','${escQ(h.name)}','${escQ(h.poster||'')}','${escQ(h.epId)}',${h.epNum})">
      <img class="continue-thumb" src="${escQ(h.poster||'')}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2252%22 height=%2272%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%231e2029%22/></svg>'" />
      <div class="continue-info">
        <div class="continue-title">${h.name}</div>
        <div class="continue-ep">// EP ${h.epNum}</div>
        <div class="continue-progress"><div class="continue-progress-fill" style="width:30%"></div></div>
      </div>
    </div>`).join('');
}

async function resumeAnime(id, name, poster, epId, epNum) {
  currentAnimeData = {id,name,poster};
  setStatus('LOADING...');
  try {
    const res=await fetch(`${BRIDGE_API}/anime/${encodeURIComponent(id)}`);
    const data=await res.json();
    currentEpisodes = data.providerEpisodes||[];
    playEpisode(epId,epNum);
  } catch { toast('// Failed to resume — bridge offline?',true); }
}

function getWatched(animeId) {
  if (!animeId) return [];
  try { const raw=localStorage.getItem(`watched_${animeId}`); return raw?JSON.parse(raw):[]; } catch { return []; }
}

function markWatched(animeId, epId) {
  if (!animeId) return;
  const w=getWatched(animeId);
  if (!w.includes(String(epId))) { w.push(String(epId)); try{localStorage.setItem(`watched_${animeId}`,JSON.stringify(w));}catch{} }
}

function markWatchedUI(epId) {
  document.getElementById(`epbtn-${CSS.escape(epId)}`)?.classList.add('watched');
  document.getElementById(`sidebar-ep-${CSS.escape(epId)}`)?.classList.add('watched');
}

function setCookieHistory(data) {
  document.cookie=`${HISTORY_KEY}=${encodeURIComponent(JSON.stringify(data))}; max-age=${60*60*24*365}; path=/; SameSite=Lax`;
}
function getCookieHistory() {
  const m=document.cookie.match(new RegExp(`(?:^|; )${HISTORY_KEY}=([^;]*)`));
  if (!m) return [];
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return []; }
}

function escQ(str) {
  return String(str||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
}
