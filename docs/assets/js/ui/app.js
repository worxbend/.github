/**
 * ui/app.js — the controller.
 *
 * Every other module in this project owns one thing and knows nothing about the page: the store
 * remembers preferences, the motion module owns the single frame loop, search owns the index,
 * telemetry owns the local database, and the two effects layers own their canvases. This file is
 * the only one that knows there is a page at all. It:
 *
 *   - reads the five `--scene-*` colours out of the active theme and hands them to both effects
 *     layers, again on every theme change (SPEC.md §5);
 *   - mounts those layers defensively, so a blocked content delivery network, an old graphics
 *     driver or a browser with WebGL switched off costs the visitor decoration and nothing else;
 *   - renders the catalogue, wires the search box, the filter chips and the view toggle;
 *   - runs the command palette, the theme picker, the motion and density toggles;
 *   - keeps the address bar in step with what is on screen through hash routes;
 *   - initialises the local-only telemetry and draws its inspector panel.
 *
 * Two rules that are load-bearing and easy to break later:
 *
 *   1. NO `innerHTML` WITH PROJECT DATA. Text from the catalogue is written with `textContent`,
 *      or through `highlight()` in core/search.js, which escapes every character before it wraps
 *      the matched parts in <mark>. Those are the only two paths.
 *   2. NO `requestAnimationFrame` HERE. core/motion.js owns the page's one frame loop. Where this
 *      file needs to wait for the next frame — coalescing keystrokes, for example — it registers
 *      a one-shot callback with `motion.add()` instead of starting a second loop.
 */

import {
  OWNERS, CLUSTERS, LANGS, PROJECTS, byCluster, stats,
  loadCatalog, onCatalogChange, catalogMeta, ACTIVE_MONTHS,
  langColor as colorForLang,
} from '../data/projects.js';
import { store, KEYS } from '../core/store.js';
import { motion, reveal, parallax, counters } from '../core/motion.js';
import { telemetry, EVENT_NAMES } from '../core/telemetry.js';
import { buildIndex, search, highlight } from '../core/search.js';
import { h, append, setChildren, formatRelative, formatCount, focusTrap } from './dom.js';

/* ============================================================================================ *
 * Constants
 * ============================================================================================ */

/**
 * The five themes, in the order their swatches appear in the bar.
 *
 * `glyphs` is how much of the matrix-style glyph rain that theme wants, from 0 (none) to 1 (full).
 * It lives here rather than in CSS because it is an argument to a WebGL layer, and no stylesheet
 * can express "run this many particles". The numbers are fixed by SPEC.md §4.
 */
const THEMES = [
  { id: 'foundation', name: 'Foundation', glyphs: 0.12 },
  { id: 'matrix', name: 'Matrix', glyphs: 1 },
  { id: 'blueprint', name: 'Blueprint', glyphs: 0.2 },
  { id: 'nebula', name: 'Nebula', glyphs: 0.18 },
  { id: 'solar', name: 'Solar', glyphs: 0 },
];

const THEME_IDS = THEMES.map((theme) => theme.id);
const DEFAULT_THEME = 'foundation';

/** The two catalogue views. `grid` is the list of cards; `constellation` hands over to the sky. */
const VIEWS = ['grid', 'constellation'];

/** How many results the catalogue will render at once. The whole catalogue is well under this. */
const SEARCH_LIMIT = 200;

/** How many results the command palette offers before it stops listing projects. */
const PALETTE_LIMIT = 7;

/** Half-life, in days, of the "recently pushed" part of a star's size in the constellation. */
const RECENCY_HALF_LIFE = 180;

/** How long the delete button stays armed after the first click, in milliseconds. */
const CONFIRM_WINDOW_MS = 6000;

/** How often the frames-per-second readout is refreshed, in milliseconds. */
const HUD_INTERVAL_MS = 400;

/**
 * How long the toast takes to fade out, in milliseconds.
 *
 * It is a little longer than the 200 ms transition in components.css on purpose: the element is
 * given the `hidden` attribute when this elapses, and taking it out of the page a frame early
 * would cut the fade off rather than let it finish.
 */
const TOAST_FADE_MS = 260;

/** Cluster metadata by id, so a project can be turned into its cluster's name in one lookup. */
const CLUSTER_BY_ID = new Map(CLUSTERS.map((cluster) => [cluster.id, cluster]));

/**
 * The catalogue's resting order: featured first, then most stars, then most recently pushed, then
 * alphabetically. Computed once, because it never changes.
 */
