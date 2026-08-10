/**
 * core/telemetry.js — visitor-owned, local-only analytics.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUDIT NOTE — READ THIS FIRST
 *
 * THIS MODULE NEVER TOUCHES THE NETWORK.
 *
 * There is no endpoint, no server, no account, no third party. This file
 * contains no `fetch`, no `XMLHttpRequest`, no `navigator.sendBeacon`, no
 * `WebSocket`, no `EventSource`, no tracking-pixel `Image()`, no dynamic
 * `import()` of a remote URL, and no `<script>` injection. Grep for any of
 * those words and you will find them only inside this comment.
 *
 * Every event that is recorded is written to an IndexedDB database that lives
 * in the visitor's own browser profile, on the visitor's own machine. The
 * visitor can read it (`query`, `summary`), download the whole thing as JSON
 * (`export`), or delete all of it (`clear`). Clearing site data in the browser
 * removes it too. Nothing leaves the device, ever.
 *
 * Recording is OFF by default. `track()` returns immediately and stores
 * nothing unless the visitor has explicitly set consent to 'granted'. If the
 * browser sends the "Do Not Track" signal, the default stays denied and the
 * UI is expected to say so (see `telemetry.doNotTrack`).
 *
 * What is deliberately NOT recorded, anywhere, in any code path:
 *   - Raw search text. A search event stores the *length* of the query and the
 *     *number of results*, never the characters typed.
 *   - The full referring URL. Only the hostname (for example "news.example.com").
 *   - Anything IP-like, any account identifier, any cookie, any canvas or font
 *     fingerprint, any free-text the visitor typed.
 * The property sanitiser below enforces these rules mechanically, so a caller
 * cannot leak text by accident.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Why this exists at all: the site is a workshop showcase, and knowing which
 * projects get opened is useful to the person who maintains it. This module is
 * the honest version of that idea — the data is collected for the visitor's own
 * inspection first, and the maintainer only ever sees it if the visitor chooses
 * to send them an exported file.
 *
 * Contract: see SPEC.md §4 `core/telemetry.js`.
 */

import { store, KEYS } from './store.js';

/* ───────────────────────────── configuration ───────────────────────────── */

/** IndexedDB database name. Visible in DevTools → Application → IndexedDB. */
const DB_NAME = 'wb-telemetry';
/** Schema version. Bumping this requires an `upgrade` branch below. */
const DB_VERSION = 1;
/** The single object store. */
const STORE_NAME = 'events';

/** Hard cap on stored events. Oldest are trimmed first. */
const MAX_EVENTS = 5000;

/**
 * How long an idle browser tab waits before writing queued events. The idle
 * callback is given this as its `timeout`, which means "run when the browser is
 * idle, but no later than this" — the "idle callback or every 2 s, whichever
 * comes first" rule from the spec, expressed in one API call.
 */
const FLUSH_TIMEOUT_MS = 2000;

/** Queue length that forces an immediate flush instead of waiting for idle. */
const BUFFER_HIGH_WATER = 64;

/** A session ends after this much inactivity, and a new session id is minted. */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/** sessionStorage slot holding `{ id, last }` for the current session. */
const SESSION_STORAGE_KEY = 'wb.telemetry:session';

/** Give up on opening the database after this long and use memory instead. */
const OPEN_TIMEOUT_MS = 3000;

/** Ceiling on the in-memory fallback buffer, so a broken DB cannot eat RAM. */
const MEMORY_EVENT_CAP = 500;

/** Property sanitising limits. */
const MAX_PROP_KEYS = 12;
const MAX_STRING_LENGTH = 120;
const MAX_KEY_LENGTH = 40;
const MAX_EVENT_NAME_LENGTH = 64;

/** Days covered by `summary().byDay`. */
const SUMMARY_DAYS = 30;

/* ─────────────────────────── the event vocabulary ──────────────────────── */

/**
 * The event names the application is expected to emit.
 *
 * This list is the shared vocabulary between whoever writes `ui/app.js` and
 * whoever reads the data six months from now. Using a name that is not in this
 * list still works — nothing rejects it — but then the two of them disagree
 * about what the data means, which is the failure this list prevents.
 *
 * Each entry documents the properties that event is expected to carry. Note
 * that none of them carry text the visitor typed.
 *
 *   page_view         { path }                     — a route was shown. `path` has any
 *                                                     search route reduced to '#/q/*'.
 *   theme_change      { from, to }                 — theme ids, e.g. 'foundation' → 'matrix'.
 *   view_change       { from, to }                 — 'grid' | 'constellation'.
 *   search_open       { via }                      — 'shortcut' | 'button' | 'hash'.
 *   search_query      { queryLen, results }        — LENGTH of the query and the number of
 *                                                     results. Never the query itself.
 *   project_open      { id, cluster, via }         — a project slug from PROJECTS, e.g. 'scenedeck'.
 *   cluster_filter    { id, active }               — a cluster id from CLUSTERS; `active` is
 *                                                     true when turned on.
 *   star_select       { id }                       — a constellation node was clicked in the
 *                                                     WebGL scene.
 *   telemetry_consent { state }                    — 'granted' | 'denied'. Emitted by this
 *                                                     module itself from `setConsent()`.
 *   telemetry_export  { count }                    — the visitor downloaded their own data.
 *                                                     Emit it from the app AFTER `export()`.
 *   telemetry_clear   { count }                    — the visitor wiped their own data. Emit it
 *                                                     from the app AFTER `clear()` resolves,
 *                                                     otherwise the wipe deletes the event that
 *                                                     records the wipe.
 *   perf_quality      { from, to, fps }            — the adaptive-quality step in core/motion.js
 *                                                     changed, e.g. 'high' → 'medium'.
 */
