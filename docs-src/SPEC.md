# worxbend.github.io/.github — build spec

This file is the contract every module is written against. It is **not** shipped copy; it is the
brief. Read it fully before writing any file.

Target: a static site served from `docs/` at `https://worxbend.github.io/.github/`.
No build step. No bundler. Plain ES modules, plain CSS. Use relative URLs only (`./assets/...`, never `/assets/...`) so the site works at the
Pages subpath. Preview through local HTTP; browser ES modules are not supported on `file://`.

---

## 1. Design direction

**Concept — “The open-source workshop.”** A calm editorial surface for finding useful
projects: graphite, ivory, sage, strong Manrope typography, and a contained orbital illustration.
The catalogue is curated, not an exhaustive account listing. Never claim “every public repo.”

The page has three main regions:

1. A split hero: “Small tools. Real possibilities.”, a short introduction, primary catalogue
   link and repository search. The generated orbital artwork is decorative, separate from text,
   and must never overlap or displace a control.
2. “Built out of curiosity.”: six numbered topic rows with concise descriptions and descriptive
   links. Desktop uses two columns; narrow phones stack metadata beneath each description.
3. “Find your next rabbit hole.”: searchable catalogue, readable category filters, result count
   and data provenance. Repository cards retain their real metadata and outbound links.

The horizontal header contains Work, Explore, GitHub, command search, and a native appearance
menu. Optional sound and motion controls belong in the footer. Audio starts only from its own
button. No performance HUD is shown to visitors.

### Typography and composition

Manrope is both display and body; JetBrains Mono is reserved for compact metadata.
Self-hosted variable WOFF2 fonts retain their SIL licenses under `docs/assets/fonts/`.
Use system fallbacks and `display=swap`; preload the main Latin font. Headings use tight tracking and a fluid scale;
body copy remains readable at 320px. The hero title is two lines on the supported mobile sizes.
The main container is 1488px including 48px gutters, reducing to 20px gutters on phones.
Interactive targets remain keyboard reachable with visible focus rings.

`workshop.css` owns the editorial composition and responsive variants; `components.css`
retains shared control primitives. Theme colors remain exclusively in `tokens.css`.
The artwork is an asset, not a screenshot of the interface. Text and all controls are native HTML.

The decorative hero is independent of optional WebGL. Constellation view preserves the text
catalogue and loads its visual layer on demand. Default browsing must not pay for unused 3D work.

## 2. Theme system

Five themes. The user picks one; it persists. There is **no** `prefers-color-scheme` media query
driving the palette — the theme is an explicit product feature stored in `localStorage`. But the
**initial default** when no preference is stored is derived from `prefers-color-scheme`:
dark → `foundation`, light → `solar`.

The theme is applied as `data-theme="<id>"` on `<html>`. A tiny inline script in `<head>` (before
any stylesheet renders content) reads storage and stamps the attribute, so there is **no flash of
the wrong theme**.

Every color in the entire site comes from a token. A component rule may never contain a literal
color and may never be defined inside a `[data-theme]` block. Only `tokens.css` knows hex values.

| id | name | character |
| --- | --- | --- |
| `foundation` | Foundation | **Default dark.** Graphite ground, ivory text, sage accent. |
| `matrix` | Matrix | Black ground, phosphor green, CRT scanlines, glyph rain at full strength. |
| `blueprint` | Blueprint | Drafting navy, cyan ink, white hairline grid — engineering drawing. |
| `nebula` | Nebula | Violet/magenta deep field, warmer, softer bloom. |
| `solar` | Solar | **The light theme.** Warm paper, ink-navy text, blue accent. Must be genuinely legible in daylight, not an inversion. |

### Token names (identical set defined in every theme block)

Surfaces & ink:
`--ground` `--ground-2` `--panel` `--panel-2` `--panel-hover` `--line` `--line-strong`
`--ink` `--ink-2` `--ink-3` `--ink-inverse`

Accents & signal:
`--accent` `--accent-2` `--accent-ink` (text that sits on `--accent`)
`--signal-ok` `--signal-warn` `--signal-crit`

