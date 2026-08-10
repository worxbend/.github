/**
 * core/search.js — client-side search over the project catalog.
 *
 * There are no dependencies here, and no network calls: the whole catalog lives in memory, so
 * every keystroke can be answered synchronously in a fraction of a millisecond.
 *
 * The public surface is fixed by SPEC.md section 4:
 *
 *   buildIndex(projects)                      -> opaque index object, built once
 *   search(index, query, { limit, filters })  -> ranked results
 *   highlight(text, ranges)                   -> HTML-escaped string with <mark> around ranges
 *   __selftest()                              -> array of failure strings (never called by the app)
 *
 * ---------------------------------------------------------------------------------------------
 * How it works, for a reader who has never seen a search engine before
 * ---------------------------------------------------------------------------------------------
 *
 * 1. TOKENISING. Every searchable piece of text is chopped into "tokens" (roughly: words).
 *    The chopping happens on punctuation and whitespace, and *also* on the boundaries that
 *    programmers write inside a single word: camelCase ("airGradient" -> "air" + "gradient"),
 *    kebab-case ("obs-websocket") and snake_case ("obs_websocket"), plus letter/digit borders
 *    ("gtk4" -> "gtk" + "4"). The whole word is kept as a token as well as its pieces, and a
 *    hyphen/underscore compound also gets a glued-together form ("obswebsocket"), so a visitor
 *    finds a project whether they type the pieces, the whole word, or the word without its
 *    punctuation.
 *
 * 2. FOLDING. Each token is lowercased, and a second "folded" copy has its accents removed
 *    (ä -> a, ø -> o, ß -> ss). Queries are folded the same way, so typing "airgrädient" finds
 *    a project written "airgradient" and the other way round.
 *
 * 3. INVERTED INDEX. Instead of scanning all 60 projects looking for the query (which gets
 *    slower as the catalog grows), we build the reverse mapping once: token -> the list of
 *    projects that contain it. Each entry in that list ("posting") stores the project's position
 *    in the catalog plus a bitmask of which fields the token appeared in. The bitmask means the
 *    scorer never has to look anything up a second time to know that a hit was in the name
 *    (weight 6) rather than buried in the description (weight 1).
 *
 * 4. PREFIX SEARCH WITHOUT A TRIE. All distinct tokens are held in one sorted array. Because the
 *    array is sorted, every token starting with "sce" sits in one contiguous block, so a binary
 *    search for the lower bound followed by a forward walk while the prefix still matches finds
 *    them all. That is why typing grows results smoothly without rebuilding a tree per keystroke.
 *
 * 5. SCORING. Multi-word queries are ANDed: every word must match something, or the project is
 *    dropped. The score adds up the weighted field hits of each word, with an exact token match
 *    worth more than a prefix match.
 *
 * 6. FUZZY FALLBACK. Only when strict matching found nothing at all do we try subsequence
 *    matching, where the query letters must appear in order but not next to each other
 *    ("sdk" -> "scenedeck"). It is scored by how tightly packed the matched letters are, so a
 *    name where s, d and k sit close together beats one where they are scattered.
 *
 * 7. FILTERS. Words of the shape `lang:rust`, `owner:w0rxbend`, `cluster:iot`, `topic:mqtt`,
 *    `stars:>2` and `stars:>=2` are pulled out of the query before anything else happens and
 *    applied as a pre-filter, so the scoring loop only ever visits projects that qualify.
 *
 * ---------------------------------------------------------------------------------------------
 * Note on match ranges
 * ---------------------------------------------------------------------------------------------
 * Results carry `matches: { field: [[start, end], …] }`. The offsets point into the ORIGINAL,
 * unfolded text of that field, so they can be fed straight to highlight(). For the fields that
 * come from arrays the "original text" is the array joined with single spaces:
 *
 *   topics -> project.topics.join(' ')
 *   lang   -> the primary language followed by any extra entries of project.langs, joined by ' '
 *
 * A caller highlighting those two fields must build the same joined string.
 */

/* ============================================================================================
 * Field table
 * ============================================================================================ */

/** The searchable fields, in bit order. A token's field bitmask uses bit `i` for FIELDS[i]. */
const FIELDS = ['name', 'tagline', 'desc', 'topics', 'lang', 'cluster', 'owner'];

/**
 * How much a hit in each field is worth. The spec fixes name 6, topics 4, tagline 3, desc 1.
 * The three short metadata fields sit in between: a project's language or cluster is a strong
 * signal but there is only ever one of them, so it should not outrank a name match.
 */
const FIELD_WEIGHT = {
  name: 6,
  tagline: 3,
  desc: 1,
  topics: 4,
  lang: 3,
  cluster: 2,
  owner: 2,
};

const FIELD_COUNT = FIELDS.length;

/**
 * Precomputed sum of field weights for every possible bitmask (128 of them for 7 fields).
 * Turning "which fields did this token appear in" into a number is then a single array read
 * inside the hot scoring loop instead of a loop over the seven fields.
 */
const MASK_WEIGHT = new Float64Array(1 << FIELD_COUNT);
for (let mask = 0; mask < MASK_WEIGHT.length; mask++) {
  let sum = 0;
  for (let f = 0; f < FIELD_COUNT; f++) if (mask & (1 << f)) sum += FIELD_WEIGHT[FIELDS[f]];
  MASK_WEIGHT[mask] = sum;
}

/**
 * Fields the fuzzy fallback is allowed to scan. Descriptions are left out on purpose: they are
 * long enough that almost any three letters appear somewhere in them in order, which would make
 * the fallback match everything and rank nothing.
 */
const FUZZY_FIELDS = ['name', 'topics', 'tagline', 'lang', 'cluster', 'owner'];

/* Scoring constants. Exact beats prefix; a prefix that covers most of the token beats a prefix
 * that covers very little of it, so typing more letters sharpens the ranking. */
const EXACT_MULTIPLIER = 2.5;
const PREFIX_MULTIPLIER = 1;
const PREFIX_FLOOR = 0.5;

/* The fuzzy fallback never competes with strict results (it only runs when there are none), but
 * scaling it down keeps the numbers honest if a caller ever compares scores across queries. */
