# ANIWATCH // SYSTEM DOCUMENTATION

A local anime streaming site for you and your friends.
Eva-inspired hybrid UI. Animepahe backend via NervHQ (Kenjitsu).

---

## ARCHITECTURE

```
Browser (index.html + app.js)
        ↓  HTTP :5000
server.js  (Express bridge — resolves Kwik m3u8)
        ↓  HTTP :3000
NervHQ / Kenjitsu  (your cloned repo — scrapes Animepahe)
        ↓
animepahe.si / kwik.si
```

---

## SETUP

### 1. Start NervHQ (Kenjitsu)

```bash
cd nervhq
pnpm install   # or npm install
pnpm dev       # starts on http://localhost:3000
```

Verify it works:
```bash
curl "http://localhost:3000/api/animepahe/anime/search?q=evangelion"
```

### 2. Start the Bridge

```bash
cd aniwatch
npm install
node server.js   # starts on http://localhost:5000
```

Or use watch mode during dev:
```bash
node --watch server.js
```

Health check:
```bash
curl http://localhost:5000/api/health
```

### 3. Open the Frontend

Open `index.html` in a browser. You can use VS Code Live Server, or:

```bash
npx serve .   # serves on http://localhost:3000 (pick a different port)
```

Or just open the file directly — `file:///path/to/aniwatch/index.html`.
CORS is handled by the bridge so file:// works fine.

---

## SHARING WITH FRIENDS (LAN)

1. Find your local IP:
   - Windows: `ipconfig`
   - Mac/Linux: `ifconfig` or `ip addr`

2. In `app.js`, change line 7:
   ```js
   const BRIDGE_API = 'http://192.168.X.X:5000/api';
   ```

3. Make sure Windows Firewall / ufw allows port 5000.

4. Share `index.html` (or host it) — friends open it in their browser.

---

## API ROUTES (Bridge)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/health` | Check if bridge + NervHQ are up |
| GET | `/api/search?q=:query` | Search anime |
| GET | `/api/episodes/:session` | Get episode list |
| GET | `/api/sources/:episodeSession` | Get stream URLs (m3u8) |

---

## KWIK URL RESOLUTION

Animepahe sources are Kwik embed pages, not direct streams.
The bridge handles extraction automatically via 3 methods:
1. Direct m3u8 in page HTML
2. Unpacking obfuscated `eval(function(p,a,c,k,e,d){...})` JS
3. POST token redirect

If streams fail, try opening `http://localhost:5000/api/health` first
to confirm NervHQ is responding.

---

## COOKIES / HISTORY

- Watch history is stored in `localStorage` (falls back to cookies)
- Per-episode watched state is stored as `watched_{animeSession}` keys
- History stores last 20 watched anime
- Clear button on homepage wipes everything

---

## FUTURE PLANS (when you're ready)

- **AniList/MAL login** — OAuth2, store token in cookie, sync watch state
- **Forum** — WebSocket-based or simple REST with SQLite
- **Waifu.im / waifu.pics API** — `/fanart` page, no auth needed
- **Second provider** — Add Anizone: register routes in server.js, add
  provider selector to navbar, prefix API calls with provider slug
- **HTTPS** — Use `caddy` or `nginx` as reverse proxy when sharing publicly

---

## TROUBLESHOOTING

| Symptom | Fix |
|---------|-----|
| Search returns nothing | Check NervHQ is running: `curl localhost:3000/api/animepahe/anime/search?q=test` |
| Streams fail | Check `/api/health`. Kwik blocks may have changed — check server logs |
| CORS errors | Bridge already handles CORS — make sure you're hitting :5000 not :3000 |
| HLS error in browser | Try a different quality button in the player |
| Episodes list empty | NervHQ session format may differ — check `node server.js` logs |