function sortDefault(a, b) {
  return (
    (b.featured ? 1 : 0) - (a.featured ? 1 : 0) ||
    b.stars - a.stars ||
    b.updated.localeCompare(a.updated) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * The catalogue's resting order, recomputed whenever the catalogue itself changes.
 *
 * This used to be a `const` sorted once at module load, which was correct while the repository
 * list was a checked-in file. It is now fetched from GitHub while the page is already on screen,
 * so a fixed snapshot would leave the grid showing the seed's order — and, worse, would not
 * contain any repository created since the seed was captured.
 */
let DEFAULT_ORDER = PROJECTS.slice().sort(sortDefault);

/* ============================================================================================ *
 * Module state
 * ============================================================================================ */

/** Everything the page needs to remember while it is open. */
const state = {
  theme: null,
  view: null,
  density: null,
  /** The free text in the catalogue search box. */
  query: '',
  /** The active cluster filter, or an empty string for "all". */
  cluster: '',
  /** The project id most recently opened, used by the constellation view. */
  selected: null,
  /** Ids currently rendered in the grid, so `openProject` knows whether to clear the filters. */
  visible: new Set(),
};

/** Handles returned by the two effects layers, or null when they are not running. */
let cosmos = null;
let glyphs = null;

/** The search index, built once from the catalogue. */
let index = null;

/** Cached DOM references, filled in `cacheElements()`. */
const els = {};

/** Card elements by project id. Reused across renders so the DOM stays stable while typing. */
const cardCache = new Map();

/**
 * The same cards again, for the constellation view's detail panel.
 *
 * Two caches rather than one, because the grid copy and the detail copy of a repository are two
 * separate elements that are in the document at the same time. They cannot share an `id`, so they
 * cannot share a cache entry either — see `buildCard`'s `idPrefix`.
 */
const starCardCache = new Map();

/** Every unsubscribe function handed back by `store.subscribe` and the motion module. */
const unsubscribes = [];

/** Every listener this file added, recorded by `on()` so `dispose()` can take them all off again. */
const listeners = [];

/** The section-highlight observer, kept so `dispose()` can disconnect it. */
let sectionObserver = null;

/** The handle of the frames-per-second timer, or 0 while it is not running. */
let hudTimer = 0;

/* ============================================================================================ *
 * Small helpers
 * ============================================================================================ */

const byId = (id) => document.getElementById(id);

/**
 * Add an event listener and remember it, so `dispose()` can take it off again.
 *
 * Every `addEventListener` in this file goes through here. The alternative — writing a matching
 * `removeEventListener` by hand next to each one — is exactly the sort of bookkeeping that falls
 * out of step the first time somebody adds a control, and SPEC.md §6 asks for a removal for every
 * listener a module adds.
 */
function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  listeners.push({ target, type, handler, options });
}

/** Read one custom property off the root element as a trimmed string. */
function readToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Run `fn` on the next animation frame, at most once per frame however many times this is called.
 *
 * This is what keeps typing responsive. A fixed debounce ("wait 150ms after the last keystroke")
 * makes a search box feel laggy for a fast typist and still fires too often for a slow one;
 * coalescing to one frame means the list is rebuilt exactly as often as the screen is redrawn.
 *
 * The frame comes from `motion.add()` rather than from `requestAnimationFrame`, because this page
 * has one frame loop and it lives in core/motion.js. When the tab is hidden that loop is stopped —
 * nobody can type into a hidden tab, but a route change could still arrive, so that case runs the
 * work immediately instead of queueing it forever.
 */
let pendingFrameJob = null;
function onNextFrame(fn) {
  if (pendingFrameJob) return;
  if (document.hidden) {
    fn();
    return;
  }
  const remove = motion.add(
    () => {
      remove();
      pendingFrameJob = null;
      fn();
    },
    // Ahead of the ambient animation, so a render lands in the same frame it was asked for.
    { priority: 20 },
  );
  pendingFrameJob = remove;
}

/**
 * Show a short message in the corner. `tone` is one of 'ok', 'warn', 'crit'.
 *
 * The toast carries the `hidden` attribute whenever it is not showing, so between messages it is
 * out of the accessibility tree and out of the layout entirely rather than merely transparent.
 * That attribute has to come off before the class goes on: a browser only animates between two
 * states it has actually laid out, and an element that appears and gains `.toast--visible` in the
 * same tick has no "before" to animate from, so it would pop in. Reading `offsetWidth` in between
 * forces the layout that gives the transition its starting point.
 */
let toastTimer = 0;
function toast(message, tone = 'ok') {
  if (!els.toast) return;
  // Order matters for the announcement, not only for the fade. A polite live region that is
  // `display: none` is not in the accessibility tree at all, so text written into it while it is
  // still hidden is written where nothing is listening. Taking `hidden` off first puts the region
  // back in the tree, and the text that follows is then a genuine change to a live region, which
  // every screen reader announces the same way.
  els.toast.hidden = false;
  els.toastMsg.textContent = message;
  els.toast.className = `toast toast--${tone}`;
  void els.toast.offsetWidth;
  els.toast.classList.add('toast--visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, 4200);
}

/**
 * Take the toast away again.
 *
 * Dropping `.toast--visible` starts the fade; `hidden` can only follow once the fade has run,
 * otherwise the element would be pulled out of the page mid-transition and the message would
 * vanish instead of fading. The same `toastTimer` handle carries that wait, so a new message
 * arriving during the fade cancels it along with everything else.
 */
function hideToast() {
  window.clearTimeout(toastTimer);
  if (!els.toast) return;
  els.toast.className = 'toast';
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, TOAST_FADE_MS);
}

/** True when the keyboard is inside a control that expects the character being typed. */
function isTypingTarget(node) {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Scroll an element into view, honouring the visitor's motion preference. */
function scrollTo(el, block = 'start') {
  if (!el) return;
  el.scrollIntoView({ block, behavior: motion.reduced ? 'auto' : 'smooth' });
}

/* ============================================================================================ *
 * The palette of scene colours (SPEC.md §5)
 * ============================================================================================ */

/**
 * Read the six `--scene-*` tokens off the root element.
 *
 * This is the only way JavaScript ever learns a colour on this site. The tokens are plain
 * `#rrggbb` strings precisely so they can be handed to WebGL, which cannot parse `rgba()` or a
 * colour keyword. Reading them again after the theme attribute changes is what makes a theme swap
 * repaint the sky as well as the page.
 */
function readScenePalette() {
  const computed = getComputedStyle(document.documentElement);
  const token = (name) => computed.getPropertyValue(name).trim();
  return {
    starA: token('--scene-star-a'),
    starB: token('--scene-star-b'),
    starC: token('--scene-star-c'),
    fog: token('--scene-fog'),
    glyph: token('--scene-glyph'),
    link: token('--scene-link'),
  };
}

/** How much glyph rain the given theme asks for, with reduced motion overriding it to none. */
function glyphIntensityFor(themeId) {
  if (motion.reduced) return 0;
  const theme = THEMES.find((entry) => entry.id === themeId);
  return theme ? theme.glyphs : 0.12;
}

/* ============================================================================================ *
 * Theme
 * ============================================================================================ */

/**
 * Apply a theme everywhere: the attribute the stylesheets read, the pressed state of the swatches,
 * storage, the two effects layers, and the event log.
 *
 * @param {string} id          one of THEME_IDS; anything else falls back to the default
 * @param {object} [options]
 * @param {boolean} [options.persist=true] write it to storage. False when the change *came* from
 *   storage (another tab), which is what stops the two tabs from writing back and forth.
 */
function applyTheme(id, { persist = true } = {}) {
  const next = THEME_IDS.includes(id) ? id : DEFAULT_THEME;
  const previous = state.theme;
  if (previous === next) return;

  state.theme = next;
  document.documentElement.setAttribute('data-theme', next);

  for (const button of els.themeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.themeId === next));
  }
  if (els.readoutTheme) els.readoutTheme.textContent = next;

  // The `theme-color` meta tag is what a mobile browser paints its address bar and its task
  // switcher card with. It is rewritten here from the resolved `--ground` token — the theme's own
  // page background — so the bar follows the theme the visitor picked in this page. Left to the
  // markup alone it could only ever answer to the operating system's light or dark setting, which
  // is a different question. The value in <head> is only the guess made before this runs.
  const ground = readToken('--ground');
  if (els.themeColor && ground) els.themeColor.setAttribute('content', ground);

  // getComputedStyle forces the browser to finish its style recalculation, so the tokens read
  // here are already the new theme's, not the outgoing one's.
  const palette = readScenePalette();
  if (cosmos) cosmos.setPalette(palette);
  if (glyphs) {
    glyphs.setPalette(palette);
    glyphs.setIntensity(glyphIntensityFor(next));
  }

  if (persist) store.set(KEYS.theme, next);
  if (previous !== null) telemetry.track(EVENT_NAMES.THEME_CHANGE, { from: previous, to: next });
}

/* ============================================================================================ *
 * View, density and motion preferences
 * ============================================================================================ */

/**
 * Switch between the card grid and the constellation.
 *
 * The catalogue is never hidden in either view, because a canvas cannot be read aloud and SPEC.md
 * §4 requires the whole catalogue to stay available whichever view is showing. What changes is how
 * much room it takes: in constellation view the grid gains `.catalog--compact` and lays its cards
 * out as one dense column, while `:root[data-view="constellation"]` quietens the rest of the page
 * so the sky reads through it.
 *
 * That is deliberately not the same as moving the grid off-screen with `.sr-only`, which is what
 * this used to do. Off-screen text is invisible but still focusable, so a keyboard visitor would
 * tab into a stack of links they could not see, with the focus ring clipped to a one-pixel box —
 * and pressing Enter would take them to GitHub from a control that was never on screen. Keeping
 * the cards visible costs a little of the sky and fixes that outright.
 *
 * The second half is about the mouse. The scene canvas is the bottom layer and the content column
 * sits on top of it across the whole page, and `fx/cosmos.js` only hit-tests a star when the canvas
 * is genuinely the element under the pointer — so without help the constellation could be looked at
 * but never touched. In constellation view <main> stops intercepting pointer events, which opens up
 * the empty gutters either side of the text, and every section's own `.wrap` takes them back, so
 * every control on the page keeps working: the hero buttons, the cluster chips, the account links,
 * the toggles, the telemetry panel and the footer, not only the catalogue's own controls. Keyboard
 * navigation is untouched throughout: `pointer-events` says nothing about Tab or Enter.
 */
function applyView(id, { persist = true } = {}) {
  const next = VIEWS.includes(id) ? id : 'grid';
  const previous = state.view;
  if (previous === next) return;

  state.view = next;
  document.documentElement.setAttribute('data-view', next);

  els.viewGrid.setAttribute('aria-pressed', String(next === 'grid'));
  els.viewConstellation.setAttribute('aria-pressed', String(next === 'constellation'));
  els.catalogGrid.classList.toggle('catalog--compact', next === 'constellation');
  els.starDetail.hidden = next !== 'constellation';

  // One pass over a list gathered once at start-up. Going back to grid clears the inline value
  // rather than writing 'auto', so the stylesheet is left in charge of the default again.
  const passThrough = next === 'constellation';
  if (els.content) els.content.style.pointerEvents = passThrough ? 'none' : '';
  for (const wrap of els.sectionWraps) wrap.style.pointerEvents = passThrough ? 'auto' : '';

  if (next === 'constellation') renderStarDetail(state.selected);
  if (els.readoutView) els.readoutView.textContent = next;

  if (persist) store.set(KEYS.view, next);
  if (previous !== null) telemetry.track(EVENT_NAMES.VIEW_CHANGE, { from: previous, to: next });
}

/**
 * Comfortable or compact.
 *
 * There is no `[data-density]` rule in the stylesheets, and there should not be: layout.css hands
 * every grid its gap through `--sp-gap`, and tokens.css hands every section its rhythm through
 * `--sp-section`. Overriding those two custom properties on the shell is the whole feature, and it
 * cascades to everything without a single new selector. The attribute is set as well, so a future
 * stylesheet can react to it.
 */
function applyDensity(id, { persist = true } = {}) {
  const next = id === 'compact' ? 'compact' : 'comfortable';
  if (state.density === next) return;
  state.density = next;

  document.documentElement.setAttribute('data-density', next);
  const shell = els.shell;
  if (shell) {
    if (next === 'compact') {
      shell.style.setProperty('--sp-gap', '0.75rem');
      shell.style.setProperty('--sp-section', 'clamp(2.5rem, 5vw, 4.5rem)');
    } else {
      shell.style.removeProperty('--sp-gap');
      shell.style.removeProperty('--sp-section');
    }
  }
  if (els.densityToggle) els.densityToggle.checked = next === 'compact';
  if (persist) store.set(KEYS.density, next);
}

