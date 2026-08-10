/**
 * The catalogue every other module reads.
 *
 * Three files meet here, and each answers a different question:
 *
 *   catalog.config.js  which projects appear, and in which section   — chosen by hand
 *   overrides.js       how each one is described in plain language   — written by hand
 *   core/github.js     what is currently true about them             — fetched from GitHub
 *
 * The split matters. Anything GitHub can tell us — stars, primary language, topics, the last time
 * somebody pushed — refreshes by itself and can never go stale. Anything requiring judgement is
 * written by a person and is never overwritten. A repository listed in the config that nobody has
 * written a description for still appears; it falls back to its own GitHub description.
 *
 * What is shown: exactly the repositories named in catalog.config.js, and nothing else. A
 * repository that GitHub does not return — renamed, made private, deleted — is skipped and named
 * in the browser console rather than left as an empty card.
 *
 * How loading works
 * -----------------
 * `PROJECTS` is populated synchronously from the committed seed, so the page has a full
 * catalogue to paint on the very first frame with no spinner and no layout shift. `loadCatalog()`
 * then asks GitHub for the current list and, if it differs, updates `PROJECTS` in place and
 * notifies subscribers. The array identity never changes, so a module that imported it once keeps
 * seeing the current contents.
 */

import { SEED } from './seed.js';
import { COPY } from './overrides.js';
import { SECTIONS, FEATURED } from './catalog.config.js';
import { ACCOUNTS, fetchCatalog, clearCache } from '../core/github.js';

export { clearCache };

/**
 * The accounts the catalogue is drawn from, keyed by login so a project can name one.
 *
 * Derived from the single list in core/github.js rather than written out again, so adding an
 * account is a one-line change in one file.
 */
export const OWNERS = Object.fromEntries(
  ACCOUNTS.map((a) => [a.login, { login: a.login, kind: a.kind, label: a.label, url: a.url }]),
);

/**
 * The sections of the catalogue, without their repository lists.
 *
 * The user interface only ever needs the label part of a section — its id, name, glyph and blurb —
 * so that is all this exposes. Membership is resolved once, below, into `SELECTED`.
 */
export const CLUSTERS = SECTIONS.map(({ id, name, glyph, blurb }) => ({ id, name, glyph, blurb }));

/** `owner/repository`, lower-cased, so a config entry and a GitHub answer compare as equal. */
function repoKey(owner, name) {
  return `${owner}/${name}`.toLowerCase();
}

/**
 * Every repository the config selects, mapped to the section that selected it.
 *
 * Built once at module load. A repository listed under two sections keeps the first, because
 * silently showing the same card twice is worse than picking one and saying so in the console.
 */
const SELECTED = new Map();
for (const section of SECTIONS) {
  for (const entry of section.repos) {
    const key = entry.toLowerCase();
    if (SELECTED.has(key)) {
      console.warn(
        `[catalog.config] ${entry} is listed under both "${SELECTED.get(key)}" and ` +
        `"${section.id}" — keeping "${SELECTED.get(key)}".`,
      );
      continue;
    }
    SELECTED.set(key, section.id);
  }
}

/** The featured set, in the same lower-cased form, so a typo in either file cannot half-match. */
const FEATURED_KEYS = new Set(FEATURED.map((entry) => entry.toLowerCase()));

/** How many repositories the config asks for. The page compares this against what it found. */
export const SELECTED_COUNT = SELECTED.size;

/**
 * Language colours, taken from GitHub's own language palette (the `linguist` project), so a
 * language dot on this page matches the dot GitHub draws for the same repository.
 *
 * Every value of `lang` in PROJECTS has an entry here, and so does every entry of every `langs`
 * array — the whole stack, not only the primary language. Both matter: `lang` colours the dot on
 * a card, and `langs` colours the per-language chips. A missing key would hand the chip an
 * `undefined` colour, the browser would discard the custom property without complaining, and the
 * chip would quietly fall back to looking exactly like the primary language.
 *
 * Two of these are not linguist values. GitHub has no published colour for Just (the `justfile`
 * command runner) or for Fluent (Mozilla's translation file format), because linguist only
 * assigns colours to languages it counts towards a repository's language bar. Rather than invent
 * a hue that would read as a real GitHub colour, both use one neutral slate, `#7d8590`. It was
 * picked to clear 3:1 contrast — the threshold for a non-text graphic — against all five theme
 * grounds at once: about 3.5:1 on solar's warm paper (`#FCF8F2`) and between 4.9:1 and 5.6:1 on
 * the four dark grounds.
 *
 * This list only needs to cover the languages that have actually turned up. Because the catalogue
 * is now fetched live, a repository in a language nobody has seen before can appear at any time;
 * `langColor()` below hands those the same neutral rather than an undefined value.
 */