Effects:
`--glow` (rgba, for box-shadow bloom) `--grid-line` (rgba hairline) `--scanline` (rgba)
`--selection` `--focus-ring`

Scene (read by JS, see §5):
`--scene-star-a` `--scene-star-b` `--scene-star-c` `--scene-fog` `--scene-glyph`
`--scene-link` — all `#rrggbb` **hex strings**, because JS parses them into WebGL colors.

Neutrals must be hue-biased toward that theme's accent. No pure `#808080`.

---

## 3. Data model

> **Superseded.** The shape below still describes one project entry, but it is produced rather
> than typed: every fact about a repository is fetched live in the visitor's browser, with no
> credentials, and *which* repositories appear is a hand-written list in
> `data/catalog.config.js`. See **3a** for how the two meet.

`docs/assets/js/data/projects.js` exports the catalog. Shape of one entry:

```js
export const OWNERS = {
  worxbend: { login: 'worxbend', kind: 'org',  label: 'worxbend',  url: 'https://github.com/worxbend' },
  w0rxbend: { login: 'w0rxbend', kind: 'user', label: 'w0rxbend',  url: 'https://github.com/w0rxbend' },
  'oleksandr-balyshyn': { login: 'oleksandr-balyshyn', kind: 'user', label: 'oleksandr-balyshyn', url: 'https://github.com/oleksandr-balyshyn' },
};

// Clusters are the constellation groupings. `id` is used in URLs and filters.
export const CLUSTERS = [
  { id: 'streaming',  name: 'Streaming & OBS',      blurb: '…', glyph: '◈' },
  { id: 'air',        name: 'Air Quality',          blurb: '…', glyph: '◇' },
  { id: 'iot',        name: 'IoT & Edge',           blurb: '…', glyph: '◆' },
  { id: 'linux',      name: 'Linux & Provisioning', blurb: '…', glyph: '▣' },
  { id: 'scala',      name: 'Scala & JVM',          blurb: '…', glyph: '⬡' },
  { id: 'cad',        name: 'CAD & 3D printing',    blurb: '…', glyph: '⬢' },
];

export const LANGS = { Rust: '#dea584', Go: '#00ADD8', Scala: '#c22d40', /* … */ };

export const PROJECTS = [
  {
    id: 'scenedeck',                  // unique slug, used in the URL hash
    name: 'scenedeck',
    owner: 'worxbend',
    cluster: 'streaming',
    lang: 'Rust',
    langs: ['Rust'],                  // full stack, for search + chips
    stars: 2,
    updated: '2026-08-09',            // ISO date, from updatedAt
    url: 'https://github.com/worxbend/scenedeck',
    home: 'https://snapcraft.io/scenedeck',   // optional
    tagline: 'Desktop OBS control for Linux.',       // ≤ 60 chars, sentence case
    desc: '…',                        // 1–2 sentences, plain language, no marketing
    topics: ['obs', 'obs-websocket', 'gtk4'],
    featured: true,                   // shows in the hero rotation
  },
  // …
];
```

Copy rules for `desc`: write for someone who has never heard of the project. Spell out
abbreviations on first use inside that description (e.g. "OBS Studio", "TCP (a raw network
socket)"). Never use "simply", "just", "obviously", "trivially". No emoji inside `desc`.

---

## 3a. How the catalogue is actually assembled

Four files, with one rule behind the split: **facts regenerate themselves, judgement does not get
overwritten.**

| File | Written by | Holds |
| --- | --- | --- |
| `core/github.js` | hand | The fetch. Three anonymous calls to GitHub's public REST API — one per account — with an ETag revalidation, a six-hour `localStorage` cache, and a fallback chain. |
| `data/seed.js` | `scripts/refresh-seed.py` | A committed snapshot, used for the first paint and as the last fallback. Never the source of truth. |
| `data/catalog.config.js` | hand | **The selection.** `SECTIONS` — one entry per subject, each carrying its label copy and the `owner/repository` lines that belong to it — and `FEATURED`. Nothing outside this file can put a project on the site. |
| `data/overrides.js` | hand | The prose layer: `COPY`, keyed by `owner/repository`, holding `tagline` and `desc`. Nothing else. |
| `data/projects.js` | hand | The merge. Keeps what the config selected, assigns ids, layers the copy on, sorts, and publishes `PROJECTS`, `CLUSTERS`, `loadCatalog()` and `onCatalogChange()`. |

