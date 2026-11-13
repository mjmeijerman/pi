---
name: achterhoek-agenda
description: "Builds a complete overview of all activities (small or large) in the Dutch Achterhoek region for a given date window. Queries the regional events API (achterhoek.nl), theater sites, municipal agendas and local sources; outputs a dated Dutch overview. Self-updating: after each run it appends newly discovered sources to its resource registry so later runs get faster and more complete."
---

# Achterhoek Activities Overview

## Goal

Produce a COMPLETE overview of all activities in the Achterhoek (all municipalities: Aalten, Berkelland, Bronckhorst, Doesburg, Doetinchem, Lochem, Montferland, Oost Gelre, Oude IJsselstreek, Winterswijk, Zutphen) for a date window. Output in Dutch, event names as published, organized by date. No activity is too small (library workshops, village feasts, markets count).

## LEGAL & DATA POLICY (gebruikersbesluit — altijd naleven)

Het verzamelde overzicht mag gebruikt worden voor een publieke website ZONDER embed, licentie-aanvraag of data-feed. Om legal gezeik te voorkomen gelden deze regels:

- **Alleen feiten verzamelen/publiceren**: titel, datum(tijd), plaats, prijs, link. Geen omschrijvingsteksten, afbeeldingen, logo's of foto's van bronnen kopiëren (auteursrecht). `text`-veld van de events-API NIET meenemen; hooguit een eigen korte formulering (max ~1 zin, eigen woorden) of helemaal geen beschrijving.
- **ALTEMD originele website als link**: elk event linkt ALLEEN naar de originele website van het event zelf (organisator/club/zaal). Overkoepelende agenda's (achterhoek.nl, achterhoekpromotie.nl, gemeente-agenda's zoals lochem.nl/agenda-met-evenementen) zijn NOOIT geldige links. Vind de originele site via: (1) het `website`-veld van de achterhoek.nl-events-API, (2) de "website www.X.nl"-regel op achterhoekpromotie-detailpagina's, (3) websearch. Is de originele website niet te vinden → het event WEGLATEN (niet met een aggregator-link opnemen).
- **Altijd linken naar de originele evenementenpagina** bij elk item (attributie + verkeer terug).
- **Geen systematische bulk-extractie** (databankrecht/sui generis): alleen venstergerichte ophaalrondes per aanvraag (dit is al de werkwijze), niet de hele database weghalen en publiceren.
- **AVG**: geen persoonsgegevens van individuen publiceren (privé telefoonnummers/e-mails van organisatoren niet tonen; organisatiegegevens alleen neutraal).
- **Takedown-regel**: in de site-output een disclaimer/takedown opnemen ("bron vermeldt een fout of wil niet vermeld worden → melden, verwijderen binnen 48u").
- Niet embedden, geen licentie/feed-aanvragen — feiten + links volstaan.

## Step 0 — Window

Run `date`. Window = today .. today+21 days. Format both as `YYYY-MM-DD`.

## Step 1 — Bronnen in PRIORITEITSvolgorde (org-agenda's eerst, overkoepelende agenda's als laatste check)

### 1a. Organisatie-eigen agenda's (PRIORITEIT — gebruik eerst)
Bij gevonden events is vrijwel altijd een eigen agenda van de organisatie te vinden (zaal, museum, club, stichting). Die eventpagina's zijn de beste links en de beste bron.
- Per organisatie de eigen agenda-URL in de registry bijhouden (sectie "Organisatie-agenda's") en bij elke run bijwerken.
- Bekende org-agenda's: Amphion, Hanzehof, Theater De Storm, musea (MORE Gorssel, Villa Mondriaan, Smedekinck, Museum de Scheper, Nationaal Onderduikmuseum…), DRU Ulft, bridgeclubs (bridge.nl-clubpagina's), vriendenvandedorpskerkvorden.nl, fruitbedrijfhorstink.nl, stichtingberkelzomp.nl, glk.nl, poortvangelre.op-shop.nl (bibliotheek West-Achterhoek), lichtenvoorde.nl, 100procentwinterswijk.nl…
- Laat de overkoepelende agenda's (achterhoek.nl + achterhoekpromotie.nl) alleen als LAATSTE controle dienen: zie je daar events die nog niet via org-agenda's binnenkwamen? Dan die org-agenda alsnog toevoegen en het event ophalen.

### 1b. achterhoek.nl events API (overkoepelend — laaste check op gemiste events)
Municipalities and venues feed it. Use the JSON API, do NOT scrape the marketing pages:

