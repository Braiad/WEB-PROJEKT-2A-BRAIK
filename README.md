## app.js

### Konfigurace a globální stav

Úplně nahoře jsou konstanty. `IS_PROD` je boolean zjistí jestli běžíš na produkci nebo lokálně tím, že se podívá na `window.location.hostname`. Pokud není `localhost`, jsme na produkci. Na základě toho se nastaví `BRIDGE_API` - buď relativní `/api` (produkce), nebo `http://localhost:5000/api` (lokální vývoj). Tohle je důležité protože na Railway běží frontend i backend na stejné doméně.

Pak jsou globální proměnné stavu - `currentView`, `currentProvider`, `currentAnimeData`, `currentEpisodes`, `activeEpId`, `currentAudio`, `malUser`, `hls`. Tyhle proměnné jsou sdílené napříč celou aplikací. Žádný framework, žádný React state -jen plain JavaScript proměnné. Tohle je záměrné -aplikace je single-page app bez jakéhokoli frameworku.

---

### Inicializace -DOMContentLoaded

Když se načte stránka, spustí se čtyři věci najednou: `loadHomePage()`, `renderContinueWatching()`, `checkMalStatus()`, a přidají se dva event listenery na Enter v obou vyhledávacích polích. Tohle je vstupní bod celé aplikace.

---

### Systém pohledů (views)

Aplikace má čtyři "stránky" -`homeView`, `searchView`, `detailView`, `playerView` -ale jsou to vlastně jen divy v jednom HTML souboru. Funkce `showView()` vždycky skryje všechny čtyři přidáním CSS třídy `hidden`, pak zobrazí tu požadovanou odebráním `hidden`. Pokud odcházíme z přehrávače, zároveň zavolá `destroyHls()` aby uvolnil paměť.

---

### Poskytovatelé (providers)

`currentProvider` určuje odkud se berou streamy -`anizone`, `hianime`, nebo `animepahe`. `switchProvider()` aktualizuje tuhle proměnnou, označí správné tlačítko v UI, a pak znovu načte obsah podle toho kde zrovna jsme. `switchPlayerProvider()` dělá totéž ale z přehrávače -navíc spustí `reloadAnimeForProvider()`, která vyhledá to samé anime u nového poskytovatele a přehraje první epizodu.

---

### Domovská stránka

`loadHomePage()` vypočítá aktuální sezónu (WINTER/SPRING/SUMMER/FALL z čísla měsíce), zobrazí ji v badge, a pak paralelně spustí `loadRecent()` a `loadTopRated()` pomocí `Promise.all` -takže obě sekce se načítají zároveň, ne za sebou.

`loadRecent()` má záložní systém. Nejdřív zkusí vlastní bridge server. Pokud data vypadají jako seznam epizod (mají `episodeId` nebo `episodeNumber`), deduplikuje je na anime -každé anime zobrazí jen jednou i když má víc nových epizod. Pokud vlastní server selže úplně, záloha je Jikan API (neoficiální MAL API). Pokud selže i to, zobrazí `// FEED UNAVAILABLE`.

`loadTopRated()` jde vždy přes Jikan API -top TV seriály podle MAL skóre.

---

### Vykreslování karet

Jsou dvě funkce -`renderCards()` pro data z vlastního serveru, a `renderJikanCards()` pro data z Jikan API. Obě generují HTML string pomocí `.map()` a `.join('')` a vloží ho do gridu přes `innerHTML`. Rozdíl je v tom, že Jikan karty navíc zobrazují skóre (odznak v rohu posteru) a volají `openJikanAnime()` místo `openAnime()` při kliknutí -protože Jikan karty mají MAL ID, ne stream ID.

---

### Vyhledávání

`triggerSearch()` a `triggerHeroSearch()` jsou jen wrappery -zkontrolují jestli je dotaz neprázdný a zavolají `performSearch()`. Hero search navíc zkopíruje dotaz do nav pole.

`performSearch()` přepne na search view, okamžitě zobrazí 8 skeleton karet jako placeholder, pak zavolá bridge API. Po odpovědi buď vykreslí výsledky, nebo zobrazí prázdný stav. Při selhání serveru zobrazí `// 500` a `BRIDGE OFFLINE`.

---

### Otevření detailu

`openAnime()` -pro karty z vlastního poskytovatele. Uloží data do `currentAnimeData`, okamžitě zobrazí detail s dostupnými základními daty, pak asynchronně dotáhne epizody.