Rules that follow from this and must not be broken:

- **No credentials, ever.** A token in a static page is readable by anyone who opens the network
  tab, so there is nothing to protect and nothing to add. Everything shown is public.
- **The rate limit is the design constraint.** Anonymous callers get 60 requests an hour per IP.
  One request per account, a six-hour cache, and `If-None-Match` revalidation (a `304` is free)
  keep a normal visitor at two or three requests a day. Never add a per-repository call — that is
  one request each and would exhaust the budget on the first visit. This is why the catalogue
  shows only the primary language: the full breakdown needs its own request per repository.
- **`PROJECTS` is refilled in place, never reassigned**, so `import { PROJECTS }` stays live.
- **Never render an empty catalogue.** The chain is fresh cache → network → stale cache → seed, and
  an empty response is treated as a failure rather than as "there are no repositories".
- **Say which source answered.** `catalogMeta.source` drives the provenance line beside the catalogue count. A
  page quietly showing month-old numbers is worse than one that admits it.
- **Membership is chosen, not inferred.** The catalogue is exactly the repositories named in
  `data/catalog.config.js`, and adding one is a single line in that file. It used to be every
  repository pushed to in the last six months, which is a rule about activity rather than intent:
  a sandbox touched last week outranked a finished tool, and every throwaway experiment appeared
  the moment it was committed to. A configured repository that GitHub does not return — renamed,
  made private, deleted — is skipped, counted in `catalogMeta.missing`, and named in the console.
- **The section list is config too.** `CLUSTERS` is derived from `SECTIONS`, and `ui/app.js`
  renders the section cards and the filter chips from it at boot. The equivalent markup in
  `index.html` is the no-JavaScript fallback, not a second source of truth.
- **Anything derived from the catalogue must rebuild when it changes** — the search index, the
  default order, the card cache, the headline figures, and the constellation. `ui/app.js` does
  this through `onCatalogChange`; a new derived value has to be added there too.

## 4. Module contracts

All modules are ES modules under `docs/assets/js/`. No globals except the two vendor libraries.

### `core/store.js`
Namespaced `localStorage` wrapper with in-memory fallback (private-mode safe) and change events.

```js
export const store = {
  get(key, fallback),          // JSON-parsed, returns fallback on miss or parse error
  set(key, value),             // JSON-stringified; fires 'change'
  remove(key),
  subscribe(key, fn),          // returns an unsubscribe function
  available,                   // boolean — false when localStorage threw
};
export const KEYS = { theme:'theme', motion:'motion', density:'density', view:'view',
                      telemetry:'telemetry:consent', recent:'search:recent', visits:'visits' };
```
All keys are written under the prefix `wb.` (so `wb.theme`). Cross-tab sync via the `storage`
event: a theme change in one tab applies in the other.

### `core/telemetry.js`
**Entirely client-side.** Nothing is ever sent over the network — there is no endpoint, no
`fetch`, no `sendBeacon`. Events are appended to an **IndexedDB** database the visitor owns and
can inspect, export as JSON, or wipe. This is a foundation for future product analytics, and a
demonstration piece.

```js
export const telemetry = {
  init({ consent }),                 // opens the DB, starts the flush loop
  track(name, props = {}),           // queue an event; no-op unless consent === 'granted'
  page(path),                        // convenience for a view event
  timing(name, ms),
  setConsent(state),                 // 'granted' | 'denied' — persisted via store
  getConsent(),
  query({ since, name, limit }),     // Promise<Event[]>
  summary(),                         // Promise<{ total, byName, byDay, firstSeen, sessions }>
  export(),                          // Promise<Blob> — application/json
  clear(),                           // Promise<void> — deletes every event
};
```

- DB `wb-telemetry`, version 1, store `events` (`keyPath: 'id'`, autoIncrement), indexes on
  `name`, `ts`, `session`.