export const EVENT_NAMES = Object.freeze({
  PAGE_VIEW: 'page_view',
  THEME_CHANGE: 'theme_change',
  VIEW_CHANGE: 'view_change',
  SEARCH_OPEN: 'search_open',
  SEARCH_QUERY: 'search_query',
  PROJECT_OPEN: 'project_open',
  CLUSTER_FILTER: 'cluster_filter',
  STAR_SELECT: 'star_select',
  TELEMETRY_CONSENT: 'telemetry_consent',
  TELEMETRY_EXPORT: 'telemetry_export',
  TELEMETRY_CLEAR: 'telemetry_clear',
  PERF_QUALITY: 'perf_quality',
  /** Fired once the live repository list has been folded in, with where it came from. */
  CATALOG_REFRESH: 'catalog_refresh',
});

/** The same vocabulary as a plain array, for building UI filter menus. */
export const EVENT_NAME_LIST = Object.freeze(Object.values(EVENT_NAMES));

/* ───────────────────── promise wrappers around raw IndexedDB ───────────── */
/*
 * IndexedDB is an event-callback API from before promises existed. These two
 * helpers are the whole of the "library" this module uses — pulling in a
 * dependency for a dozen lines of adapter code would be a worse trade.
 */

/**
 * Resolve when a transaction commits; reject if it errors or aborts.
 *
 * Aborts matter more than they look: a single failed write (a full disk, for
 * example) aborts the whole transaction, and `transaction.error` is where the
 * real reason — such as QuotaExceededError — surfaces.
 */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

/** True when an error means "the browser refused to store more data". */
function isQuotaError(error) {
  if (!error) return false;
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22
  );
}

/* ──────────────────────────── module state ─────────────────────────────── */

/** Cached consent value, so the hot path never reads localStorage. */
let consentState = 'denied';

/** Open database connection, or null when we are running on memory only. */
let database = null;
/** In-flight open attempt, so concurrent callers share one connection. */
let openAttempt = null;
/**
 * Set when IndexedDB is unusable for the rest of this page's life (missing,
 * blocked by another tab, or closed by a versionchange). Once true we stop
 * retrying — retrying a blocked open in a loop would keep the other tab stuck.
 */
let storageDisabled = false;
/** Human-readable reason for the degrade, surfaced for debugging. */
let degradeReason = '';

/** Events waiting to be written. */
let buffer = [];
/** Events that could not be written, kept in memory so nothing silently vanishes. */
let memoryEvents = [];
/** Ids for memory-only events; negative so they never collide with real DB keys. */
let memoryIdCounter = -1;

/** Current session, `{ id, last }`. */
let session = null;
/** Per-session sequence number, so events written in the same millisecond still order. */
let seq = 0;
/** Session context, captured once. See SPEC.md §4. */
let context = null;

/** Flush scheduling handles. */
let idleHandle = null;
let timerHandle = null;
let flushScheduled = false;
let flushing = false;
/** The flush that is running right now, so a caller arriving mid-flush can wait for it. */
let flushPromise = null;
/** The single follow-up flush queued behind the running one. See `flushNow()`. */
let queuedFlush = null;

/** Lifecycle wiring, so `dispose()` can undo exactly what `init()` did. */
let initialised = false;
let unsubscribeConsent = null;
let listenersAttached = false;

/* ───────────────────────────── small utilities ─────────────────────────── */

/** A random session id. `crypto.randomUUID` is not available on http:// origins. */
function makeSessionId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Last resort. This id is a grouping key for one visit, not a security token.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Read `sessionStorage` without letting private-mode exceptions escape. */
function readStoredSession() {
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === 'string' && typeof parsed.last === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Write `sessionStorage`, ignoring failures (private mode, disabled storage). */
function writeStoredSession(value) {
  try {
    globalThis.sessionStorage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* The session id survives in memory for this page; that is good enough. */
  }
}

/**
 * Return the current session, minting a new one if the last activity was more
 * than 30 minutes ago. Called on every `track()`, so it does no I/O — the
 * sessionStorage write is deferred to the next flush.
 */
function currentSession(now) {
  if (!session) {
    const stored = readStoredSession();
    session = stored && now - stored.last <= SESSION_IDLE_MS
      ? { id: stored.id, last: now }
      : { id: makeSessionId(), last: now };
    writeStoredSession(session);
    return session;
  }
  if (now - session.last > SESSION_IDLE_MS) {
    // A fresh visit after a long pause. New id, sequence restarts, context is
    // recaptured because the theme or viewport may well have changed.
    session = { id: makeSessionId(), last: now };
    seq = 0;
    context = null;
    writeStoredSession(session);
    return session;
  }
  session.last = now;
  return session;
}

/** Hostname of a URL string, or '' when there is not one. Never the full URL. */
function hostOf(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    return new URL(value).hostname || '';
  } catch {
    return '';
  }
}