`openJikanAnime()` -složitější, protože Jikan karty mají MAL ID ale ne stream ID. Musí nejdřív vyhledat anime u poskytovatele, zároveň paralelně načte podrobná Jikan metadata, a pak zkombinuje obojí. Pokud anime u poskytovatele nenajde, zobrazí detail jen s MAL metadaty bez epizod.

`loadAnimeInfo()` dotáhne epizody ze serveru a doplní metadata do already-zobrazeného detailu. Zobrazí loading indikátor, pak vykreslí epizody nebo chybovou zprávu.

---

### Přehrávání

`playEpisode()` je nejkomplexnější funkce v celém souboru. Postupně:
1. Uloží `activeEpId`
2. Označí správné ep tlačítko jako aktivní
3. Přepne na player view
4. Zobrazí overlay s "FETCHING STREAM..."
5. Vykreslí sidebar s epizodami
6. Zavolá bridge API pro stream zdroje
7. Vybere nejlepší kvalitu -preferuje 1080p, pak 720p, jinak první dostupný
8. Spustí `loadStream()`
9. Označí epizodu jako zhlédnutou v localStorage
10. Uloží do historie
11. Pokud je uživatel přihlášen do MAL, automaticky aktualizuje průběh

`loadStream()` rozlišuje typy streamů. HLS streamy (`.m3u8`) jdou přes vlastní proxy na serveru -to je proto, že původní servery blokují přímé požadavky z prohlížeče kvůli CORS. Na Chrome a Firefox použije HLS.js knihovnu. Na Safari použije nativní HLS podporu. Ostatní formáty (MP4) přehraje přímo.

`switchAudio()` přepne mezi SUB a DUB a restartuje přehrávání aktuální epizody -zavolá znovu `playEpisode()` se stejným ID.

---

### MAL integrace

`malLogin()` přesměruje na server endpoint `/auth/mal/login` který spustí OAuth flow.

`checkMalStatus()` se volá při startu -zavolá server a pokud vrátí `loggedIn: true`, zobrazí avatar a jméno v navigaci.

`loadMalTracker()` načte stav sledování pro konkrétní anime -status (watching/completed/...) a skóre -a předvyplní selecty v tracker panelu. Nepřihlášeným zobrazí výzvu k přihlášení.

`saveMalStatus()` odešle změny na server který je přepošle na MAL API.

`autoUpdateMal()` se volá tiše po každém přehraném epizodě -aktualizuje počet zhlédnutých epizod na MAL bez jakékoli notifikace.

---

### Historie sledování

`saveHistory()` uloží záznam do localStorage -nejdřív odstraní případnou duplicitu stejného anime, přidá nový záznam na začátek, a ořízne na max 20 položek. Záloha je cookie pro případ že localStorage není dostupný.

`renderContinueWatching()` přečte historii a vykreslí karty v sekci "Continue Watching". Prázdná historie celou sekci skryje.

`getWatched()` / `markWatched()` / `markWatchedUI()` -tři funkce pro sledování zhlédnutých epizod. Data jdou do localStorage pod klíčem `watched_{animeId}`. `markWatchedUI()` přidá CSS třídu `watched` na tlačítko -CSS pak zobrazí zelenou fajfku.

`escQ()` je pomocná funkce na konci -escapuje speciální znaky v řetězcích které se vkládají do HTML `onclick` atributů, aby nezlomily kód.

---

## server.js

Server má tři role. Za prvé je **bridge** -přeposílá požadavky na interní NervHQ API a normalizuje odpovědi do jednotného formátu. Každý poskytovatel (anizone, hianime, animepahe) má vlastní konfiguraci v objektu `PROVIDERS` -prefix URL, jak mapovat data, jestli jsou epizody součástí info endpointu nebo na zvláštním endpointu. Za druhé je **HLS proxy** -stáhne `.m3u8` manifesty, přepíše všechny URL v nich aby procházely znovu přes proxy, a tak obejde CORS omezení. Za třetí spravuje **MAL OAuth** přes PKCE flow -vygeneruje verifikátor, přesměruje na MAL, přijme callback s kódem, vymění ho za token a uloží do HttpOnly cookie.

## style.css

Celý design je postavený na CSS proměnných v `:root` -barevná paleta (tmavé odstíny šedé, modrá, fialová, zlatá), tři fonty (Share Tech Mono pro UI, Orbitron pro nadpisy, Inter pro text). Scanlines efekt je `position:fixed` div přes celou stránku s `repeating-linear-gradient` a animací posunu -simuluje CRT monitor. Navigace má `backdrop-filter:blur` pro glassmorphism efekt. Skeleton karty mají shimmer animaci přes `background-size:200%` a posun gradientu. Přehrávač má `z-index:100` aby byl nad scanlines vrstvou.

---