```bash
curl "https://achterhoek.nl/events-api?createdby=1&order=ASC&place=&datefrom=$FROM&dateto=$TO&filterids=&categoryId=556"
```

- `categoryId=556` = ALL events. ALSO fetch the category ids below; the "all" query misses some (notably exhibitions):
  festivals=1979, theater=1981, streekcultuur=1982, eten-en-drinken=1983, muziek-en-uitgaan=1984, films=1985, kids-en-jeugd=1986, wandel-en-fietstochten=1987, corso-en-optocht=1988, tentoonstellingen=1949
- Event fields: `title`, `start_date`/`end_date` (format "YYYY-MM-DD HH:MM:SS"), `city`, `address`, `website`, `slug` → URL = "https://achterhoek.nl" + slug. Per de legal-policy: het `text`-veld NIET meenemen in de output (alleen feiten + link). Gebruik het `website`-veld als originele event-link (niet de achterhoek.nl-slug-URL).
- Merge all responses and DEDUPE by `event_id` (events appear in multiple categories; also true title-duplicates exist, e.g. "Buiten Bios Lochem"/"BuitenBios Lochem" — merge manually by title).
- Keep events whose range overlaps the window (ongoing exhibitions included).

### 1c. achterhoekpromotie.nl agenda (overkoepelend — laaste check op gemiste events)
Veel dorpsfeesten/kermissen/markten staan ALLEEN hier, nooit in de achterhoek.nl API (verified: Halse Dag Halle, Kermis Zutphen, Septemberfeest Borculo, Najaarskermis Doetinchem, TrialGP Zelhem, Volksfeest Winterswijk, Bloemencorso Beltrum, 7even Festival Gaanderen, ...). Gebruik als aanvulling/controle op 1a en 1b.

```bash
curl -A "Mozilla/5.0" "https://www.achterhoekpromotie.nl/evenementen/agenda.php?start=YYYYMM01"
curl -A "Mozilla/5.0" "https://www.achterhoekpromotie.nl/evenementen/agenda.php?start=YYYYMM06"
```

- Fetch for every month overlapping the window (both the 01 and 06 anchors; pages overlap, dedupe by title+place).
- Parse blocks: `<div class="agenda-event"><h2>Title</h2></div>` + `<div class="agenda-datum"><h2>Place - Dutch date text</h2></div>` + category + omschrijving + `Meer info` link `/evenementen/agenda/<year>/<id>/<slug>`.
- Dates are Dutch text ("Woensdag 2 t/m zondag 6 september 2026") — parse month/year, treat "t/m" as a range, assume same year if not stated.
- Originale website: detailpagina's bevatten een "website www.X.nl"-regel → extract en gebruik als event-link; geen link naar achterhoekpromotie.nl zelf.
- Filter to Achterhoek municipalities ONLY — EXCLUDE Liemers: Duiven, Zevenaar, Westervoort, Groessen, Loil, Aerdt, Herwen, Tolkamer, Spijk, Ooy, Giesbeek, Pannerden (all Zevenaar/Duiven/Westervoort area).

## Step 2 — Theaters (add their unique events)

- **Amphion Doetinchem**: fetch `/theater/page1` .. `/theater/page8`. Parse `<section class="show" data-url="/theater/<slug>/<dd-mm-yyyy-hh-mm>/"`; title = `<a class="title">`, subtitle = `<span class="subtitle">`. Convert dd-mm-yyyy to ISO **before** comparing (string compare on dd-mm vs yyyy-mm-dd silently fails).
- **Hanzehof Zutphen**: `/nl/programma` lists `/nl/voorstelling/<slug>/` links; each page has dates as Dutch text "21 augustus 2026".
- **Theater De Storm Winterswijk**: `/voorstelling/` pages, regex `\d{1,2} (augustus|september|oktober) \d{4}`. Seizoen start medio september; in de zomer vooral openlucht-theater.
- Kleine podia (seizoensgebonden, check bij theaterweken): Rietveld Theater Lochem (vrijwilligerstheater, onregelmatig programma — check per week), Boogie Woogie Winterswijk (cultuurcentrum; agenda is schooljaar-gebonden — actief sep-jun), DRU Cultuurfabriek Ulft, De Pluu (Montferland), Cultuurhuus Aalten.

## Step 3 — LINK-VERIFICATIE EN TEKSTKWALITEIT (verplicht, vóór output)