/**
 * Capture the once-per-session context described in SPEC.md §4.
 *
 * Everything here is coarse and shared by thousands of other visitors — a theme
 * id, a viewport size, a time zone. None of it is combined into an identifier,
 * and the referrer is reduced to a hostname before it is ever stored.
 */
function captureContext() {
  const root = globalThis.document?.documentElement;
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    timeZone = '';
  }
  let reducedMotion = false;
  try {
    reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    reducedMotion = false;
  }

  const referrer = globalThis.document?.referrer || '';
  const referrerHost = hostOf(referrer);
  const ownHost = globalThis.location?.hostname || '';

  return {
    theme: root?.getAttribute('data-theme') || store.get(KEYS.theme, '') || '',
    view: store.get(KEYS.view, 'grid') || 'grid',
    // Language, not locale-plus-region-plus-calendar: 'en-GB', at most.
    lang: String(globalThis.navigator?.language || '').slice(0, 8),
    tz: timeZone,
    viewport: {
      w: Math.round(globalThis.innerWidth || 0),
      h: Math.round(globalThis.innerHeight || 0),
    },
    dpr: Math.round((globalThis.devicePixelRatio || 1) * 100) / 100,
    reducedMotion,
    // 'self' for internal navigation, '' for a direct visit, otherwise a bare
    // hostname. The path and query string of the referrer are discarded here
    // and never reach storage.
    referrerHost: referrerHost && referrerHost === ownHost ? 'self' : referrerHost,
  };
}

/* ───────────────────────── property sanitising ─────────────────────────── */

/**
 * Property keys whose value is free text the visitor may have typed. The value
 * is thrown away and replaced by its length under a `<key>Len` key, so a caller
 * that passes `{ query: 'my secret project' }` stores `{ queryLen: 17 }`.
 *
 * This is belt-and-braces: callers are told to pass `queryLen` themselves. The
 * rule exists so that forgetting cannot leak anything.
 */
const TEXT_KEYS = new Set([
  'query', 'q', 'search', 'term', 'text', 'input', 'value', 'keyword',
  'keywords', 'message', 'content', 'comment', 'note', 'email', 'user',
  'username', 'login', 'token', 'password',
]);

/** Property keys holding a URL. Reduced to a hostname under `<key>Host`. */
const URL_KEYS = new Set(['url', 'href', 'link', 'referrer', 'referer', 'origin', 'src']);

/** Shorten a string to the storage limit. */
function clampString(value) {
  return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
}

/**
 * Reduce caller-supplied properties to something safe and small.
 *
 * Rules, in order:
 *   1. Only strings, finite numbers and booleans survive. Objects, arrays,
 *      functions, `null`, `undefined`, `NaN`, `Infinity` and symbols are dropped
 *      — nested objects are the usual way personal data sneaks into analytics.
 *   2. Keys in TEXT_KEYS become `<key>Len` with the character count.
 *   3. Keys in URL_KEYS, and any string that looks like an http(s) URL, are
 *      reduced to a hostname.
 *   4. Strings are truncated to 120 characters.
 *   5. At most 12 keys are kept; the rest are ignored.
 *
 * Kept deliberately allocation-light: `track()` may be called from a keystroke
 * handler, so this runs a plain loop and returns early.
 */
function sanitiseProps(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;

  let kept = 0;
  for (const rawKey in props) {
    if (!Object.prototype.hasOwnProperty.call(props, rawKey)) continue;
    if (kept >= MAX_PROP_KEYS) break;

    const key = rawKey.length > MAX_KEY_LENGTH ? rawKey.slice(0, MAX_KEY_LENGTH) : rawKey;
    const value = props[rawKey];
    const type = typeof value;

    if (type === 'string') {
      if (TEXT_KEYS.has(key)) {
        out[`${key}Len`] = value.length;
        kept += 1;
        continue;
      }
      if (URL_KEYS.has(key) || value.startsWith('http://') || value.startsWith('https://')) {
        const host = hostOf(value);
        if (host) {
          out[URL_KEYS.has(key) ? `${key}Host` : key] = host;
          kept += 1;
        }
        continue;
      }
      out[key] = clampString(value);
      kept += 1;
      continue;
    }

    if (type === 'number') {
      // Number.isFinite rejects NaN and both infinities, which would not
      // survive a round-trip through JSON on export anyway.
      if (Number.isFinite(value)) {
        out[TEXT_KEYS.has(key) ? `${key}Len` : key] = value;
        kept += 1;
      }
      continue;
    }

    if (type === 'boolean') {
      out[key] = value;
      kept += 1;
    }
    // Everything else (objects, arrays, null, undefined, functions, symbols,
    // bigints) is dropped without comment.
  }
  return out;
}

/**
 * Turn a route into something recordable.
 *
 * The site's hash routes are `#/p/<id>`, `#/c/<cluster>` and `#/q/<query>`.
 * The first two are public slugs and are safe to keep. The third contains text
 * the visitor typed, so it is replaced with `#/q/*` and the length is returned
 * separately. Any query string is discarded entirely.
 */
function normalisePath(path) {
  let pathname = '/';
  let hash = '';

  try {
    const base = globalThis.location?.href || 'https://localhost/';
    const url = new URL(
      typeof path === 'string' && path ? path : (globalThis.location?.pathname || '/') + (globalThis.location?.hash || ''),
      base,
    );
    pathname = url.pathname || '/';
    hash = url.hash || '';
  } catch {
    return { path: '/', queryLen: undefined };
  }

  if (hash.startsWith('#/q/')) {
    const raw = hash.slice(4);
    let queryLen = raw.length;
    try {
      queryLen = decodeURIComponent(raw).length;
    } catch {
      /* A malformed escape sequence; the raw length is close enough. */
    }
    return { path: `${clampString(pathname)}#/q/*`, queryLen };
  }

  return { path: clampString(pathname + hash), queryLen: undefined };
}