/**
 * Write the motion preference — to the root element for the stylesheets, and to storage for
 * everything else.
 *
 * The attribute is the half that used to be missing. The stylesheets already answer to
 * `prefers-reduced-motion`, the operating system's own setting, but that setting belongs to the
 * machine and this toggle belongs to the page: a visitor who leaves their system alone and turns
 * this switch off would otherwise keep every CSS animation running — the caret in the hero would go
 * on blinking, and in the matrix theme the full-screen scanline would go on sweeping. Stamping
 * `data-motion="reduced"` gives motion.css a selector to answer, mirroring what it already does
 * inside the media query, so one switch turns both sources off.
 *
 * The stored value is the other half. core/motion.js watches that key itself, in this tab and in
 * every other one, so writing it is all the JavaScript-driven animation needs — `motion.reduced`
 * updates and the callback registered in `wireMotion()` picks up the consequences.
 */
function applyMotionPreference(animate, { persist = true } = {}) {
  document.documentElement.setAttribute('data-motion', animate ? 'full' : 'reduced');
  if (els.motionToggle) els.motionToggle.checked = animate;
  if (persist) store.set(KEYS.motion, animate ? 'full' : 'reduced');
}

/* ============================================================================================ *
 * Cards
 * ============================================================================================ */

/**
 * Build one project card. Called once per project, ever: `renderCatalog` moves these nodes around
 * rather than rebuilding them, which is what keeps focus, scroll position and the reveal animation
 * from being thrown away on every keystroke.
 *
 * The returned object keeps direct references to the three elements whose contents change when the
 * search terms change, so an update never has to query the DOM again.
 *
 * `idPrefix` exists because the constellation view shows a second copy of one repository's card
 * while the grid copy is still in the document. Two elements in one page may never carry the same
 * `id`: `getElementById` would answer with whichever came first, and a screen reader would read the
 * repository out twice. The detail copy passes 'star-card' so the two are told apart.
 *
 * @param {object} project    the catalogue entry to draw
 * @param {string} [idPrefix] what the element's `id` starts with, before the project's slug
 */
function buildCard(project, idPrefix = 'card') {
  const owner = OWNERS[project.owner] || {
    login: project.owner,
    kind: 'user',
    url: `https://github.com/${project.owner}`,
  };
  const cluster = CLUSTER_BY_ID.get(project.cluster);
  const langColor = colorForLang(project.lang);

  const titleLink = h('a', {
    href: project.url,
    rel: 'noopener',
    dataset: { open: project.id },
  });
  const title = h('h3', { className: 'card__title' }, titleLink);
  const tagline = h('p', { className: 'card__tagline' });
  const desc = h('p', { className: 'card__desc' });

  const topics = h(
    'ul',
    { className: 'card__topics' },
    (project.topics || []).slice(0, 6).map((topic) =>
      h(
        'li',
        null,
        // `title` carries the full topic, because the chip's CSS truncates a long one with an
        // ellipsis on a narrow screen rather than letting it widen the page.
        h('button', { className: 'chip', type: 'button', title: topic, dataset: { topic } }, topic),
      ),
    ),
  );

  const foot = h('p', { className: 'card__foot' }, [
    h('span', { className: 'card__stars' }, [
      h('span', { 'aria-hidden': 'true' }, '★'),
      h('span', null, formatCount(project.stars)),
      h('span', { className: 'sr-only' }, project.stars === 1 ? 'stargazer' : 'stargazers'),
    ]),
    cluster
      ? h('span', { className: 'chip', title: cluster.name }, cluster.id)
      : null,
    project.home
      ? h('a', { className: 'chip', href: project.home, rel: 'noopener' }, 'site')
      : null,
    h(
      'span',
      { className: 'card__updated', title: `Pushed on ${project.updated}` },
      formatRelative(project.updated),
    ),
  ]);

  const root = h(
    'article',
    {
      className: project.featured ? 'card card--featured' : 'card',
      id: `${idPrefix}-${project.id}`,
      dataset: { id: project.id },
      // A per-language colour is data, not theme — GitHub's own colour for that language — so it
      // arrives as an inline custom property that .card__lang reads.
      style: langColor ? { '--lang': langColor } : null,
    },
    [
      h('div', { className: 'card__head' }, [
        h('span', {
          className: 'card__lang',
          title: project.lang,
          'aria-hidden': 'true',
        }),
        h(
          'span',
          {
            className:
              owner.kind === 'org' ? 'card__owner card__owner--org' : 'card__owner card__owner--user',
          },
          owner.login,
        ),
        h('span', { className: 'chip' }, project.lang),
      ]),
      title,
      tagline,
      desc,
      topics,
      foot,
    ],
  );

  return { root, project, titleLink, tagline, desc };
}

/** Get the grid card for a project, building it the first time it is needed. */
function cardFor(project) {
  let entry = cardCache.get(project.id);
  if (!entry) {
    entry = buildCard(project);
    cardCache.set(project.id, entry);
  }
  return entry;
}

/**
 * The same thing for the constellation view's detail panel, out of its own cache.
 *
 * Caching matters here for the same reason it does in the grid: clicking back and forth between two
 * stars would otherwise rebuild a whole card subtree every time, throwing away the reveal state and
 * anything the visitor had focused inside it.
 */
function starCardFor(project) {
  let entry = starCardCache.get(project.id);
  if (!entry) {
    entry = buildCard(project, 'star-card');
    starCardCache.set(project.id, entry);
  }
  return entry;
}

/**
 * Write the matched text into a card.
 *
 * `highlight()` is the one function in this codebase allowed to produce HTML, and it escapes every
 * character of its input before wrapping the matched ranges in <mark>. Called with no ranges — the
 * ordinary browsing case — it returns the same text, still escaped.
 */
function updateCard(entry, matches) {
  const { project } = entry;
  entry.titleLink.innerHTML = highlight(project.name, matches && matches.name);
  entry.tagline.innerHTML = highlight(project.tagline, matches && matches.tagline);
  entry.desc.innerHTML = highlight(project.desc, matches && matches.desc);
}

/**
 * Put `results` into the grid in order, reusing the cards that are already there.
 *
 * The walk is the standard "reconcile against a cursor" one: step through the wanted list and the
 * existing children together, and only touch the DOM when they disagree. `insertBefore` on a node
 * that is already in the document moves it rather than copying it, so a card that merely changed
 * position is never destroyed and rebuilt.
 *
 * @param {Array<{project: object, matches?: object}>} results
 */
function renderCatalog(results) {
  const grid = els.catalogGrid;
  const fresh = [];
  let cursor = grid.firstElementChild;

  state.visible = new Set();

  for (const result of results) {
    const entry = cardFor(result.project);
    state.visible.add(result.project.id);
    updateCard(entry, result.matches);

    if (entry.root !== cursor) {
      if (!entry.root.isConnected) fresh.push(entry.root);
      grid.insertBefore(entry.root, cursor);
    } else {
      cursor = cursor.nextElementSibling;
    }
  }

  // Anything still after the cursor did not survive this query.
  while (cursor) {
    const next = cursor.nextElementSibling;
    grid.removeChild(cursor);
    cursor = next;
  }

  // Only the cards that are new to the document need a reveal observer; `reveal()` skips elements
  // it has already seen, so this is belt and braces rather than strictly necessary.
  for (const node of fresh) node.setAttribute('data-reveal', '');
  if (fresh.length > 0) reveal(grid);
}

/** Render the single card the constellation view shows for the selected star. */
function renderStarDetail(id) {
  if (!els.starDetail) return;
  const project = id ? PROJECTS.find((entry) => entry.id === id) : null;

  if (!project) {
    setChildren(
      els.starDetail,
      h(
        'p',
        { className: 'cluster__blurb' },
        'Point at a star in the sky to see which repository it is, and click it to open the card here.',
      ),
    );
    return;
  }

  const entry = starCardFor(project);
  updateCard(entry, null);
  setChildren(els.starDetail, entry.root);
  els.starDetailLink = entry.titleLink;
}

/* ============================================================================================ *
 * Query and filters
 * ============================================================================================ */

/** The last query written to the event log, so re-rendering for another reason cannot log twice. */
let lastLoggedQuery = '';

/** Rebuild the catalogue from the current query and cluster filter, and announce the result. */
function applyQuery({ announce = true } = {}) {
  const query = state.query.trim();
  let results;

  if (query) {
    results = search(index, query, {
      limit: SEARCH_LIMIT,
      filters: state.cluster ? { cluster: state.cluster } : {},
    });
  } else {
    const list = state.cluster ? byCluster(state.cluster) : DEFAULT_ORDER;
    results = list.map((project) => ({ project, matches: null }));
  }

  renderCatalog(results);

  if (els.catalogClear) els.catalogClear.hidden = query.length === 0;

  if (announce) {
    const count = results.length;
    const scope = state.cluster ? ` in ${state.cluster}` : '';
    const term = query ? ` matching “${query}”` : '';
    els.catalogCount.textContent = count === 0
      ? `No repositories${scope}${term}. Try a shorter word, or clear the filters.`
      : `${formatCount(count)} of ${formatCount(PROJECTS.length)} repositories${scope}${term}.`;
  }

  if (query && query !== lastLoggedQuery) {
    lastLoggedQuery = query;
    // The event records how long the query was and how many results came back — never the text.
    telemetry.track(EVENT_NAMES.SEARCH_QUERY, { queryLen: query.length, results: results.length });
  } else if (!query) {
    lastLoggedQuery = '';
  }
  return results;
}