export const LANGS = {
  C: '#555555',
  'C++': '#f34b7d',
  CSS: '#563d7c',
  Crystal: '#000100',
  Flix: '#dc94b0',
  Fluent: '#7d8590', // not a linguist colour — see the note above
  Go: '#00ADD8',
  HTML: '#e34c26',
  Java: '#b07219',
  JavaScript: '#f1e05a',
  Just: '#7d8590', // not a linguist colour — see the note above
  Kotlin: '#A97BFF',
  Lua: '#000080',
  Python: '#3572A5',
  Rust: '#dea584',
  Scala: '#c22d40',
  Shell: '#89e051',
  TypeScript: '#3178c6',
  Vue: '#41b883',
};

/** A neutral for a language nobody has picked a colour for yet. Keyed off nothing, on purpose. */
const LANG_FALLBACK = '#7d8590';

/** The colour for a language dot, always returning something paintable. */
export function langColor(name) {
  return (name && LANGS[name]) || LANG_FALLBACK;
}

/**
 * A URL-safe id for the location hash and the card's DOM id.
 *
 * Built from the name alone where that is unique, because `#/p/scenedeck` reads better than
 * `#/p/worxbend-scenedeck`. Collisions are resolved by the caller, which knows about all of them.
 */
function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Make a repository's homepage field into something a browser can follow, or drop it.
 *
 * GitHub does not validate this field. Several of these repositories set it without a scheme —
 * `obs.worxbend.com` rather than `https://obs.worxbend.com` — and a browser reads a bare value
 * like that as a path relative to the current page, so the link would land somewhere inside this
 * site instead of on the project's own page. Anything that is not plainly http or https is
 * dropped rather than guessed at.
 */
function normaliseHomepage(home) {
  const text = (home || '').trim();
  if (!text) return undefined;
  if (/^https?:\/\//i.test(text)) return text;
  // A scheme we do not recognise (including `javascript:`) is not something to repair.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return undefined;
  // Looks like a bare host, for example `obs.worxbend.com` or `worxbend.github.io/twi/`.
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(text)) return `https://${text}`;
  return undefined;
}

/** First sentence of a GitHub description, trimmed to something that fits a card's subtitle. */
function taglineFromDescription(description) {
  if (!description) return '';
  const firstSentence = description.split(/(?<=[.!?])\s/)[0].trim().replace(/\.$/, '');
  return firstSentence.length <= 60 ? firstSentence : `${firstSentence.slice(0, 57).trimEnd()}…`;
}

/**
 * Turn one fetched repository into a catalogue entry, layering any hand-written copy on top.
 *
 * The fallbacks matter as much as the overrides: a repository with no description at all still
 * has to produce a readable card rather than an empty one, and saying so plainly is better than
 * inventing a summary.
 */
function toProject(repo, id) {
  const key = repoKey(repo.owner, repo.name);
  const override = COPY[`${repo.owner}/${repo.name}`];
  const described = Boolean(override?.desc || repo.description);
  return {
    id,
    name: repo.name,
    owner: repo.owner,
    cluster: SELECTED.get(key),
    lang: repo.lang || 'Other',
    langs: repo.lang ? [repo.lang] : [],
    stars: repo.stars,
    updated: repo.updated,
    url: repo.url,
    home: normaliseHomepage(repo.home),
    tagline: override?.tagline || taglineFromDescription(repo.description) || 'No description yet',
    desc: override?.desc || repo.description ||
      'This repository has no description on GitHub yet. Open it to see what is inside.',
    topics: repo.topics,
    featured: FEATURED_KEYS.has(key),
    /** True when a person wrote this entry, so the UI can tell a summary from a placeholder. */
    curated: Boolean(override?.desc),
    described,
  };
}

/** Sort: stars first, then most recently pushed, then alphabetically. Stable and predictable. */
function order(a, b) {
  return b.stars - a.stars || b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name);
}

/**
 * Which configured repositories were not in the last set of facts, so the page can say so.
 *
 * Kept as module state rather than returned, because `buildProjects` is called from two places and
 * only the caller that loads the live catalogue has anything useful to do with the answer.
 */
