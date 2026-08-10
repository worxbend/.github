/**
 * core/motion.js — the single heartbeat for everything that moves on this page.
 *
 * What it is for
 * --------------
 * A page like this has several things that want to animate at the same time: the WebGL starfield,
 * the glyph rain, parallax layers, number roll-ups. The naive approach is to give each of them its
 * own `requestAnimationFrame` loop. That goes wrong in ways that are hard to debug later:
 *
 *   - the browser has to run several callbacks per frame instead of one, and each one re-reads
 *     layout information it could have shared;
 *   - each loop has to remember, separately, to stop when the tab is hidden;
 *   - when the page gets slow there is no single place to turn the work down.
 *
 * So there is exactly one `requestAnimationFrame` loop in this codebase, and it lives here.
 * Nothing else may call `requestAnimationFrame`. Everything else registers a callback with
 * `motion.add(fn)` and gets called once per frame with how much time has passed.
 *
 * The four behaviours worth knowing about
 * ---------------------------------------
 * 1. **Delta clamping.** Callbacks receive `dt` — seconds since the previous frame — capped at
 *    0.05 s (20 frames per second). Without the cap, coming back to a tab that was in the
 *    background for two minutes would hand every animation a `dt` of 120 and teleport the whole
 *    scene. The cap makes a long pause look like a brief stall instead.
 * 2. **Pausing.** When the tab is hidden the loop stops completely rather than running invisibly.
 * 3. **Adaptive quality.** The loop measures its own frame rate. If that stays under 45 frames
 *    per second for two seconds, `motion.quality` steps down (`'high'` -> `'medium'` -> `'low'`)
 *    and the loop starts calling its callbacks less often — 40, then 30 times per second — which
 *    leaves the browser more room per frame. It steps back up when the page recovers. Heavy
 *    layers (the WebGL scene, the glyph rain) also read `motion.quality` to drop their own detail.
 * 4. **Reduced motion.** `motion.reduced` is the honest answer to "should this page animate?". It
 *    starts from the operating system's `prefers-reduced-motion` setting and is overridden by the
 *    in-page motion toggle once the visitor has expressed a preference of their own. Ambient,
 *    decorative animation must check it and stay still; reveals and counters jump straight to
 *    their final state.
 *
 * This module also exports the three small DOM helpers that every page section uses —
 * `reveal()`, `parallax()` and `counters()` — because all three are consumers of the
 * loop and of `reduced`, and keeping them here is what stops them from growing their own loops.
 */

import { store, KEYS } from './store.js';

/* ------------------------------------------------------------------------------------------- *
 * Reduced motion: the operating system setting, overridden by the in-page toggle.
 * ------------------------------------------------------------------------------------------- */

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/** May be null in very old browsers, or in a non-browser test harness. */
const reduceQuery =
  typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(REDUCE_QUERY) : null;

/** What the operating system currently says. */
let systemReduced = reduceQuery ? reduceQuery.matches : false;

/**
 * Turn whatever is in storage into a three-way answer.
 *
 * The stored value is deliberately forgiving, because it is written by a UI toggle that may end up
 * using either wording: `'reduced'` / `'off'` / `'none'` / `false` all mean "hold still", and
 * `'full'` / `'on'` / `true` all mean "animate". Anything else — including nothing stored at all,
 * or the explicit `'system'` — means "follow the operating system".
 *
 * @returns {boolean|null} true = forced reduced, false = forced full, null = defer to the OS
 */
function storedPreference() {
  const raw = store.get(KEYS.motion, null);
  if (raw === null || raw === undefined || raw === 'system' || raw === 'auto') return null;
  if (raw === true || raw === 'full' || raw === 'on') return false;
  if (raw === false || raw === 'reduced' || raw === 'reduce' || raw === 'off' || raw === 'none') {
    return true;
  }
  return null;
}

let reduced = storedPreference() ?? systemReduced;

/** Callbacks registered through `motion.onReducedChange`. */
const reducedListeners = new Set();

