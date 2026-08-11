/**
 * core/profile.js — the visitor profiler and browser fingerprinter.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, PLAINLY
 *
 * This module builds an identifying profile of the person viewing the page: a
 * browser fingerprint stable enough to recognise the same visitor across
 * visits, plus every device, network, timing and capability signal the browser
 * will hand a script. It exists to demonstrate, in the open, exactly how much a
 * website can learn about you without a login and without a cookie — which is
 * why the site tells the visitor it is doing this and shows them the result.
 *
 * It is deliberately a SEPARATE module from core/telemetry.js. That file makes
 * a hard promise never to touch the network and never to fingerprint, and it
 * keeps it. This file is the opposite kind of thing and says so up front, so
 * the two guarantees never get confused.
 *
 * CONSENT AND STORAGE
 *   - Nothing here runs until the visitor has turned recording on. The caller
 *     (ui/app.js) only invokes `collect()` once consent is 'granted'.
 *   - The profile is stored in this browser (localStorage) and shown back to the
 *     visitor in the instrumentation panel. It is theirs to read and to clear.
 *   - The IP-and-location lookup is the ONE thing that leaves the browser: it is
 *     a GET to a public "what is my IP" service, made only when
 *     `collect({ network: true })` is passed, and the visitor is told it happens.
 *
 * THE BACKEND SEAM (not wired to anything yet)
 *   `configureTransport({ endpoint })` and `flush()` are the hooks for sending
 *   this profile to a server later. Until an endpoint is configured, `flush()`
 *   collects the payload and returns it without sending anything. This is the
 *   "later I will export it to the backend API" seam, stubbed so that turning it
 *   on is one call and no change to the collectors.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { store, KEYS } from './store.js';

/* ───────────────────────────── configuration ───────────────────────────── */

/** localStorage slot for the durable visitor identity: id, firstSeen, visits. */
const IDENTITY_KEY = 'wb.profile:identity';

/** localStorage slot for the most recent full profile, so the panel can show it. */
const SNAPSHOT_KEY = 'wb.profile:last';

/**
 * The public IP + geolocation endpoint. A GET here returns the caller's own
 * public address and a coarse location derived from it. Swapped behind one
 * constant so it is the single line to change or remove.
 */
const IP_ENDPOINT = 'https://ipapi.co/json/';

/** Abandon the IP lookup after this long rather than hanging the profile. */
const IP_TIMEOUT_MS = 4000;

/** Fonts probed for presence, a classic fingerprinting surface. */
const FONT_PROBES = [
  'Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Georgia', 'Palatino',
  'Garamond', 'Comic Sans MS', 'Trebuchet MS', 'Arial Black', 'Impact', 'Tahoma',
  'Verdana', 'Segoe UI', 'Roboto', 'Ubuntu', 'Cantarell', 'Noto Sans', 'DejaVu Sans',
  'Liberation Sans', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'SF Pro',
  'Menlo', 'Monaco', 'Consolas', 'Inter', 'Open Sans', 'Lato',
];

/* ─────────────────────────── module state ──────────────────────────────── */

/** The most recently collected profile, kept so the panel can read it cheaply. */
let lastProfile = null;

/** Where flush() would POST the profile, once a backend exists. Null = stubbed. */
let transportEndpoint = null;

/* ───────────────────────────── small helpers ───────────────────────────── */

/** Run a collector, returning its value or `{ error }` — a collector never throws upward. */
function safe(fn, fallback = null) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (error) {
    return { error: String((error && error.name) || error || 'unavailable') };
  }
}

/** FNV-1a, a fast non-cryptographic string hash. Used to fold a big blob into a short tag. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A stable, well-mixed id from the stable fingerprint components. Uses SHA-256
 * through the Web Crypto API where it is available (it is, on this https site),
 * and falls back to FNV otherwise. Async because crypto.subtle.digest is.
 */
async function hashStable(text) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const bytes = new TextEncoder().encode(text);
      const digest = await subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* Fall through to the non-crypto hash. */
    }
  }
  return fnv1a(text);
}