/* ─────────────────────────── database plumbing ─────────────────────────── */

/**
 * Stop using IndexedDB for the rest of this page's life and keep working from
 * memory. Called from every failure path; it never throws and never rethrows.
 */
function degrade(reason, permanent = true) {
  degradeReason = reason;
  if (database) {
    try {
      database.close();
    } catch {
      /* Already closing. */
    }
  }
  database = null;
  openAttempt = null;
  if (permanent) storageDisabled = true;
}

/**
 * Open (and on first run create) the database.
 *
 * Resolves with an IDBDatabase, or with `null` when the browser cannot give us
 * one. It never rejects — every caller treats `null` as "write to memory
 * instead", which is why no failure here can reach the application.
 *
 * Failure modes handled, all of them observed in the wild:
 *   - `indexedDB` missing entirely (very old browsers, some embedded webviews).
 *   - `indexedDB.open` throwing synchronously (Firefox private windows used to).
 *   - The open request erroring (corrupt profile, storage disabled by policy).
 *   - The open request being *blocked* — another tab holds an older version
 *     open and will not let the upgrade through. That tab may never close, so
 *     waiting is not an option.
 *   - The open request neither succeeding nor failing (rare, but a hung request
 *     would otherwise leave every write pending forever), caught by a timeout.
 *   - `versionchange`, meaning another tab wants to upgrade or delete the
 *     database. We must close immediately or we block that tab.
 *   - `close`, an unexpected forced disconnect (disk error, storage cleared).
 */
function openDB() {
  if (storageDisabled) return Promise.resolve(null);
  if (database) return Promise.resolve(database);
  if (openAttempt) return openAttempt;

  const idb = globalThis.indexedDB;
  if (!idb) {
    degrade('IndexedDB is not available in this browser');
    return Promise.resolve(null);
  }

  openAttempt = new Promise((resolve) => {
    let settled = false;
    let abandoned = false;
    let timer = null;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };

    let request;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch (error) {
      degrade(`opening the database threw: ${error && error.name}`);
      settle(null);
      return;
    }

    timer = setTimeout(() => {
      // Neither success nor error arrived. Give up on this connection so the
      // caller is not left waiting; a later success is closed below.
      abandoned = true;
      degrade('the database took too long to open');
      settle(null);
    }, OPEN_TIMEOUT_MS);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // `id` is assigned by the browser. Indexes match SPEC.md §4: `ts` drives
        // time-range queries and the oldest-first trim, `name` filters by event
        // type, `session` groups one visit.
        const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        objectStore.createIndex('name', 'name', { unique: false });
        objectStore.createIndex('ts', 'ts', { unique: false });
        objectStore.createIndex('session', 'session', { unique: false });
      }
    };

    request.onblocked = () => {
      // Another tab is holding an older version of the database open. It may
      // stay open for hours. Degrade now rather than stalling every write; the
      // connection is discarded if it eventually opens.
      abandoned = true;
      degrade('another tab is blocking the database upgrade');
      settle(null);
    };

    request.onerror = () => {
      degrade(`the database could not be opened: ${request.error && request.error.name}`);
      settle(null);
    };

    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) {
        try {
          db.close();
        } catch {
          /* Nothing to do. */
        }
        return;
      }

      db.onversionchange = () => {
        // Another tab is upgrading or deleting this database. Holding the
        // connection open would block it indefinitely, so let go at once and
        // finish this page's session in memory.
        degrade('another tab changed the database version');
      };
      db.onclose = () => {
        // Forced disconnect (storage cleared, disk error). Allow one reopen on
        // the next write rather than giving up for good.
        database = null;
        openAttempt = null;
        degradeReason = 'the database connection was closed unexpectedly';
      };

      database = db;
      storageDisabled = false;
      degradeReason = '';
      settle(db);
    };
  });

  return openAttempt;
}

/** Append events to the in-memory fallback, dropping the oldest past the cap. */
function rememberInMemory(events) {
  for (const event of events) {
    memoryEvents.push({ id: memoryIdCounter--, ...event });
  }
  if (memoryEvents.length > MEMORY_EVENT_CAP) {
    memoryEvents = memoryEvents.slice(memoryEvents.length - MEMORY_EVENT_CAP);
  }
}

/**
 * Write one batch and trim to the cap inside a single transaction.
 *
 * Doing both in one transaction is what makes the cap safe: a concurrent flush
 * from another tab cannot interleave between "count" and "delete", so two tabs
 * cannot both decide to delete the same rows, and the store cannot be left over
 * the cap because a delete lost a race.
 *
 * Note there is no `await` between the individual requests. An IndexedDB
 * transaction commits as soon as the event loop has no more work queued against
 * it, so the trim is driven by nested callbacks and only the final commit is
 * awaited.
 */
