/**
 * core/store.js — the one place this site remembers anything.
 *
 * What it is for
 * --------------
 * The page has a handful of small preferences that must survive a reload: which theme you picked,
 * whether you asked for reduced motion, which view you were in, and so on. Browsers give us
 * `localStorage` for that, but using it directly in every module causes three recurring problems:
 *
 *   1. Key collisions. `localStorage` is shared by every page on the same origin, and
 *      `worxbend.github.io` hosts more than this site. So every key we own is written with the
 *      prefix `wb.` — `theme` becomes `wb.theme`. Nothing outside this file adds that prefix.
 *   2. It can throw. In Safari's private mode, and in browsers where the user has blocked site
 *      storage, *reading or writing* `localStorage` raises an exception rather than returning
 *      null. An unguarded `localStorage.getItem()` therefore takes the whole page down. This
 *      module probes once at load; if storage is unusable it transparently falls back to a plain
 *      in-memory object, so the site still works for the length of that visit — the preference
 *      does not survive a reload. `store.available` tells you which mode you are in.
 *   3. Values are strings. Everything here is JSON-encoded on the way in and JSON-decoded on the
 *      way out, and a corrupt or hand-edited value returns your fallback instead of throwing.
 *
 * Change notification
 * -------------------
 * `subscribe(key, fn)` covers both directions:
 *   - a `set()` in *this* tab notifies local subscribers directly (the browser deliberately does
 *     not fire a `storage` event in the tab that caused the write);
 *   - a `set()` in *another* tab arrives as a `storage` event, which we translate into the same
 *     callback. That is what makes "change the theme in one tab, watch the other tab follow" work.
 *
 * No matter how many subscribers exist, this module attaches exactly one real `storage` listener
 * to `window`, and it attaches it lazily — a page that never subscribes never adds a listener.
 */

/** Every key this site owns lives under this prefix inside the shared localStorage namespace. */
const PREFIX = 'wb.';

/**
 * The canonical key names. Always go through this map rather than typing a string literal, so a
 * rename happens in one place and a typo is a missing property instead of a silently dead read.
 *
 * The inline anti-flash script in the page `<head>` reads `wb.theme` directly, because it has to
 * run before any module is loaded. If you rename `theme` here, rename it there too.
 */
export const KEYS = {
  theme: 'theme',
  motion: 'motion',
  density: 'density',
  view: 'view',
  sound: 'sound',
  telemetry: 'telemetry:consent',
  recent: 'search:recent',
  visits: 'visits',
};

/* ------------------------------------------------------------------------------------------- *
 * Backend selection: real localStorage when we can, a plain Map when we cannot.
 * ------------------------------------------------------------------------------------------- */

/**
 * Probe `localStorage` by actually writing and removing a value. Feature-detecting with
 * `'localStorage' in window` is not enough: the property exists in Safari private mode, and only
 * blows up on the first write.
 *
 * @returns {Storage|null} the usable Storage object, or null when storage is unavailable.
 */
function probeLocalStorage() {
  try {
    const probeKey = `${PREFIX}__probe__`;
    const ls = globalThis.localStorage;
    ls.setItem(probeKey, '1');
    ls.removeItem(probeKey);
    return ls;
  } catch {
    // Private mode, blocked storage, a sandboxed iframe, or a quota of zero. All the same to us.
    return null;
  }
}

const backing = probeLocalStorage();

/** Used only when `backing` is null. Lives as long as the page does, then disappears. */
const memory = new Map();

/**
 * True when preferences will survive a reload. The UI can use this to explain to the visitor why
 * their theme choice keeps resetting, instead of leaving them to guess.
 */
const available = backing !== null;

/**
 * Read the raw, still-encoded string for a key.
 *
 * The `memory` map is consulted whenever the real store hands back nothing — not only when
 * there is no real store at all. The extra case never shows up in ordinary use, which is
 * exactly why it needs writing down: when `localStorage` exists but refuses a write because
 * the origin has filled its storage quota, `writeRaw` below keeps the value in `memory` so
 * the rest of the page still sees the preference it asked for. If reads went to
 * `localStorage` alone, a visitor at quota would pick a theme, watch it apply, and then have
 * every later read — the boot-time restore, and the "did this actually change?" comparison
 * in `set()` — report the preference as never set.
 *
 * @param {string} full prefixed key
 * @returns {string|null}
 */
function readRaw(full) {
  if (backing) {
    try {
      const stored = backing.getItem(full);
      if (stored !== null) return stored;
    } catch {
      // Storage worked at probe time but failed now (quota, or permission revoked
      // mid-session). Fall through to whatever we managed to keep in memory.
    }
  }
  return memory.has(full) ? memory.get(full) : null;
}

/**
 * Write a raw string, returning false if the browser refused (a full quota, most likely).
 * @param {string} full prefixed key
 * @param {string} raw already JSON-encoded value
 * @returns {boolean}
 */
function writeRaw(full, raw) {
  if (!backing) {
    memory.set(full, raw);
    return true;
  }
  try {
    backing.setItem(full, raw);
    return true;
  } catch {
    // Out of quota. Keep the value for this session so the UI stays consistent, and carry on.
    memory.set(full, raw);
    return false;
  }
}