/* ───────────────────────────── the collectors ──────────────────────────── */
/*
 * Each returns a plain object of primitives. Every one is wrapped so that a
 * browser that refuses a given API costs one `{ error }` field, never a throw.
 */

/** Wall-clock, timezone and locale — the "when and where" of the session. */
function collectTime() {
  const now = new Date();
  const intl = safe(() => Intl.DateTimeFormat().resolvedOptions(), {});
  const numberFmt = safe(() => new Intl.NumberFormat().format(1234567.89), '');
  return {
    iso: now.toISOString(),
    epoch: now.getTime(),
    timezone: intl.timeZone || '',
    timezoneOffsetMinutes: now.getTimezoneOffset(),
    locale: intl.locale || '',
    calendar: intl.calendar || '',
    numberingSystem: intl.numberingSystem || '',
    hourCycle: intl.hourCycle || '',
    // How this locale renders a known number — separators reveal region.
    numberSample: numberFmt,
  };
}

/** Everything the `navigator` object exposes about the browser and machine. */
function collectNavigator() {
  const nav = globalThis.navigator || {};
  const uaData = safe(() => {
    if (!nav.userAgentData) return null;
    return {
      brands: (nav.userAgentData.brands || []).map((b) => `${b.brand} ${b.version}`),
      mobile: nav.userAgentData.mobile,
      platform: nav.userAgentData.platform,
    };
  });
  return {
    userAgent: nav.userAgent || '',
    userAgentData: uaData,
    platform: nav.platform || '',
    vendor: nav.vendor || '',
    language: nav.language || '',
    languages: Array.isArray(nav.languages) ? nav.languages.slice(0, 12) : [],
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    cookieEnabled: nav.cookieEnabled ?? null,
    doNotTrack: nav.doNotTrack ?? globalThis.doNotTrack ?? null,
    globalPrivacyControl: nav.globalPrivacyControl ?? null,
    pdfViewerEnabled: nav.pdfViewerEnabled ?? null,
    webdriver: nav.webdriver ?? null,
    // Plugin names, thin these days but still a signal on desktop browsers.
    plugins: safe(() => Array.from(nav.plugins || []).map((p) => p.name).slice(0, 20), []),
  };
}

/** Screen geometry and colour depth. Stable per device, so part of the id. */
function collectScreen() {
  const s = globalThis.screen || {};
  const orientation = safe(() => s.orientation?.type || '', '');
  return {
    width: s.width ?? null,
    height: s.height ?? null,
    availWidth: s.availWidth ?? null,
    availHeight: s.availHeight ?? null,
    colorDepth: s.colorDepth ?? null,
    pixelDepth: s.pixelDepth ?? null,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
    orientation,
  };
}

/** The browser window right now — changes as the visitor resizes, so NOT in the id. */
function collectViewport() {
  return {
    innerWidth: globalThis.innerWidth ?? null,
    innerHeight: globalThis.innerHeight ?? null,
    outerWidth: globalThis.outerWidth ?? null,
    outerHeight: globalThis.outerHeight ?? null,
    scrollX: Math.round(globalThis.scrollX ?? 0),
    scrollY: Math.round(globalThis.scrollY ?? 0),
  };
}

/** The Network Information API: connection type and rough speed. */
function collectConnection() {
  const c = globalThis.navigator?.connection
    || globalThis.navigator?.mozConnection
    || globalThis.navigator?.webkitConnection;
  if (!c) return null;
  return {
    effectiveType: c.effectiveType || '',
    downlinkMbps: c.downlink ?? null,
    rttMs: c.rtt ?? null,
    saveData: c.saveData ?? null,
    type: c.type || '',
  };
}

