# Deploying Sightline (GitHub Pages)

Live address: https://myrondoesnotcode.github.io/sightline/
Every push to `main` rebuilds and publishes it (`.github/workflows/pages.yml`).

## The Google key: how it stays safe

A browser map key can't be hidden. Anyone can read it from the site's JavaScript.
That's normal for Google Maps keys. What keeps it safe is what the key is allowed
to do and how much it can spend:

1. **Locked to this site.** Google rejects the key on any other website.
2. **Locked to one API.** It only works for the Map Tiles API.
3. **Daily caps.** Once the daily limit is reached, Google stops answering, so
   spending can't run away.
4. **Not in the repo.** It lives in a GitHub secret and is only added at build time.

### One-time steps (Myron, in the browser)

**A. Lock the key to the site** (do this before step C)
Google Cloud console → project BriefBot → APIs & Services → Credentials →
key "Sightline map tiles" → Application restrictions: Websites. Keep
`http://localhost:4173/*` and add:

    https://myrondoesnotcode.github.io/sightline/*

API restrictions: keep "Map Tiles API" only. Save.

**B. Cap daily use**
Google Maps Platform → Quotas → Map Tiles API. Tick each quota, click Edit, enter
a lower number, and submit:
- Photorealistic 3D Tiles root requests per day: e.g. 300
- 2D tiles per day: e.g. 20,000

Google resets these at midnight Pacific time. Past the cap, Sightline still
works on its own dark map and buildings; only the Google satellite and 3D
views stop for the rest of the day.
Optional: Billing → Budgets & alerts. Add a budget with an email alert. It only
warns you; the quota caps are what actually stop spending.

**C. Give GitHub the key** (Terminal, from the Sightline folder; the key is
never printed):

    grep '^GOOGLE_MAPS_API_KEY=' .env | cut -d= -f2- | tr -d '"' | gh secret set GOOGLE_MAPS_API_KEY --repo myrondoesnotcode/sightline

**D. Publish:** `gh workflow run pages.yml --repo myrondoesnotcode/sightline`
(or push to main).

## If the key ever leaks beyond these limits
Credentials → the key → Regenerate key, then repeat step C.

## Notes
- The build only bakes in `GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` (unset).
  The server-side keys in `.env` (OpenAI, OpenSky, AIS) are never in the site.
- `STATUS.md` and `FEEDBACK.md` are kept out of the repo (`.git/info/exclude`).
- Share links and the PDF brief use the address you're on, so on Pages they
  point to the Pages site.