/**
 * Recompute `reduced` from its two inputs and, if the answer moved, tell everyone who asked.
 * Called both when the OS setting changes and when the stored preference changes (including a
 * change made in a different tab, which arrives through the store's cross-tab sync).
 */
function refreshReduced() {
  const next = storedPreference() ?? systemReduced;
  if (next === reduced) return;
  reduced = next;
  for (const fn of [...reducedListeners]) {
    try {
      fn(reduced);
    } catch (error) {
      console.error('[motion] onReducedChange listener threw', error);
    }
  }
}

if (reduceQuery) {
  // `addEventListener` on a MediaQueryList is the modern spelling; Safari before 14 only had
  // `addListener`. Support both so an older iPad does not lose the OS setting entirely.
  if (typeof reduceQuery.addEventListener === 'function') {
    reduceQuery.addEventListener('change', (event) => {
      systemReduced = event.matches;
      refreshReduced();
    });
  } else if (typeof reduceQuery.addListener === 'function') {
    reduceQuery.addListener((event) => {
      systemReduced = event.matches;
      refreshReduced();
    });
  }
}

// The toggle writes through the store, so watching the store covers both "the toggle was clicked
// here" and "the toggle was clicked in another tab".
store.subscribe(KEYS.motion, refreshReduced);

/* ------------------------------------------------------------------------------------------- *
 * The loop.
 * ------------------------------------------------------------------------------------------- */

/** Longest step any callback will ever be given, in seconds. See note 1 in the header. */
const MAX_DT = 0.05;

/** Below this frame rate for QUALITY_DOWN_AFTER seconds, we turn the work down. */
const SLOW_FPS = 45;
const QUALITY_DOWN_AFTER = 2;

/** Above this frame rate for QUALITY_UP_AFTER seconds, we try turning it back up. */
const FAST_FPS = 55;
const QUALITY_UP_AFTER = 5;

/** How often callbacks run at each quality level, as a minimum gap in seconds. */
const STEP_FOR_QUALITY = { high: 0, medium: 1 / 40, low: 1 / 30 };
const QUALITY_ORDER = ['high', 'medium', 'low'];

/**
 * How strongly each new frame pulls the reported frame rate. 0.08 gives a number that settles in
 * roughly a second and does not flicker while you read it in the on-screen readout.
 */
const FPS_SMOOTHING = 0.08;

/**
 * @typedef {object} Task
 * @property {(dt: number, elapsed: number) => void} fn
 * @property {number} priority
 */

/** @type {Task[]} sorted by priority, highest first; insertion order breaks ties. */
let tasks = [];

/**
 * The exact array the loop is walking right now, or null when the loop is between frames.
 *
 * `add`/`remove` during a frame must not touch that array — splicing it mid-walk would skip the
 * next callback. Instead they copy it first (see `mutableTasks`), so the in-flight walk finishes
 * over the snapshot it started with and the change takes effect on the following frame. That is
 * what makes it safe for a callback to remove itself.
 *
 * @type {Task[]|null}
 */
let running = null;

/** @returns {Task[]} an array that is safe to mutate right now. */
function mutableTasks() {
  if (tasks === running) tasks = tasks.slice();
  return tasks;
}

let rafId = 0;
/** Whether we *want* to be running. The loop may still be paused because the tab is hidden. */
let wantRunning = false;
/** Set by an explicit `stop()`, so that a later `add()` does not quietly restart the loop. */
let stoppedByCaller = false;
/** Timestamp of the previous frame. Only meaningful once `needsBaseline` is false. */
let lastNow = 0;
/**
 * True until we have seen one frame to measure from. A plain "is lastNow zero?" test would be
 * wrong, because a timestamp of exactly 0 is legal and would leave the loop permanently
 * rebaselining and never calling anybody.
 */
let needsBaseline = true;
/** Clamped time accumulated but not yet delivered, because of quality throttling. */
let pending = 0;
/** Seconds of animation time delivered so far. Handed to callbacks as their second argument. */
let elapsed = 0;

let fps = 60;
let quality = 'high';
let slowFor = 0;
let fastFor = 0;