/** A yes/no map of browser capabilities — each present API narrows the crowd. */
function collectCapabilities() {
  const has = (fn) => safe(() => Boolean(fn()), false) === true;
  const nav = globalThis.navigator || {};
  return {
    touch: has(() => 'ontouchstart' in globalThis || nav.maxTouchPoints > 0),
    webgl: has(() => !!document.createElement('canvas').getContext('webgl')),
    webgl2: has(() => !!document.createElement('canvas').getContext('webgl2')),
    webgpu: has(() => 'gpu' in nav),
    serviceWorker: has(() => 'serviceWorker' in nav),
    webrtc: has(() => 'RTCPeerConnection' in globalThis),
    webAudio: has(() => 'AudioContext' in globalThis || 'webkitAudioContext' in globalThis),
    localStorage: has(() => !!globalThis.localStorage),
    sessionStorage: has(() => !!globalThis.sessionStorage),
    indexedDB: has(() => !!globalThis.indexedDB),
    bluetooth: has(() => 'bluetooth' in nav),
    usb: has(() => 'usb' in nav),
    gamepad: has(() => 'getGamepads' in nav),
    battery: has(() => 'getBattery' in nav),
    share: has(() => 'share' in nav),
    clipboard: has(() => 'clipboard' in nav),
    geolocation: has(() => 'geolocation' in nav),
    notifications: has(() => 'Notification' in globalThis),
    speechSynthesis: has(() => 'speechSynthesis' in globalThis),
  };
}

/** CSS media-feature preferences: system-level settings that leak into the page. */
function collectPreferences() {
  const q = (query) => safe(() => globalThis.matchMedia?.(query).matches === true, false);
  return {
    colorScheme: q('(prefers-color-scheme: dark)') ? 'dark' : 'light',
    reducedMotion: q('(prefers-reduced-motion: reduce)'),
    reducedTransparency: q('(prefers-reduced-transparency: reduce)'),
    reducedData: q('(prefers-reduced-data: reduce)'),
    highContrast: q('(prefers-contrast: more)'),
    forcedColors: q('(forced-colors: active)'),
    invertedColors: q('(inverted-colors: inverted)'),
    hoverCapable: q('(hover: hover)'),
    finePointer: q('(pointer: fine)'),
    coarsePointer: q('(pointer: coarse)'),
  };
}

/** A 2D-canvas fingerprint: how this exact GPU + driver + font stack rasterises. */
function collectCanvasFingerprint() {
  const canvas = document.createElement('canvas');
  canvas.width = 280;
  canvas.height = 60;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { error: 'no-2d-context' };
  ctx.textBaseline = 'top';
  ctx.font = "16px 'Arial'";
  ctx.fillStyle = '#f60';
  ctx.fillRect(10, 10, 100, 30);
  ctx.fillStyle = '#069';
  ctx.fillText('worxbend·observatory·∮√π', 12, 14);
  ctx.fillStyle = 'rgba(102,204,0,0.7)';
  ctx.fillText('worxbend·observatory·∮√π', 14, 20);
  ctx.strokeStyle = 'rgba(120,80,200,0.6)';
  ctx.beginPath();
  ctx.arc(200, 30, 20, 0, Math.PI * 2);
  ctx.stroke();
  const data = safe(() => canvas.toDataURL(), '');
  return { hash: fnv1a(String(data)), length: String(data).length };
}

/** A WebGL fingerprint: the actual GPU vendor/renderer and a spread of driver limits. */
function collectWebglFingerprint() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) return { error: 'no-webgl' };
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const param = (name) => safe(() => gl.getParameter(gl[name]), null);
  const out = {
    vendor: safe(() => gl.getParameter(gl.VENDOR), ''),
    renderer: safe(() => gl.getParameter(gl.RENDERER), ''),
    unmaskedVendor: debugInfo ? safe(() => gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL), '') : '',
    unmaskedRenderer: debugInfo ? safe(() => gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL), '') : '',
    version: safe(() => gl.getParameter(gl.VERSION), ''),
    shadingLanguageVersion: safe(() => gl.getParameter(gl.SHADING_LANGUAGE_VERSION), ''),
    maxTextureSize: param('MAX_TEXTURE_SIZE'),
    maxRenderBufferSize: param('MAX_RENDERBUFFER_SIZE'),
    maxViewportDims: safe(() => Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []), null),
    maxVertexAttribs: param('MAX_VERTEX_ATTRIBS'),
    aliasedLineWidthRange: safe(() => Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || []), null),
    extensions: safe(() => (gl.getSupportedExtensions() || []).slice(0, 40), []),
  };
  out.hash = fnv1a(JSON.stringify(out));
  return out;
}