/** Set the search text and schedule a re-render. */
function setQuery(value, { immediate = false, writeInput = true } = {}) {
  state.query = typeof value === 'string' ? value : '';
  if (writeInput && els.catalogSearch && els.catalogSearch.value !== state.query) {
    els.catalogSearch.value = state.query;
  }
  if (immediate) applyQuery();
  else onNextFrame(() => applyQuery());
}

/** Turn a cluster filter on, or pass an empty string to clear it. */
function setCluster(id, { track = true } = {}) {
  const next = CLUSTER_BY_ID.has(id) ? id : '';
  const previous = state.cluster;
  state.cluster = next;

  for (const chip of els.filterChips) {
    chip.setAttribute('aria-pressed', String((chip.dataset.filter || '') === next));
  }

  if (track && previous !== next) {
    if (previous) telemetry.track(EVENT_NAMES.CLUSTER_FILTER, { id: previous, active: false });
    if (next) telemetry.track(EVENT_NAMES.CLUSTER_FILTER, { id: next, active: true });
  }
}

/**
 * Bring one project to the visitor's attention: make sure it is in the grid, scroll to it, move
 * the keyboard there, aim the camera at its star, and record the route.
 */
function openProject(id, via = 'card') {
  const project = PROJECTS.find((entry) => entry.id === id);
  if (!project) return false;

  state.selected = id;

  // A project reached from a link or from the sky may be filtered out of the current view. Clear
  // the filters rather than silently doing nothing.
  if (!state.visible.has(id)) {
    setCluster('');
    setQuery('', { immediate: true });
  }

  if (state.view === 'constellation') {
    renderStarDetail(id);
    scrollTo(els.starDetail, 'center');
    if (els.starDetailLink) els.starDetailLink.focus({ preventScroll: true });
  } else {
    const entry = cardCache.get(id);
    if (entry && entry.root.isConnected) {
      scrollTo(entry.root, 'center');
      entry.titleLink.focus({ preventScroll: true });
    }
  }

  if (cosmos) cosmos.focus(id);
  telemetry.track(EVENT_NAMES.PROJECT_OPEN, { id, cluster: project.cluster, via });
  writeRoute(`#/p/${encodeURIComponent(id)}`);
  return true;
}

/* ============================================================================================ *
 * Hash routing
 * ============================================================================================ */

/**
 * Read `location.hash` as one of the three routes in SPEC.md §4.
 *
 * Anything else — including the plain section anchors such as `#catalog` that the navigation bar
 * uses — is reported as `{ kind: 'none' }` and left to the browser's own anchor behaviour.
 */
function parseRoute(hash) {
  if (!hash || hash.length < 4 || hash[1] !== '/') return { kind: 'none' };
  const body = hash.slice(2);
  const slash = body.indexOf('/');
  if (slash === -1) return { kind: 'none' };

  const kind = body.slice(0, slash);
  let value = body.slice(slash + 1);
  try {
    value = decodeURIComponent(value);
  } catch {
    /* A malformed escape sequence. Use the raw text rather than throwing away the route. */
  }
  if (!value) return { kind: 'none' };
  if (kind === 'p') return { kind: 'project', value };
  if (kind === 'c') return { kind: 'cluster', value };
  if (kind === 'q') return { kind: 'query', value };
  return { kind: 'none' };
}

/** True while a route is being applied, so writing the address bar cannot start a second pass. */
let applyingRoute = false;

/**
 * Put a route in the address bar without adding a history entry.
 *
 * `replaceState` rather than `pushState` on purpose: filtering and searching change the address
 * dozens of times in a minute, and every one of those as a history entry would turn the browser's
 * Back button into a per-keystroke undo. It also does not fire `hashchange`, so this cannot loop
 * back into `applyRoute`.
 */
function writeRoute(hash) {
  const target = hash || window.location.pathname + window.location.search;
  if (window.location.hash === hash) return;
  try {
    window.history.replaceState(null, '', target);
  } catch {
    // `file://` pages refuse replaceState. The page still works; only the address bar is stale.
    return;
  }
  telemetry.page();
}

/** Apply whatever route is currently in the address bar. */
function applyRoute({ initial = false } = {}) {
  if (applyingRoute) return;
  applyingRoute = true;
  try {
    const route = parseRoute(window.location.hash);

    if (route.kind === 'project') {
      openProject(route.value, initial ? 'hash' : 'link');
      return;
    }

    if (route.kind === 'cluster') {
      setCluster(route.value);
      setQuery('', { immediate: true });
      scrollTo(els.catalogSection);
      // An unknown cluster id leaves the filter cleared, so the address bar is cleared with it
      // rather than left pointing at a group that does not exist.
      writeRoute(state.cluster ? `#/c/${encodeURIComponent(state.cluster)}` : '');
      return;
    }

    if (route.kind === 'query') {
      setCluster('');
      setQuery(route.value, { immediate: true });
      scrollTo(els.catalogSection);
      if (!initial) telemetry.track(EVENT_NAMES.SEARCH_OPEN, { via: 'hash' });
    }
  } finally {
    applyingRoute = false;
  }
}

/* ============================================================================================ *
 * Command palette
 * ============================================================================================ */

const palette = {
  open: false,
  /** The rendered items, in list order. Group headings are not in here. */
  items: [],
  active: 0,
  release: null,
};

/**
 * Build the list the palette should show for the text typed into it.
 *
 * Three groups, always in the same order so the palette is predictable: projects, then themes,
 * then actions. Each item carries the function that runs when it is chosen.
 */
function paletteItems(rawQuery) {
  const query = rawQuery.trim();
  const folded = query.toLowerCase();
  const items = [];

  const projects = query
    ? search(index, query, { limit: PALETTE_LIMIT }).map((result) => result.project)
    : DEFAULT_ORDER.slice(0, PALETTE_LIMIT);

  for (const project of projects) {
    items.push({
      group: 'Projects',
      title: project.name,
      meta: project.cluster,
      run: () => {
        // Closing first hands focus back to whatever opened the palette; opening the project then
        // moves it on to the card, so the keyboard ends up where the visitor is looking.
        closePalette();
        openProject(project.id, 'palette');
      },
    });
  }

  for (const theme of THEMES) {
    if (folded && !theme.name.toLowerCase().includes(folded) && !'theme'.includes(folded)) continue;
    items.push({
      group: 'Themes',
      title: `Theme: ${theme.name}`,
      meta: theme.id === state.theme ? 'current' : '',
      run: () => {
        applyTheme(theme.id);
        closePalette();
      },
    });
  }

  const actions = [
    {
      title: state.view === 'grid' ? 'Switch to constellation view' : 'Switch to grid view',
      run: () => {
        applyView(state.view === 'grid' ? 'constellation' : 'grid');
        closePalette();
      },
    },
    {
      title: 'Clear all filters',
      run: () => {
        setCluster('');
        setQuery('', { immediate: true });
        writeRoute('');
        closePalette();
      },
    },
    {
      title: 'Go to the catalogue',
      run: () => {
        closePalette();
        scrollTo(els.catalogSection);
      },
    },
    {
      title: 'Go to what this page is doing',
      run: () => {
        closePalette();
        scrollTo(els.instrumentSection);
      },
    },
    {
      title: 'Download my visit log',
      run: () => {
        closePalette();
        void exportTelemetry();
      },
    },
  ];

  for (const action of actions) {
    if (folded && !action.title.toLowerCase().includes(folded)) continue;
    items.push({ group: 'Actions', title: action.title, meta: '', run: action.run });
  }

  return items;
}