function writeAndTrim(db, batch) {
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const objectStore = transaction.objectStore(STORE_NAME);

  for (const event of batch) {
    const request = objectStore.add(event);
    // A handler here keeps a failed write from being reported as an unhandled
    // error. It deliberately does NOT call preventDefault(), so a real failure
    // still aborts the transaction and surfaces through `transactionDone`.
    request.onerror = () => {};
  }

  const countRequest = objectStore.count();
  countRequest.onerror = () => {};
  countRequest.onsuccess = () => {
    let excess = countRequest.result - MAX_EVENTS;
    if (excess <= 0) return;

    // The `ts` index in its default direction walks oldest first, which is
    // exactly the trim order the spec asks for.
    const cursorRequest = objectStore.index('ts').openCursor();
    cursorRequest.onerror = () => {};
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || excess <= 0) return;
      cursor.delete();
      excess -= 1;
      cursor.continue();
    };
  };

  return transactionDone(transaction);
}

/**
 * Delete the oldest slice of the stored history to make room.
 *
 * The amount is a fraction of what is actually stored, not a fixed number: a
 * quota error can be caused by some entirely different part of the origin's
 * storage, and deleting a flat 1250 rows when only 70 exist would wipe the
 * visitor's whole history to solve someone else's problem.
 */
async function trimOldest(fraction) {
  const db = await openDB();
  if (!db) return false;
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const objectStore = transaction.objectStore(STORE_NAME);

    const countRequest = objectStore.count();
    countRequest.onerror = () => {};
    countRequest.onsuccess = () => {
      let remaining = Math.ceil(countRequest.result * fraction);
      if (remaining <= 0) return;
      const cursorRequest = objectStore.index('ts').openCursor();
      cursorRequest.onerror = () => {};
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || remaining <= 0) return;
        cursor.delete();
        remaining -= 1;
        cursor.continue();
      };
    };

    await transactionDone(transaction);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist one batch, degrading rather than failing.
 *
 * On QuotaExceededError — the browser refusing to store more, usually because
 * the whole origin is over its storage budget — the oldest quarter of the
 * history is deleted and the batch is retried exactly once. If that still
 * fails the batch goes to the memory buffer, so the visitor's current session
 * is still readable in the panel even though nothing is being persisted.
 */
async function writeBatch(batch, allowRetry = true) {
  const db = await openDB();
  if (!db) {
    rememberInMemory(batch);
    return;
  }
  try {
    await writeAndTrim(db, batch);
  } catch (error) {
    if (isQuotaError(error) && allowRetry) {
      const trimmed = await trimOldest(0.25);
      if (trimmed) {
        await writeBatch(batch, false);
        return;
      }
    }
    degradeReason = isQuotaError(error)
      ? 'the browser is out of storage space, so recent events are kept in memory only'
      : `events could not be written (${(error && error.name) || 'unknown error'})`;
    rememberInMemory(batch);
  }
}

/* ──────────────────────────── the flush loop ───────────────────────────── */

/** Cancel a pending idle callback or timer. */
function cancelScheduledFlush() {
  if (idleHandle !== null && typeof globalThis.cancelIdleCallback === 'function') {
    globalThis.cancelIdleCallback(idleHandle);
  }
  if (timerHandle !== null) clearTimeout(timerHandle);
  idleHandle = null;
  timerHandle = null;
  flushScheduled = false;
}

/**
 * Ask for a flush at the next convenient moment.
 *
 * `requestIdleCallback(fn, { timeout })` means "run when the browser has spare
 * time, but no later than `timeout`", which is the spec's "idle callback or
 * every 2 s, whichever comes first" in one call. Browsers without it (Safari,
 * historically) fall back to a plain timer with the same deadline.
 */
function scheduleFlush() {
  if (flushScheduled || buffer.length === 0) return;
  flushScheduled = true;

  if (typeof globalThis.requestIdleCallback === 'function') {
    idleHandle = globalThis.requestIdleCallback(() => {
      idleHandle = null;
      flushScheduled = false;
      flushNow();
    }, { timeout: FLUSH_TIMEOUT_MS });
    return;
  }

  timerHandle = setTimeout(() => {
    timerHandle = null;
    flushScheduled = false;
    flushNow();
  }, FLUSH_TIMEOUT_MS);
}

/**
 * Drain the buffer into storage. Never called while another drain is in flight —
 * `flushNow()` below owns that rule — so batches cannot be written twice or reordered.
 */
async function runFlush() {
  flushing = true;
  try {
    while (buffer.length > 0) {
      const batch = buffer;
      buffer = [];
      await writeBatch(batch);
    }
  } finally {
    flushing = false;
    if (session) writeStoredSession(session);
  }
}

/**
 * Move everything queued into storage.
 *
 * Returns a promise. Callers on the hot path deliberately ignore it, but `query()`,
 * `summary()` and `export()` all await it, and they await it for a reason: a panel opened
 * straight after a click has to show that click. So the promise this returns must mean
 * "everything queued when you asked is now in the database", including for a caller that
 * turns up while a flush is already running.
 *
 * That is the whole reason for the two module-level promises. A batch that is mid-write
 * has already been taken out of `buffer` and has not yet reached storage, so it is in
 * neither `buffer` nor `memoryEvents` and `memorySnapshot()` cannot see it either. A
 * re-entrant caller handed an already-resolved promise would read straight past it and
 * report a total short by that batch. Instead it waits for the running flush and then for
 * one more, which picks up anything that arrived while the first one was busy.
 *
 * Only one follow-up is ever queued: everybody who arrives during the same flush shares
 * `queuedFlush`, so a burst of re-entrant calls chains one extra flush, not one per caller.
 */