const FUZZY_SCALE = 0.5;

/** Guard rail: a pathological query is truncated rather than allowed to blow up the bitmask. */
const MAX_TERMS = 24;

/* ============================================================================================
 * Character helpers
 * ============================================================================================ */

const CLASS_SEPARATOR = 0;
const CLASS_LOWER = 1;
const CLASS_UPPER = 2;
const CLASS_DIGIT = 3;
const CLASS_LETTER_OTHER = 4; // any non-ASCII character; treated as a word character

/**
 * Classify one UTF-16 code unit. Working from character codes avoids running a regular
 * expression per character, which matters because the tokeniser walks every character of the
 * catalog at build time.
 */
function classOf(code) {
  if (code >= 97 && code <= 122) return CLASS_LOWER;
  if (code >= 65 && code <= 90) return CLASS_UPPER;
  if (code >= 48 && code <= 57) return CLASS_DIGIT;
  if (code >= 128) return CLASS_LETTER_OTHER;
  return CLASS_SEPARATOR;
}

function isWordClass(cls) {
  return cls !== CLASS_SEPARATOR;
}

/** '-' and '_' glue two word segments into a compound such as "obs-websocket". */
function isCompoundJoiner(code) {
  return code === 45 || code === 95;
}

/**
 * A few letters do not decompose into "plain letter + accent" under Unicode normalisation, so
 * they need spelling out by hand. Without this, searching "strasse" would miss "straße".
 */
const FOLD_SPECIAL = {
  ß: 'ss',
  ø: 'o',
  Ø: 'o',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ł: 'l',
  Ł: 'l',
  đ: 'd',
  Đ: 'd',
  ð: 'd',
  Ð: 'd',
  þ: 'th',
  Þ: 'th',
  ı: 'i',
  'İ': 'i',
};

/** Unicode blocks holding combining accent marks, which folding removes. */
function isCombiningMark(code) {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20f0) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

/** Non-ASCII folding is comparatively expensive, so each distinct character is folded once. */
const foldCache = new Map();

/**
 * Fold a single character (or code point) to its lowercase, accent-free form. The result may be
 * empty (a bare accent mark) or longer than one character ("ß" -> "ss").
 */
function foldChar(ch) {
  const cached = foldCache.get(ch);
  if (cached !== undefined) return cached;

  let out;
  const special = FOLD_SPECIAL[ch];
  if (special !== undefined) {
    out = special;
  } else {
    const lower = ch.toLowerCase();
    const decomposed = lower.normalize ? lower.normalize('NFD') : lower;
    let stripped = '';
    for (let i = 0; i < decomposed.length; i++) {
      if (!isCombiningMark(decomposed.charCodeAt(i))) stripped += decomposed[i];
    }
    out = stripped;
  }
  foldCache.set(ch, out);
  return out;
}

/**
 * Lowercase a string and strip its accents. ASCII takes a fast path, because in practice almost
 * every character in the catalog and in a query is plain ASCII.
 */
function fold(text) {
  let needsWork = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 128 || (code >= 65 && code <= 90)) {
      needsWork = true;
      break;
    }
  }
  if (!needsWork) return text;

  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 128) {
      out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
    } else {
      out += foldChar(ch);
    }
  }
  return out;
}

/**
 * Fold a string while remembering where every folded character came from, so a match found in
 * the folded text can be reported as a range in the original text. `starts[i]` and `ends[i]` are
 * the original offsets of the code point that produced folded character `i`.
 */
function foldWithMap(text) {
  const chars = [];
  const starts = [];
  const ends = [];
  let src = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    let folded;
    if (code < 128) {
      folded = code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
    } else {
      folded = foldChar(ch);
    }
    for (let k = 0; k < folded.length; k++) {
      chars.push(folded[k]);
      starts.push(src);
      ends.push(src + ch.length);
    }
    src += ch.length;
  }
  return { text: chars.join(''), starts, ends };
}

/* ============================================================================================
 * Tokeniser
 * ============================================================================================ */

/**
 * Split `text` into tokens and hand each one to `emit(token, start, end)`, where start/end are
 * offsets into `text` itself (not into any folded copy).
 *
 * Emitted for "airGradient-bridge":
 *   air, gradient, airgradient (the whole segment), bridge, airgradientbridge (the compound)
 */
function tokenizeInto(text, emit) {
  const n = text.length;
  let i = 0;
  // A compound is a run of segments joined by single '-' or '_' characters.
  let compoundStart = -1;
  let compoundEnd = -1;
  let compoundParts = 0;

  const flushCompound = () => {
    if (compoundParts > 1 && compoundEnd - compoundStart <= 64) {
      // Rebuild the run with its joiners removed: "obs-websocket" -> "obswebsocket".
      let glued = '';
      for (let k = compoundStart; k < compoundEnd; k++) {
        if (!isCompoundJoiner(text.charCodeAt(k))) glued += text[k];
      }
      if (glued.length > 1) emit(glued, compoundStart, compoundEnd);
    }
    compoundStart = -1;
    compoundEnd = -1;
    compoundParts = 0;
  };

  while (i < n) {
    if (!isWordClass(classOf(text.charCodeAt(i)))) {
      i++;
      continue;
    }

    const segStart = i;
    while (i < n && isWordClass(classOf(text.charCodeAt(i)))) i++;
    const segEnd = i;

    emitSegment(text, segStart, segEnd, emit);

    if (compoundStart < 0) compoundStart = segStart;
    compoundEnd = segEnd;
    compoundParts++;

    // Keep collecting only if the very next characters are "<joiner><word char>".
    const continues =
      segEnd + 1 < n &&
      isCompoundJoiner(text.charCodeAt(segEnd)) &&
      isWordClass(classOf(text.charCodeAt(segEnd + 1)));
    if (!continues) flushCompound();
  }

  flushCompound();
}

/**
 * Emit one run of word characters: its camelCase / digit-boundary pieces, plus the whole run
 * when it actually split into more than one piece.
 */