/** Draw the palette list and mark one row as selected. */
function renderPalette() {
  const list = els.paletteList;
  const count = palette.items.length;
  list.replaceChildren();

  // Say out loud how many results there are.
  //
  // A screen reader reads a listbox when the focus moves into it, and the focus never leaves the
  // text field here — that is the whole point of a combobox. So a visitor who types a misspelling
  // would get complete silence: the list would empty and nothing would announce it. The polite live
  // region below the list is read whenever this text changes, without interrupting whatever is
  // already being spoken. `aria-expanded` reports the same fact to anyone navigating by structure:
  // true only while there is a list to expand into.
  els.paletteInput.setAttribute('aria-expanded', String(count > 0));
  if (els.paletteStatus) {
    els.paletteStatus.textContent =
      count === 0 ? 'No results' : `${count} ${count === 1 ? 'result' : 'results'}`;
  }

  if (count === 0) {
    append(list, h('li', { className: 'palette__empty', role: 'presentation' }, 'Nothing matches that.'));
    els.paletteInput.removeAttribute('aria-activedescendant');
    return;
  }

  let lastGroup = null;
  palette.items.forEach((item, position) => {
    if (item.group !== lastGroup) {
      lastGroup = item.group;
      append(list, h('li', { className: 'palette__group', role: 'presentation' }, item.group));
    }
    append(
      list,
      h(
        'li',
        {
          className: 'palette__item',
          role: 'option',
          id: `palette-item-${position}`,
          'aria-selected': String(position === palette.active),
          dataset: { position: String(position) },
        },
        [
          h('span', { className: 'palette__item-title' }, item.title),
          item.meta ? h('span', { className: 'palette__item-meta' }, item.meta) : null,
        ],
      ),
    );
  });

  // `aria-activedescendant` is how a combobox tells a screen reader which row is current while
  // the keyboard focus itself stays in the text field.
  els.paletteInput.setAttribute('aria-activedescendant', `palette-item-${palette.active}`);
  const activeRow = list.querySelector('[aria-selected="true"]');
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
}

function refreshPalette() {
  palette.items = paletteItems(els.paletteInput.value);
  if (palette.active >= palette.items.length) palette.active = Math.max(0, palette.items.length - 1);
  renderPalette();
}

function movePaletteSelection(step) {
  if (palette.items.length === 0) return;
  const count = palette.items.length;
  palette.active = (palette.active + step + count) % count;
  renderPalette();
}

function openPalette(via = 'button') {
  if (palette.open) return;
  palette.open = true;
  els.palette.hidden = false;
  els.paletteInput.value = '';
  palette.active = 0;
  refreshPalette();
  // The trap focuses the input, remembers what was focused before, and restores it on release.
  palette.release = focusTrap(els.paletteDialog, { initial: els.paletteInput });
  telemetry.track(EVENT_NAMES.SEARCH_OPEN, { via });
}

/** Close the palette. Releasing the trap returns focus to the control that opened it. */
function closePalette() {
  if (!palette.open) return;
  palette.open = false;
  els.palette.hidden = true;
  // Empty the live region on the way out, so the next opening announces its count as a change
  // rather than repeating a number that is already sitting there.
  els.paletteInput.setAttribute('aria-expanded', 'false');
  if (els.paletteStatus) els.paletteStatus.textContent = '';
  if (palette.release) {
    const release = palette.release;
    palette.release = null;
    release();
  }
}

function wirePalette() {
  on(els.paletteInput, 'input', () => {
    palette.active = 0;
    refreshPalette();
  });

  on(els.paletteInput, 'keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      movePaletteSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      movePaletteSelection(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      palette.active = 0;
      renderPalette();
    } else if (event.key === 'End') {
      event.preventDefault();
      palette.active = Math.max(0, palette.items.length - 1);
      renderPalette();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = palette.items[palette.active];
      if (item) item.run();
    }
  });

  // Pointer selection. `mousedown` rather than `click`, so the input never loses focus first.
  on(els.paletteList, 'mousedown', (event) => {
    const row = event.target.closest('[data-position]');
    if (!row) return;
    event.preventDefault();
    const item = palette.items[Number(row.dataset.position)];
    if (item) item.run();
  });

  on(els.paletteScrim, 'click', () => closePalette());

  on(els.palette, 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  });

  on(els.openPalette, 'click', () => openPalette('button'));
  on(els.heroSearch, 'click', () => openPalette('button'));

  on(document, 'keydown', (event) => {
    // Control-K on Windows and Linux, Command-K on a Mac.
    if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
      event.preventDefault();
      if (palette.open) closePalette();
      else openPalette('shortcut');
      return;
    }
    // "/" is the other conventional search key, but only when the visitor is not already typing
    // a slash into a field — a search for "lang:rust" contains no slash, but a URL does.
    if (event.key === '/' && !palette.open && !isTypingTarget(event.target)) {
      event.preventDefault();
      openPalette('shortcut');
    }
  });
}

/* ============================================================================================ *
 * Telemetry: consent, the inspector panel, export and delete
 * ============================================================================================ */

/**
 * Reflect the current consent state on the button inside the panel.
 *
 * The value can be passed in explicitly, which matters for the cross-tab path: this page's store
 * subscriber may run before telemetry's own, in which case `getConsent()` would still be the old
 * answer while the event already carries the new one.
 */
function syncConsentButton(explicit) {
  const granted = explicit === undefined ? telemetry.getConsent() === 'granted' : explicit === 'granted';
  els.consentButton.textContent = granted ? 'Recording: on' : 'Recording: off';
  els.consentButton.setAttribute('aria-pressed', String(granted));
}

/** Set consent, update the interface, and refresh the panel so the change is visible at once. */
function setConsent(next) {
  telemetry.setConsent(next);
  syncConsentButton();
  els.consentBanner.hidden = true;
  void refreshInspector();
}

/**
 * Draw the inspector: the one-line summary, the per-day bars, and the most recent events.
 *
 * Both reads flush anything still queued first, so a panel opened straight after a click shows
 * that click rather than waiting for the browser's next idle moment.
 */
async function refreshInspector() {
  let summary;
  let events;
  try {
    summary = await telemetry.summary();
    events = await telemetry.query({ limit: 40 });
  } catch {
    // The module promises never to reject, but a broken browser build is not worth a dead page.
    return;
  }

  const sessions = summary.sessions === 1 ? '1 visit' : `${formatCount(summary.sessions)} visits`;
  els.telemetrySummary.textContent = summary.total === 0
    ? 'Nothing recorded in this browser yet.'
    : `${formatCount(summary.total)} events across ${sessions}, first seen ${formatRelative(summary.firstSeen)}.`;

  els.telemetryStorage.textContent = telemetry.storage === 'indexeddb'
    ? 'indexeddb'
    : `memory only — ${telemetry.degradeReason || 'storage unavailable'}`;

  const days = Object.keys(summary.byDay);
  const counts = days.map((day) => summary.byDay[day]);
  const peak = counts.reduce((most, value) => Math.max(most, value), 0);

  setChildren(
    els.telemetryBars,
    days.map((day, position) =>
      h('span', {
        className: counts[position] > 0 && counts[position] === peak ? 'panel__bar panel__bar--peak' : 'panel__bar',
        // The bar's height is `calc(var(--v) * 100%)`, so --v is this day's share of the busiest.
        style: { '--v': String(peak > 0 ? counts[position] / peak : 0) },
        title: `${day}: ${counts[position]}`,
      }),
    ),
  );
  els.telemetryDayFirst.textContent = days[0] || '';
  els.telemetryDayLast.textContent = days[days.length - 1] || '';

  setChildren(
    els.telemetryRows,
    events.map((event) =>
      h('tr', { className: 'panel__row' }, [
        h('td', { className: 'panel__td' }, new Date(event.ts).toLocaleTimeString()),
        h('td', { className: 'panel__td' }, event.name),
        h('td', { className: 'panel__td' }, describeProps(event.props)),
      ]),
    ),
  );
  els.telemetryEmpty.hidden = events.length > 0;
}

/** Turn an event's properties into one readable line. Values are already sanitised by the module. */
function describeProps(props) {
  if (!props) return '';
  const parts = [];
  for (const key of Object.keys(props)) parts.push(`${key}=${props[key]}`);
  return parts.join('  ');
}

/** Hand the visitor their own data as a file. Nothing is uploaded; the Blob never leaves the tab. */
async function exportTelemetry() {
  const summary = await telemetry.summary();
  const blob = await telemetry.export();
  if (!blob) {
    toast('This browser cannot build the download.', 'warn');
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: 'worxbend-telemetry.json' });
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers, so let the click settle first.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);

  // Emitted after the export, per the vocabulary note in core/telemetry.js.
  telemetry.track(EVENT_NAMES.TELEMETRY_EXPORT, { count: summary.total });
  toast(`Exported ${formatCount(summary.total)} events.`);
  void refreshInspector();
}

/**
 * Delete everything, but only on a second click.
 *
 * A two-step button rather than a `confirm()` dialog: this destroys data that cannot be recovered,
 * so it needs a deliberate confirmation, and a native dialog would block the whole page while the
 * WebGL scene is running.
 */
let clearArmedAt = 0;
let clearResetTimer = 0;

function disarmClear() {
  clearArmedAt = 0;
  window.clearTimeout(clearResetTimer);
  els.telemetryClear.textContent = 'Delete all';
}

async function onClearClicked() {
  const now = Date.now();
  if (now - clearArmedAt > CONFIRM_WINDOW_MS) {
    clearArmedAt = now;
    els.telemetryClear.textContent = 'Click again to delete';
    toast('This deletes every event stored in this browser. Click again to confirm.', 'warn');
    window.clearTimeout(clearResetTimer);
    clearResetTimer = window.setTimeout(disarmClear, CONFIRM_WINDOW_MS);
    return;
  }

  disarmClear();
  const summary = await telemetry.summary();
  await telemetry.clear();
  // Tracked after the wipe resolves, otherwise the wipe would delete the record of the wipe.
  telemetry.track(EVENT_NAMES.TELEMETRY_CLEAR, { count: summary.total });
  toast(`Deleted ${formatCount(summary.total)} events.`);
  await refreshInspector();
}