/** Callbacks registered through `motion.onQualityChange`. */
const qualityListeners = new Set();

function setQuality(next) {
  if (next === quality) return;
  quality = next;
  slowFor = 0;
  fastFor = 0;
  for (const fn of [...qualityListeners]) {
    try {
      fn(quality);
    } catch (error) {
      console.error('[motion] onQualityChange listener threw', error);
    }
  }
}

/**
 * Watch the measured frame rate and move `quality` one step at a time.
 * @param {number} rawDt unclamped seconds since the previous frame
 */
function updateQuality(rawDt) {
  const index = QUALITY_ORDER.indexOf(quality);

  if (fps < SLOW_FPS) {
    slowFor += rawDt;
    fastFor = 0;
    if (slowFor >= QUALITY_DOWN_AFTER && index < QUALITY_ORDER.length - 1) {
      setQuality(QUALITY_ORDER[index + 1]);
    }
  } else if (fps > FAST_FPS) {
    fastFor += rawDt;
    slowFor = 0;
    if (fastFor >= QUALITY_UP_AFTER && index > 0) {
      setQuality(QUALITY_ORDER[index - 1]);
    }
  } else {
    // In the middle band, hold whatever level we are on rather than oscillating around it.
    slowFor = 0;
    fastFor = 0;
  }
}

/**
 * Run every registered callback once.
 * @param {number} dt clamped seconds since the last dispatch
 */
function dispatch(dt) {
  running = tasks;
  for (let i = 0; i < running.length; i += 1) {
    const task = running[i];
    try {
      task.fn(dt, elapsed);
    } catch (error) {
      // One broken animation must not take the rest of the page's motion with it. Drop the
      // offender, report it once (it cannot throw again because it is gone), and keep going.
      console.error('[motion] frame callback threw and was removed', error);
      const list = mutableTasks();
      const at = list.indexOf(task);
      if (at !== -1) list.splice(at, 1);
    }
  }
  running = null;
}

/** @param {number} now DOMHighResTimeStamp supplied by requestAnimationFrame */
function frame(now) {
  rafId = requestAnimationFrame(frame);

  if (needsBaseline) {
    // First frame after starting or un-hiding: we have nothing to measure against yet, so
    // establish the baseline and wait for the next one. This is what stops a resumed tab from
    // delivering one enormous step.
    needsBaseline = false;
    lastNow = now;
    return;
  }

  const rawDt = (now - lastNow) / 1000;
  lastNow = now;
  if (rawDt <= 0) return;

  fps += (1 / rawDt - fps) * FPS_SMOOTHING;
  updateQuality(rawDt);

  pending += Math.min(rawDt, MAX_DT);
  if (pending < STEP_FOR_QUALITY[quality]) return;

  // Clamp again: at a throttled quality level `pending` is the sum of two or more frames, and the
  // promise to callbacks is that `dt` never exceeds MAX_DT.
  const dt = Math.min(pending, MAX_DT);
  pending = 0;
  elapsed += dt;

  if (tasks.length > 0) dispatch(dt);

  // A callback may have removed itself (or the last remaining task) during `dispatch`. Removals
  // made mid-frame deliberately do not touch the loop, so settle it here now that the walk is
  // over — otherwise an empty loop would keep spinning for the life of the page.
  syncLoop();
}

function loopShouldRun() {
  return wantRunning && !document.hidden && tasks.length > 0;
}

function syncLoop() {
  if (loopShouldRun()) {
    if (rafId === 0) {
      needsBaseline = true;
      pending = 0;
      rafId = requestAnimationFrame(frame);
    }
  } else if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    needsBaseline = true;
    pending = 0;
  }
}

// A hidden tab gets throttled to roughly one frame a second anyway; stopping outright is cheaper
// still, and it means a laptop lid closed on this page does not keep a GPU busy.
document.addEventListener('visibilitychange', () => {
  // Reported frame rate from a hidden tab is meaningless, so reset the adaptive-quality timers
  // instead of letting them conclude that the machine is slow.
  slowFor = 0;
  fastFor = 0;
  syncLoop();
});