function emitSegment(text, start, end, emit) {
  let pieceStart = start;
  let pieces = 0;

  for (let k = start + 1; k < end; k++) {
    const prev = classOf(text.charCodeAt(k - 1));
    const cur = classOf(text.charCodeAt(k));
    const next = k + 1 < end ? classOf(text.charCodeAt(k + 1)) : CLASS_SEPARATOR;

    let boundary = false;
    if (cur === CLASS_UPPER && prev !== CLASS_UPPER) {
      // lower/digit followed by upper: "airGradient", "gtk4Widget"
      boundary = true;
    } else if (cur === CLASS_UPPER && prev === CLASS_UPPER && next === CLASS_LOWER) {
      // the tail of an acronym running into a word: "HTTPServer" -> "HTTP" + "Server"
      boundary = true;
    } else if (cur === CLASS_DIGIT && prev !== CLASS_DIGIT) {
      boundary = true;
    } else if (prev === CLASS_DIGIT && cur !== CLASS_DIGIT) {
      boundary = true;
    }

    if (boundary) {
      emit(text.slice(pieceStart, k), pieceStart, k);
      pieces++;
      pieceStart = k;
    }
  }

  emit(text.slice(pieceStart, end), pieceStart, end);
  pieces++;

  if (pieces > 1) emit(text.slice(start, end), start, end);
}

/**
 * Split a query into terms. This deliberately does NOT split on camelCase: a visitor who types
 * "sceneDeck" means the one word "scenedeck", and splitting it into "scene" AND "deck" would
 * demand that both pieces exist as separate tokens in the project.
 */
function queryTerms(text) {
  const terms = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isWordClass(classOf(text.charCodeAt(i)))) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isWordClass(classOf(text.charCodeAt(i)))) i++;
    const term = fold(text.slice(start, i));
    if (term && terms.indexOf(term) === -1) terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/* ============================================================================================
 * Filters
 * ============================================================================================ */

/**
 * Accepted inline filter keys, including a couple of natural aliases.
 *
 * Built with a null prototype on purpose. A plain object literal inherits from
 * `Object.prototype`, so an unguarded `FILTER_ALIASES[word]` also answers to `constructor`,
 * `toString`, `valueOf`, `hasOwnProperty` and `__proto__` — every one of which is truthy and none
 * of which is a filter name. Somebody typing `constructor:x` into the search box would get a
 * truthy key, then `filters[key]` would be `undefined`, and `.push` on it would throw straight
 * out of `search()` and take the catalogue down. With no prototype there is nothing to inherit,
 * and the string check at each lookup is the second line of defence.
 */
const FILTER_ALIASES = Object.assign(Object.create(null), {
  lang: 'lang',
  language: 'lang',
  owner: 'owner',
  org: 'owner',
  user: 'owner',
  cluster: 'cluster',
  group: 'cluster',
  topic: 'topic',
  tag: 'topic',
  stars: 'stars',
  star: 'stars',
});

function emptyFilters() {
  return { lang: [], owner: [], cluster: [], topic: [], stars: [] };
}

/**
 * Turn a stars filter value into a comparison. Accepts ">2", ">=2", "<5", "<=5", "=3" and a bare
 * "3" (read as "at least 3", which is what people mean when they type `stars:3`).
 */
function parseStarsPredicate(raw) {
  let op = '>=';
  let rest = raw;
  if (rest.startsWith('>=') || rest.startsWith('<=')) {
    op = rest.slice(0, 2);
    rest = rest.slice(2);
  } else if (rest.startsWith('>') || rest.startsWith('<') || rest.startsWith('=')) {
    op = rest[0] === '=' ? '=' : rest[0];
    rest = rest.slice(1);
  }
  const value = Number.parseInt(rest, 10);
  if (!Number.isFinite(value)) return null;
  return { op, value };
}

function starsPasses(stars, predicate) {
  switch (predicate.op) {
    case '>':
      return stars > predicate.value;
    case '>=':
      return stars >= predicate.value;
    case '<':
      return stars < predicate.value;
    case '<=':
      return stars <= predicate.value;
    default:
      return stars === predicate.value;
  }
}

/**
 * Pull inline `key:value` filters out of the raw query and return them separately from the free
 * text. Values may be quoted (`owner:"two words"`). Anything that is not a recognised key is
 * left in the free text, so a description containing a colon still searches normally.
 */
function parseQuery(raw) {
  const filters = emptyFilters();
  const textParts = [];
  const n = raw.length;
  let i = 0;

  while (i < n) {
    const ch = raw[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    const wordStart = i;
    let colon = -1;
    while (i < n && raw[i] !== ' ' && raw[i] !== '\t' && raw[i] !== '\n' && raw[i] !== '\r') {
      if (colon === -1 && raw[i] === ':') colon = i;
      // A quoted value may contain spaces, so consume the quoted run as part of this word.
      if ((raw[i] === '"' || raw[i] === "'") && colon !== -1) {
        const quote = raw[i];
        i++;
        while (i < n && raw[i] !== quote) i++;
        if (i < n) i++;
        continue;
      }
      i++;
    }
    const word = raw.slice(wordStart, i);

    if (colon > wordStart) {
      const alias = FILTER_ALIASES[fold(raw.slice(wordStart, colon))];
      // Belt and braces alongside the null prototype. Anything that is not one of the filter
      // names above is not a filter, and the word falls through to be searched as ordinary text —
      // so `constructor:x` looks for the words "constructor" and "x" rather than throwing.
      const key = typeof alias === 'string' ? alias : '';
      let value = raw.slice(colon + 1, i);
      if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' || first === "'") && last === first) value = value.slice(1, -1);
      }
      if (key && value) {
        if (key === 'stars') {
          const predicate = parseStarsPredicate(value.trim());
          if (predicate) filters.stars.push(predicate);
        } else {
          filters[key].push(fold(value.trim()));
        }
        continue;
      }
    }

    textParts.push(word);
  }

  return { text: textParts.join(' '), filters };
}