/** Start telemetry, show the consent banner once, and wire the panel's four buttons. */
async function wireTelemetry() {
  const stored = store.get(KEYS.telemetry, null);
  await telemetry.init({});
  syncConsentButton();

  if (stored !== 'granted' && stored !== 'denied') {
    if (telemetry.doNotTrack) {
      els.consentBody.textContent =
        'Your browser sends a "Do Not Track" signal, so recording stays off. If you turn it on, ' +
        'the events go into a database inside this browser and are never sent anywhere.';
    }
    els.consentBanner.hidden = false;
  }

  on(els.consentAllow, 'click', () => setConsent('granted'));
  on(els.consentDeny, 'click', () => setConsent('denied'));
  on(els.consentButton, 'click', () => {
    setConsent(telemetry.getConsent() === 'granted' ? 'denied' : 'granted');
  });

  on(els.telemetryRefresh, 'click', () => void refreshInspector());
  on(els.telemetryExport, 'click', () => void exportTelemetry());
  on(els.telemetryClear, 'click', () => void onClearClicked());
  on(els.telemetryClear, 'blur', disarmClear);

  // The first page view waits until here, because `track()` stores nothing until the consent
  // state has been read back out of storage.
  telemetry.page();
  await refreshInspector();
}

/* ============================================================================================ *
 * The effects layers
 * ============================================================================================ */

/**
 * Turn the catalogue into the node list the constellation draws.
 *
 * Size comes from two things added together: how many people starred the repository, and how
 * recently it was pushed. Recency decays smoothly — a repository pushed today contributes a full
 * point, one pushed six months ago contributes half of it — so the sky shows both what is popular
 * and what is alive, and a repository that is neither is still visible as a small star.
 */
function constellationNodes() {
  const now = Date.now();
  return PROJECTS.map((project) => {
    const ageDays = Math.max(0, (now - Date.parse(project.updated)) / 86400000);
    const recency = Number.isFinite(ageDays) ? Math.pow(0.5, ageDays / RECENCY_HALF_LIFE) : 0;
    return {
      id: project.id,
      cluster: project.cluster,
      lang: project.lang,
      weight: project.stars + recency * 2,
      color: colorForLang(project.lang),
    };
  });
}

/**
 * Mount both canvases.
 *
 * Note the dynamic `import()`. `fx/cosmos.js` imports three.js at the top of the file, which means
 * a failure to fetch three.js takes that whole module down — and a static import here would take
 * *this* module down with it, leaving a blank page. A dynamic import is an expression, so the
 * failure lands in the catch and the catalogue below carries on working. `fx/glyphs.js` already
 * imports PixiJS dynamically for the same reason, but it is loaded the same way for symmetry.
 *
 * When the sky cannot be drawn, `no-webgl` goes on <html> and motion.css takes over with a
 * CSS-only drifting starfield. A failure of the glyph layer alone does not set that class: there
 * is no CSS fallback for glyph rain, and the sky is still real.
 */
async function mountEffects() {
  const paletteColors = readScenePalette();

  try {
    const module = await import('../fx/cosmos.js');
    cosmos = await module.mountCosmos(els.scene, {
      palette: paletteColors,
      quality: motion.quality,
      nodes: constellationNodes(),
      seed: 'worxbend',
    });
  } catch {
    cosmos = null;
  }

  if (!cosmos) {
    document.documentElement.classList.add('no-webgl');
    if (els.readoutScene) els.readoutScene.textContent = 'css fallback';
  } else {
    if (els.readoutScene) els.readoutScene.textContent = 'webgl';
    on(els.scene, 'star:select', (event) => {
      const id = event.detail && event.detail.id;
      if (!id) return;
      telemetry.track(EVENT_NAMES.STAR_SELECT, { id });
      openProject(id, 'star');
    });
  }

  try {
    const module = await import('../fx/glyphs.js');
    glyphs = await module.mountGlyphs(els.glyphs, {
      palette: paletteColors,
      intensity: glyphIntensityFor(state.theme),
    });
  } catch {
    glyphs = null;
  }
}

/**
 * Rebuild the sky after the catalogue changes.
 *
 * The constellation layout is seeded from the node list, so a repository that arrived after mount
 * has no position and cannot simply be pushed in. Tearing the scene down and building it again is
 * both simpler and correct, and it is rare — at most once per page view, and only when the live
 * catalogue actually differs from the seed.
 *
 * `remounting` guards against a second refresh landing while the first is still awaiting the
 * dynamic import, which would otherwise leave two scenes drawing to one canvas.
 */
let remounting = false;
async function remountCosmos() {
  if (remounting || !cosmos) return;
  remounting = true;
  try {
    const module = await import('../fx/cosmos.js');
    const previous = cosmos;
    cosmos = null;
    previous.dispose();
    cosmos = await module.mountCosmos(els.scene, {
      palette: readScenePalette(),
      quality: motion.quality,
      nodes: constellationNodes(),
      seed: 'worxbend',
    });
  } catch (error) {
    // The sky is decoration over an information graphic that also exists as a list. Losing it is
    // survivable; taking the catalogue down with it is not.
    console.error('[app] could not rebuild the constellation', error);
    cosmos = null;
    document.documentElement.classList.add('no-webgl');
  } finally {
    remounting = false;
  }
}

/* ============================================================================================ *
 * Wiring
 * ============================================================================================ */

function cacheElements() {
  els.shell = document.querySelector('.shell');
  els.scene = byId('scene');
  els.glyphs = byId('glyphs');

  els.themeColor = document.querySelector('meta[name="theme-color"]');
  els.themeButtons = [...document.querySelectorAll('[data-theme-id]')];
  els.openPalette = byId('open-palette');
  els.heroSearch = byId('hero-search');

  els.readoutTheme = byId('readout-theme');
  els.readoutView = byId('readout-view');
  els.readoutNodes = byId('readout-nodes');
  els.readoutScene = byId('readout-scene');
  els.provenance = byId('catalog-provenance');

  els.content = byId('main');
  els.catalogSection = byId('catalog');
  // Every section's inner column. `applyView` walks this fixed list to give the pointer back to the
  // controls when <main> hands it to the sky, so the toggle is one pass over an array gathered once
  // rather than a query of the document on every switch.
  els.sectionWraps = [...document.querySelectorAll('.section > .wrap')];
  els.instrumentSection = byId('instrument');
  els.catalogSearch = byId('catalog-search');
  els.catalogClear = byId('catalog-clear');
  els.catalogCount = byId('catalog-count');
  els.catalogGrid = byId('catalog-grid');
  els.starDetail = byId('star-detail');
  els.filterChips = [...document.querySelectorAll('[data-filter]')];
  els.viewGrid = byId('view-grid');
  els.viewConstellation = byId('view-constellation');

  els.motionToggle = byId('toggle-motion');
  els.densityToggle = byId('toggle-density');

  els.palette = byId('palette');
  els.paletteDialog = els.palette.querySelector('.palette__dialog');
  els.paletteScrim = byId('palette-scrim');
  els.paletteInput = byId('palette-input');
  els.paletteList = byId('palette-list');
  els.paletteStatus = byId('palette-status');

  els.consentBanner = byId('consent-banner');
  els.consentBody = byId('consent-body');
  els.consentAllow = byId('consent-allow');
  els.consentDeny = byId('consent-deny');
  els.consentButton = byId('telemetry-consent');

  els.telemetrySummary = byId('telemetry-summary');
  els.telemetryStorage = byId('telemetry-storage');
  els.telemetryBars = byId('telemetry-bars');
  els.telemetryDayFirst = byId('telemetry-day-first');
  els.telemetryDayLast = byId('telemetry-day-last');
  els.telemetryRows = byId('telemetry-rows');
  els.telemetryEmpty = byId('telemetry-empty');
  els.telemetryRefresh = byId('telemetry-refresh');
  els.telemetryExport = byId('telemetry-export');
  els.telemetryClear = byId('telemetry-clear');

  els.toast = byId('toast');
  els.toastMsg = byId('toast-msg');
  els.toastClose = byId('toast-close');

  els.hud = byId('hud');
  els.hudFps = byId('hud-fps');
  els.hudQuality = byId('hud-quality');
  els.hudDot = byId('hud-dot');

  els.railLinks = [...document.querySelectorAll('.rail__link')];
}