async function flushNow() {
  cancelScheduledFlush();

  if (flushing) {
    if (!queuedFlush) {
      queuedFlush = flushPromise.then(() => {
        // Release the slot before running, so a caller that turns up during the follow-up
        // queues a fresh one instead of joining a chain that is already finishing.
        queuedFlush = null;
        return flushNow();
      });
    }
    return queuedFlush;
  }

  if (buffer.length === 0) {
    if (session) writeStoredSession(session);
    return;
  }

  // `writeBatch` already swallows write failures, so `runFlush` is not expected to reject.
  // The `.catch` makes that structural rather than a hope: every caller shares this one
  // promise, and one unexpected rejection must not be handed on to every later caller of a
  // method — `query()`, `summary()`, `export()` — that promises never to reject.
  flushPromise = runFlush().catch(() => {});
  return flushPromise;
}

/**
 * The last-chance flush, on the two events that actually mean "this page may
 * never run code again": the tab becoming hidden, and `pagehide`.
 *
 * IndexedDB has no synchronous API, so this cannot be a true synchronous write.
 * What it can do — and does — is start the transaction inside the same task as
 * the event, before the browser freezes the page. A transaction that has begun
 * is committed by the browser even if the page goes away, so queued events
 * survive a tab close, a back-navigation into the bfcache, or a phone locking.
 * The session record, which lives in `sessionStorage`, IS written synchronously
 * here.
 */
function flushOnHide() {
  if (session) writeStoredSession(session);
  if (buffer.length === 0) return;
  cancelScheduledFlush();
  // Not awaited on purpose: awaiting would yield to the microtask queue, and
  // during page dismissal that yield may never come back.
  void flushNow();
}

function handleVisibilityChange() {
  if (globalThis.document?.visibilityState === 'hidden') flushOnHide();
}

function attachLifecycleListeners() {
  if (listenersAttached || !globalThis.addEventListener) return;
  globalThis.document?.addEventListener('visibilitychange', handleVisibilityChange);
  globalThis.addEventListener('pagehide', flushOnHide);
  listenersAttached = true;
}

function detachLifecycleListeners() {
  if (!listenersAttached) return;
  globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange);
  globalThis.removeEventListener('pagehide', flushOnHide);
  listenersAttached = false;
}

/* ───────────────────────────── reading it back ─────────────────────────── */

