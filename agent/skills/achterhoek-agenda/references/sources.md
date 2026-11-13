# Resource registry — sources for the Achterhoek overview

Loaded on demand by `SKILL.md` (step 8 updates this file, nothing else). Grow it, mark dead
entries, keep one line per source.

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