/** Coerce whatever a caller passed in `options.filters` into the same shape as inline filters. */
function normalizeStructuredFilters(input) {
  const filters = emptyFilters();
  if (!input || typeof input !== 'object') return filters;

  for (const rawKey of Object.keys(input)) {
    const key = FILTER_ALIASES[fold(rawKey)];
    if (typeof key !== 'string') continue;
    const value = input[rawKey];
    if (value === null || value === undefined || value === '') continue;

    if (key === 'stars') {
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (typeof entry === 'number' && Number.isFinite(entry)) {
          filters.stars.push({ op: '>=', value: entry });
        } else if (typeof entry === 'string') {
          const predicate = parseStarsPredicate(entry.trim());
          if (predicate) filters.stars.push(predicate);
        } else if (entry && typeof entry === 'object') {
          if (Number.isFinite(entry.min)) filters.stars.push({ op: '>=', value: entry.min });
          if (Number.isFinite(entry.max)) filters.stars.push({ op: '<=', value: entry.max });
        }
      }
      continue;
    }

    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (entry === null || entry === undefined) continue;
      const folded = fold(String(entry).trim());
      if (folded) filters[key].push(folded);
    }
  }
  return filters;
}

function mergeFilters(a, b) {
  return {
    lang: a.lang.concat(b.lang),
    owner: a.owner.concat(b.owner),
    cluster: a.cluster.concat(b.cluster),
    topic: a.topic.concat(b.topic),
    stars: a.stars.concat(b.stars),
  };
}

function hasAnyFilter(filters) {
  return (
    filters.lang.length > 0 ||
    filters.owner.length > 0 ||
    filters.cluster.length > 0 ||
    filters.topic.length > 0 ||
    filters.stars.length > 0
  );
}

/**
 * Build the allow-list of project positions. Within one key the values are ORed
 * (`lang:rust lang:go` means either language); across keys they are ANDed; every stars
 * comparison must hold, so `stars:>1 stars:<10` reads as a range.
 */
function applyFilters(index, filters) {
  if (!hasAnyFilter(filters)) return index.allowAll;

  const allowed = new Uint8Array(index.size);
  for (let doc = 0; doc < index.size; doc++) {
    if (!setPasses(index.langSets[doc], filters.lang)) continue;
    if (!setPasses(index.topicSets[doc], filters.topic)) continue;
    if (filters.owner.length && filters.owner.indexOf(index.owners[doc]) === -1) continue;
    if (filters.cluster.length && filters.cluster.indexOf(index.clusters[doc]) === -1) continue;

    let starsOk = true;
    for (let k = 0; k < filters.stars.length; k++) {
      if (!starsPasses(index.stars[doc], filters.stars[k])) {
        starsOk = false;
        break;
      }
    }
    if (!starsOk) continue;

    allowed[doc] = 1;
  }
  return allowed;
}

function setPasses(set, wanted) {
  if (wanted.length === 0) return true;
  for (let i = 0; i < wanted.length; i++) if (set.has(wanted[i])) return true;
  return false;
}

/* ============================================================================================
 * Index construction
 * ============================================================================================ */

function textOf(project, field) {
  switch (field) {
    case 'name':
      return String(project.name || project.id || '');
    case 'tagline':
      return String(project.tagline || '');
    case 'desc':
      return String(project.desc || '');
    case 'topics':
      return Array.isArray(project.topics) ? project.topics.join(' ') : '';
    case 'lang': {
      const list = [];
      if (project.lang) list.push(String(project.lang));
      if (Array.isArray(project.langs)) {
        for (const entry of project.langs) {
          const value = String(entry);
          if (list.indexOf(value) === -1) list.push(value);
        }
      }
      return list.join(' ');
    }
    case 'cluster':
      return String(project.cluster || '');
    case 'owner':
      return String(project.owner || '');
    default:
      return '';
  }
}

/**
 * Build the search index. Do this once, when the catalog loads — never per keystroke. The
 * returned object is opaque: its shape is an implementation detail and may change.
 */
export function buildIndex(projects) {
  const list = Array.isArray(projects) ? projects.slice() : [];
  const size = list.length;

  // Working maps, discarded once the flat typed arrays below are built.
  const postingsByToken = new Map(); // token -> Map(docIndex -> field bitmask)
  const occurrencesByToken = new Map(); // token -> flat [doc, fieldIndex, start, end, …]

  const rawTexts = new Array(size);
  const foldedTexts = new Array(size);
  const langSets = new Array(size);
  const topicSets = new Array(size);
  const owners = new Array(size);
  const clusters = new Array(size);
  const stars = new Int32Array(size);
  const updated = new Array(size);
  const nameKeys = new Array(size);

  for (let doc = 0; doc < size; doc++) {
    const project = list[doc] || {};
    const raw = Object.create(null);
    const folded = Object.create(null);

    for (let f = 0; f < FIELD_COUNT; f++) {
      const field = FIELDS[f];
      const text = textOf(project, field);
      raw[field] = text;
      if (FUZZY_FIELDS.indexOf(field) !== -1) folded[field] = foldWithMap(text);
      if (!text) continue;

      const bit = 1 << f;
      tokenizeInto(text, (token, start, end) => {
        // Two forms go into the same token space: the plain lowercase one (so an accented
        // spelling can still be matched letter for letter) and the accent-free one.
        const lowered = token.toLowerCase();
        addToken(postingsByToken, occurrencesByToken, lowered, doc, f, bit, start, end);
        const foldedToken = fold(lowered);
        if (foldedToken && foldedToken !== lowered) {
          addToken(postingsByToken, occurrencesByToken, foldedToken, doc, f, bit, start, end);
        }
      });
    }

    rawTexts[doc] = raw;
    foldedTexts[doc] = folded;

    const langSet = new Set();
    if (project.lang) langSet.add(fold(String(project.lang)));
    if (Array.isArray(project.langs)) for (const l of project.langs) langSet.add(fold(String(l)));
    langSets[doc] = langSet;

    const topicSet = new Set();
    if (Array.isArray(project.topics)) for (const t of project.topics) topicSet.add(fold(String(t)));
    topicSets[doc] = topicSet;

    owners[doc] = fold(String(project.owner || ''));
    clusters[doc] = fold(String(project.cluster || ''));
    stars[doc] = Number.isFinite(project.stars) ? project.stars : 0;
    updated[doc] = String(project.updated || '');
    nameKeys[doc] = fold(String(project.name || project.id || ''));
  }

  // Freeze the working maps into a sorted token array plus flat typed arrays. Sorted order is
  // what makes prefix lookup a binary search instead of a scan.
  const tokens = Array.from(postingsByToken.keys()).sort();
  const postings = new Array(tokens.length);
  const occurrences = new Array(tokens.length);
  for (let t = 0; t < tokens.length; t++) {
    const docMap = postingsByToken.get(tokens[t]);
    const flat = new Int32Array(docMap.size * 2);
    let at = 0;
    for (const [doc, mask] of docMap) {
      flat[at++] = doc;
      flat[at++] = mask;
    }
    postings[t] = flat;
    occurrences[t] = Int32Array.from(occurrencesByToken.get(tokens[t]));
  }

  const allowAll = new Uint8Array(size).fill(1);

  return {
    version: 1,
    projects: list,
    size,
    tokens,
    postings,
    occurrences,
    rawTexts,
    foldedTexts,
    langSets,
    topicSets,
    owners,
    clusters,
    stars,
    updated,
    nameKeys,
    allowAll,
    // Scratch buffers, reused by every search so a keystroke allocates almost nothing.
    scratchScores: new Float64Array(size),
    scratchMasks: new Int32Array(size),
  };
}