/** Normalise a `since` argument (epoch milliseconds, Date, or ISO string). */
function toTimestamp(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Local-time `YYYY-MM-DD` key, so "today" means the visitor's today. */
function dayKey(timestamp) {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Everything in the memory fallback plus anything still queued, so the panel
 * shows the current visit even when nothing can be persisted. Queued events
 * borrow provisional negative ids that cannot collide with stored ones.
 */
function memorySnapshot() {
  let provisional = memoryIdCounter;
  return memoryEvents.concat(buffer.map((event) => ({ id: provisional--, ...event })));
}

/* ─────────────────────────────── public API ────────────────────────────── */

/**
 * The telemetry facade. See SPEC.md §4 for the contract.
 *
 * Every method resolves. None of them reject, and none of them throw, even
 * with IndexedDB missing or broken — a page must not break because a browser
 * refused to store an analytics event.
 */
export const telemetry = {
  /**
   * Read the consent state. Defaults to 'denied', which is what an unanswered
   * banner, a "Do Not Track" browser, and a browser with no localStorage all
   * produce. Nothing is recorded until this returns 'granted'.
   */
  getConsent() {
    return consentState;
  },

  /**
   * Set consent to 'granted' or 'denied' and persist it via `core/store.js`.
   * Anything else is treated as 'denied' — an unknown state is not consent.
   *
   * Granting starts the database and the flush loop. Denying stops recording
   * immediately and discards anything still queued. Denying does NOT delete
   * events already stored; call `clear()` for that, so "stop watching" and
   * "erase what you have" stay two separate, deliberate choices.
   */
  setConsent(state) {
    const next = state === 'granted' ? 'granted' : 'denied';
    const previous = consentState;
    consentState = next;
    store.set(KEYS.telemetry, next);

    if (next === 'granted') {
      attachLifecycleListeners();
      // Warm the connection so the first real event does not pay for the open.
      void openDB();
      if (previous !== 'granted') {
        // Record the moment consent was given. Only this module knows the
        // transition, so it emits the event rather than leaving it to the app.
        telemetry.track(EVENT_NAMES.TELEMETRY_CONSENT, { state: next });
      }
    } else {
      cancelScheduledFlush();
      buffer = [];
    }
    return next;
  },

  /** True when the browser is sending a "Do Not Track" signal. */
  get doNotTrack() {
    const nav = globalThis.navigator;
    return (
      nav?.doNotTrack === '1' ||
      nav?.doNotTrack === 'yes' ||
      globalThis.doNotTrack === '1' ||
      nav?.msDoNotTrack === '1'
    );
  },

  /** 'indexeddb' while events are being persisted, 'memory' after a degrade. */
  get storage() {
    return database ? 'indexeddb' : 'memory';
  },

  /** Empty string normally; a plain-language explanation after a degrade. */
  get degradeReason() {
    return degradeReason;
  },

  /**
   * Start up: work out the consent state, open the database if recording is
   * allowed, and attach the flush listeners. Safe to call more than once.
   *
   * `consent` is optional. Pass it to apply an explicit choice (the visitor
   * clicked a banner button); leave it out to use the stored preference, which
   * defaults to 'denied'.
   *
   * Resolves with `{ consent, storage, doNotTrack }`. Awaiting it is optional.
   */
  async init({ consent } = {}) {
    const stored = store.get(KEYS.telemetry, null);
    const explicit = consent === 'granted' || consent === 'denied' ? consent : null;
    const resolved = explicit || (stored === 'granted' ? 'granted' : 'denied');

    consentState = resolved;
    if (explicit && explicit !== stored) store.set(KEYS.telemetry, explicit);

    if (!initialised) {
      initialised = true;
      // Cross-tab agreement: if the visitor grants or withdraws consent in another
      // tab, this one follows without needing a reload.
      unsubscribeConsent = store.subscribe(KEYS.telemetry, (value) => {
        consentState = value === 'granted' ? 'granted' : 'denied';
        if (consentState === 'granted') {
          // Do exactly what the granting half of `setConsent()` does, with the same two
          // calls, so the two routes into "recording is on" cannot drift apart. Setting
          // `consentState` alone is not enough: without `attachLifecycleListeners()` this
          // tab has no visibilitychange or pagehide handler, so events queued behind the
          // 2 s idle deadline have nothing to drain them when the tab is closed and are
          // lost — every time, for the rest of that tab's life.
          attachLifecycleListeners();
          // Warm the connection so the first real event does not pay for the open.
          void openDB();
        } else {
          cancelScheduledFlush();
          buffer = [];
        }
      });
    }

    if (consentState === 'granted') {
      attachLifecycleListeners();
      await openDB();
    }

    return { consent: consentState, storage: telemetry.storage, doNotTrack: telemetry.doNotTrack };
  },

  /**
   * Queue one event.
   *
   * This is the hot path — it is expected to be called from things like a
   * keystroke handler — so it does the least possible work: one consent check,
   * one clock read, a sanitise pass over at most twelve properties, and a push
   * onto an array. It never awaits, never touches storage, and never throws.
   *
   * With consent anything other than 'granted' it returns immediately, having
   * done nothing at all — no buffering "in case", no deferred write.
   */
  track(name, props = {}) {
    if (consentState !== 'granted') return;
    if (typeof name !== 'string' || name.length === 0) return;

    const now = Date.now();
    const active = currentSession(now);
    if (!context) context = captureContext();

    buffer.push({
      ts: now,
      name: name.length > MAX_EVENT_NAME_LENGTH ? name.slice(0, MAX_EVENT_NAME_LENGTH) : name,
      session: active.id,
      seq: ++seq,
      props: sanitiseProps(props),
      ctx: context,
    });

    if (buffer.length >= BUFFER_HIGH_WATER) {
      // A burst is happening. Drain it now rather than letting the queue grow
      // until the tab goes idle.
      void flushNow();
      return;
    }
    scheduleFlush();
  },

  /**
   * Record a route view. Any search route is reduced to `#/q/*` plus the query
   * length, so the text the visitor typed is not stored. Called with no
   * argument it reads the current location.
   */
  page(path) {
    if (consentState !== 'granted') return;
    const { path: safePath, queryLen } = normalisePath(path);
    telemetry.track(EVENT_NAMES.PAGE_VIEW, queryLen === undefined ? { path: safePath } : { path: safePath, queryLen });
  },

  /**
   * Record a duration in milliseconds, for example how long the WebGL scene
   * took to become interactive. Timings share the event namespace with
   * everything else; the duration lands in `props.ms`.
   */
  timing(name, ms) {
    if (consentState !== 'granted') return;
    if (!Number.isFinite(ms)) return;
    telemetry.track(name, { ms: Math.round(ms) });
  },

  /**
   * Read events back, newest first.
   *
   * `since` accepts epoch milliseconds, a Date, or an ISO string. `name`
   * filters to one event type. `limit` caps the number returned (default 200).
   *
   * Resolves with an array — an empty one when there is nothing stored, when
   * IndexedDB is unavailable and the memory buffer is empty, or when anything
   * goes wrong. It never rejects.
   */
  async query({ since, name, limit = 200 } = {}) {
    // Write what is queued first, so a panel opened immediately after a click
    // shows that click instead of waiting for the next idle moment.
    await flushNow();

    const sinceTs = toTimestamp(since);
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;

    // Events that never reached storage (no database, or a write that failed)
    // are still the visitor's events, so they are folded into every read.
    const filterMemory = () => {
      let rows = memorySnapshot();
      if (sinceTs !== null) rows = rows.filter((event) => event.ts >= sinceTs);
      if (name) rows = rows.filter((event) => event.name === name);
      return rows;
    };
    const newestFirst = (a, b) => b.ts - a.ts || b.seq - a.seq;

    const db = await openDB();
    if (!db) {
      return filterMemory().sort(newestFirst).slice(0, cap);
    }

    try {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const index = transaction.objectStore(STORE_NAME).index('ts');
      const range = sinceTs === null ? null : IDBKeyRange.lowerBound(sinceTs);
      // 'prev' walks the ts index from newest to oldest, so the loop can stop
      // as soon as it has `limit` matches instead of reading the whole store.
      const cursorRequest = index.openCursor(range, 'prev');
      const results = [];

      await new Promise((resolve, reject) => {
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || results.length >= cap) {
            resolve();
            return;
          }
          const value = cursor.value;
          if (!name || value.name === name) results.push(value);
          cursor.continue();
        };
      });

      const pending = filterMemory();
      if (pending.length === 0) return results;
      return results.concat(pending).sort(newestFirst).slice(0, cap);
    } catch {
      return filterMemory().sort(newestFirst).slice(0, cap);
    }
  },

  /**
   * Summarise everything stored in one pass.
   *
   * Returns `{ total, byName, byDay, firstSeen, sessions }`:
   *   total     — number of stored events
   *   byName    — `{ page_view: 12, … }`
   *   byDay     — `{ '2026-08-10': 4, … }`, one key per day for the last 30
   *               days including days with zero, so a chart can read it directly
   *   firstSeen — timestamp of the oldest stored event, or null
   *   sessions  — count of distinct session ids
   *
   * All five come from a single ascending cursor over the `ts` index. Five
   * separate queries would each re-read the same rows and could disagree with
   * each other if a flush landed in between.
   */
  async summary() {
    // Same reason as `query()`: count what has happened, not what happens to
    // have been written already.
    await flushNow();

    const now = Date.now();
    const byDay = {};
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    // Days are stepped with setDate rather than by adding 86 400 000 ms,
    // because on the day a daylight-saving change happens one local day is 23
    // or 25 hours long and fixed-size steps would skip or repeat a date.
    let cutoff = startOfToday.getTime();
    for (let i = SUMMARY_DAYS - 1; i >= 0; i -= 1) {
      const day = new Date(startOfToday);
      day.setDate(day.getDate() - i);
      byDay[dayKey(day.getTime())] = 0;
      if (i === SUMMARY_DAYS - 1) cutoff = day.getTime();
    }

    const result = { total: 0, byName: {}, byDay, firstSeen: null, sessions: 0 };
    const sessions = new Set();

    const accumulate = (event) => {
      result.total += 1;
      result.byName[event.name] = (result.byName[event.name] || 0) + 1;
      if (event.ts >= cutoff) {
        const key = dayKey(event.ts);
        if (key in byDay) byDay[key] += 1;
      }
      if (result.firstSeen === null || event.ts < result.firstSeen) result.firstSeen = event.ts;
      if (event.session) sessions.add(event.session);
    };

    const db = await openDB();
    if (!db) {
      // Same rule as `query()`: events held in memory because storage was
      // unavailable still count, otherwise the panel would report zero while
      // plainly showing a list of events.
      for (const event of memorySnapshot()) accumulate(event);
      result.sessions = sessions.size;
      return result;
    }

    for (const event of memorySnapshot()) accumulate(event);

    try {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const cursorRequest = transaction.objectStore(STORE_NAME).index('ts').openCursor();
      await new Promise((resolve, reject) => {
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve();
            return;
          }
          accumulate(cursor.value);
          cursor.continue();
        };
      });
    } catch {
      /* Fall through with whatever was counted before the failure. */
    }

    result.sessions = sessions.size;
    return result;
  },

  /**
   * Package everything stored as a downloadable JSON file.
   *
   * This is the visitor's copy of their own data. The application turns the
   * Blob into a download with `URL.createObjectURL`; the file never leaves the
   * machine unless the visitor chooses to send it somewhere.
   *
   * Resolves with `null` only in an environment without `Blob`.
   */
  async export() {
    await flushNow();
    const events = await telemetry.query({ limit: MAX_EVENTS });
    events.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

    const payload = {
      format: 'wb-telemetry',
      version: DB_VERSION,
      exportedAt: new Date().toISOString(),
      note: 'Recorded locally in your browser. Nothing here was ever sent anywhere.',
      consent: consentState,
      storage: telemetry.storage,
      count: events.length,
      events,
    };

    let json;
    try {
      json = JSON.stringify(payload, null, 2);
    } catch {
      json = JSON.stringify({ ...payload, events: [] }, null, 2);
    }

    if (typeof Blob !== 'function') return null;
    return new Blob([json], { type: 'application/json' });
  },

  /**
   * Delete every stored event. The database itself is kept (an empty store
   * costs nothing and avoids an upgrade round-trip on the next event); the
   * in-memory queue and fallback buffer are emptied too, so nothing that was
   * mid-flight reappears afterwards.
   *
   * Resolves even when there is no database to clear.
   */
  async clear() {
    cancelScheduledFlush();
    buffer = [];
    memoryEvents = [];

    const db = await openDB();
    if (!db) return;
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).clear();
      await transactionDone(transaction);
    } catch {
      /* Nothing stored, or storage refused. Either way there is nothing left
         for this page to hand back to the caller. */
    }
  },

  /**
   * Release everything this module attached to the page: the lifecycle
   * listeners, the pending flush, the store subscription and the database
   * connection. Present because SPEC.md §6 requires every listener a module
   * adds to have a matching removal.
   */
  async dispose() {
    detachLifecycleListeners();
    cancelScheduledFlush();
    if (unsubscribeConsent) {
      unsubscribeConsent();
      unsubscribeConsent = null;
    }
    initialised = false;
    await flushNow();
    if (database) {
      try {
        database.close();
      } catch {
        /* Already closed. */
      }
    }
    database = null;
    openAttempt = null;
  },
};