- **Links moeten op de EVENT-pagina uitkomen**, niet op een landingspagina, hoofdpagina of oude/jaar-gebonden pagina:
  - Statuscheck is onvoldoende (200 ≠ juiste pagina). Controleer de inhoud: de eventtitel (of een sterk onderscheidend deel ervan) moet in de paginatekst voorkomen (diakritiek-neutraal: poëet≈poeet).
  - **Deep-link-detectie**: is de url een organisator-homepage (of klopt de inhoud niet) → zoek op die pagina de interne link naar het event (link-tekst of slug met titelwoorden, score≥1, geen social/aggregator-links) en gebruik díe pagina. Andere domeinen/subdomeinen van dezelfde organisatie zijn toegestaan (bv. museummore-kasteelruurlo.nl → moreruurlo.nl; www → development.); de content-verificatie is de echte controle.
  - Let op oude jaargangen in de URL (bv. `plukdagen-2023/` terwijl het event 2026 is → juiste link `plukdagen/`).
  - Landings-/hoofdpagina-links (bv. museumhomepage i.p.v. de agenda-item-pagina) → zoek de juiste eventpagina (vaak `/agenda-activiteiten/…`, `/event/…` of `/activiteiten/…`).
  - Homepage-links zijn alleen ok als de organisatie klein/eenduidig is (de site IS het event, bv. britishweekend.nl) of als er geen diepere eventpagina bestaat.
  - Is de juiste eventpagina niet te achterhalen (organisatie-site-search, websearch) → event weglaten.
  - Geverifieerde voorbeelden: Oldtimerdag Smedekinck = `development.museumsmedekinck.nl/agenda-activiteiten/zelhemse-oldtimerdag`; Fruitplukdagen = `fruitbedrijfhorstink.nl/beleving/plukdagen/`; Zomeravondconcert Dutch Swing College Band = `vriendenvandedorpskerkvorden.nl/event/zomeravondconcert-dutch-swing-college-band/`; mini-verhaal bibliotheek = `poortvangelre.op-shop.nl/7002/…`; Louis Nijhuis = `museumfabriekwinterswijk.nl/panorama_winterswijk_louis_nijhuis/`; Chagall = `laliquemuseum.nl/nu-te-zien/tentoonstelling-marc-chagall/`; Sam Drukker = `moreruurlo.nl/tentoonstellingen/sam-drukker-de-ouder-wordende-mens/`; Zij aan Zij = `villamondriaan.nl/tentoonstellingen/zij-aan-zij-mondriaan-in-dialoog/`; Vikingzwaard = `stadsmuseumdoetinchem.nl/agenda/het-vikingzwaard/`.
- **Leden-only clubevents**: als de eventpagina aangeeft dat het voor leden is ("voor leden", inschrijving via club) → weglaten, tenzij het ledenwerving is (open dag, kennismaking). Voorbeeld: LTC Zelhem Clubfestijn mét Bingo bleek leden-only → verwijderd. Bij twijfel de pagina lezen vóór opnemen.
- **Tekstkwaliteit**: alle opgeslagen teksten (titel, samenvatting) checken op taal, spelling en stijl (Nederlands, geen Engelse restanten, geen typefouten, consistente stijl). Typeclassificatie controleren: pas op dat `college` in een naam (bv. "Dutch Swing College Band") géén cursus/workshop oplevert.
- **Samenvatting = kern van het event, uit de eigen website**: de samenvatting op kaart/modal vat de TEKST van de eventpagina zelf samen — wát het is, waar, voor wie, hoogtepunten — in eigen woorden, 1–3 zinnen (max ~320 tekens). De pipeline haalt hiervoor de paginatekst op (wordt al gefetcht voor de link-check), scoort zinnen op titelwoorden en filtert navigatie/openingstijden/cookie-teksten. SANITY-CHECK verplicht vóór publicatie: geen navigatieregels, openingstijden, cookie-/privacy-tekst, 'Zoekresultaten gevonden', menu-opsommingen of leidende titel-/jaar-herhalingen; niet-leesbaar → type-sjabloon als fallback. Samenvattingen meenemen in de kwaliteitscheck; geen volledige bronteksten opslaan.

## Step 5 — Municipalities & local sources

