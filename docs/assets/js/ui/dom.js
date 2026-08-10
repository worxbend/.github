/**
 * ui/dom.js — the handful of DOM chores this page needs, and nothing else.
 *
 * This is not a framework and it is not trying to become one. There are five functions here,
 * and every one of them exists because `ui/app.js` needed it more than twice:
 *
 *   h(tag, attrs, children)  build an element without writing a string of HTML
 *   escapeHtml(text)         turn `<` and friends into their harmless spellings
 *   formatRelative(iso)      "3 days ago", in the visitor's own language
 *   formatCount(value)       "1,204" or "12K", in the visitor's own number format
 *   focusTrap(element)       keep the keyboard inside an open dialog
 *
 * The one rule worth stating out loud, because the whole site's safety rests on it:
 *
 *   h() NEVER accepts HTML. It sets properties and attributes and appends text nodes. The only
 *   place in this codebase where data becomes markup is `highlight()` in core/search.js, which
 *   escapes every character of its input before wrapping the matched parts in <mark>. If you
 *   find yourself wanting to pass an `innerHTML` key to h(), that is the signal to build child
 *   elements instead — and h() ignores the key so the mistake cannot land quietly.
 */

/* ------------------------------------------------------------------------------------------- *
 * h() — the element factory
 * ------------------------------------------------------------------------------------------- */

/**
 * Keys that must be written with setAttribute even though a property of the same name exists.
 *
 * `list` is the classic example: `input.list` is a read-only reference to the <datalist> element,
 * so assigning a string to it silently does nothing, while `setAttribute('list', id)` works.
 */
const ATTRIBUTE_ONLY = new Set(['list', 'form', 'download', 'role']);

/** Keys h() refuses outright, because assigning them would turn a string into live markup. */
const FORBIDDEN = new Set(['innerHTML', 'outerHTML', 'innerText', 'srcdoc']);

/**
 * Create an element.
 *
 * @param {string} tag        the tag name, for example 'button'
 * @param {object|null} attrs properties, attributes, `style`, `dataset` and `on*` handlers
 * @param {*} children        a string, a Node, or a (nested) array of either; null and false are
 *                            skipped, which is what makes `cond && h('span')` work inline
 * @returns {HTMLElement}
 *
 * How each key in `attrs` is treated, in order:
 *   - `null`, `undefined` and `false` values are skipped entirely, so an optional attribute can
 *     be written as `{ disabled: someCondition }` without an if-statement around it;
 *   - `class` and `className` both set the class list;
 *   - `style` takes an object; keys starting with `--` are set as CSS custom properties, which is
 *     how a card gets its language colour (`{ style: { '--lang': '#dea584' } }`);
 *   - `dataset` takes an object and becomes `data-*` attributes;
 *   - a key beginning with `on` whose value is a function becomes an event listener;
 *   - `true` becomes a bare attribute (`hidden`, `required`);
 *   - anything else is assigned as a property when the element has one of that name, and set as
 *     an attribute otherwise. Properties are preferred because they take the right type —
 *     `checked`, `value` and `textContent` all behave differently as attributes.
 */
export function h(tag, attrs = null, children = null) {
  const el = document.createElement(tag);

  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (FORBIDDEN.has(key)) continue;

      if (key === 'class' || key === 'className') {
        el.className = String(value);
        continue;
      }

      if (key === 'style' && typeof value === 'object') {
        for (const prop of Object.keys(value)) {
          const styleValue = value[prop];
          if (styleValue === null || styleValue === undefined) continue;
          // A custom property (one starting with two dashes) is not a member of CSSStyleDeclaration
          // and has to go through setProperty; ordinary properties can be assigned directly.
          if (prop.startsWith('--')) el.style.setProperty(prop, String(styleValue));
          else el.style[prop] = String(styleValue);
        }
        continue;
      }

      if (key === 'dataset' && typeof value === 'object') {
        for (const name of Object.keys(value)) {
          if (value[name] === null || value[name] === undefined) continue;
          el.dataset[name] = String(value[name]);
        }
        continue;
      }

      if (key.length > 2 && key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
        continue;
      }

      if (value === true) {
        el.setAttribute(key, '');
        continue;
      }

      if (!ATTRIBUTE_ONLY.has(key) && key in el) {
        el[key] = value;
        continue;
      }

      el.setAttribute(key, String(value));
    }
  }

  append(el, children);
  return el;
}

