/**
 * The catalogue every other module reads.
 *
 * Nothing in here is a hand-written list of repositories any more. The facts arrive from GitHub's
 * public API, fetched in the visitor's own browser with no credentials (core/github.js), and this
 * module is where those facts meet the editorial decisions in overrides.js: which subject a
 * repository belongs to, how to describe it in plain language, which few to feature.
 *
 * The split matters. Anything GitHub can tell us — stars, primary language, topics, the last time
 * somebody pushed — regenerates by itself and can never go stale. Anything requiring judgement is
 * written by a person and is never overwritten. A repository nobody has written about still
 * appears; it simply falls back to its own GitHub description.
 *
 * What is shown: every public, non-fork, non-archived repository on the three accounts that has
 * been pushed to in the last six months, minus anything in the EXCLUDE list.
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
import { COPY, EXCLUDE, KEEP_BOTH, PREFER_OWNER, CLUSTER_RULES } from './overrides.js';
import { ACCOUNTS, fetchCatalog, isActive, ACTIVE_MONTHS, clearCache } from '../core/github.js';

export { ACTIVE_MONTHS, clearCache };

/**
 * The accounts the catalogue is drawn from, keyed by login so a project can name one.
 *
 * Derived from the single list in core/github.js rather than written out again, so adding an
 * account is a one-line change in one file.
 */
export const OWNERS = Object.fromEntries(
  ACCOUNTS.map((a) => [a.login, { login: a.login, kind: a.kind, label: a.label, url: a.url }]),
);

export const CLUSTERS = [
  {
    id: 'streaming',
    name: 'Streaming & OBS',
    blurb: 'Controllers, dashboards and browser overlays for OBS Studio, plus chat clients and bots for Twitch and YouTube — everything that runs while a live stream is on air.',
    glyph: '◈',
  },
  {
    id: 'air',
    name: 'Air Quality',
    blurb: 'Ways of reading an AirGradient air-quality monitor: a desktop window, a phone app, a terminal, a panel icon, an e-paper screen, a wall of LEDs and a metrics stack, all talking to the sensor on the local network rather than to a cloud account.',
    glyph: '◇',
  },
  {
    id: 'iot',
    name: 'IoT & Edge',
    blurb: 'Firmware for small Wi-Fi microcontroller boards — cameras, relays, LED panels — together with the network services on the other end of the wire that receive their frames and send them commands.',
    glyph: '◆',
  },
  {
    id: 'linux',
    name: 'Linux & Provisioning',
    blurb: 'Tools that take a fresh Linux machine, or a homelab of them, and bring it to a known state from files kept in version control: packages, dotfiles, fonts, binaries and monitoring.',
    glyph: '▣',
  },
  {
    id: 'scala',
    name: 'Scala & JVM',
    blurb: 'Libraries and services for the Java Virtual Machine, mostly written in Scala 3 — API clients, an authentication server, data pipelines and ports of existing libraries to the Flix language.',
    glyph: '⬡',
  },
  {
    id: 'labs',
    name: 'Labs',
    blurb: 'Experiments that exist to answer a question rather than to ship a product: a browser game, an automated writing journal, a webcam filter and other one-off sketches.',
    glyph: '⬢',
  },
];

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

/** Lower-cased haystack used by the cluster rules, built once per repository. */
function haystack(repo) {
  return {
    name: repo.name.toLowerCase(),
    topics: repo.topics.map((t) => t.toLowerCase()),
    lang: repo.lang || '',
  };
}

/**
 * Decide which cluster a repository belongs to.
 *
 * An explicit `cluster` in overrides.js always wins. Otherwise the rules are tried in order and
 * the first match takes it; a repository matching nothing lands in `labs`, which is the honest
 * answer for a sketch nobody has written about.
 */
function clusterFor(repo, override) {
  if (override?.cluster) return override.cluster;
  const hay = haystack(repo);
  for (const rule of CLUSTER_RULES) {
    if (rule.topics?.some((t) => hay.topics.includes(t))) return rule.cluster;
    if (rule.names?.some((n) => hay.name.includes(n))) return rule.cluster;
    if (rule.langs?.includes(hay.lang)) return rule.cluster;
  }
  return 'labs';
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
  const key = `${repo.owner}/${repo.name}`;
  const override = COPY[key];
  const described = Boolean(override?.desc || repo.description);
  return {
    id,
    name: repo.name,
    owner: repo.owner,
    cluster: clusterFor(repo, override),
    lang: repo.lang || 'Other',
    langs: repo.lang ? [repo.lang] : [],
    stars: repo.stars,
    updated: repo.updated,
    url: repo.url,
    home: repo.home || undefined,
    tagline: override?.tagline || taglineFromDescription(repo.description) || 'No description yet',
    desc: override?.desc || repo.description ||
      'This repository has no description on GitHub yet. Open it to see what is inside.',
    topics: repo.topics,
    featured: override?.featured === true,
    /** True when a person wrote this entry, so the UI can tell a summary from a placeholder. */
    curated: Boolean(override?.desc),
    described,
  };
}

/**
 * Drop the copies left behind when a project moved between accounts.
 *
 * The same repository name on two accounts is almost always one project and one leftover, and
 * showing both makes the catalogue look padded. The winner is decided by PREFER_OWNER, and a name
 * listed in KEEP_BOTH opts out of the whole thing.
 */
function dedupe(repos) {
  const byName = new Map();
  for (const repo of repos) {
    const key = repo.name.toLowerCase();
    if (KEEP_BOTH.has(repo.name) || KEEP_BOTH.has(key)) {
      byName.set(`${repo.owner}/${key}`, repo);
      continue;
    }
    const held = byName.get(key);
    if (!held) {
      byName.set(key, repo);
      continue;
    }
    const rank = (r) => {
      const index = PREFER_OWNER.indexOf(r.owner);
      return index === -1 ? PREFER_OWNER.length : index;
    };
    if (rank(repo) < rank(held)) byName.set(key, repo);
  }
  return [...byName.values()];
}

/** Sort: stars first, then most recently pushed, then alphabetically. Stable and predictable. */
function order(a, b) {
  return b.stars - a.stars || b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name);
}

/**
 * The whole pipeline: filter, de-duplicate, assign ids, layer the copy on, sort.
 *
 * Exported so it can be exercised directly without a network call — hand it a seed-shaped array
 * and it returns exactly what the page would render.
 */
export function buildProjects(repos, now = Date.now()) {
  const eligible = dedupe(
    repos.filter(
      (repo) =>
        !repo.isFork &&
        !repo.isArchived &&
        isActive(repo, now) &&
        !EXCLUDE.has(`${repo.owner}/${repo.name}`),
    ),
  );

  // Assign ids only once the final set is known, so a name that is unique after de-duplication
  // gets the short id and only genuine collisions carry an owner prefix.
  const counts = new Map();
  for (const repo of eligible) {
    const key = slug(repo.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return eligible
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
  activeMonths: ACTIVE_MONTHS,
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
  if (next.length > 0) replace(next);

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