- **Gemeente Lochem**: `/agenda-met-evenementen` is server-rendered and has unique village events (fees/markten) NOT in the Achterhoek API (e.g. Barchems Feest, Zomertoer Lochem).
- Most other municipality sites are JS-driven/404/403 — check the registry before retrying; only Lochem yielded data so far.
- Probe the local-source categories the user wants covered (see registry "To probe"): lokale scholen (schoolagenda's: open dagen, culturele avonden), lokale verenigingen (dorpshuizen, kermisorganisaties, carnavalsverenigingen, muziekverenigingen), lokale Facebook-pagina's per dorp, gemeente-websites, lokale theaterwebsites (kleine podia).
- **Sportverenigingen & dorpshuizen websites**: clubs announce clubfeesten/bingo's/clinics on their own news pages and often never submit to the Achterhoek agenda (e.g. LTC Zelhem Clubfestijn mét Bingo, za 5 sep 2026 — confirmed absent from the API). Scan club news pages for in-window events; typically a date appears in the first ~2 sentences.
- **Lokale nieuwswebsites & radiowebsites**: scan for event announcements in the window via RSS where available (locofm.nl/feed, omroepgelderland.nl/rss) or site search/sitemap (regio8.nl). No structured agenda sections — value is in nieuws items about upcoming events. destentor.nl & gelderlander.nl work but are partially paywalled; only free sections.
- uitagenda.nl city pages: venue guides, maar enkele echte events (alle buiten de aug/sep-window van 2026) — check per window; parse `evenement/<id>/` links.

## Step 6 — Sports & season gaps

- De Graafschap (degraafschap.nl): JS-driven, match dates not in server HTML — add a note pointing to their speelschema instead of guessing.
- CLUB-SCAN (mandatory before output): scan the round-1 verified club sites (registry) for social events (feesten/bingo's/clinics) in the window; matches alone don't count, but note the biggest home matches. Pattern: LTC Zelhem Clubfestijn mét Bingo (05-09-2026) was only on ltczelhem.nl/nieuws/. Skip ledenvergaderingen/klusdagen (member-only); keep open dagen and kennismakingsactiviteiten.
- Known just-outside-window items to mention: Corso Lichtenvoorde (2nd Sunday of Sep), Hanzehof BuitenSoos LIVE (11 Sep), new theater season openings mid-Sep.
- Late Aug is festival season: Huntenpop, Stadsfeest Doetinchem, Zelhem op hete kolen, Barchems Feest, Ronde van de Achterhoek.

## Step 4 — REVIEW-PASS (verplicht, vóór publicatie; pipeline-output is altijd een DRAFT)

De automatische pipeline (links + samenvattingen) is een heuristiek en FAALT regelmatig op pagina's met meerdere events, JS-sites en kleine organisaties. Daarom:

- **ALTIJD handmatige/LLM-sanity-check op ELKE link en ELKE tekst vóór publicatie.**
- Link-check per event: opent de url echt de EVENT-pagina (geen homepage, privacy-pagina, contact-pagina, oude jaargang of ander event)? Steekproefsgewijs klikken is onvoldoende — de review dekt alle events.
- Tekst-check per event: is de samenvatting de kern van DIT event (niet van een ander event op dezelfde pagina, geen openingstijden, navigatie, cookie-tekst of contactgegevens)?
- Correcties landen in `URL_OVERRIDES` / `SAMENVAT_OVERRIDES` in scripts/enrich.py (met datum) zodat ze blijvend zijn.
- Twijfel over leden-only of juistheid van de link → event weglaten of markeren voor curatie (link_check_report.txt).

## Step 7 — Output format

1. Weekend/highlights list; 2. day-by-day listing "Event (plaats)", multi-day ranges noted; 3. "running through the whole period" section (exhibitions/open activities); 4. just-outside-window notes; 5. one line listing sources used.

- FILTER (before output): skip member-only events — ledenvergaderingen, klusdagen, clubcompetities, ledendrives, repetities (music), trainingen (sport) — UNLESS they are member-recruitment events (ledenwerving): open dagen, kennismakingslessen/clinics, gratis introductielessen, beginnerscursussen (bridge/schaak/muziek), proeverijen. These ARE public activities.

## Step 8 — SELF-UPDATE (mandatory after every run)

This skill improves itself. After delivering the overview, update the **Resource Registry** below:

- **Append** every newly discovered working source: URL, endpoint, API parameter, parse recipe (one line each, grouped by category).
- **Mark dead/changed** entries `[DEAD]` / `[CHANGED]` and add the replacement.
- **Mark probed-but-empty** categories as `[GEEN-EVENTS YYYY-MM-DD..MM-DD]` — a WEEK-SPECIFIC finding, NOT a permanent skip. The source stays valid; other weeks may have events (seasons!). Only `[DEAD]`/`[BLOCKED]` is permanent (technical failure).
- When a window falls in a different season, re-check the seasonal sources listed in the registry.
- Add candidate venues/schools/associations/Facebook pages found during the run to "To probe".
- Keep entries one line, keep the file tidy; the registry grows with every use.

## Resource Registry (evolves)

### Confirmed working
- Achterhoek events API: `https://achterhoek.nl/events-api?createdby=1&order=ASC&place=&datefrom=&dateto=&filterids=&categoryId=` — category 556 = all; categories: 1979 festivals, 1981 theater, 1982 streekcultuur, 1983 eten-drinken, 1984 muziek-uitgaan, 1985 films, 1986 kids-jeugd, 1987 wandel-fiets, 1988 corso-optocht, 1949 tentoonstellingen. Empty result = wrong/empty categoryId.
- Amphion: `https://www.amphion.nl/theater/page{N}` (N=1..8); parse `<section class="show" data-url=".../dd-mm-yyyy-hh-mm/">`, `.title`, `.subtitle`. Also `/film/filmagenda/` for cinema note.
- Hanzehof: `https://hanzehof.nl/nl/programma`; per-show `https://hanzehof.nl/nl/voorstelling/<slug>/`, dates as Dutch month names.
- Theater De Storm: `https://www.theaterdestorm.nl/voorstelling/` + category pages (openluchttheater/, familie/, cabaret/, ...); Ticketmatic widget links, no dates in URLs.
- Gemeente Lochem: `https://www.lochem.nl/agenda-met-evenementen` (news-based; pagination params ignored without cHash — page 1 suffices).
- Achterhoek event URL pattern: `https://achterhoek.nl` + `slug`.
- achterhoekpromotie.nl: `https://www.achterhoekpromotie.nl/evenementen/agenda.php?start=YYYYMM01` (also `...MM06`; pages overlap). Parse `div.agenda-event` + `div.agenda-datum`; detail URL `/evenementen/agenda/<year>/<id>/<slug>`. Dutch-text dates; filter out Liemers gemeenten. Covers village feesten/kermissen missing from achterhoek.nl [verified 2026-08: Halse Dag Halle 06-09, Kermis Zutphen 02-06/09, TrialGP Zelhem 04-06/09].
- Lokale nieuws/radio: regio8.nl (news, no RSS — use site search), locofm.nl (RSS: /feed), omroepgelderland.nl (RSS: /rss, gld.nl), ideal.nl (Radio Ideaal), slingelandfm.nl. No agenda sections; scan news for event announcements in window.
- Sportclub news pages: ltczelhem.nl/nieuws/ — pattern: club feesten/bingo's only on club site, absent from Achterhoek API [verified 2026-08].
- Round-1 verified club sites (news/agenda pages; check for in-window events):
  Voetbal: dzc68.nl (DZC '68 Doetinchem), vvg25.nl (VVG '25 Doetinchem), fcwinterswijk.nl (FC Winterswijk), vvgrol.nl (Grol Groenlo), vvgendringen.nl (Gendringen), vvterborg.nl (Terborg), vvvorden.nl (Vorden), svalmen.nl (SV Almen)
  Korfbal: dindoa.nl (KV Dindoa Doetinchem)
  Hockey: hczutphen.nl (HC Zutphen)
  [Clubscan 2026-08-20: alleen LTC Zelhem Clubfestijn mét Bingo (05-09) in window; andere clubs alleen wedstrijden]
- Club directory (use FIRST for voetbalclubs): hollandsevelden.nl/xml-sitemaps/clubs.xml = full NL club list; club page /clubs/<letter>/<slug>/ has JSON-LD (club name, dissolutionDate, KNVB nummer). Full Achterhoek inventory (88 clubs, 71 actief) in clubs-achterhoek.tsv (this dir).
- Round-2 club sites found via directory [scan 2026-08-20, only wedstrijden in window]: svbredevoort.nl, vvdoetinchem.nl, dvc26.nl, fceibergen.nl, gsv63.nl, svhalle.nl, vvmontferland.nl, vvreunie.nl, vvruurlo.nl, sprinkhanen.nl, src24.nl, stevo.nl, svbv.nl, svgg.nl, fctrias.nl, scvarsseveld.nl, vioddoetinchem.nl, viosbeltrum.nl, fczutphen.nl (Seesing U13 Tournament 28-30/08 = zelfde als achterhoekpromotie), ajaxb.nl, kczutphen.nl (korfbal), ltczutphen.nl (tennis)

### Technisch dood / geblokkeerd (week-onafhankelijk — NOOIT checken)
- Dode nieuws/radio-domeinen: achterhoeknieuws.nl, hallowinterswijk.nl, rtvwinterswijk.nl, halloaalten.nl, zutphenfm.nl, halloachterhoek.nl
- Zoekmachines blokkeren bots of geven junk: bing.com, duckduckgo (html + lite), mojeek.com — ga direct naar bekende domeinen
- oostgelre.nl geeft 403 aan bots
- Bonddirectories login/JS zonder scrapebare lijsten: korfbal.nl→mijn.korfbal, knltb.nl, hockey.nl, bridge.nl, schaakbond.nl
- Dorpshuis-domeinpatroon dorpshuis<dorp>.nl faalt vrijwel overal; alleen dorpshuiszeddam.nl bestaat (in onderhoud) — dorpshuizen alleen handmatig per dorp
- Gemeente-sites (doetinchem, zutphen, winterswijk, aalten, berkelland, bronckhorst, montferland, oudeijsselstreek) zijn JS/404 — hercontrole alleen bij seizoenswisseling

### Seizoensgebonden / periodiek (VALIDE bron — activeer per week via de Seizoenskalender)
- Theaters Amphion/Hanzehof/De Storm: seizoen ~sep-okt t/m jun; zomer alleen openlucht/specials. Bij winter/kerstweken: hoge prioriteit.
- Rietveld Theater Lochem: vrijwilligerstheater, onregelmatig — elke week checken, vaak niets
- Boogie Woogie Winterswijk: schooljaar-gebonden programma (sep-jun); zomeragenda leeg
- uitagenda.nl: enkele events per stad; check per window [GEEN-EVENTS 2026-08-20..09-10]
- klankwijzer.nl (muziekverenigingen/KNFM): jaarrond; concerten clusteren sep-nov en mrt-mei [GEEN-EVENTS 2026-08-20..09-10; later: Kracht van de Achterhoek 07-11 Doetinchem]
- Denksport: svdoetinchem.nl (schaakvereniging) actief okt-mei, zomer stil [GEEN-EVENTS 2026-08-20..09-10]
- Survival/obstacle runs: GEEN eigen verenigingssites in de Achterhoek (domeinen dood; graafobstaclerun.nl 403; survivalruns.nl lege shell). Deze events landen in achterhoekpromotie.nl (voorbeeld: Graaf Obstacle Run Lochem 20-09-2026, 3 routes, gratis publiek).
- Gemeente verenigingen-registers: NIET scrapebaar — alle 10 gemeenten getest op /verenigingen & /sportverenigingen; alleen berkelland.nl (embed OverBorculo, geen lijst) en doesburg.nl (leeg) bestaan, rest 404/JS. Gebruik hollandsevelden + clubscans i.p.v. gemeente-sites [2026-08-20].
- Sociale kaart meedoeninbronckhorst.nl (Bronckhorst): /is/organisaties = complete organisatieregistratie met websites; categorie Buurtcentrum/dorpshuis (x=849) leverde de eerder onvindbare dorpshuizen/dorpsbelangen op: dorpshuishalle.nl (Halle), dorpshuishummelo.nl, dorpshuisdrempt.nl, dorpshuisdehorst.nl, dekeisteenderen.nl, keijenborg.info, toldieksbelang.nl, vorden.nl (Vordens Belang), veldhoeksbelang.nl, dorpskerkhoogkeppel.nl, theateronderdemolen.nl. /is/agenda = terugkerende welzijnsactiviteiten per dorp (geen datumfilter; toont eerstvolgende keer).
- meedoeninoudeijsselstreek.nl (Oude IJsselstreek): zelfde idee maar op mijnbuurtje.nl-platform — semi-bruikbaar, apart uitzoeken. Overige 9 gemeenten hebben GEEN meedoenin-platform.
- BRIDGE (NBB-platform, structureel): clubs op <id>.bridge.nl; club-lijst via clubsites.bridge.nl + <district>.bridge.nl/aangesloten-clubs/ (district 10=IJsselstreek, 7=Midden/Oost Gelderland; 102 clubs, 14 Achterhoeks: 7007 A.B.C. Doetinchem, 7071 B.C. de Honneur Doetinchem, 10018 B.C. Zutphen, 7058 B.C. Doesburg, 7079 Montferland, 7501 Aaltense B.C., 10065 Vorden, 10019 Gorssel, 10031 Sportver. Epse, 7036 Gendringen, 7040 Didam, 7043 Varsseveld, 7052 Neede, 7075 De Wehlse Snit).
  - Landelijke events-API (check per window): GET https://www.bridge.nl/wp-admin/admin-ajax.php?action=listjs_events → JSON met event_date/event_name/event_kind/event_city/event_time_duration/event_href. Datumfilters in query worden genegeerd — client-side filteren op event_date (lijst dekt ~aug-dec).
  - Evenement-detail: https://www.bridge.nl/evenement/<id>/ of <clubid>.bridge.nl/evenement/<id>/ (openbaar, incl. locatie/kosten/inschrijving).
  - Achterhoekse bridgeclubs hebben GEEN eigen websites — geen enkele van de 14 verwijst vanaf bridge.nl naar een externe site [2026-08-20]. Cursussen staan INCONSISTENT in de landelijke agenda (Zutphen/Winterswijk wel, Doetinchem niet); club-interne cursussen (A.B.C. Doetinchem beginners-/opfriscursus) zijn niet scrapebaar — alleen via clubcontact (tel. staat op de clubpagina).
  - Voorbeeld: CityDrive Doetinchem 2026 (19-09) alleen hier te vinden [2026-08-20]; ook: Monumenten Drive Winterswijk 26-09, Kroegentocht Bronkhorst 10-10, beginnerscursussen Zutphen/Winterswijk.
- Sportclubs (33 sites, zie boven): jaarrond checken; vooral wedstrijden, zelden publieke events [GEEN-EVENTS 2026-08-20..09-10 behalve LTC Zelhem Clubfestijn]
- Scholen (agenda's open dagen/culturele avonden): actief sep-jun
- destentor.nl / gelderlander.nl: altijd bereikbaar, maar deels betaalmuur; alleen gratis secties

### Wekelijks terugkerend (markten — los van evenementenkalenders; apart checken)
- Geverifieerde markten-bronnen: zutphen.nl/markten (do+za Zutphen Zaadmarkt 08:00-13:00/17:00; wo Warnsveld De Dreiumme 07:30-13:00), doetinchem.nl/weekmarkt (di textielmarkt, do, za kleiner; Wehl do 13:00-17:30 Koningin Wilhelminaplein), montferland.nl/weekmarkt (Didam vr).
- Geverifieerde markten-bronnen: zutphen.nl/markten (do+za Zutphen Zaadmarkt 08:00-13:00/17:00; wo Warnsveld De Dreiumme 07:30-13:00), doetinchem.nl/weekmarkt (di textielmarkt, do, za kleiner; Wehl do 13:00-17:30 Koningin Wilhelminaplein), montferland.nl/weekmarkt (Didam vr), lichtenvoorde.nl/warenmarkt (za ochtend), Winterswijk warenmarkt rond Jacobskerk (100procentwinterswijk.nl; dag niet op site — algemeen bekend: za).
- Overige gemeenten (Lochem, Doesburg, Aalten, Berkelland, Oost Gelre/Groenlo, Oude IJsselstreek, Bronckhorst): geen scrapebare marktenpagina; zoekmachines onbruikbaar (bing/ddg geven junk) — marktdagen alleen handmatig via VVV/gemeente te bevestigen [2026-08-20].
- Bronckhorst-dorpen: wekelijkse inloop/koffieochtend/biljarten via meedoeninbronckhorst.nl/is/agenda (recurring, geen datumfilter — toont eerstvolgende keer).

### Seizoenskalender (welke bronnen actief in welke periode)
- Zomer (jun-aug): festivals/dorpsfeesten/kermissen (achterhoek.nl + achterhoekpromotie.nl = hoofdbron), openluchtfilms, exposities; theaters rustig (alleen openlucht), denksport/scholen stil
- Sep-nov: theaterseizoen start (medio sep) → Amphion/Hanzehof/Storm hoge prioriteit; denksport start (okt); muziekverenigingsconcerten; cursussen/bibliotheken actief
- Dec: kerstactiviteiten, wintermarkten, theaters vol; Boogie Woogie/scholen actief
- Jan-mrt: theater + denksport piek; carnaval (feb/mrt) en corso's (sep) via achterhoekpromotie; harmoniekampioenschappen Zutphen (mrt)
- Apr-mei: voorjaarsmarkten, opgtochten, schoolvakantie-activiteiten; expositie-wisselingen

### To probe next time (user-requested categories)
- Lokale scholen: schoolagenda's van scholengemeenschappen Doetinchem (SG de Rietlanden?), Zutphen (Isendoorn?), Winterswijk (SG Werenfridus?) — open dagen, culturele/muziekavonden in de regio
- Lokale verenigingen: dorpshuizen, kermisorganisaties, carnavalsverenigingen, muziekverenigingen (per dorp)
- Sportverenigingen per dorp: round-1 verified URLs above; unverified clubs to locate via site search (domain guessing failed for these): Zelhemse Boys (Zelhem), Be Quick Zutphen, WVC Winterswijk, Longa '30 (Lichtenvoorde), Aalten, Lochem, Doesburg, Ulft, Silvolde, De Sprinkhanen ('s-Heerenberg), Didam, Dinxperlo, Varsseveld, Westendorp, Neede, Eibergen, Borculo, Beltrum, Rekken, Lievelde, Zieuwent, Hengelo Gld, Steenderen, Harfsen, Epse, Gorssel, Warnsveld, Megchelen, Etten, Breedenbroek, Sinderen, Geesteren, Haarlo, Barchem, Laren (Gld)
  [OPGELOST 2026-08-20: alle voetbalclubs gevonden via hollandsevelden.nl — zie clubs-achterhoek.tsv; domein-gokken onnodig]
- Lokale Facebook-pagina's: per dorp evenementen/uitgaanspagina's (niet scrapebaar zonder sessie — alleen als overzichtslijst relevant)
- Kleine podia: DRU Cultuurfabriek Ulft, De Pluu (Montferland?), Cultuurhuus Aalten, muziekverenigingen Borculo/Zelhem
- Gemeente-websites: hercontrole agenda-URL's bij seizoenswisselingen (alleen Lochem leverde data)

### Organisatie-agenda's (PRIORITEIT boven overkoepelende agenda's — hier bijhouden en bijwerken)
- amphion.nl (theater/film Doetinchem) · hanzehof.nl (Zutphen) · theaterdestorm.nl (Winterswijk)
- musea: museum MORE (moremuseum.nl), villamondriaan.nl, development.museumsmedekinck.nl/agenda-activiteiten, museumdescheper.nl, nationaalonderduikmuseum.nl, laliquemuseum.nl, museumfabriekwinterswijk.nl
- stichtingberkelzomp.nl · glk.nl (Geldersch Landschap) · poortvangelre.op-shop.nl (Bibliotheek West-Achterhoek) · vriendenvandedorpskerkvorden.nl/event · fruitbedrijfhorstink.nl/beleving · ltczelhem.nl
- bridgeclubs via bridge.nl-clubpagina's · lichtenvoorde.nl · 100procentwinterswijk.nl
- [bij elke run: nieuwe organisatie-agenda's toevoegen die je tegenkomt; dode/gewijzigde markeren]

### Facebook strategy (do not scrape facebook.com directly)
- Direct scraping is not realistic: login walls, anti-bot, ToS violation, AVG, account bans.
- Preferred: map each FB page to the org's own website (via page About info) and scrape that; most village pages mirror their own site / gemeente / achterhoek.nl content.
- oEmbed (official, no auth, per-post): `https://www.facebook.com/plugins/post/oembed.json?url=<public post URL>` — verification only, needs the post URL first.
- Graph API: needs app + token + per-page admin consent; events-search API removed in 2018 — not a regional sweep.
- RSS-bridge services (rss.app, fetchrss, fivefilters) can convert public FB pages to RSS — trial for top ~10 village pages; reliability varies.
- Playwright with human-logged-in session: manual spot checks only, not an automated pipeline (ban risk).
- Sustainable fix: encourage orgs to submit free to achterhoek.nl/evenement-aanmelden so events land in the official agenda.

### FB-only verenigingen (no own website — FB page is the only source)
- Pipeline: (1) self-hosted RSS-Bridge (RSS-Bridge/rss-bridge, Facebook bridge) → RSS per page; (2) OCR flyers with tesseract-ocr + nld lang pack — event details are usually IN the image, not the post text; (3) Playwright with human session as fallback when the bridge breaks.
- Expect bridge breakage every few months; repair on failure or quarterly.
- Long-term fix: ask orgs to also post free on achterhoek.nl/evenement-aanmelden.
- ToS-gray but low risk for public page content.

### Known pitfalls (do not repeat)
- Convert dd-mm-yyyy to ISO before range filtering.
- API needs a known categoryId; empty/0 returns empty events.
- Theater season boundary ~Sep 11–13: big programs start after; festival season is late Aug.
- Dedupe by event_id; watch title-duplicates across categories.