/** An audio-stack fingerprint from an offline render — driver maths, no sound played. */
function collectAudioFingerprint() {
  return new Promise((resolve) => {
    try {
      const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!OfflineCtx) {
        resolve({ error: 'no-offline-audio' });
        return;
      }
      const ctx = new OfflineCtx(1, 5000, 44100);
      const oscillator = ctx.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.value = 10000;
      const compressor = ctx.createDynamicsCompressor();
      oscillator.connect(compressor);
      compressor.connect(ctx.destination);
      oscillator.start(0);
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      ctx.oncomplete = (event) => {
        const channel = event.renderedBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < channel.length; i += 1) sum += Math.abs(channel[i]);
        done({ hash: fnv1a(sum.toString()), sum });
      };
      ctx.startRendering();
      setTimeout(() => done({ error: 'audio-timeout' }), 1000);
    } catch (error) {
      resolve({ error: String((error && error.name) || 'audio-failed') });
    }
  });
}

/**
 * Which of a probe set of fonts is installed, measured by the width trick: a
 * string is drawn in a generic family, then in "probe, generic"; if the width
 * moves, the probe font exists and displaced the generic.
 */
function collectFonts() {
  const baseFonts = ['monospace', 'sans-serif', 'serif'];
  const testString = 'mmmmmmmmmmlli·WORxbend·018';
  const testSize = '72px';
  const body = document.body;
  if (!body) return { error: 'no-body', present: [] };

  const span = document.createElement('span');
  span.style.position = 'absolute';
  span.style.left = '-9999px';
  span.style.top = '-9999px';
  span.style.fontSize = testSize;
  span.style.lineHeight = 'normal';
  span.textContent = testString;
  body.appendChild(span);

  const baseline = {};
  for (const base of baseFonts) {
    span.style.fontFamily = base;
    baseline[base] = { w: span.offsetWidth, h: span.offsetHeight };
  }

  const present = [];
  for (const font of FONT_PROBES) {
    let detected = false;
    for (const base of baseFonts) {
      span.style.fontFamily = `'${font}',${base}`;
      if (span.offsetWidth !== baseline[base].w || span.offsetHeight !== baseline[base].h) {
        detected = true;
        break;
      }
    }
    if (detected) present.push(font);
  }
  body.removeChild(span);
  return { present, probed: FONT_PROBES.length };
}

/** Maths quirks: some engines compute transcendental functions to different last bits. */
function collectMathFingerprint() {
  const values = [
    Math.tan(-1e300),
    Math.sin(1e10),
    Math.cos(1e13),
    Math.acos(0.123456789),
    Math.atanh(0.5),
    Math.sinh(1),
    Math.expm1(1),
    Math.cbrt(100),
  ];
  return { hash: fnv1a(values.join(',')) };
}

