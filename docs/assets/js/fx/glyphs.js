/**
 * fx/glyphs.js — the "signal" layer: matrix-style glyph rain, a vignette and CRT scanlines,
 * drawn with PixiJS onto its own lower canvas.
 *
 * Contract (see SPEC.md §4):
 *   mountGlyphs(canvas, { palette, intensity }) -> Promise<{ dispose, setPalette, setIntensity } | null>
 *
 * The whole layer is decoration. If anything at all goes wrong — the content delivery network
 * (CDN) that serves PixiJS is unreachable, the browser cannot give us a WebGL drawing context,
 * the canvas has no size — this module resolves to `null` and the page carries on without it.
 * Nothing here is allowed to throw into the caller.
 */

import { motion } from '../core/motion.js';

// PixiJS is imported *dynamically* rather than with a top-level `import * as PIXI from 'pixi.js'`.
// Both forms resolve through the same importmap entry, but a static import that fails to load
// takes this whole module down with it — the browser would never even run mountGlyphs. A dynamic
// import is an expression, so a network failure or a missing importmap entry lands in a catch
// block and we can return `null` the way the contract asks.
const loadPixi = () => import('pixi.js');

/* ------------------------------------------------------------------------------------------ */
/* Tunables. These are deliberately module constants: everything below reads them, and no code  */
/* path recomputes them, so the per-frame loop never has to ask "how big is a cell again?".     */
/* ------------------------------------------------------------------------------------------ */

/** Characters baked into the atlas: half-width katakana, a few Greek capitals, digits. */
const GLYPH_CHARS = (
  'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ' +
  'ΛΞΣΦΨΩΔΘ' +
  '0123456789'
).split('');

/** Atlas cells are square and generous so the glyph never touches its own edges. */
const ATLAS_CELL = 36;
const ATLAS_COLS = 10;
const ATLAS_FONT = 26;

/** On-screen cell size in CSS pixels. Columns are CELL_W apart, rows CELL_H apart. */
const CELL_W = 15;
const CELL_H = 20;

/** Longest possible trail. Each active column permanently owns this many pooled sprites. */
const TAIL_MAX = 16;
const TAIL_MIN = 6;

/** Hard ceiling on pooled sprites, so an ultrawide monitor at intensity 1 cannot run away. */
const MAX_SPRITES = 2400;

/** Rows travelled per second, per column. The spread is what makes the rain read as organic. */
const SPEED_MIN = 3.5;
const SPEED_MAX = 13;

/**
 * Chance per column, per frame, that one cell already on screen swaps to a different character.
 * Real matrix rain is mostly *stable* text that occasionally flickers; changing every cell every
 * frame turns it into noise that the eye reads as static rather than as falling glyphs.
 */
const SWAP_CHANCE = 0.14;

/** Scanlines only appear once the theme is genuinely leaning into the CRT look. */
const SCANLINE_FROM = 0.55;

/** Milliseconds to wait after the last resize event before rebuilding the column grid. */
const RESIZE_DEBOUNCE_MS = 120;

/* ------------------------------------------------------------------------------------------ */
/* Small helpers                                                                                */
/* ------------------------------------------------------------------------------------------ */

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Deterministic pseudo-random number generator (mulberry32). Seeded, so the rain looks the same
 * on every visit instead of reshuffling itself — the sky is meant to be a place, not a lottery.
 * It also keeps `Math.random` out of the frame loop, which the spec asks for elsewhere.
 */
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Turn a CSS colour string from the theme tokens into the 24-bit integer Pixi wants for `tint`.
 * The tokens are documented as `#rrggbb` hex, but `rgb()` is accepted too in case a browser
 * normalises the computed value. Returns `null` when the string is not understood, and callers
 * fall back to plain white — white means "no tint", never a hardcoded design colour.
 */
function parseColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  if (text[0] === '#') {
    const body = text.slice(1);
    if (body.length === 3) {
      const r = parseInt(body[0] + body[0], 16);
      const g = parseInt(body[1] + body[1], 16);
      const b = parseInt(body[2] + body[2], 16);
      if ([r, g, b].some(Number.isNaN)) return null;
      return (r << 16) | (g << 8) | b;
    }
    if (body.length >= 6) {
      const n = parseInt(body.slice(0, 6), 16);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }

  const parts = text.match(/-?\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))));
  return (r << 16) | (g << 8) | b;
}

/** Blend a colour toward white. Used to make the leading glyph of each column hotter. */
function brighten(color, amount) {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/**
 * The palette object comes from `getComputedStyle` in ui/app.js. Its exact key names are decided
 * over there, so read a few plausible spellings of the same token rather than failing hard if
 * the other side calls it `sceneGlyph` instead of `glyph`.
 */
function pickToken(palette, names) {
  if (!palette || typeof palette !== 'object') return null;
  for (const name of names) {
    const parsed = parseColor(palette[name]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* Offscreen canvases baked once at mount time                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Draw every glyph once onto a grid on a plain 2D canvas. That canvas becomes a single GPU
 * texture, and each character is then a cheap sub-rectangle ("frame") of it. This is the reason
 * the frame loop can change the character in a cell by assigning `sprite.texture` — no text
 * layout, no font rasterisation, no object creation while the page is running.
 *
 * Glyphs are drawn in white so that `sprite.tint` can recolour them for any theme later without
 * ever rebuilding the atlas.
 */
function drawAtlasCanvas() {
  const rows = Math.ceil(GLYPH_CHARS.length / ATLAS_COLS);
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * ATLAS_CELL;
  canvas.height = rows * ATLAS_CELL;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // The mono stack matches the site's data typeface. If the webfont has not finished loading
  // yet the browser substitutes a fallback, which is acceptable here: at the sizes and opacities
  // this layer runs at, the exact letterforms are not legible anyway.
  ctx.font = `${ATLAS_FONT}px "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';

  for (let i = 0; i < GLYPH_CHARS.length; i++) {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    ctx.fillText(GLYPH_CHARS[i], col * ATLAS_CELL + ATLAS_CELL / 2, row * ATLAS_CELL + ATLAS_CELL / 2);
  }

  return canvas;
}

/**
 * A radial gradient: transparent in the middle, opaque at the corners. Stretched over the whole
 * canvas and tinted dark, it pulls the eye back to the centre of the page and stops the rain
 * from colliding with the page edges. Generated at a small fixed size and scaled — a gradient
 * has no detail to lose.
 */
function drawVignetteCanvas() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size * 0.62);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.65, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  return canvas;
}

/** One repeating unit of the scanline pattern: four rows tall, one of them faintly inked. */
function drawScanlineCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 4;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(0, 2, 1, 1);

  return canvas;
}

/* ------------------------------------------------------------------------------------------ */
/* mountGlyphs                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * @param {HTMLCanvasElement} canvas   the lower of the two stacked canvases
 * @param {object}   [options]
 * @param {object}   [options.palette]    parsed `--scene-*` tokens; `glyph` is the one used here
 * @param {number}   [options.intensity]  0..1 — 0 is off, 0.12 is the default whisper, 1 is full
 * @returns {Promise<{dispose:Function,setPalette:Function,setIntensity:Function}|null>}
 */
export async function mountGlyphs(canvas, { palette = null, intensity = 0.12 } = {}) {
  if (!canvas || typeof canvas !== 'object' || !('getContext' in canvas)) return null;

  /* ---- state that exists whether or not the renderer was ever created ---------------------- */

  let disposed = false;
  let starting = false;          // an ensureRenderer() call is in flight
  let running = false;           // the per-frame callback is registered with motion
  let currentIntensity = clamp01(Number.isFinite(intensity) ? intensity : 0.12);
  let currentPalette = palette;

  let bodyTint = 0xffffff;
  let headTint = 0xffffff;
  let vignetteTint = 0x000000;
  let scanlineTint = 0xffffff;

  let PIXI = null;
  let app = null;
  let rainLayer = null;
  let vignetteSprite = null;
  let scanlineSprite = null;

  let atlasSource = null;        // the shared GPU texture behind every glyph frame
  let glyphTextures = [];        // one sub-texture per character
  let vignetteTexture = null;
  let scanlineTexture = null;

  /** @type {Array<import('pixi.js').Sprite>} */
  const sprites = [];
  /** Active columns. Index i owns pooled sprites [i * TAIL_MAX, i * TAIL_MAX + TAIL_MAX). */
  const columns = [];

  let viewWidth = 0;
  let viewHeight = 0;
  let rowCount = 0;

  const random = makeRandom(0x5eed_1a7e);

  let removeFrame = null;        // unsubscribe returned by motion.add
  let offReduced = null;         // unsubscribe returned by motion.onReducedChange, when it gives one
  let resizeObserver = null;
  let windowResizeBound = null;  // fallback listener, only when ResizeObserver is missing
  let resizeTimer = 0;

  let frameParity = 0;           // used to drop every other frame on low quality
  let carriedDt = 0;             // time from a dropped frame, handed to the next real one

  /* ---- palette ----------------------------------------------------------------------------- */

  function applyPalette() {
    const glyph = pickToken(currentPalette, ['glyph', 'sceneGlyph', '--scene-glyph']);
    const fog = pickToken(currentPalette, ['fog', 'sceneFog', '--scene-fog']);

    bodyTint = glyph === null ? 0xffffff : glyph;
    // The leading character of a column is the freshly "typed" one, so it burns brighter than
    // the trail behind it. Mixing toward white keeps the theme's hue while raising luminance.
    headTint = brighten(bodyTint, 0.62);
    // The vignette darkens, so it wants the theme's deep fog colour rather than its accent.
    vignetteTint = fog === null ? 0x000000 : fog;
    scanlineTint = bodyTint;

    if (vignetteSprite) vignetteSprite.tint = vignetteTint;
    if (scanlineSprite) scanlineSprite.tint = scanlineTint;
  }

  applyPalette();

  /* ---- intensity curves --------------------------------------------------------------------- */

  /** Fraction of the available columns that actually rain. */
  function densityFor(i) {
    return 0.08 + 0.87 * i;
  }

  /** Opacity of the whole rain layer. Deliberately steep so 0.12 is a hint, not a wall of green. */
  function layerAlphaFor(i) {
    return 0.09 + 0.86 * Math.pow(i, 1.45);
  }

  /* ---- column grid --------------------------------------------------------------------------- */

  function resetColumn(col, initial) {
    col.speed = SPEED_MIN + random() * (SPEED_MAX - SPEED_MIN);
    col.tail = TAIL_MIN + ((random() * (TAIL_MAX - TAIL_MIN + 1)) | 0);
    // Start above the top edge, at a random distance, so columns never march in lockstep.
    const lead = initial ? random() * (rowCount + TAIL_MAX) : random() * rowCount * 0.5;
    col.head = -lead - col.tail;
    col.row = Math.floor(col.head);
    col.cursor = 0;
    for (let k = 0; k < TAIL_MAX; k++) col.glyphs[k] = (random() * glyphTextures.length) | 0;
  }

  /**
   * Recompute how many columns fit and which of them are active. Called on mount, on resize and
   * whenever the intensity changes. It never touches the atlas — the characters are size-agnostic
   * because the sprites are scaled, not re-rasterised.
   */
  function layout() {
    if (!app || !rainLayer) return;

    const colSlots = Math.max(1, Math.ceil(viewWidth / CELL_W));
    rowCount = Math.max(1, Math.ceil(viewHeight / CELL_H));

    const wanted = Math.round(colSlots * densityFor(currentIntensity));
    const affordable = Math.floor(MAX_SPRITES / TAIL_MAX);
    const activeCount = Math.max(0, Math.min(colSlots, wanted, affordable));

    ensureSprites(activeCount * TAIL_MAX);

    // Grow or shrink the column list in place. Existing columns keep their state (and therefore
    // their sprites) across a resize, so a window drag does not restart the rain.
    while (columns.length > activeCount) columns.pop();
    while (columns.length < activeCount) {
      const col = { slot: 0, x: 0, head: 0, row: 0, speed: 0, tail: TAIL_MIN, cursor: 0, glyphs: new Uint16Array(TAIL_MAX) };
      resetColumn(col, true);
      columns.push(col);
    }

    // Spread the active columns evenly across the available slots, with a little jitter so the
    // spacing does not read as a printed pattern.
    const step = activeCount > 0 ? colSlots / activeCount : 1;
    for (let i = 0; i < activeCount; i++) {
      const jitter = (random() - 0.5) * step * 0.6;
      const slot = Math.max(0, Math.min(colSlots - 1, Math.round(i * step + jitter)));
      columns[i].slot = slot;
      columns[i].x = slot * CELL_W + CELL_W / 2;
      if (columns[i].row - columns[i].tail > rowCount) resetColumn(columns[i], true);
    }

    // Any sprite beyond the active columns' blocks is parked, not destroyed: growing the window
    // back out should not have to allocate again.
    for (let i = activeCount * TAIL_MAX; i < sprites.length; i++) sprites[i].visible = false;

    if (vignetteSprite) {
      vignetteSprite.width = viewWidth;
      vignetteSprite.height = viewHeight;
    }
    if (scanlineSprite) {
      scanlineSprite.width = viewWidth;
      scanlineSprite.height = viewHeight;
    }
    if (rainLayer) rainLayer.alpha = layerAlphaFor(currentIntensity);
    if (scanlineSprite) {
      scanlineSprite.visible = currentIntensity >= SCANLINE_FROM;
      scanlineSprite.alpha = clamp01((currentIntensity - SCANLINE_FROM) / (1 - SCANLINE_FROM)) * 0.45;
    }
  }

  /**
   * Make sure the pool holds at least `count` sprites. Allocation happens here and only here —
   * mount, resize and intensity changes — never inside the frame loop.
   */
  function ensureSprites(count) {
    const capped = Math.min(count, MAX_SPRITES);
    const scale = CELL_H / ATLAS_CELL;
    for (let i = sprites.length; i < capped; i++) {
      const sprite = new PIXI.Sprite(glyphTextures[i % glyphTextures.length]);
      sprite.anchor.set(0.5);
      sprite.scale.set(scale);
      sprite.visible = false;
      rainLayer.addChild(sprite);
      sprites.push(sprite);
    }
  }

  /* ---- the frame ------------------------------------------------------------------------------ */

  function frame(dt) {
    if (disposed || !app || currentIntensity <= 0) return;

    // Adaptive quality: on a struggling device draw half as often, but hand the skipped frame's
    // time to the next one so the rain falls at the same real-world speed, just less smoothly.
    if (motion && motion.quality === 'low') {
      frameParity ^= 1;
      if (frameParity === 1) {
        carriedDt += dt;
        return;
      }
      // motion promises callbacks a `dt` of at most 0.05 s; keep that promise after re-adding the
      // skipped frame, so a stall cannot teleport every column down the screen.
      dt = Math.min(dt + carriedDt, 0.05);
      carriedDt = 0;
    }

    const glyphCount = glyphTextures.length;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      col.head += col.speed * dt;

      // Every whole row the head advances, a brand new character enters at the leading edge.
      // The trail is a ring buffer, so "entering" is one array write, not a shift.
      const nextRow = Math.floor(col.head);
      let steps = nextRow - col.row;
      if (steps > TAIL_MAX) steps = TAIL_MAX; // after a long pause, do not spin thousands of times
      for (let s = 0; s < steps; s++) {
        col.cursor = (col.cursor + 1) % TAIL_MAX;
        col.glyphs[col.cursor] = (random() * glyphCount) | 0;
      }
      col.row = nextRow;

      // Occasionally mutate a character that is already on screen. This flicker is what makes
      // the layer read as live text rather than as a scrolling image.
      if (random() < SWAP_CHANCE) {
        const k = (random() * col.tail) | 0;
        const idx = (col.cursor - k + TAIL_MAX * 2) % TAIL_MAX;
        col.glyphs[idx] = (random() * glyphCount) | 0;
      }

      if (col.row - col.tail > rowCount) resetColumn(col, false);

      const base = i * TAIL_MAX;
      for (let k = 0; k < TAIL_MAX; k++) {
        const sprite = sprites[base + k];
        if (!sprite) break;

        if (k >= col.tail) {
          sprite.visible = false;
          continue;
        }

        const y = (col.head - k) * CELL_H;
        if (y < -CELL_H || y > viewHeight + CELL_H) {
          sprite.visible = false;
          continue;
        }

        const fade = 1 - k / col.tail;
        sprite.visible = true;
        sprite.x = col.x;
        sprite.y = y;
        sprite.texture = glyphTextures[col.glyphs[(col.cursor - k + TAIL_MAX * 2) % TAIL_MAX]];
        sprite.tint = k === 0 ? headTint : bodyTint;
        sprite.alpha = k === 0 ? 1 : fade * fade * 0.9;
      }
    }

    if (scanlineSprite && scanlineSprite.visible) {
      // A slow downward crawl of the scanlines; 4 is the pattern height, so it wraps seamlessly.
      scanlineSprite.tilePosition.y = (scanlineSprite.tilePosition.y + dt * 9) % 4;
    }

    try {
      app.render();
    } catch {
      // A lost WebGL context surfaces here. Stop rather than throwing once per frame forever.
      stopLoop();
    }
  }

  /* ---- start / stop --------------------------------------------------------------------------- */

  function startLoop() {
    if (disposed || running || !app) return;
    if (motion && motion.reduced) return;
    if (currentIntensity <= 0) return;
    if (!motion || typeof motion.add !== 'function') return;

    frameParity = 0;
    carriedDt = 0;
    if (rainLayer) rainLayer.visible = true;
    if (vignetteSprite) vignetteSprite.visible = true;
    // Negative priority keeps the background behind the foreground work in the shared rAF loop.
    removeFrame = motion.add(frame, { priority: -10 });
    running = true;
  }

  function stopLoop() {
    if (typeof removeFrame === 'function') removeFrame();
    removeFrame = null;
    running = false;
  }

  /** Stop animating and wipe the canvas, so a dormant layer leaves no ghost image behind. */
  function suspendAndClear() {
    stopLoop();
    if (!app) return;
    if (rainLayer) rainLayer.visible = false;
    if (vignetteSprite) vignetteSprite.visible = false;
    if (scanlineSprite) scanlineSprite.visible = false;
    try {
      app.render(); // one pass with an empty stage; backgroundAlpha 0 means it clears to nothing
    } catch {
      /* the context is gone; there is nothing left to clear */
    }
  }

  /* ---- sizing --------------------------------------------------------------------------------- */

  function measure() {
    // Prefer the element's laid-out size; fall back to its parent and then the viewport so that
    // a canvas which is still display:none at mount time does not end up zero-sized forever.
    let w = canvas.clientWidth;
    let h = canvas.clientHeight;
    if ((!w || !h) && canvas.parentElement) {
      const rect = canvas.parentElement.getBoundingClientRect();
      w = w || Math.round(rect.width);
      h = h || Math.round(rect.height);
    }
    if (!w) w = window.innerWidth || 1;
    if (!h) h = window.innerHeight || 1;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  function applySize() {
    if (disposed || !app || !app.renderer) return;
    const { w, h } = measure();
    if (w === viewWidth && h === viewHeight) return;
    viewWidth = w;
    viewHeight = h;
    try {
      app.renderer.resize(viewWidth, viewHeight);
    } catch {
      return;
    }
    layout();
    if (!running) {
      // Redraw once even while paused, so a resize during reduced-motion is not left stale.
      try {
        app.render();
      } catch {
        /* ignore — nothing to draw onto */
      }
    }
  }

  function scheduleResize() {
    if (disposed) return;
    clearTimeout(resizeTimer);
    // Debounced: a window drag fires dozens of events, and rebuilding the grid on each one would
    // do far more work than the redraw itself.
    resizeTimer = setTimeout(applySize, RESIZE_DEBOUNCE_MS);
  }

  /* ---- renderer creation (lazy) ---------------------------------------------------------------- */

  /**
   * Create the PixiJS application the first time the layer actually has something to do. Two
   * situations skip it entirely and therefore cost nothing at all: intensity 0 (the `solar`
   * theme) and reduced motion. Both can flip later, and this is what runs when they do.
   */
  async function ensureRenderer() {
    if (disposed || app || starting) return app;
    starting = true;
    try {
      PIXI = await loadPixi();

      const atlasCanvas = drawAtlasCanvas();
      if (!atlasCanvas) return null;

      const application = new PIXI.Application();
      const lowQuality = motion && motion.quality === 'low';
      const size = measure();

      await application.init({
        canvas,
        width: size.w,
        height: size.h,
        backgroundAlpha: 0,
        antialias: false,
        autoStart: false,          // motion.add owns the clock; Pixi's own ticker stays parked
        autoDensity: false,        // CSS sizes this canvas; Pixi must not write inline styles
        resolution: Math.min(window.devicePixelRatio || 1, lowQuality ? 1 : 1.5),
        powerPreference: 'low-power',
      });

      if (disposed) {
        // dispose() was called while init was still awaiting. Tear straight back down.
        try { application.destroy({ removeView: false }, { children: true, texture: true, textureSource: true }); } catch { /* already gone */ }
        return null;
      }
      if (!application.renderer) {
        try { application.destroy({ removeView: false }); } catch { /* nothing to destroy */ }
        return null;
      }

      app = application;
      if (app.ticker && typeof app.ticker.stop === 'function') app.ticker.stop();

      // One upload of the atlas, then one Texture per character pointing at a rectangle inside it.
      atlasSource = PIXI.Texture.from(atlasCanvas).source;
      glyphTextures = GLYPH_CHARS.map((_, i) => new PIXI.Texture({
        source: atlasSource,
        frame: new PIXI.Rectangle((i % ATLAS_COLS) * ATLAS_CELL, ((i / ATLAS_COLS) | 0) * ATLAS_CELL, ATLAS_CELL, ATLAS_CELL),
      }));

      rainLayer = new PIXI.Container();
      app.stage.addChild(rainLayer);

      const vignetteCanvas = drawVignetteCanvas();
      if (vignetteCanvas) {
        vignetteTexture = PIXI.Texture.from(vignetteCanvas);
        vignetteSprite = new PIXI.Sprite(vignetteTexture);
        vignetteSprite.alpha = 0.5;
        app.stage.addChild(vignetteSprite);
      }

      const scanlineCanvas = drawScanlineCanvas();
      if (scanlineCanvas) {
        scanlineTexture = PIXI.Texture.from(scanlineCanvas);
        scanlineSprite = new PIXI.TilingSprite({ texture: scanlineTexture, width: size.w, height: size.h });
        scanlineSprite.visible = false;
        app.stage.addChild(scanlineSprite);
      }

      applyPalette();
      viewWidth = 0;
      viewHeight = 0;
      applySize();
      return app;
    } catch {
      // Import failure, a rejected init, or no WebGL context. The page is fine without us.
      app = null;
      return null;
    } finally {
      starting = false;
    }
  }

  /* ---- reduced-motion handling ------------------------------------------------------------------ */

  function handleReducedChange(reduced) {
    if (disposed) return;
    const isReduced = typeof reduced === 'boolean' ? reduced : Boolean(motion && motion.reduced);
    if (isReduced) {
      suspendAndClear();
      return;
    }
    if (currentIntensity <= 0) return;
    void ensureRenderer().then(() => {
      if (!disposed && !(motion && motion.reduced) && currentIntensity > 0) {
        layout();
        startLoop();
      }
    });
  }

  if (motion && typeof motion.onReducedChange === 'function') {
    // Some implementations hand back an unsubscribe function; keep it if so, ignore it if not.
    offReduced = motion.onReducedChange(handleReducedChange);
  }

  /* ---- initial mount ------------------------------------------------------------------------------ */

  const shouldRunNow = currentIntensity > 0 && !(motion && motion.reduced);
  if (shouldRunNow) {
    const ready = await ensureRenderer();
    if (!ready) {
      // Nothing was created, but the reduced-motion subscription may exist. Clean it up and
      // report failure, exactly as the contract requires.
      if (typeof offReduced === 'function') offReduced();
      return null;
    }
    startLoop();
  }

  // The canvas may be resized by CSS at any time (orientation change, sidebar toggle, zoom).
  // ResizeObserver watches the element itself; the window listener is only a fallback for
  // browsers without it.
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(scheduleResize);
    try {
      resizeObserver.observe(canvas);
    } catch {
      resizeObserver = null;
    }
  }
  if (!resizeObserver) {
    windowResizeBound = scheduleResize;
    window.addEventListener('resize', windowResizeBound, { passive: true });
  }

  /* ---- public handle -------------------------------------------------------------------------------- */

  return {
    /** Recolour from the current theme's `--scene-*` tokens. Tints only — the atlas is untouched. */
    setPalette(next) {
      if (disposed) return;
      currentPalette = next || currentPalette;
      applyPalette();
      if (app && !running) {
        try { app.render(); } catch { /* nothing to draw onto */ }
      }
    },

    /**
     * Change how much rain there is. 0 stops the loop and clears the canvas outright, which is
     * what the `solar` theme uses; anything above 0 restarts it, creating the renderer on the
     * spot if this layer had never needed one.
     */
    setIntensity(next) {
      if (disposed) return;
      const value = clamp01(Number.isFinite(next) ? next : 0);
      // Nothing to do when the value is unchanged *and* the layer is already in the matching
      // state: either running, or at zero and therefore correctly cleared.
      if (value === currentIntensity && (running || value === 0)) return;
      currentIntensity = value;

      if (value <= 0) {
        suspendAndClear();
        return;
      }
      if (motion && motion.reduced) return;

      if (!app) {
        void ensureRenderer().then(() => {
          if (!disposed && app && currentIntensity > 0 && !(motion && motion.reduced)) {
            layout();
            startLoop();
          }
        });
        return;
      }
      layout();
      startLoop();
    },

    /** Idempotent teardown: every listener, timer, texture and GPU resource this layer created. */
    dispose() {
      if (disposed) return;
      disposed = true;

      stopLoop();
      clearTimeout(resizeTimer);

      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch { /* already disconnected */ }
        resizeObserver = null;
      }
      if (windowResizeBound) {
        window.removeEventListener('resize', windowResizeBound);
        windowResizeBound = null;
      }
      if (typeof offReduced === 'function') {
        try { offReduced(); } catch { /* the unsubscribe was optional anyway */ }
      }
      offReduced = null;

      sprites.length = 0;
      columns.length = 0;

      if (app) {
        try {
          // `removeView: false` leaves the <canvas> element in the document — the HTML author
          // owns it, not this module. The second argument destroys children plus their textures
          // and the underlying GPU texture sources, including the glyph atlas.
          app.destroy({ removeView: false }, { children: true, texture: true, textureSource: true });
        } catch {
          /* the renderer was already gone; there is nothing further to release */
        }
      }
      app = null;
      rainLayer = null;
      vignetteSprite = null;
      scanlineSprite = null;
      glyphTextures = [];
      atlasSource = null;
      vignetteTexture = null;
      scanlineTexture = null;
      PIXI = null;
    },
  };
}

export default mountGlyphs;