export const motion = {
  /**
   * Register a per-frame callback.
   *
   * @param {(dt: number, elapsed: number) => void} fn called with seconds since the previous
   *   dispatch (never more than 0.05) and total seconds of animation time.
   * @param {{priority?: number}} [options] higher priority runs earlier in the frame; use it when
   *   one callback computes something a later one reads. Equal priorities keep insertion order.
   * @returns {() => void} removes the callback. Safe to call twice, and safe to call from inside
   *   `fn` itself.
   */
  add(fn, { priority = 0 } = {}) {
    if (typeof fn !== 'function') throw new TypeError('motion.add expects a function');

    const task = { fn, priority };
    const list = mutableTasks();

    // Insert before the first task of strictly lower priority. Walking forwards like this (rather
    // than pushing and sorting) is what keeps equal priorities in the order they were added.
    let at = list.length;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].priority < priority) {
        at = i;
        break;
      }
    }
    list.splice(at, 0, task);

    // Registering something implies wanting it to run — but if the page has explicitly called
    // `stop()`, adding a callback must not undo that. It waits for the next `start()`.
    if (!stoppedByCaller) wantRunning = true;
    syncLoop();

    let removed = false;
    return function remove() {
      if (removed) return;
      removed = true;
      const current = mutableTasks();
      const index = current.indexOf(task);
      if (index !== -1) current.splice(index, 1);
      // Do not call syncLoop() while a frame is in flight: cancelling the pending rAF from inside
      // its own callback would stop the loop for everyone. The next frame notices instead.
      if (running === null) syncLoop();
    };
  },

  /** Resume the loop after `stop()`. Harmless if it is already running. */
  start() {
    stoppedByCaller = false;
    wantRunning = true;
    syncLoop();
  },

  /** Halt the loop. Registered callbacks stay registered and resume on `start()`. */
  stop() {
    stoppedByCaller = true;
    wantRunning = false;
    syncLoop();
  },

  /**
   * True when this page should hold still. Live: reading it again later gives the current answer.
   * Ambient, decorative animation must check this every time it runs, not once at setup.
   */
  get reduced() {
    return reduced;
  },

  /**
   * @param {(reduced: boolean) => void} fn called whenever the answer flips, from either the
   *   operating system setting or the in-page toggle.
   * @returns {() => void} unsubscribe
   */
  onReducedChange(fn) {
    reducedListeners.add(fn);
    return () => reducedListeners.delete(fn);
  },

  /** Smoothed frames per second, for the on-screen telemetry readout. */
  get fps() {
    return fps;
  },

  /** `'high' | 'medium' | 'low'` — how much work the page should attempt. */
  get quality() {
    return quality;
  },

  /**
   * @param {(quality: string) => void} fn called when the adaptive quality level changes, so heavy
   *   layers can drop their own detail (pixel ratio, particle counts) at the same moment.
   * @returns {() => void} unsubscribe
   */
  onQualityChange(fn) {
    qualityListeners.add(fn);
    return () => qualityListeners.delete(fn);
  },
};

/* ------------------------------------------------------------------------------------------- *
 * reveal() — fade sections in as they scroll into view.
 * ------------------------------------------------------------------------------------------- */

/**
 * Trim the bottom of the viewport by a tenth before an element counts as "visible". Without this,
 * an element technically enters view the instant its top edge crosses the bottom of the screen,
 * and it finishes animating before you have actually looked at it. The negative bottom margin
 * makes it wait until it is properly on screen.
 */
const REVEAL_ROOT_MARGIN = '0px 0px -10% 0px';

/**
 * Longest stagger index handed to CSS. A list of fifty cards must not take fifty steps' worth of
 * delay to finish appearing, so the ramp flattens out after this many siblings.
 */
const MAX_STAGGER = 8;

/** Elements already handed to the observer, so calling reveal() twice does not double-register. */
const revealSeen = new WeakSet();

/** @type {IntersectionObserver|null} one observer for every [data-reveal] element on the page. */
let revealObserver = null;