/** The public IP address and coarse location — the one signal fetched from a server. */
async function collectNetwork() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IP_TIMEOUT_MS);
  try {
    const response = await fetch(IP_ENDPOINT, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) return { error: `http-${response.status}` };
    const data = await response.json();
    return {
      ip: data.ip || '',
      version: data.version || '',
      city: data.city || '',
      region: data.region || '',
      country: data.country_name || data.country || '',
      countryCode: data.country_code || '',
      postal: data.postal || '',
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      timezone: data.timezone || '',
      org: data.org || '',
      asn: data.asn || '',
    };
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'timeout' : 'network-failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get (or mint and persist) the durable visitor identity: the fingerprint-derived
 * id, when this browser was first seen, and how many times it has visited.
 */
function loadIdentity() {
  const stored = store.get(IDENTITY_KEY, null);
  if (stored && typeof stored.id === 'string') return stored;
  return null;
}

/* ─────────────────────────────── public API ────────────────────────────── */

export const profile = {
  /**
   * Build the full profile. `network: true` adds the IP/geolocation lookup (the
   * one external request); leave it off for a purely local fingerprint.
   *
   * Resolves with the profile object, which is also cached for `snapshot()` and
   * persisted so the panel survives a reload. Never rejects.
   */
  async collect({ network = false } = {}) {
    const [audio] = await Promise.all([collectAudioFingerprint()]);

    const canvas = safe(collectCanvasFingerprint, {});
    const webgl = safe(collectWebglFingerprint, {});
    const fonts = safe(collectFonts, { present: [] });
    const mathFp = safe(collectMathFingerprint, {});
    const screen = collectScreen();
    const nav = collectNavigator();
    const time = collectTime();

    // The stable id is built ONLY from components that do not change when the
    // visitor resizes the window, switches theme, or moves between networks —
    // GPU, canvas, audio, fonts, screen, timezone, languages and core hardware.
    // That is what lets it recognise the same browser on a later visit.
    const stableSeed = JSON.stringify({
      canvas: canvas.hash,
      webgl: webgl.hash || webgl.unmaskedRenderer,
      audio: audio.hash,
      fonts: fonts.present,
      math: mathFp.hash,
      screen: [screen.width, screen.height, screen.colorDepth, screen.devicePixelRatio],
      tz: time.timezone,
      langs: nav.languages,
      cores: nav.hardwareConcurrency,
      memory: nav.deviceMemoryGB,
      platform: nav.platform,
    });
    const visitorId = await hashStable(stableSeed);

    // Durable identity: first-seen and a visit counter, persisted across visits.
    const prior = loadIdentity();
    const identity = prior && prior.id === visitorId
      ? { id: visitorId, firstSeen: prior.firstSeen, visits: (prior.visits || 0) + 1 }
      : { id: visitorId, firstSeen: prior?.firstSeen || time.iso, visits: (prior?.visits || 0) + 1 };
    store.set(IDENTITY_KEY, identity);

    const result = {
      collectedAt: time.iso,
      visitorId,
      identity,
      time,
      navigator: nav,
      screen,
      viewport: collectViewport(),
      connection: collectConnection(),
      capabilities: collectCapabilities(),
      preferences: collectPreferences(),
      fingerprints: {
        canvas,
        webgl,
        audio,
        fonts,
        math: mathFp,
      },
      network: network ? await collectNetwork() : { skipped: true },
    };

    lastProfile = result;
    // Persist a copy so the panel can render immediately on the next visit,
    // before a fresh collect() finishes. It stays in this browser.
    store.set(SNAPSHOT_KEY, result);
    return result;
  },

  /** The most recent profile — from this session, or the persisted copy, or null. */
  snapshot() {
    return lastProfile || store.get(SNAPSHOT_KEY, null);
  },

  /** The durable identity without recomputing the whole profile. */
  identity() {
    return loadIdentity();
  },

  /**
   * Point the transport seam at a backend. Once set, `flush()` POSTs there.
   * Passing null (the default state) leaves flush() a local no-op.
   */
  configureTransport({ endpoint } = {}) {
    transportEndpoint = typeof endpoint === 'string' && endpoint ? endpoint : null;
  },

  /**
   * The export seam for a future backend. Bundles the current profile and any
   * events the caller passes, and — only if an endpoint has been configured —
   * sends it with `sendBeacon` (falling back to `fetch`). With no endpoint it
   * returns the payload and sends nothing, which is the shipped state today.
   *
   * Returns `{ sent, endpoint, payload }` so the caller can show what happened.
   */
  async flush({ events = [] } = {}) {
    const payload = {
      format: 'wb-profile',
      version: 1,
      sentAt: new Date().toISOString(),
      profile: profile.snapshot(),
      events,
    };
    if (!transportEndpoint) {
      return { sent: false, endpoint: null, payload };
    }
    const body = JSON.stringify(payload);
    let sent = false;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        sent = navigator.sendBeacon(transportEndpoint, new Blob([body], { type: 'application/json' }));
      }
      if (!sent) {
        await fetch(transportEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        });
        sent = true;
      }
    } catch {
      sent = false;
    }
    return { sent, endpoint: transportEndpoint, payload };
  },

  /** Forget the stored profile and durable identity. The visitor's erase button. */
  clear() {
    lastProfile = null;
    store.remove(SNAPSHOT_KEY);
    store.remove(IDENTITY_KEY);
  },
};
