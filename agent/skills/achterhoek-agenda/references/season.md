# Markets, seasons and pitfalls

Loaded on demand by `SKILL.md` when the window is not a plain summer week.

## Wekelijks terugkerend (markten — los van evenementenkalenders; apart checken)
- Geverifieerde markten-bronnen: zutphen.nl/markten (do+za Zutphen Zaadmarkt 08:00-13:00/17:00; wo Warnsveld De Dreiumme 07:30-13:00), doetinchem.nl/weekmarkt (di textielmarkt, do, za kleiner; Wehl do 13:00-17:30 Koningin Wilhelminaplein), montferland.nl/weekmarkt (Didam vr).
- Geverifieerde markten-bronnen: zutphen.nl/markten (do+za Zutphen Zaadmarkt 08:00-13:00/17:00; wo Warnsveld De Dreiumme 07:30-13:00), doetinchem.nl/weekmarkt (di textielmarkt, do, za kleiner; Wehl do 13:00-17:30 Koningin Wilhelminaplein), montferland.nl/weekmarkt (Didam vr), lichtenvoorde.nl/warenmarkt (za ochtend), Winterswijk warenmarkt rond Jacobskerk (100procentwinterswijk.nl; dag niet op site — algemeen bekend: za).
- Overige gemeenten (Lochem, Doesburg, Aalten, Berkelland, Oost Gelre/Groenlo, Oude IJsselstreek, Bronckhorst): geen scrapebare marktenpagina; zoekmachines onbruikbaar (bing/ddg geven junk) — marktdagen alleen handmatig via VVV/gemeente te bevestigen [2026-08-20].
- Bronckhorst-dorpen: wekelijkse inloop/koffieochtend/biljarten via meedoeninbronckhorst.nl/is/agenda (recurring, geen datumfilter — toont eerstvolgende keer).


## Seizoenskalender (welke bronnen actief in welke periode)
- Zomer (jun-aug): festivals/dorpsfeesten/kermissen (achterhoek.nl + achterhoekpromotie.nl = hoofdbron), openluchtfilms, exposities; theaters rustig (alleen openlucht), denksport/scholen stil
- Sep-nov: theaterseizoen start (medio sep) → Amphion/Hanzehof/Storm hoge prioriteit; denksport start (okt); muziekverenigingsconcerten; cursussen/bibliotheken actief
- Dec: kerstactiviteiten, wintermarkten, theaters vol; Boogie Woogie/scholen actief
- Jan-mrt: theater + denksport piek; carnaval (feb/mrt) en corso's (sep) via achterhoekpromotie; harmoniekampioenschappen Zutphen (mrt)
- Apr-mei: voorjaarsmarkten, opgtochten, schoolvakantie-activiteiten; expositie-wisselingen


## Known pitfalls (do not repeat)
- Convert dd-mm-yyyy to ISO before range filtering.
- API needs a known categoryId; empty/0 returns empty events.
- Theater season boundary ~Sep 11–13: big programs start after; festival season is late Aug.
- Dedupe by event_id; watch title-duplicates across categories.