function addToken(postingsByToken, occurrencesByToken, token, doc, fieldIndex, bit, start, end) {
  if (!token) return;
  let docMap = postingsByToken.get(token);
  if (docMap === undefined) {
    docMap = new Map();
    postingsByToken.set(token, docMap);
    occurrencesByToken.set(token, []);
  }
  docMap.set(doc, (docMap.get(doc) || 0) | bit);
  const occ = occurrencesByToken.get(token);
  occ.push(doc, fieldIndex, start, end);
}

/* ============================================================================================
 * Prefix lookup
 * ============================================================================================ */

/** First position in the sorted token array whose token is not less than `target`. */
function lowerBound(tokens, target) {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ============================================================================================
 * Fuzzy subsequence matching
 * ============================================================================================ */

/**
 * Find the shortest window of `hay` that contains all of `pat` as a subsequence (letters in
 * order, gaps allowed). Returns [start, endExclusive] or null.
 *
 * The walk is the standard two-pass trick: run forward until every pattern character has been
 * consumed, then run backwards from that point to pull the start as far right as possible. The
 * shortest window is what "tightly packed" means for scoring.
 */
function minWindowSubsequence(hay, pat) {
  const n = hay.length;
  const m = pat.length;
  if (m === 0 || n < m) return null;

  let best = null;
  let bestLength = Infinity;
  let i = 0;

  while (i < n) {
    let j = 0;
    while (i < n && j < m) {
      if (hay.charCodeAt(i) === pat.charCodeAt(j)) j++;
      i++;
    }
    if (j < m) break;

    const end = i - 1;
    let k = end;
    let back = m - 1;
    while (k >= 0) {
      if (hay.charCodeAt(k) === pat.charCodeAt(back)) {
        back--;
        if (back < 0) break;
      }
      k--;
    }

    const length = end - k + 1;
    if (length < bestLength) {
      bestLength = length;
      best = [k, end + 1];
    }
    i = k + 1;
  }

  return best;
}

/** Positions of the matched characters inside a known window, for highlighting. */
function subsequencePositions(hay, pat, start, end) {
  const positions = [];
  let j = 0;
  for (let i = start; i < end && j < pat.length; i++) {
    if (hay.charCodeAt(i) === pat.charCodeAt(j)) {
      positions.push(i);
      j++;
    }
  }
  return positions;
}

/* ============================================================================================
 * Ranges
 * ============================================================================================ */

/** Sort ranges by start and glue together anything that overlaps or touches. */
function mergeRanges(ranges) {
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    const next = ranges[i];
    if (next[0] <= last[1]) {
      if (next[1] > last[1]) last[1] = next[1];
    } else {
      merged.push(next);
    }
  }
  return merged;
}

/** Discard anything a caller could pass that is not a usable range, then merge what is left. */
function normalizeRanges(ranges, length) {
  if (!Array.isArray(ranges) || ranges.length === 0) return [];
  const clean = [];
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length < 2) continue;
    let start = Math.floor(Number(range[0]));
    let end = Math.floor(Number(range[1]));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0) start = 0;
    if (end > length) end = length;
    if (end <= start) continue;
    clean.push([start, end]);
  }
  return mergeRanges(clean);
}

/* ============================================================================================
 * search()
 * ============================================================================================ */

/**
 * Run a query against an index built by buildIndex().
 *
 * @param {object} index    the object returned by buildIndex()
 * @param {string} query    free text, optionally containing `key:value` filters
 * @param {object} [options]
 * @param {number} [options.limit=50]    maximum number of results
 * @param {object} [options.filters={}]  structured filters, ANDed with any inline ones
 * @returns {Array<{project: object, score: number, matches: Object<string, Array<number[]>>}>}
 *
 * Results are ordered by score (descending), then stars (descending), then `updated`
 * (most recent first), then name (A to Z). That order is fully determined by the data, so the
 * same query always produces the same list.
 *
 * An empty query with no filters returns an empty list: showing everything is the catalog view's
 * job, not the search box's. A query that is only filters (`lang:rust`) returns the whole
 * filtered set in tie-break order.
 */
export function search(index, query, options = {}) {
  if (!index || !index.size) return [];

  const limit = Number.isFinite(options.limit) ? Math.floor(options.limit) : 50;
  if (limit <= 0) return [];

  const rawQuery = typeof query === 'string' ? query : '';
  const parsed = parseQuery(rawQuery);
  const filters = mergeFilters(parsed.filters, normalizeStructuredFilters(options.filters));
  const filtered = hasAnyFilter(filters);
  const allowed = applyFilters(index, filters);

  const terms = queryTerms(parsed.text);

  if (terms.length === 0) {
    if (!filtered) return [];
    return finish(index, collectAllowed(index, allowed), limit, null, null);
  }

  const strict = runStrict(index, terms, allowed);
  if (strict.length > 0) return finish(index, strict, limit, strict.tokenIds, null);

  const fuzzy = runFuzzy(index, terms, allowed);
  if (fuzzy.length > 0) return finish(index, fuzzy, limit, null, fuzzy.pattern);

  return [];
}

