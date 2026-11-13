# Facebook strategy

Loaded on demand by `SKILL.md` when a village or club has no website.

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
