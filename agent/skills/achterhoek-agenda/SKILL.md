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

## Step 4 — REVIEW-PASS (verplicht, vóór publicatie; pipeline-output is altijd een DRAFT)

De automatische pipeline (links + samenvattingen) is een heuristiek en FAALT regelmatig op pagina's met meerdere events, JS-sites en kleine organisaties. Daarom:

- **ALTIJD handmatige/LLM-sanity-check op ELKE link en ELKE tekst vóór publicatie.**
- Link-check per event: opent de url echt de EVENT-pagina (geen homepage, privacy-pagina, contact-pagina, oude jaargang of ander event)? Steekproefsgewijs klikken is onvoldoende — de review dekt alle events.
- Tekst-check per event: is de samenvatting de kern van DIT event (niet van een ander event op dezelfde pagina, geen openingstijden, navigatie, cookie-tekst of contactgegevens)?
- Correcties landen in `URL_OVERRIDES` / `SAMENVAT_OVERRIDES` in scripts/enrich.py (met datum) zodat ze blijvend zijn.
- Twijfel over leden-only of juistheid van de link → event weglaten of markeren voor curatie (link_check_report.txt).

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

## Step 7 — Output format

Five sections, in this order, plus the pre-publication filter. Full detail:
[`references/output-format.md`](references/output-format.md).

## Step 8 — SELF-UPDATE (mandatory after every run)

This skill improves itself. After delivering the overview, update the resource registry in
[`references/sources.md`](references/sources.md):

- **Append** every newly discovered working source: URL, endpoint, API parameter, parse recipe (one line each, grouped by category).
- **Mark dead/changed** entries `[DEAD]` / `[CHANGED]` and add the replacement.
- **Mark probed-but-empty** categories as `[GEEN-EVENTS YYYY-MM-DD..MM-DD]` — a WEEK-SPECIFIC finding, NOT a permanent skip. The source stays valid; other weeks may have events (seasons!). Only `[DEAD]`/`[BLOCKED]` is permanent (technical failure).
- When a window falls in a different season, re-check the seasonal sources listed in the registry.
- Add candidate venues/schools/associations/Facebook pages found during the run to "To probe".
- Keep entries one line, keep the file tidy; the registry grows with every use.

## References (load only when needed — progressive disclosure, blip 5)

- [`references/sources.md`](references/sources.md) — the resource registry: confirmed working
  sources, technically dead ones, seasonal sources, organisation agendas, to-probe list.
- [`references/season.md`](references/season.md) — weekly markets, seasonal calendar, known
  pitfalls.
- [`references/facebook.md`](references/facebook.md) — Facebook strategy and FB-only clubs.
- [`references/output-format.md`](references/output-format.md) — output format and the
  member-only filter.

`clubs-achterhoek.tsv` (this directory) holds the full Achterhoek football-club inventory.