function collectAllowed(index, allowed) {
  const hits = [];
  for (let doc = 0; doc < index.size; doc++) {
    if (allowed[doc]) hits.push({ doc, score: 0 });
  }
  return hits;
}

/**
 * Strict matching: every term must match at least one token (exact or as a prefix) in a project
 * that survived the filters. The per-document term bitmask is what enforces that AND.
 */
function runStrict(index, terms, allowed) {
  const scores = index.scratchScores;
  const masks = index.scratchMasks;
  scores.fill(0);
  masks.fill(0);

  const tokens = index.tokens;
  const postings = index.postings;
  const tokenIds = [];
  const allTermsMask = terms.length === 32 ? -1 : (1 << terms.length) - 1;

  for (let t = 0; t < terms.length; t++) {
    const term = terms[t];
    const bit = 1 << t;
    const termLength = term.length;

    for (let k = lowerBound(tokens, term); k < tokens.length; k++) {
      const token = tokens[k];
      if (token.length < termLength || !token.startsWith(term)) break;

      const exact = token.length === termLength;
      const multiplier = exact
        ? EXACT_MULTIPLIER
        : PREFIX_MULTIPLIER * (PREFIX_FLOOR + (1 - PREFIX_FLOOR) * (termLength / token.length));

      const list = postings[k];
      let used = false;
      for (let p = 0; p < list.length; p += 2) {
        const doc = list[p];
        if (!allowed[doc]) continue;
        scores[doc] += MASK_WEIGHT[list[p + 1]] * multiplier;
        masks[doc] |= bit;
        used = true;
      }
      // `cover` is how many characters of the token the visitor actually typed. A whole word
      // that was matched exactly is highlighted end to end; a prefix highlights only the part
      // that was typed, so typing "air" marks three characters of "airGradient-bridge" rather
      // than the whole name.
      if (used) tokenIds.push({ id: k, cover: exact ? Infinity : termLength });
    }
  }

  const hits = [];
  for (let doc = 0; doc < index.size; doc++) {
    if (masks[doc] === allTermsMask && scores[doc] > 0) hits.push({ doc, score: scores[doc] });
  }
  hits.tokenIds = tokenIds;
  return hits;
}

/**
 * Fuzzy fallback, used only when strict matching returned nothing. The query words are glued
 * into one letter sequence and looked for as a subsequence of each short field. The tighter the
 * window holding those letters, the higher the score, so "sdk" prefers "scenedeck" over a name
 * where s, d and k are far apart.
 */
function runFuzzy(index, terms, allowed) {
  const pattern = terms.join('');
  const hits = [];
  hits.pattern = pattern;
  if (pattern.length < 2) return hits;

  for (let doc = 0; doc < index.size; doc++) {
    if (!allowed[doc]) continue;
    const folded = index.foldedTexts[doc];
    let score = 0;

    for (const field of FUZZY_FIELDS) {
      const entry = folded[field];
      if (!entry || !entry.text) continue;
      const window = minWindowSubsequence(entry.text, pattern);
      if (!window) continue;
      const tightness = pattern.length / (window[1] - window[0]);
      score += FIELD_WEIGHT[field] * tightness * FUZZY_SCALE;
    }

    if (score > 0) hits.push({ doc, score });
  }
  return hits;
}

/**
 * Sort the hits, cut them to `limit`, then attach the match ranges. Ranges are computed only for
 * the results that are actually returned, so a broad query does not pay for highlighting rows
 * nobody will see.
 */
function finish(index, hits, limit, tokenIds, fuzzyPattern) {
  hits.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    const starDiff = index.stars[b.doc] - index.stars[a.doc];
    if (starDiff !== 0) return starDiff;
    const ua = index.updated[a.doc];
    const ub = index.updated[b.doc];
    if (ua !== ub) return ua < ub ? 1 : -1;
    const na = index.nameKeys[a.doc];
    const nb = index.nameKeys[b.doc];
    if (na !== nb) return na < nb ? -1 : 1;
    return a.doc - b.doc;
  });

  const top = hits.length > limit ? hits.slice(0, limit) : hits;
  const wanted = new Map();
  for (let i = 0; i < top.length; i++) wanted.set(top[i].doc, i);

  const matches = new Array(top.length);
  for (let i = 0; i < top.length; i++) matches[i] = Object.create(null);

  if (tokenIds && tokenIds.length) {
    const occurrences = index.occurrences;
    for (let t = 0; t < tokenIds.length; t++) {
      const occ = occurrences[tokenIds[t].id];
      const cover = tokenIds[t].cover;
      for (let p = 0; p < occ.length; p += 4) {
        const slot = wanted.get(occ[p]);
        if (slot === undefined) continue;
        const field = FIELDS[occ[p + 1]];
        const start = occ[p + 2];
        const end = Math.min(occ[p + 3], start + cover);
        const bucket = matches[slot];
        (bucket[field] || (bucket[field] = [])).push([start, end]);
      }
    }
  } else if (fuzzyPattern) {
    for (let i = 0; i < top.length; i++) {
      const folded = index.foldedTexts[top[i].doc];
      for (const field of FUZZY_FIELDS) {
        const entry = folded[field];
        if (!entry || !entry.text) continue;
        const window = minWindowSubsequence(entry.text, fuzzyPattern);
        if (!window) continue;
        const positions = subsequencePositions(entry.text, fuzzyPattern, window[0], window[1]);
        if (!positions.length) continue;
        const bucket = matches[i];
        const list = bucket[field] || (bucket[field] = []);
        for (const at of positions) list.push([entry.starts[at], entry.ends[at]]);
      }
    }
  }

  const results = new Array(top.length);
  for (let i = 0; i < top.length; i++) {
    const bucket = matches[i];
    for (const field of Object.keys(bucket)) bucket[field] = mergeRanges(bucket[field]);
    results[i] = {
      project: index.projects[top[i].doc],
      score: Math.round(top[i].score * 1e6) / 1e6,
      matches: bucket,
    };
  }
  return results;
}

