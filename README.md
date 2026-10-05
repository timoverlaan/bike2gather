# Bike2Gather 🚲

Find the best spot to meet up and cycle to work together, or to split up on the way home.
It runs fully in the browser (no backend), so it can be hosted as-is on GitHub Pages.
The interface is in Dutch and English, works on phones, and covers the Netherlands for now.

## What it does

- **To work (morning):** everyone rides from home to a meetup spot, then together to the destination.
  You get a departure time per person so you all arrive on time.
- **Back home (evening):** you ride together from work to a split point, then each ride home.
- Enter addresses with Dutch address search (PDOK), or tap the map. Markers can be dragged.
- You get a few options. Each shows the meetup time, how far you ride together, each person's
  ride and detour, and how green the route is. Tap an option to see the routes on the map.
- **Try my own spot:** tap the map to see how a place you choose scores against the suggestions.
- **Copy plan** puts a text you can paste into the group chat on your clipboard.
- **Share link** creates a link (`…/#plan=…`) that contains the setup *and* the computed options
  and routes. Whoever opens it sees the results right away, without searching again or contacting
  any routing service. Route lines are simplified to ~5 m and compressed, so a typical link is a
  few kB. The data comes after `#`, so it is never sent to the web server (`?plan=…` also works).
  It does include everyone's home location, so share it only with your group. On phones it opens
  the share sheet.

## Weighing priorities

Every term is expressed in *kilometres of detour*, so the sliders trade off against something
tangible. Lower total is better:

| Slider | Effect |
| --- | --- |
| **Fairness** | `(1−f)·mean(detour) + f·max(detour)`: from *least total km for the group* to *equal detours for everyone*. |
| **Time together** | Bonus for kilometres ridden together, relative to the average commute (meet earlier, split later). |
| **Nice meetup spot** | Bonus for waiting at a café/bakery, park, landmark/windmill, square, station or bike shop instead of a street corner. |
| **Green & scenic** | Bonus for the share of the route through or along parks, woods, grass, fields, water, canals and tree rows. |
| **Fitter riders go further** | Each person's detour is multiplied by `2^(s·(3−fitness)/2)`. With fitness 5 a detour "costs" less, so fit riders take the longer leg. |

Per rider you can also set a **speed** (used for times) and an optional **max detour** (a hard-ish
limit with a steep penalty). The presets (*Balanced*, *Fair share*, *Least total effort*, *Ride together*,
*Scenic*, *Coffee stop*) are starting points. Under *More settings* you can set the group pace
(slowest rider or average), the number of options, and a wait buffer.

Moving a slider re-ranks immediately from cached data. Only new top options trigger extra routing.

## How the solver works

1. **Candidates:** cafés, parks, squares, landmarks, stations and bike shops from OpenStreetMap
   (Overpass), plus a grid of generic points across the area.
2. **Pre-filter:** all candidates are scored with crow-fly distances × 1.3. About 85 of the most
   promising are kept: two thirds of the best ones, plus spread-out ones in case crow-fly is
   misleading (rivers without bridges, for example).
3. **Distance matrix:** two OSRM `table` calls give real cycling distances from every home to every
   candidate, and from every candidate to the destination.
4. **Detail:** the top options (kept at least 250 m apart) get full bicycle routes. Greenery is then
   measured by sampling each route every 40 m against OSM green and blue features near it.
5. **Re-rank** with the real greenery, then repeat until the top list is stable.

If a service is busy, the app falls back gracefully: estimates instead of the matrix, street points
when spots can't be loaded, and no greenery bonus when it can't be measured. It shows a warning when
it does this.

## Data sources & privacy

Everything runs and is stored in your browser (localStorage). No accounts, no analytics, no API keys.
Coordinates are sent only to these free public services:

| Service | Used for | Operator |
| --- | --- | --- |
| [PDOK Locatieserver](https://www.pdok.nl/introductie/-/article/pdok-locatieserver) | address search / reverse geocoding | Kadaster (Dutch government) |
| [PDOK BRT-Achtergrondkaart](https://www.pdok.nl/introductie/-/article/basisregistratie-topografie-achtergrondkaarten-brt-a-) | map tiles | Kadaster (Dutch government) |
| [OSRM bike routing](https://routing.openstreetmap.de/about.html) | distances and routes | FOSSGIS e.V. |
| [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) | meetup spots and greenery | FOSSGIS e.V. (fallback: private.coffee) |

The public routing and Overpass servers are meant for light use. The app throttles its requests
and caches results, which is fine for a group of colleagues. For heavy use, point
`src/services/osrm.ts` and `src/services/overpass.ts` at your own instances.

## Development

With [pixi](https://pixi.sh), you don't need Node.js or npm on your system:

```bash
pixi install      # Node.js (incl. npm) from conda-forge into .pixi/
pixi run dev      # installs the JS packages on first run, then starts the dev server
pixi run test     # tests
pixi run build    # production build into dist/
pixi run preview  # build + serve the production version
```

Or with your own Node.js (20.19+):

```bash
npm install
npm run dev       # local dev server
npm test          # unit + solver tests (network mocked)
npm run build     # type-check + production build into dist/
```

Code layout:

- `src/solver/`: scoring model, candidate generation, greenery, and the `Engine` that orchestrates and caches
- `src/services/`: thin clients for PDOK, OSRM and Overpass
- `src/ui/map.ts`: the Leaflet map
- `src/main.ts`: UI and state wiring
- `src/i18n.ts`: Dutch and English strings
- `tests/`: Vitest tests, including an end-to-end engine run against a fake network

## Deploying to GitHub Pages

The workflow in `.github/workflows/deploy.yml` tests, builds and deploys on every push to `main`.
Enable it once under **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The build uses relative paths, so it works under `https://<user>.github.io/<repo>/`.