/** Fill in every figure that is derived from the catalogue rather than written by hand. */
/**
 * Write the headline figures.
 *
 * `animate` is true exactly once, during start-up, when `counters()` has not run yet and the
 * numbers should roll up from zero as they scroll into view. Every later call — when the live
 * catalogue lands and the totals move — writes the new value straight in. Re-arming the roll-up
 * would be wrong twice over: `counters()` marks an element done and skips it afterwards, so the
 * figure would stay frozen at the zero this function had just written; and even if it did replay,
 * numbers spinning back to zero on a page the visitor is already reading looks like a fault.
 */
function fillFigures({ animate = false } = {}) {
  const totals = stats();

  const figures = {
    repos: totals.repos,
    clusters: totals.clusters,
    langs: totals.langs,
    stars: totals.stars,
  };
  for (const key of Object.keys(figures)) {
    const el = document.querySelector(`[data-stat="${key}"]`);
    if (!el) continue;
    const value = String(figures[key]);
    if (animate) {
      el.setAttribute('data-count-to', value);
      el.textContent = '0';
    } else {
      el.setAttribute('data-count-to', value);
      el.setAttribute('data-count-done', '');
      el.textContent = formatCount(figures[key]);
    }
  }
  const updatedEl = document.querySelector('[data-stat="updated"]');
  if (updatedEl) updatedEl.textContent = formatRelative(totals.latestUpdate);

  for (const el of document.querySelectorAll('[data-cluster-count]')) {
    const count = byCluster(el.dataset.clusterCount).length;
    el.textContent = `${formatCount(count)} ${count === 1 ? 'repository' : 'repositories'}`;
  }

  for (const el of document.querySelectorAll('[data-owner-count]')) {
    const login = el.dataset.ownerCount;
    const count = PROJECTS.filter((project) => project.owner === login).length;
    el.textContent = `${formatCount(count)} ${count === 1 ? 'repository' : 'repositories'}`;
  }

  if (els.readoutNodes) els.readoutNodes.textContent = String(totals.repos);
}

/**
 * Fold a freshly fetched catalogue into a page that is already on screen.
 *
 * The page paints from the committed seed on the first frame, then GitHub answers a moment later
 * with the current list. That answer can add repositories, remove them, and move every star count
 * and push date, so everything derived from the catalogue has to be rebuilt — but without
 * throwing away what the visitor is doing. Their search text, their cluster filter, their scroll
 * position and their focus all survive, because the update goes through the same `applyQuery()`
 * path a keystroke does.
 */
function wireCatalogRefresh() {
  unsubscribes.push(onCatalogChange((projects, meta) => {
    // Cards are memoised by project id. A repository that has gone (archived, made private, or
    // simply not pushed to for six months) must not keep a cached node, or it would reappear the
    // next time the grid is rebuilt.
    const live = new Set(projects.map((project) => project.id));
    for (const id of [...cardCache.keys()]) if (!live.has(id)) cardCache.delete(id);
    for (const id of [...starCardCache.keys()]) if (!live.has(id)) starCardCache.delete(id);

    DEFAULT_ORDER = projects.slice().sort(sortDefault);
    index = buildIndex(projects);
    fillFigures();
    renderProvenance(meta);
    applyQuery();

    // The sky is a picture of the catalogue, so a changed catalogue means a changed sky. Remount
    // rather than patch: the layout is seeded from the node list, and rebuilding it is the only
    // way a new repository gets a position instead of being appended off to one side.
    if (cosmos && state.view === 'constellation') void remountCosmos();

    telemetry.track(EVENT_NAMES.CATALOG_REFRESH, {
      source: meta.source,
      repos: projects.length,
      failed: Boolean(meta.error),
    });
  }));
}

/**
 * Say where the catalogue came from and how old it is.
 *
 * A page that quietly shows month-old numbers is worse than one that admits it, so the instrument
 * panel always states which of the four sources answered: a live call, a cached answer still
 * inside its six-hour window, a revalidated one GitHub confirmed unchanged, a stale cache kept
 * because the network failed, or the copy committed alongside the code.
 */
function renderProvenance(meta = catalogMeta) {
  if (!els.provenance) return;
  const when = meta.fetchedAt ? formatRelative(new Date(meta.fetchedAt).toISOString()) : null;
  const text = {
    // Nothing has been asked for yet: the seed is on screen and the request is in flight.
    pending: () => 'Checking GitHub for the current list…',
    network: () => `Live from the GitHub API, fetched ${when}.`,
    revalidated: () => `Live from the GitHub API — unchanged since ${when}.`,
    cache: () => `From this browser's saved copy, fetched ${when}.`,
    'stale-cache': () =>
      `GitHub could not be reached, so this is the saved copy from ${when}.`,
    seed: () =>
      'GitHub could not be reached, so this is the copy committed with the page. It may be out of date.',
  }[meta.source];
  els.provenance.textContent =
    `${text ? text() : 'Loading…'} Showing every public repository pushed to in the last ` +
    `${ACTIVE_MONTHS} months.`;
  els.provenance.dataset.source = meta.source;
}

function wireCatalog() {
  on(els.catalogSearch, 'input', () => {
    setQuery(els.catalogSearch.value, { writeInput: false });
  });

  on(els.catalogSearch, 'keydown', (event) => {
    if (event.key === 'Escape' && els.catalogSearch.value) {
      event.preventDefault();
      setQuery('', { immediate: true });
      writeRoute('');
    }
  });

  // Keep the address bar in step, but only once the typing has settled into a rendered result.
  on(els.catalogSearch, 'change', () => {
    const query = state.query.trim();
    writeRoute(query ? `#/q/${encodeURIComponent(query)}` : '');
  });

  on(els.catalogClear, 'click', () => {
    setQuery('', { immediate: true });
    writeRoute('');
    els.catalogSearch.focus();
  });

  for (const chip of els.filterChips) {
    on(chip, 'click', () => {
      const wanted = chip.dataset.filter || '';
      // Clicking the chip that is already on turns the filter off, which is what a pressed
      // toggle button is expected to do.
      const next = wanted && wanted === state.cluster ? '' : wanted;
      setCluster(next);
      applyQuery();
      writeRoute(next ? `#/c/${encodeURIComponent(next)}` : '');
    });
  }

  on(els.viewGrid, 'click', () => applyView('grid'));
  on(els.viewConstellation, 'click', () => applyView('constellation'));

  // One delegated listener for the whole grid rather than three per card.
  on(els.catalogGrid, 'click', (event) => {
    const topicChip = event.target.closest('[data-topic]');
    if (topicChip) {
      setQuery(topicChip.dataset.topic, { immediate: true });
      writeRoute(`#/q/${encodeURIComponent(topicChip.dataset.topic)}`);
      scrollTo(els.catalogSection);
      return;
    }
    const link = event.target.closest('[data-open]');
    if (link) {
      const project = PROJECTS.find((entry) => entry.id === link.dataset.open);
      if (project) {
        state.selected = project.id;
        telemetry.track(EVENT_NAMES.PROJECT_OPEN, {
          id: project.id,
          cluster: project.cluster,
          via: 'card',
        });
      }
    }
  });

  // Hovering a card aims the camera at that repository's star, which is what ties the two views
  // together: the grid explains the sky and the sky locates the grid.
  let aimedAt = null;
  on(els.catalogGrid, 'pointerover', (event) => {
    // Aiming the camera is ambient motion: nobody asked for it, it happens because the pointer
    // passed over something. A visitor who has asked the page to hold still gets no sky movement
    // from a stray mouse sweep. Deliberate actions — opening a project from the palette, following
    // a link — still call `focus()`, and `fx/cosmos.js` snaps rather than eases in that case.
    if (!cosmos || state.view !== 'grid' || motion.reduced) {
      aimedAt = null;
      return;
    }
    const card = event.target.closest('[data-id]');
    if (!card || card.dataset.id === aimedAt) return;
    // `pointerover` fires again for every child element inside the same card, and each call
    // restarts a seven-hundred-millisecond camera tween, so the last aim is remembered.
    aimedAt = card.dataset.id;
    cosmos.focus(aimedAt);
  });

  on(els.starDetail, 'click', (event) => {
    const topicChip = event.target.closest('[data-topic]');
    if (!topicChip) return;
    applyView('grid');
    setQuery(topicChip.dataset.topic, { immediate: true });
    scrollTo(els.catalogSection);
  });
}

function wireThemeAndToggles() {
  for (const button of els.themeButtons) {
    on(button, 'click', () => applyTheme(button.dataset.themeId));
  }

  on(els.motionToggle, 'change', () => {
    applyMotionPreference(els.motionToggle.checked);
  });

  on(els.densityToggle, 'change', () => {
    applyDensity(els.densityToggle.checked ? 'compact' : 'comfortable');
  });

  on(els.toastClose, 'click', hideToast);
}

/**
 * Keep the effects layers in step with the motion module, and mirror preference changes made in
 * another tab. `store.subscribe` fires for writes from this tab as well as from other ones; the
 * `applyX` functions all return early when nothing actually changed, so there is no ping-pong.
 */