/* ============================================================================================
 * highlight()
 * ============================================================================================ */

/*
 * SECURITY BOUNDARY.
 *
 * This is the only place in the whole application where text that came from data or from what a
 * visitor typed is turned into HTML. Everything else builds DOM nodes and sets textContent.
 * Because of that, the escaping below is not a nicety — it is the thing standing between a
 * project description (or a query) containing `<img src=x onerror=…>` and that markup running.
 *
 * The rule that keeps it safe: every character of the source text is passed through
 * escapeHtml(), and the only characters ever added to the output are the literal `<mark>` and
 * `</mark>` tags this function writes itself. Ranges only choose *where* those two fixed strings
 * go; they can never introduce a character that was not escaped. If you change this function,
 * keep that invariant, and never interpolate a range value, a class name or an attribute from
 * caller-supplied data.
 */

const ESCAPE_PATTERN = /[&<>"'`]/g;
const ESCAPE_REPLACEMENTS = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

function escapeReplacer(ch) {
  return ESCAPE_REPLACEMENTS[ch];
}

function escapeHtml(text) {
  return text.replace(ESCAPE_PATTERN, escapeReplacer);
}

/**
 * Escape `text` for HTML and wrap the given ranges in `<mark>`.
 *
 * @param {string} text                     the ORIGINAL field text the ranges were measured in
 * @param {Array<number[]>} [ranges]        [start, endExclusive] pairs, as returned in `matches`
 * @returns {string} HTML safe to assign to innerHTML
 *
 * Out-of-order, overlapping, negative and out-of-bounds ranges are all tolerated: they are
 * clamped and merged first. Passing no ranges returns the escaped text unchanged.
 */
export function highlight(text, ranges) {
  const source = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  const safe = normalizeRanges(ranges, source.length);
  if (safe.length === 0) return escapeHtml(source);

  let out = '';
  let cursor = 0;
  for (let i = 0; i < safe.length; i++) {
    const [start, end] = safe[i];
    if (start > cursor) out += escapeHtml(source.slice(cursor, start));
    out += '<mark>' + escapeHtml(source.slice(start, end)) + '</mark>';
    cursor = end;
  }
  if (cursor < source.length) out += escapeHtml(source.slice(cursor));
  return out;
}

/* ============================================================================================
 * Self-check
 * ============================================================================================ */

/**
 * A tiny built-in test suite. Nothing in the application calls this; it exists so a contributor
 * can paste the following into the browser console and see whether search still behaves:
 *
 *   const m = await import('./assets/js/core/search.js'); console.log(m.__selftest());
 *
 * @returns {string[]} one entry per failed assertion; an empty array means everything passed.
 */
export function __selftest() {
  const failures = [];
  const check = (label, condition) => {
    if (!condition) failures.push(label);
  };

  const fixtures = [
    {
      id: 'scenedeck',
      name: 'scenedeck',
      owner: 'worxbend',
      cluster: 'streaming',
      lang: 'Rust',
      langs: ['Rust'],
      stars: 2,
      updated: '2026-08-09',
      tagline: 'Desktop OBS control for Linux.',
      desc: 'Controls OBS Studio scenes from a desktop window.',
      topics: ['obs', 'obs-websocket', 'gtk4'],
    },
    {
      id: 'airgradient-bridge',
      name: 'airGradient-bridge',
      owner: 'worxbend',
      cluster: 'air',
      lang: 'Go',
      langs: ['Go'],
      stars: 5,
      updated: '2026-07-01',
      tagline: 'Air quality sensor bridge.',
      desc: 'Reads sensors and publishes their readings.',
      topics: ['air-quality', 'mqtt'],
    },
    {
      id: 'decoy',
      name: 's o m e d e c o y k',
      owner: 'w0rxbend',
      cluster: 'labs',
      lang: 'Scala',
      langs: ['Scala'],
      stars: 0,
      updated: '2026-01-01',
      tagline: 'Spread out letters.',
      desc: 'A fixture whose letters are scattered.',
      topics: [],
    },
    {
      id: 'alpha',
      name: 'alpha',
      owner: 'w0rxbend',
      cluster: 'labs',
      lang: 'Go',
      langs: ['Go'],
      stars: 1,
      updated: '2026-02-02',
      tagline: 'First tie-break fixture.',
      desc: 'One of two fixtures used to check ordering.',
      topics: [],
    },
    {
      id: 'beta',
      name: 'beta',
      owner: 'w0rxbend',
      cluster: 'labs',
      lang: 'Go',
      langs: ['Go'],
      stars: 3,
      updated: '2026-02-02',
      tagline: 'Second tie-break fixture.',
      desc: 'One of two fixtures used to check ordering.',
      topics: [],
    },
    {
      id: 'markup',
      name: 'markup-probe',
      owner: 'worxbend',
      cluster: 'labs',
      lang: 'Rust',
      langs: ['Rust'],
      stars: 0,
      updated: '2026-03-03',
      tagline: 'Contains <img src=x> in its text.',
      desc: 'A fixture holding <script>alert(1)</script> to prove escaping works.',
      topics: [],
    },
  ];

  const index = buildIndex(fixtures);
  const ids = (results) => results.map((r) => r.project.id);

  // 1. Exact name match wins.
  check('exact name match should rank scenedeck first', ids(search(index, 'scenedeck'))[0] === 'scenedeck');

  // 2. Prefix match finds the project, and scores lower than the exact match.
  const prefixHit = search(index, 'scene');
  check('prefix "scene" should find scenedeck', ids(prefixHit)[0] === 'scenedeck');
  check(
    'exact match should score above prefix match',
    search(index, 'scenedeck')[0].score > prefixHit[0].score,
  );

  // 3. camelCase splitting: the "gradient" half of "airGradient-bridge" is its own token.
  check('camelCase split should expose "gradient"', ids(search(index, 'gradient')).indexOf('airgradient-bridge') !== -1);

  // 4. Kebab compounds are searchable without their hyphen.
  check('compound "obswebsocket" should match', ids(search(index, 'obswebsocket')).indexOf('scenedeck') !== -1);

  // 5. Diacritics fold away in both directions.
  check('"airgrädient" should find airgradient-bridge', ids(search(index, 'airgrädient')).indexOf('airgradient-bridge') !== -1);

  // 6. Multi-word queries are ANDed.
  check('"obs mqtt" should match nothing', search(index, 'obs mqtt').length === 0);
  check('"obs desktop" should match scenedeck', ids(search(index, 'obs desktop')).indexOf('scenedeck') !== -1);

  // 7. Fuzzy fallback, and its tightness ordering.
  const fuzzy = search(index, 'sdk');
  check('"sdk" should fall back to fuzzy and find scenedeck', ids(fuzzy)[0] === 'scenedeck');
  check('tightly packed letters should outrank scattered ones', ids(fuzzy).indexOf('decoy') > 0 || ids(fuzzy).indexOf('decoy') === -1);

  // 8. Fuzzy does not run while strict matching still produces results.
  check('strict results should suppress the fuzzy fallback', ids(search(index, 'obs')).indexOf('decoy') === -1);

  // 9. Inline filter parsing.
  const rustOnly = search(index, 'lang:rust');
  check('lang:rust should return only Rust projects', rustOnly.length === 2 && rustOnly.every((r) => r.project.lang === 'Rust'));
  check('owner:w0rxbend should return three projects', search(index, 'owner:w0rxbend').length === 3);
  check('cluster:labs should return four projects', search(index, 'cluster:labs').length === 4);
  check('topic:mqtt should return one project', ids(search(index, 'topic:mqtt')).join() === 'airgradient-bridge');
  check('stars:>2 should return two projects', search(index, 'stars:>2').length === 2);
  check('stars:>=2 should return three projects', search(index, 'stars:>=2').length === 3);

  // 10. A filter with free text still filters.
  check('"lang:go bridge" should match one project', ids(search(index, 'lang:go bridge')).join() === 'airgradient-bridge');
  check('"lang:rust bridge" should match nothing', search(index, 'lang:rust bridge').length === 0);

  // 11. Structured filters are ANDed with inline ones.
  check(
    'structured cluster filter should AND with inline lang filter',
    search(index, 'lang:rust', { filters: { cluster: 'air' } }).length === 0,
  );
  check(
    'structured filters alone should filter',
    search(index, '', { filters: { owner: 'worxbend' } }).length === 3,
  );

  // 12. Filter-only results use the tie-break order, and equal scores fall back to stars.
  const labs = ids(search(index, 'cluster:labs'));
  check('filter-only results should be sorted by stars first', labs[0] === 'beta');
  const tie = ids(search(index, 'tie-break fixture'));
  check('equal scores should break by stars', tie[0] === 'beta' && tie[1] === 'alpha');

  // 13. Empty query with no filters returns nothing.
  check('empty query should return no results', search(index, '   ').length === 0);

  // 14. limit is honoured.
  check('limit should cap the result count', search(index, 'stars:>=0', { limit: 2 }).length === 2);

  // 15. Ranges point at the original text and highlight() marks the right characters.
  const nameHit = search(index, 'bridge').find((r) => r.project.id === 'airgradient-bridge');
  const nameRanges = nameHit && nameHit.matches.name;
  check('a name match should report ranges', Array.isArray(nameRanges) && nameRanges.length > 0);
  if (Array.isArray(nameRanges) && nameRanges.length > 0) {
    check(
      'the reported range should cover "bridge"',
      'airGradient-bridge'.slice(nameRanges[0][0], nameRanges[0][1]).toLowerCase().indexOf('bridge') !== -1,
    );
  }

  // 16. A short prefix marks only what was typed, not the whole compound name.
  const shortPrefix = search(index, 'air').find((r) => r.project.id === 'airgradient-bridge');
  check(
    'a prefix should highlight only the typed characters',
    !!shortPrefix &&
      highlight(shortPrefix.project.name, shortPrefix.matches.name) === '<mark>air</mark>Gradient-bridge',
  );

  // 17. Escaping — markup in the data can never become markup in the output.
  const escaped = highlight('<img src=x onerror=alert(1)>', []);
  check('highlight must escape angle brackets', escaped.indexOf('<img') === -1 && escaped.indexOf('&lt;img') === 0);
  check('highlight must escape quotes', highlight('a "b" \'c\' `d`', []).indexOf('"') === -1);
  check('highlight should mark the requested slice', highlight('abcdef', [[0, 3]]) === '<mark>abc</mark>def');
  check('highlight should merge overlapping ranges', highlight('abcdef', [[2, 4], [0, 3]]) === '<mark>abcd</mark>ef');
  check('highlight should tolerate out-of-range input', highlight('abc', [[-5, 99]]) === '<mark>abc</mark>');
  check('highlight with no ranges should still escape', highlight('<b>', undefined) === '&lt;b&gt;');

  // 18. Markup coming through a real search result stays escaped.
  const markupHit = search(index, 'script').find((r) => r.project.id === 'markup');
  if (markupHit) {
    const rendered = highlight(markupHit.project.desc, markupHit.matches.desc);
    check('rendered description must not contain a live tag', rendered.indexOf('<script') === -1);
    check('rendered description should still contain a mark', rendered.indexOf('<mark>') !== -1);
  } else {
    failures.push('expected the markup fixture to be found by "script"');
  }

  // 19. A query full of markup is harmless.
  let threw = false;
  try {
    search(index, '"><img src=x onerror=alert(1)>');
  } catch (error) {
    threw = true;
  }
  check('a markup query must not throw', !threw);

  // 20. Degenerate input.
  check('search on a null index returns nothing', search(null, 'anything').length === 0);
  check('an empty catalog builds and searches', search(buildIndex([]), 'anything').length === 0);

  return failures;
}