- Event: `{ id, ts, name, session, seq, props, ctx }` where `ctx` is captured once per session:
  `{ theme, view, lang, tz, viewport:{w,h}, dpr, reducedMotion, referrerHost }`.
- **No fingerprinting, no personal data.** Never store the full referrer URL (host only), never
  store IP-like data, never store input text — search events record query *length* and result
  *count*, not the query string.
- Buffer in memory and flush on `requestIdleCallback` (fallback `setTimeout`) or every 2 s,
  whichever first, plus an unconditional flush on `visibilitychange → hidden`.
- Cap at 5000 events; trim oldest first.
- Session id: `crypto.randomUUID()`, held in `sessionStorage`, 30-minute idle timeout.
- Default consent is **`denied`**. A quiet, non-modal banner asks once. Honour
  `navigator.doNotTrack === '1'` / `globalThis.doNotTrack` by defaulting to denied and saying so.
- Every public method must resolve even if IndexedDB is unavailable — degrade to a no-op, never
  throw into the caller.

### `core/motion.js`
One rAF loop for the whole page. Nothing else may call `requestAnimationFrame`.

```js
export const motion = {
  add(fn, { priority = 0 } = {}),    // fn(dtSeconds, elapsedSeconds); returns remove()
  start(), stop(),
  reduced,                           // boolean, live — reflects the OS setting and the user toggle
  onReducedChange(fn),
  fps,                               // rolling average, exposed for the HUD
};
export function reveal(root = document);      // IntersectionObserver-driven [data-reveal]
export function parallax(root = document);    // [data-parallax="0.2"] via one shared observer
export function counters(root = document);    // [data-count-to] tabular number roll-up
```

Requirements: pause the loop on `document.hidden` and when the canvas is fully scrolled out of
view; clamp `dt` to 0.05 s so a backgrounded tab does not jump the simulation; run at a reduced
step when `fps` stays under 45 for 2 s (adaptive quality — expose `motion.quality` as
`'high' | 'medium' | 'low'`); when `reduced` is true, skip ambient animation entirely and make
reveals instant. `reveal()` must use one `IntersectionObserver` for all elements, unobserve on
first reveal, and stagger siblings by index — never by a per-element `setTimeout`.

### `core/search.js`
Client-side search over `PROJECTS`. No dependencies.

```js
export function buildIndex(projects);            // returns an opaque index object
export function search(index, query, { limit = 50, filters = {} } = {});
// -> [{ project, score, matches: { field: [[start,end], …] } }]
export function highlight(text, ranges);         // returns HTML-escaped string with <mark>
```

Implementation: tokenised inverted index over `name`, `tagline`, `desc`, `topics`, `lang`,
`cluster`, `owner`. Prefix matching via a per-token trie or sorted-token binary search. Score =
weighted field hits (name 6, topics 4, tagline 3, desc 1) × exact/prefix multiplier, plus a
subsequence-fuzzy fallback (`sdk` → `scenedeck`) that only runs when strict matching returns
nothing. Support field filters typed inline: `lang:rust`, `owner:w0rxbend`, `cluster:iot`,
`stars:>0`. Deterministic tie-break: score, then stars, then `updated` desc, then name.
Must return in well under 5 ms for the whole catalog — no regex built inside the loop, no
`Array#includes` over the full set per keystroke.

### `fx/cosmos.js` — three.js layer
```js
export async function mountCosmos(canvas, { palette, quality }); // -> { dispose, setPalette, setQuality, resize, focus(id) }
```
- Loaded from a CDN as an ES module with an `importmap`; **if it fails to load, the site must
  still work** — catch and fall back to the CSS-only starfield in `motion.css`.
- Layers: near starfield (`Points`, additive, per-vertex colour from `--scene-star-*`), far
  starfield, a slow nebula shader plane, and the **constellation graph** — repo stars positioned
  by a seeded deterministic layout (no `Math.random()` without a seeded PRNG, so the sky is the
  same on every visit), with `LineSegments` between same-cluster nodes.