function getRevealObserver() {
  if (revealObserver) return revealObserver;

  revealObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        // Reveal is a one-way trip: once an element has appeared it never hides again, so stop
        // watching it immediately. On a long page this is the difference between a handful of
        // observed elements and all of them.
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: REVEAL_ROOT_MARGIN, threshold: 0 }
  );
  return revealObserver;
}

/**
 * Count how many earlier siblings also carry `data-reveal`. This is the index CSS uses to stagger
 * a row of cards, exposed as the custom property `--i`. Deriving it from the DOM (rather than from
 * a counter held in JavaScript) means it stays correct when `reveal()` is called again later for
 * content that was added after the first pass.
 *
 * @param {Element} el
 * @returns {number}
 */
function staggerIndex(el) {
  let index = 0;
  let sibling = el.previousElementSibling;
  while (sibling && index < MAX_STAGGER) {
    if (sibling.hasAttribute('data-reveal')) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

/**
 * Wire up every `[data-reveal]` element under `root` so it gets the `is-in` class when it scrolls
 * into view. Safe to call repeatedly — elements already wired are skipped.
 *
 * Elements that are already on screen when the page loads are handled by the observer's very first
 * callback, which the browser fires as soon as it has done its initial layout. They therefore
 * animate in from their starting state like everything else, instead of appearing already-visible
 * and then jumping.
 *
 * @param {ParentNode} [root=document]
 * @returns {() => void} stops watching anything this call registered that has not yet appeared
 */
export function reveal(root = document) {
  const elements = [...root.querySelectorAll('[data-reveal]')].filter((el) => !revealSeen.has(el));
  if (elements.length === 0) return () => {};

  for (const el of elements) revealSeen.add(el);

  if (motion.reduced) {
    // No animation wanted: show everything now, and flatten the stagger so any CSS delay that is
    // still keyed off --i resolves to zero.
    for (const el of elements) {
      el.style.setProperty('--i', '0');
      el.classList.add('is-in');
    }
    return () => {};
  }

  const observer = getRevealObserver();
  for (const el of elements) {
    el.style.setProperty('--i', String(staggerIndex(el)));
    observer.observe(el);
  }

  return () => {
    for (const el of elements) observer.unobserve(el);
  };
}

/* ------------------------------------------------------------------------------------------- *
 * parallax() — move layers at different speeds as the page scrolls.
 * ------------------------------------------------------------------------------------------- */

/**
 * @typedef {object} ParallaxItem
 * @property {HTMLElement} el
 * @property {number} speed how far it drifts relative to the scroll, e.g. 0.2 = a fifth as far
 * @property {number} centre the element's own centre in page coordinates, measured, not per-frame
 * @property {number} applied the transform currently written, so measurement can subtract it
 */

/** @type {ParallaxItem[]} */
const parallaxItems = [];

/** Scroll position and viewport height, read once per frame instead of once per element. */
let scrollTop = 0;
let viewportHeight = 0;
let parallaxNeedsMeasure = true;
let parallaxRemove = null;
let parallaxWasReduced = false;

function markParallaxDirty() {
  parallaxNeedsMeasure = true;
}

/**
 * Read every element's resting position in one uninterrupted pass.
 *
 * `getBoundingClientRect` forces the browser to finish any pending layout work. Doing that once
 * for all elements is cheap; doing it between writes — read, write, read, write — makes the
 * browser redo layout every time, which is the "layout thrash" the performance budget forbids.
 * So this function only reads, and the frame callback below only writes.
 */
function measureParallax() {
  scrollTop = window.scrollY;
  viewportHeight = window.innerHeight;
  for (const item of parallaxItems) {
    const rect = item.el.getBoundingClientRect();
    // The rect already includes whatever transform we wrote last frame, so subtract it to recover
    // the element's untransformed position.
    item.centre = rect.top + scrollTop + rect.height / 2 - item.applied;
  }
}

function parallaxFrame() {
  if (motion.reduced) {
    if (!parallaxWasReduced) {
      // The visitor turned motion off mid-scroll. Put every layer back where it belongs and stop
      // touching them until they turn it on again.
      for (const item of parallaxItems) {
        item.applied = 0;
        item.el.style.transform = '';
      }
      parallaxWasReduced = true;
      parallaxNeedsMeasure = true;
    }
    return;
  }
  parallaxWasReduced = false;

  if (parallaxNeedsMeasure) {
    measureParallax();
    parallaxNeedsMeasure = false;
  }

  // One read of the scroll position for the whole frame — this is the value every element shares.
  scrollTop = window.scrollY;
  const viewportCentre = scrollTop + viewportHeight / 2;

  for (const item of parallaxItems) {
    // Offsets are measured from the viewport centre so the displacement stays small and is zero
    // when the element is centred, rather than growing without bound down a long page.
    const next = Math.round((viewportCentre - item.centre) * item.speed * 100) / 100;
    if (next === item.applied) continue;
    item.applied = next;
    // translate3d rather than top/margin: it is composited on the GPU and never triggers layout.
    item.el.style.transform = `translate3d(0, ${next}px, 0)`;
  }
}

function ensureParallaxRunning() {
  if (parallaxRemove) return;
  window.addEventListener('resize', markParallaxDirty, { passive: true });
  window.addEventListener('orientationchange', markParallaxDirty, { passive: true });
  // Priority 10: run before ordinary animation so anything that reads these positions in the same
  // frame sees the value for this frame, not the previous one.
  parallaxRemove = motion.add(parallaxFrame, { priority: 10 });
}

function stopParallaxIfEmpty() {
  if (parallaxItems.length > 0 || !parallaxRemove) return;
  window.removeEventListener('resize', markParallaxDirty);
  window.removeEventListener('orientationchange', markParallaxDirty);
  parallaxRemove();
  parallaxRemove = null;
}

/**
 * Register every `[data-parallax]` element under `root`. The attribute value is the drift factor:
 * `data-parallax="0.2"` moves the element a fifth as far as the page scrolls; a negative value
 * moves it the other way. A missing or unreadable value falls back to 0.2.
 *
 * @param {ParentNode} [root=document]
 * @returns {() => void} unregisters the elements this call added and clears their transforms
 */
export function parallax(root = document) {
  const added = [];

  for (const el of root.querySelectorAll('[data-parallax]')) {
    if (parallaxItems.some((item) => item.el === el)) continue;
    const speed = Number.parseFloat(el.getAttribute('data-parallax'));
    const item = {
      el,
      speed: Number.isFinite(speed) ? speed : 0.2,
      centre: 0,
      applied: 0,
    };
    parallaxItems.push(item);
    added.push(item);
  }

  if (added.length === 0) return () => {};

  parallaxNeedsMeasure = true;
  ensureParallaxRunning();

  return () => {
    for (const item of added) {
      const index = parallaxItems.indexOf(item);
      if (index !== -1) parallaxItems.splice(index, 1);
      item.el.style.transform = '';
    }
    stopParallaxIfEmpty();
  };
}

/* ------------------------------------------------------------------------------------------- *
 * counters() — roll a number up to its final value once it is on screen.
 * ------------------------------------------------------------------------------------------- */

const DEFAULT_COUNT_DURATION = 1.2; // seconds

/**
 * @typedef {object} CounterItem
 * @property {HTMLElement} el
 * @property {number} from
 * @property {number} to
 * @property {number} duration seconds
 * @property {number} t elapsed seconds since it started
 * @property {Intl.NumberFormat} format
 */

/** @type {CounterItem[]} counters that are currently rolling. Finished ones are dropped. */
const activeCounters = [];
let countersRemove = null;

/** @type {IntersectionObserver|null} */
let counterObserver = null;

/**
 * `Intl.NumberFormat` does real work when constructed, so build one per distinct decimal setting
 * and reuse it. Formatting itself is cheap; constructing sixty of them a second is not.
 * @type {Map<number, Intl.NumberFormat>}
 */
const numberFormats = new Map();

function formatterFor(decimals) {
  let format = numberFormats.get(decimals);
  if (!format) {
    // No explicit locale: this follows the visitor's own browser settings, so a German reader sees
    // 1.234 and an English reader sees 1,234 without us deciding for them.
    format = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberFormats.set(decimals, format);
  }
  return format;
}

/**
 * Ease-out cubic. The number sprints away from its starting value and coasts into the final one,
 * which reads as "settling" rather than as a linear tick.
 * @param {number} t progress from 0 to 1
 */
function easeOut(t) {
  const inverse = 1 - t;
  return 1 - inverse * inverse * inverse;
}

function finish(item) {
  item.el.textContent = item.format.format(item.to);
  item.el.setAttribute('data-count-done', '');
}

function countersFrame(dt) {
  for (let i = activeCounters.length - 1; i >= 0; i -= 1) {
    const item = activeCounters[i];

    if (motion.reduced) {
      // The visitor asked for stillness partway through. Land on the answer immediately.
      finish(item);
      activeCounters.splice(i, 1);
      continue;
    }

    item.t += dt;
    const progress = Math.min(item.t / item.duration, 1);
    const value = item.from + (item.to - item.from) * easeOut(progress);
    item.el.textContent = item.format.format(value);

    if (progress >= 1) {
      finish(item);
      activeCounters.splice(i, 1);
    }
  }

  if (activeCounters.length === 0 && countersRemove) {
    countersRemove();
    countersRemove = null;
  }
}

/** @param {HTMLElement} el */
function startCounter(el) {
  if (el.hasAttribute('data-count-done')) return;

  const to = Number.parseFloat(el.getAttribute('data-count-to'));
  if (!Number.isFinite(to)) return;

  const decimalsAttr = Number.parseInt(el.getAttribute('data-count-decimals') ?? '', 10);
  const decimals = Number.isFinite(decimalsAttr) ? Math.max(0, decimalsAttr) : 0;

  const durationAttr = Number.parseFloat(el.getAttribute('data-count-duration') ?? '');
  // The attribute is in milliseconds because that is what the rest of the page's timings use.
  const duration = Number.isFinite(durationAttr)
    ? Math.max(0.01, durationAttr / 1000)
    : DEFAULT_COUNT_DURATION;

  const fromAttr = Number.parseFloat(el.getAttribute('data-count-from') ?? '');
  const from = Number.isFinite(fromAttr) ? fromAttr : 0;

  const item = { el, from, to, duration, t: 0, format: formatterFor(decimals) };

  if (motion.reduced) {
    finish(item);
    return;
  }

  activeCounters.push(item);
  if (!countersRemove) countersRemove = motion.add(countersFrame);
}

function getCounterObserver() {
  if (counterObserver) return counterObserver;
  counterObserver = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        startCounter(entry.target);
      }
    },
    // Same trim as reveal(), so a figure starts counting at the same moment its card appears
    // rather than while it is still below the fold.
    { rootMargin: REVEAL_ROOT_MARGIN, threshold: 0 }
  );
  return counterObserver;
}

/**
 * Animate every `[data-count-to]` element under `root` from `data-count-from` (default 0) up to
 * `data-count-to`, starting when it scrolls into view.
 *
 * Optional attributes: `data-count-decimals` (default 0) and `data-count-duration` in
 * milliseconds (default 1200). The element's text is replaced each frame with the formatted
 * value, so give it `font-variant-numeric: tabular-nums` in CSS or the digits will jitter as their
 * widths change.
 *
 * When reduced motion is in force, the final value is written straight away and nothing animates.
 *
 * @param {ParentNode} [root=document]
 * @returns {() => void} stops watching anything this call registered that has not started yet
 */
export function counters(root = document) {
  const elements = [...root.querySelectorAll('[data-count-to]')].filter(
    (el) => !el.hasAttribute('data-count-done')
  );
  if (elements.length === 0) return () => {};

  if (motion.reduced) {
    for (const el of elements) startCounter(el);
    return () => {};
  }

  const observer = getCounterObserver();
  for (const el of elements) observer.observe(el);

  return () => {
    for (const el of elements) observer.unobserve(el);
  };
}