let lastMissing = [];

/**
 * The whole pipeline: keep what the config selected, assign ids, layer the copy on, sort.
 *
 * Exported so it can be exercised directly without a network call — hand it a seed-shaped array
 * and it returns exactly what the page would render.
 */
export function buildProjects(repos) {
  const found = new Map();
  for (const repo of repos) {
    const key = repoKey(repo.owner, repo.name);
    // A config entry is the only way in, and the first answer for a key wins: GitHub can return
    // the same repository twice across page boundaries if something is pushed mid-fetch.
    if (SELECTED.has(key) && !found.has(key)) found.set(key, repo);
  }

  lastMissing = [...SELECTED.keys()].filter((key) => !found.has(key));

  // Ids are assigned once the final set is known, so a repository whose name is unique gets the
  // short id — `#/p/scenedeck` reads better than `#/p/worxbend-scenedeck` — and only a genuine
  // collision between two accounts carries an owner prefix.
  const chosen = [...found.values()];
  const counts = new Map();
  for (const repo of chosen) {
    const key = slug(repo.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return chosen
    .map((repo) => {
      const base = slug(repo.name);
      const id = counts.get(base) > 1 ? `${slug(repo.owner)}-${base}` : base;
      return toProject(repo, id);
    })
    .sort(order);
}

/**
 * The live catalogue.
 *
 * A module-level array that is refilled in place rather than replaced, so every module that did
 * `import { PROJECTS }` keeps seeing the current contents without re-importing anything.
 */
export const PROJECTS = buildProjects(SEED);

/** Where the current contents came from, and when. The page shows this in the instrument panel. */
export const catalogMeta = {
  source: 'pending',
  fetchedAt: null,
  error: null,
  accounts: [],
  /** How many repositories catalog.config.js asks for. */
  selected: SELECTED_COUNT,
  /** Configured repositories GitHub did not return, as `owner/repository` strings. */
  missing: [],
};

const listeners = new Set();

/** Be told when the catalogue changes. Returns a function that stops the subscription. */
export function onCatalogChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function replace(projects) {
  PROJECTS.length = 0;
  PROJECTS.push(...projects);
}

/**
 * Ask GitHub for the current list and fold it in.
 *
 * Safe to call more than once — a second call inside the cache window costs no network at all.
 * It never throws: a failure leaves the seed-built catalogue in place and is reported through
 * `catalogMeta.error` so the page can say what happened rather than looking broken.
 */
export async function loadCatalog({ force = false } = {}) {
  const result = await fetchCatalog({ seed: SEED, force });
  const next = buildProjects(result.repos);

  catalogMeta.source = result.source;
  catalogMeta.fetchedAt = result.fetchedAt;
  catalogMeta.error = result.error || null;
  catalogMeta.accounts = result.accounts || [];

  // An empty answer is treated as a failure rather than as "there are no repositories", because
  // wiping a full catalogue is far worse than showing a slightly old one.
  if (next.length > 0) {
    replace(next);
    catalogMeta.missing = lastMissing;
    if (lastMissing.length > 0) {
      console.warn(
        '[catalog.config] listed but not returned by GitHub — check the spelling, or whether the ' +
        `repository was renamed or made private: ${lastMissing.join(', ')}`,
      );
    }
  }

  for (const fn of listeners) {
    try {
      fn(PROJECTS, catalogMeta);
    } catch (error) {
      console.error('[projects] a catalogue subscriber threw', error);
    }
  }
  return { projects: PROJECTS, meta: catalogMeta };
}

/** Projects in one cluster, most starred first. */
export function byCluster(id) {
  return PROJECTS.filter((p) => p.cluster === id).sort(order);
}

/** Headline figures for the hero strip, computed from whatever the catalogue currently holds. */
export function stats() {
  const langs = new Set();
  const clusters = new Set();
  let stars = 0;
  let latestUpdate = '';
  for (const p of PROJECTS) {
    if (p.lang && p.lang !== 'Other') langs.add(p.lang);
    clusters.add(p.cluster);
    stars += p.stars;
    if (p.updated > latestUpdate) latestUpdate = p.updated;
  }
  return {
    repos: PROJECTS.length,
    langs: langs.size,
    clusters: clusters.size,
    stars,
    latestUpdate,
  };
}