/**
 * Append children to a parent. Arrays are flattened as deeply as they nest, so a render function
 * can return a list of lists without the caller having to care.
 *
 * @param {Node} parent
 * @param {*} children
 */
export function append(parent, children) {
  if (children === null || children === undefined || children === false) return;

  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return;
  }

  if (children instanceof Node) {
    parent.appendChild(children);
    return;
  }

  parent.appendChild(document.createTextNode(String(children)));
}

/**
 * Replace everything inside an element with new children, in one step.
 *
 * `replaceChildren()` is the modern browser method for this and it is what does the work; the
 * wrapper exists so callers can hand it the same loose child shapes h() accepts.
 *
 * @param {Element} parent
 * @param {*} children
 */
export function setChildren(parent, children) {
  parent.replaceChildren();
  append(parent, children);
}

/* ------------------------------------------------------------------------------------------- *
 * escapeHtml()
 * ------------------------------------------------------------------------------------------- */

const ESCAPE_PATTERN = /[&<>"'`]/g;
const ESCAPE_REPLACEMENTS = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/**
 * Turn text into something that cannot be read as markup.
 *
 * Six characters are replaced rather than the usual three: the two quote marks and the backtick
 * matter whenever escaped text lands inside an attribute value, and escaping them always is
 * cheaper than remembering which context you are in.
 *
 * Note that `core/search.js` has its own copy of this, on purpose — it is a security boundary and
 * is written to have no dependencies at all. This one is for everyone else.
 *
 * @param {*} text
 * @returns {string}
 */
export function escapeHtml(text) {
  const source = text === null || text === undefined ? '' : String(text);
  return source.replace(ESCAPE_PATTERN, (ch) => ESCAPE_REPLACEMENTS[ch]);
}

/* ------------------------------------------------------------------------------------------- *
 * formatRelative()
 * ------------------------------------------------------------------------------------------- */

/**
 * Units from largest to smallest, with how many seconds each one holds. A month is treated as 30
 * days and a year as 365: this is a human-readable stamp under a repository card, not a calendar.
 */
const RELATIVE_UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * `Intl.RelativeTimeFormat` does real work when it is constructed, so build one and keep it.
 * Passing `undefined` as the locale means "use whatever the browser is set to", so a German
 * visitor reads "vor 3 Tagen" without this file knowing any German.
 * @type {Intl.RelativeTimeFormat|null}
 */
let relativeFormatter = null;

function getRelativeFormatter() {
  if (relativeFormatter) return relativeFormatter;
  try {
    // `numeric: 'auto'` is what produces "yesterday" instead of "1 day ago" where the language
    // has a word for it.
    relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  } catch {
    relativeFormatter = null;
  }
  return relativeFormatter;
}

/**
 * Turn an ISO date such as `'2026-08-09'` into "3 days ago".
 *
 * @param {string|number|Date} iso  an ISO date string, epoch milliseconds, or a Date
 * @param {number} [now]            the moment to measure against; only passed by tests
 * @returns {string} an empty string when the input cannot be read as a date
 */
export function formatRelative(iso, now = Date.now()) {
  let timestamp;
  if (iso instanceof Date) timestamp = iso.getTime();
  else if (typeof iso === 'number') timestamp = iso;
  else if (typeof iso === 'string') timestamp = Date.parse(iso);
  else return '';

  if (!Number.isFinite(timestamp)) return '';

  const formatter = getRelativeFormatter();
  // Past times are negative, which is the sign Intl expects: -3 days reads as "3 days ago".
  const seconds = Math.round((timestamp - now) / 1000);
  const magnitude = Math.abs(seconds);

  if (!formatter) {
    // No Intl support at all. Fall back to the plain date rather than inventing English wording.
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  if (magnitude < 45) return formatter.format(0, 'second');

  for (const [unit, size] of RELATIVE_UNITS) {
    if (magnitude >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.round(seconds), 'second');
}

/* ------------------------------------------------------------------------------------------- *
 * formatCount()
 * ------------------------------------------------------------------------------------------- */

/** Above this, a number is shortened ("12K") instead of written out in full. */
const COMPACT_FROM = 10000;

/** @type {Map<string, Intl.NumberFormat>} one formatter per style, built on first use. */
const numberFormatters = new Map();

function getNumberFormatter(compact) {
  const key = compact ? 'compact' : 'plain';
  const cached = numberFormatters.get(key);
  if (cached) return cached;

  let formatter = null;
  try {
    formatter = compact
      ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
      : new Intl.NumberFormat(undefined);
  } catch {
    formatter = null;
  }
  numberFormatters.set(key, formatter);
  return formatter;
}

/**
 * Format a whole number for display: thousands separated the way the visitor's browser does it,
 * and shortened once it gets long enough that the exact figure stops mattering.
 *
 * @param {number} value
 * @returns {string} '0' for anything that is not a finite number
 */
export function formatCount(value) {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  const formatter = getNumberFormatter(Math.abs(rounded) >= COMPACT_FROM);
  return formatter ? formatter.format(rounded) : String(rounded);
}

/* ------------------------------------------------------------------------------------------- *
 * focusTrap()
 * ------------------------------------------------------------------------------------------- */

/**
 * Everything a keyboard can land on. `:not([disabled])` matters because a disabled control still
 * matches `button` but cannot be focused, and a trap that tries to focus one would appear broken.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * An element that matches the selector but has been hidden (by `display: none`, by the `hidden`
 * attribute, or by an ancestor) is not really focusable. `getClientRects()` is empty for anything
 * that is not being laid out, which catches all of those cases in one test.
 *
 * @param {Element} el
 */
function isVisible(el) {
  return el.getClientRects().length > 0;
}

/**
 * Keep keyboard focus inside `element` until the returned function is called.
 *
 * Why a modal needs this: pressing Tab in a dialog that does not trap focus walks the keyboard
 * out of the dialog and into the page behind it, which is still there and still clickable. A
 * screen-reader user then has no way of knowing they have left, and no way back except Tab-ing
 * through the whole document. So Tab from the last control wraps to the first, and Shift+Tab from
 * the first wraps to the last.
 *
 * The list of focusable children is re-read on every Tab rather than captured once, because the
 * command palette rebuilds its result list as you type.
 *
 * @param {HTMLElement} element
 * @param {object} [options]
 * @param {HTMLElement|null} [options.initial] what to focus first; defaults to the first
 *   focusable child, or to `element` itself when it has none
 * @param {boolean} [options.restore=true] whether releasing the trap returns focus to whatever
 *   was focused when it was created
 * @returns {() => void} release the trap. Safe to call more than once.
 */
export function focusTrap(element, { initial = null, restore = true } = {}) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let released = false;
  /** Set when we had to make a non-focusable container focusable, so it can be undone. */
  let addedTabIndex = false;

  const focusables = () => [...element.querySelectorAll(FOCUSABLE_SELECTOR)].filter(isVisible);

  const first = initial || focusables()[0] || null;
  if (first) {
    first.focus();
  } else {
    // A dialog with nothing focusable in it still has to take focus, or the keyboard stays on the
    // page behind. `tabindex="-1"` makes an element focusable by script without adding it to the
    // Tab order, which is exactly what is wanted here.
    if (!element.hasAttribute('tabindex')) {
      element.setAttribute('tabindex', '-1');
      addedTabIndex = true;
    }
    element.focus();
  }

  function onKeyDown(event) {
    if (event.key !== 'Tab') return;

    const list = focusables();
    if (list.length === 0) {
      // Nothing to move to, so Tab must not escape.
      event.preventDefault();
      return;
    }

    const firstEl = list[0];
    const lastEl = list[list.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === firstEl || !element.contains(active))) {
      event.preventDefault();
      lastEl.focus();
      return;
    }
    if (!event.shiftKey && (active === lastEl || !element.contains(active))) {
      event.preventDefault();
      firstEl.focus();
    }
  }

  /**
   * A click, or a focus moved by script somewhere else on the page, can put focus outside the
   * dialog without a Tab ever being pressed. Catching `focusin` on the document pulls it back.
   */
  function onFocusIn(event) {
    if (element.contains(event.target)) return;
    const list = focusables();
    (list[0] || element).focus();
  }

  // Capture phase, so the trap sees the key before any handler inside the dialog can stop it.
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn, true);

  return function release() {
    if (released) return;
    released = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('focusin', onFocusIn, true);
    if (addedTabIndex) element.removeAttribute('tabindex');
    // Only restore if the element that opened the dialog is still on the page; putting focus on a
    // removed node drops it to <body>, which is worse than leaving it alone.
    if (restore && previous && previous.isConnected) previous.focus();
  };
}