- Pointer parallax with damping; scroll drives the camera dolly.
- Raycast hover/click on constellation nodes → dispatches
  `canvas.dispatchEvent(new CustomEvent('star:select', { detail: { id } }))`.
- `setPixelRatio(Math.min(devicePixelRatio, quality === 'low' ? 1 : 2))`. Dispose every geometry,
  material and texture in `dispose()`.
- Runs through `motion.add`, never its own rAF.

### `fx/glyphs.js` — pixi.js layer
```js
export async function mountGlyphs(canvas, { palette, intensity }); // -> { dispose, setPalette, setIntensity }
```
- Matrix-style glyph rain rendered with PixiJS on a second, lower canvas, plus a subtle scanline
  and vignette filter. `intensity` 0–1; the `matrix` theme sets 1, `foundation` sets 0.12,
  `solar` sets 0.
- Same rules: CDN import with a graceful failure path, driven by `motion.add`, full `dispose()`.
- Use one `ParticleContainer`/sprite pool with a pre-rendered glyph atlas — never create a new
  `Text` object per frame.

### `ui/app.js`
Owns the DOM: renders the catalog, wires the command palette (`⌘K` / `Ctrl-K` / `/`), filters,
theme picker, view toggle (`grid` ↔ `constellation`), the telemetry panel, and hash routing
(`#/p/<id>`, `#/c/<cluster>`, `#/q/<query>?cluster=<cluster>`). Combined query and category
state must survive copying the URL, reload, and browser navigation. Reads `PROJECTS`, calls the modules above.

Accessibility is not optional: every control is a real `<button>`/`<a>` with a visible
`:focus-visible` ring, the palette is a proper modal with focus trap and `Escape` to close,
the canvases are `aria-hidden="true"`, results announce via a polite live region, and the
whole catalog is present in the DOM for screen readers regardless of the view toggle.

---

## 5. How JS reads the palette

JS must never hardcode a colour. On load and on every theme change:

```js
const cs = getComputedStyle(document.documentElement);
const palette = {
  starA: cs.getPropertyValue('--scene-star-a').trim(), /* … */
};
```
then `setPalette(palette)` on each FX layer. Theme changes tween the scene colours over ~400 ms
rather than snapping.

---

## 6. Performance & robustness budget

- No third-party JS except three.js and pixi.js, both CDN ES modules behind an `importmap`, both
  optional at runtime.
- First paint must not wait on WebGL, fonts, or the CDN. The page is fully readable and
  navigable with JavaScript disabled — the catalog markup is generated at runtime, so ship a
  `<noscript>` block linking to the GitHub org and listing the cluster links.
- Respect `prefers-reduced-motion` and the in-page motion toggle everywhere.
- No layout thrash: read all geometry in one pass, write in the next.
- Every `addEventListener` in a module has a matching removal in its `dispose`.
- Zero console errors or unhandled rejections in a normal session.

## 7. Development and release

Preview with `python3 -m http.server 8765`, then open `http://127.0.0.1:8765/docs/`.
Use Node 24. Run `npm ci`, `npm test`, then `npx playwright install chromium` and
`npm run test:browser`. These dependencies are development-only; the deployed site still has no
bundler or build step. Unit tests validate shipped module syntax,
relative asset paths, search behavior and escaping, and the curated seed's integrity.
The persistent Playwright suite verifies offline fallback, silent/graphics-free initial browsing,
combined search/category routes, focus isolation/restoration, keyboard appearance controls,
mobile gutters, and automated contrast checks across all themes.
Refresh public repository metadata with `python3 scripts/refresh-seed.py`.

Before release, exercise search, category links, combined URL reload/back, empty results,
command palette focus and touch selection, all themes, motion, explicit sound, and constellation
fallback. Check 320px, 390px, desktop, reduced motion and JavaScript-disabled behavior.
Automated accessibility scans supplement visual and keyboard review; they do not replace it.

The Pages workflow runs validation on pull requests and before main-branch deployment.
Only the deployment job receives Pages write permissions. The static `docs/` artifact is
published unchanged. Confirm the deployed revision and perform a live smoke check after push.