/** @param {string} full prefixed key */
function deleteRaw(full) {
  memory.delete(full);
  if (!backing) return;
  try {
    backing.removeItem(full);
  } catch {
    /* Nothing useful to do — the value is already gone from our point of view. */
  }
}

/**
 * Decode a stored string. Anything unparseable (a hand-edited value, a key written by an older
 * version of the site) is treated as "not set" rather than as an error.
 *
 * @param {string|null} raw
 * @param {*} fallback
 */
function decode(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Subscriptions.
 * ------------------------------------------------------------------------------------------- */

/** key (unprefixed) -> set of callbacks. A key with no callbacks is deleted from the map. */
const listeners = new Map();

/** Whether the single shared `storage` listener is currently attached to `window`. */
let storageListenerAttached = false;

/**
 * Translate another tab's write into our own callbacks.
 * @param {StorageEvent} event
 */
function handleStorageEvent(event) {
  // `storageArea` distinguishes localStorage from sessionStorage. Ignore anything that is not ours.
  if (event.storageArea && event.storageArea !== backing) return;

  // A `localStorage.clear()` in another tab arrives with key === null: every key we know about is
  // now gone, so tell every subscriber.
  if (event.key === null) {
    for (const key of [...listeners.keys()]) notify(key, undefined);
    return;
  }

  if (!event.key.startsWith(PREFIX)) return;
  const key = event.key.slice(PREFIX.length);
  if (!listeners.has(key)) return;

  notify(key, decode(event.newValue, undefined));
}

function attachStorageListener() {
  if (storageListenerAttached) return;
  // `storage` only ever fires on *other* tabs, so this is purely the cross-tab path.
  globalThis.addEventListener('storage', handleStorageEvent);
  storageListenerAttached = true;
}

function detachStorageListener() {
  if (!storageListenerAttached) return;
  globalThis.removeEventListener('storage', handleStorageEvent);
  storageListenerAttached = false;
}

/**
 * Call every subscriber for one key. Iterates a copy, so a callback that unsubscribes itself (or
 * subscribes something new) cannot corrupt the walk. A callback that throws is reported and
 * skipped — one broken listener must not stop the others from updating.
 *
 * @param {string} key unprefixed key
 * @param {*} value the newly stored value, or `undefined` when the key was removed
 */
function notify(key, value) {
  const set = listeners.get(key);
  if (!set || set.size === 0) return;
  for (const fn of [...set]) {
    try {
      fn(value, key);
    } catch (error) {
      console.error(`[store] subscriber for "${key}" threw`, error);
    }
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Public surface.
 * ------------------------------------------------------------------------------------------- */

export const store = {
  available,

  /**
   * Read a preference.
   * @param {string} key one of the values in KEYS
   * @param {*} [fallback] returned when the key is unset or its stored value is unreadable
   */
  get(key, fallback = undefined) {
    return decode(readRaw(PREFIX + key), fallback);
  },

  /**
   * Write a preference and, if it actually changed, tell subscribers.
   *
   * The comparison is done on the *encoded* strings. That means `set(KEYS.theme, 'matrix')` twice
   * in a row fires one change, not two, and re-writing an object with the same contents is also a
   * no-op — which matters because several places in the UI write the current value defensively on
   * every render.
   *
   * @param {string} key
   * @param {*} value anything JSON can represent
   * @returns {boolean} true when the value changed (and subscribers were notified)
   */
  set(key, value) {
    const raw = JSON.stringify(value);

    // `JSON.stringify(undefined)` is `undefined`, not a string. Storing "nothing" means removal.
    if (raw === undefined) return store.remove(key);

    const full = PREFIX + key;
    if (readRaw(full) === raw) return false;

    writeRaw(full, raw);
    notify(key, value);
    return true;
  },

  /**
   * Forget a preference. Fires a change with `undefined` only when something was actually stored.
   * @param {string} key
   * @returns {boolean} true when a value was removed
   */
  remove(key) {
    const full = PREFIX + key;
    if (readRaw(full) === null) return false;
    deleteRaw(full);
    notify(key, undefined);
    return true;
  },

  /**
   * Watch a key. The callback receives `(value, key)` — `value` is the decoded new value, or
   * `undefined` if the key was removed. It fires for writes from this tab *and* from other tabs.
   *
   * It does **not** fire immediately with the current value; read that yourself with `get()` if
   * you need it, so that the initial-render path stays explicit.
   *
   * @param {string} key
   * @param {(value: *, key: string) => void} fn
   * @returns {() => void} call to stop listening. Safe to call more than once.
   */
  subscribe(key, fn) {
    if (typeof fn !== 'function') throw new TypeError('store.subscribe expects a function');

    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(fn);
    attachStorageListener();

    let done = false;
    return function unsubscribe() {
      if (done) return;
      done = true;

      const current = listeners.get(key);
      if (!current) return;
      current.delete(fn);

      // Drop empty buckets so `listeners` cannot grow forever on a long-lived page, and take the
      // single window listener back down once nothing at all is being watched.
      if (current.size === 0) listeners.delete(key);
      if (listeners.size === 0) detachStorageListener();
    };
  },
};