function wireMotion() {
  unsubscribes.push(
    motion.onReducedChange((reduced) => {
      // This callback also fires when the *operating system* setting changes, which no code in this
      // file wrote, so the attribute the stylesheets read is stamped here as well as in
      // `applyMotionPreference`. Whichever of the two sources moves, the page ends up in step.
      document.documentElement.setAttribute('data-motion', reduced ? 'reduced' : 'full');
      if (els.motionToggle) els.motionToggle.checked = !reduced;
      if (glyphs) glyphs.setIntensity(reduced ? 0 : glyphIntensityFor(state.theme));
    }),
  );

  let lastQuality = motion.quality;
  unsubscribes.push(
    motion.onQualityChange((quality) => {
      if (cosmos) cosmos.setQuality(quality);
      telemetry.track(EVENT_NAMES.PERF_QUALITY, {
        from: lastQuality,
        to: quality,
        fps: Math.round(motion.fps),
      });
      lastQuality = quality;
    }),
  );

  unsubscribes.push(
    store.subscribe(KEYS.theme, (value) => applyTheme(value, { persist: false })),
    store.subscribe(KEYS.view, (value) => applyView(value, { persist: false })),
    store.subscribe(KEYS.density, (value) => applyDensity(value, { persist: false })),
    store.subscribe(KEYS.telemetry, (value) => syncConsentButton(value)),
  );

  on(window, 'hashchange', () => applyRoute());
}

/** Write the current frame rate and quality level into the corner readout. */
function drawHud() {
  const fps = Math.round(motion.fps);
  const quality = motion.quality;
  els.hudFps.textContent = String(fps);
  els.hudQuality.textContent = quality;
  els.hudDot.className =
    quality === 'high' ? 'hud__dot' : quality === 'medium' ? 'hud__dot hud__dot--warn' : 'hud__dot hud__dot--crit';
}

/** Start the readout's timer, unless it is already running. */
function resumeHud() {
  if (!hudTimer) hudTimer = window.setInterval(drawHud, HUD_INTERVAL_MS);
}

/** Stop the readout's timer and forget its handle. */
function pauseHud() {
  window.clearInterval(hudTimer);
  hudTimer = 0;
}

/**
 * The small readout in the corner. It is driven by a timer rather than by `motion.add`, because a
 * per-frame callback would keep the shared loop awake for the life of the page just to redraw two
 * numbers — and the numbers only need to change a few times a second to be readable.
 *
 * The timer's handle is kept, and the timer is stopped whenever the tab goes into the background.
 * core/motion.js already parks its frame loop on `document.hidden`; a `setInterval` has no such
 * instinct and would go on waking a tab nobody is looking at, several times a second, to redraw a
 * frame rate that is not being measured. It starts again when the tab comes back.
 */
function startHud() {
  els.hud.hidden = false;
  drawHud();
  resumeHud();

  on(document, 'visibilitychange', () => {
    if (document.hidden) pauseHud();
    else resumeHud();
  });
}

/**
 * Light the navigation link for whichever section is on screen. One IntersectionObserver for all
 * five sections, rather than a scroll handler that measures them on every frame.
 */
function wireSectionHighlight() {
  const sections = [...document.querySelectorAll('.section[id]')];
  if (sections.length === 0 || typeof IntersectionObserver !== 'function') return;

  sectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.id;
        for (const link of els.railLinks) {
          const matches = link.getAttribute('href') === `#${id}`;
          if (matches) link.setAttribute('aria-current', 'true');
          else link.removeAttribute('aria-current');
        }
      }
    },
    // A band across the middle of the viewport: a section counts as "current" when it is where the
    // reader is looking, not when its top edge first appears.
    { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
  );

  for (const section of sections) sectionObserver.observe(section);
}

/* ============================================================================================ *
 * Boot
 * ============================================================================================ */

function boot() {
  // Before anything else, and before the first animated element paints: the stylesheets hold the
  // ambient animation still through `:root[data-motion="reduced"]`, so the attribute has to be on
  // the element from the start rather than arriving after the catalogue has been built.
  document.documentElement.setAttribute('data-motion', motion.reduced ? 'reduced' : 'full');

  cacheElements();

  // The inline script in <head> has already stamped the theme so nothing flashed; this reads it
  // back so the swatches and the effects layers agree with what is on screen.
  const storedTheme = store.get(KEYS.theme, null);
  const stampedTheme = document.documentElement.getAttribute('data-theme');
  applyTheme(THEME_IDS.includes(storedTheme) ? storedTheme : stampedTheme, { persist: false });

  applyDensity(store.get(KEYS.density, 'comfortable'), { persist: false });
  applyMotionPreference(!motion.reduced, { persist: false });

  fillFigures({ animate: true });
  renderProvenance();
  for (const el of document.querySelectorAll('[data-active-months]')) {
    el.textContent = String(ACTIVE_MONTHS);
  }

  index = buildIndex(PROJECTS);
  wireCatalogRefresh();
  wireCatalog();
  wirePalette();
  wireThemeAndToggles();
  wireMotion();
  wireSectionHighlight();

  // The catalogue is rendered before anything asks the network for a graphics library, so the
  // page is complete and usable whatever happens to the effects layers.
  applyView(store.get(KEYS.view, 'grid'), { persist: false });
  applyQuery();
  applyRoute({ initial: true });

  // Mark the page's own sections for the reveal animation here rather than in the HTML: the
  // stylesheet starts a `[data-reveal]` element at opacity 0, so a page whose script never runs
  // must not contain the attribute at all.
  for (const wrap of els.sectionWraps) {
    wrap.setAttribute('data-reveal', '');
  }
  // Each of these returns a function that disconnects its observer. Collecting them here is what
  // lets `dispose()` leave the page exactly as it found it; dropping them would leak three
  // IntersectionObservers and a scroll subscription on every remount.
  unsubscribes.push(reveal(document), parallax(document), counters(document));

  startHud();

  void wireTelemetry();
  void mountEffects();
  // Last, and deliberately not awaited: the page is already complete and interactive from the
  // seed, so asking GitHub for the current list is an upgrade rather than a prerequisite.
  void loadCatalog();
}

/**
 * Take the page apart again: every listener off, every subscription cancelled, every timer and
 * observer stopped, and both effects layers disposed.
 *
 * Nothing on this site calls it. The tab closes and the operating system reclaims everything, so on
 * a static page a teardown is never strictly needed. It is here because every other module in this
 * project has one and SPEC.md §6 asks for a removal for every listener a module adds; because a
 * future host — a router that swaps this page out, a test that mounts it twice — would otherwise
 * leak a frame-rate timer, an IntersectionObserver and thirty-odd listeners per mount; and because
 * writing it is what proves every one of those things has an owner.
 *
 * It cannot fall out of step with the wiring, because it does not name any of it: `on()` records
 * each listener as it is added and `unsubscribes` collects each cancel function as it comes back,
 * so a control added later is torn down without anyone remembering to come back here.
 */
export function dispose() {
  pauseHud();

  if (sectionObserver) {
    sectionObserver.disconnect();
    sectionObserver = null;
  }

  // A queued render is a callback still sitting in the shared frame loop; `pendingFrameJob` is the
  // function that takes it out again.
  if (pendingFrameJob) {
    pendingFrameJob();
    pendingFrameJob = null;
  }

  window.clearTimeout(toastTimer);
  window.clearTimeout(clearResetTimer);

  // `splice(0)` empties each list as it hands the contents over, so calling dispose() twice is
  // harmless rather than a second round of removals.
  for (const off of unsubscribes.splice(0)) {
    try {
      off();
    } catch (error) {
      console.error('[app] an unsubscribe threw', error);
    }
  }

  for (const entry of listeners.splice(0)) {
    entry.target.removeEventListener(entry.type, entry.handler, entry.options);
  }

  if (palette.release) {
    const release = palette.release;
    palette.release = null;
    release();
  }

  // Telemetry owns listeners this module never sees — the `visibilitychange` and `pagehide`
  // handlers that guarantee a last flush, and its own cross-tab consent subscription — so it has
  // to be asked to release them rather than having them removed from out here.
  void telemetry.dispose();

  cosmos?.dispose();
  cosmos = null;
  glyphs?.dispose();
  glyphs = null;
}

/**
 * One try/catch around the whole start-up. If something here throws — a browser missing an API
 * that was assumed, a data file edited into an invalid state — the visitor gets a plain message
 * and the static content of the page instead of a silent blank column.
 */
try {
  boot();
} catch (error) {
  console.error('[app] start-up failed', error);
  const count = document.getElementById('catalog-count');
  if (count) {
    count.textContent =
      'The interactive catalogue could not start in this browser. Every repository is listed at github.com/worxbend.';
  }
}
