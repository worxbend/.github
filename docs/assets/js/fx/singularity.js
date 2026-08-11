/**
 * fx/singularity.js — the hero's centrepiece: a three-dimensional cloud of a few thousand
 * particles that keeps becoming something else, drawn with three.js into the small canvas under
 * the hero's standfirst.
 *
 * Contract, matching the other effect layers (SPEC.md §4):
 *   mountSingularity(canvas, { palette }) -> Promise<{ dispose, setPalette } | null>
 *
 * The whole layer is decoration. If anything at all goes wrong — the content delivery network
 * serving three.js is unreachable, the browser cannot give us a WebGL context, the canvas has no
 * size — this module resolves to `null` and the page carries on; the container's CSS gradient is
 * what a visitor sees instead. Nothing here is allowed to throw into the caller.
 *
 * What it does
 * ------------
 * One particle cloud, four *forms*, and a slow perpetual cycle between them:
 *
 *   galaxy    a flat two-armed spiral, seen at a tilt — the site's own emblem
 *   knot      a trefoil torus knot, the classic "impossible" loop
 *   shell     a hollow sphere with the points spread evenly over it (a Fibonacci lattice)
 *   swarm     a swept sine ribbon, like a magnetic field caught mid-ripple
 *
 * Every particle owns one fixed slot in each form. The cycle holds a form for a few seconds,
 * then eases every particle simultaneously to its slot in the next one — six thousand
 * independent straight-line journeys that read as one object melting into another. Between and
 * during morphs the whole cloud rotates slowly and every particle breathes along its own seeded
 * phase, so the shape is never frozen even while it is "holding".
 *
 * The morph is deliberately computed on the CPU, one lerp per particle per frame, rather than in
 * a vertex shader: 6,000 × 3 floats is nothing per frame, it keeps every number inspectable, and
 * it avoids hand-written GLSL — the one part of a graphics library this project treats as too
 * version-fragile to own (the same rule glyphs.js follows with PixiJS).
 *
 * Everything is seeded, so the cloud is identical on every visit — like the sky behind it, it is
 * meant to be a place, not a lottery.
 */

import { motion } from '../core/motion.js';

// Dynamic for the same reason as in the other layers: a static import that fails to resolve
// takes this module down before mountSingularity() can run, and the failure must land in a
// catch so the contract's `null` can be returned.
const loadThree = () => import('three');

/** How many particles the cloud owns. Every form is built for exactly this many. */
const COUNT = 6000;

/** Seconds a form is held before the next morph begins. */
const HOLD_S = 6;

/** Seconds a morph takes. Long on purpose: the melt is the show, not the arrival. */
const MORPH_S = 3.2;

/** Radians per second of idle rotation around the vertical axis. */
const SPIN = 0.12;

/** Milliseconds to wait after the last resize before re-fitting the camera. */
const RESIZE_DEBOUNCE_MS = 150;

/** Deterministic pseudo-random generator (mulberry32), same as the other layers. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** '#8AB4FF' -> 0x8ab4ff, with a quiet fallback for a token that failed to resolve. */
function hexToNumber(hex, fallback) {
  const text = String(hex || '').trim().replace(/^#/, '');
  const full = text.length === 3 ? text.replace(/./g, (c) => c + c) : text;
  const n = Number.parseInt(full, 16);
  return Number.isFinite(n) && full.length === 6 ? n : fallback;
}

/** Smooth ease for the morph: starts gently, lands gently. */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

/* ------------------------------------------------------------------------------------------ */
/* The four forms. Each writes COUNT xyz triples into a Float32Array and returns it. The       */
/* coordinate space is roughly a unit ball; the camera is fitted to that, not to any one form. */
/* ------------------------------------------------------------------------------------------ */

/** A flat two-armed spiral galaxy with a bright, dense core and thinning arms. */
function formGalaxy(random) {
  const out = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i += 1) {
    const arm = i % 2 === 0 ? 0 : Math.PI;
    // Bias the radius toward the core, which is where a galaxy keeps most of its light.
    const r = random() ** 1.6;
    const angle = arm + r * 4.6 + (random() - 0.5) * 0.55;
    const spread = (1 - r) * 0.1 + 0.02;
    out[i * 3] = Math.cos(angle) * r;
    out[i * 3 + 1] = (random() - 0.5) * spread * 2.4;
    out[i * 3 + 2] = Math.sin(angle) * r;
  }
  return out;
}

/** A trefoil torus knot: the parametric curve, thickened into a tube by a random offset. */
function formKnot(random) {
  const out = new Float32Array(COUNT * 3);
  const p = 2;
  const q = 3;
  for (let i = 0; i < COUNT; i += 1) {
    const t = (i / COUNT) * Math.PI * 2;
    const r = Math.cos(q * t) + 2;
    const x = r * Math.cos(p * t);
    const y = r * Math.sin(p * t);
    const z = -Math.sin(q * t);
    // The tube: a small random offset around the curve, denser near its centre line.
    const tube = 0.22 * Math.sqrt(random());
    const jitter = random() * Math.PI * 2;
    out[i * 3] = (x + Math.cos(jitter) * tube) / 3.2;
    out[i * 3 + 1] = (z + Math.sin(jitter) * tube) / 3.2 * 1.4;
    out[i * 3 + 2] = (y + Math.cos(jitter * 1.7) * tube) / 3.2;
  }
  return out;
}

/** A hollow sphere, points spread evenly with the golden-angle (Fibonacci) lattice. */
function formShell(random) {
  const out = new Float32Array(COUNT * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < COUNT; i += 1) {
    const y = 1 - (i / (COUNT - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = golden * i;
    // Two nested shells rather than one, so the sphere has visible depth when it rotates.
    const shell = i % 5 === 0 ? 0.55 : 0.88;
    const wobble = 1 + (random() - 0.5) * 0.04;
    out[i * 3] = Math.cos(theta) * radius * shell * wobble;
    out[i * 3 + 1] = y * shell * wobble;
    out[i * 3 + 2] = Math.sin(theta) * radius * shell * wobble;
  }
  return out;
}

/** A wide sine ribbon — rows of particles swept into a travelling wave, like a caught field. */
function formSwarm(random) {
  const out = new Float32Array(COUNT * 3);
  const cols = 120;
  const rows = COUNT / cols;
  for (let i = 0; i < COUNT; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const u = col / (cols - 1);
    const v = row / (rows - 1);
    const x = (u - 0.5) * 2.2;
    const z = (v - 0.5) * 1.1;
    const y = Math.sin(u * Math.PI * 3 + v * 4) * 0.28 + Math.sin(v * Math.PI * 5) * 0.12;
    out[i * 3] = x + (random() - 0.5) * 0.02;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z + (random() - 0.5) * 0.02;
  }
  return out;
}

/**
 * The round sprite each particle is drawn with. Rendered once on a 2D canvas — a soft radial
 * falloff, so a particle reads as a glowing mote rather than a hard square (the default when a
 * points material has no map).
 */
function makeDotTexture(THREE) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const half = size / 2;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Write the per-particle colours for one palette into `attr`.
 *
 * Each particle blends between the palette's two glow colours by its position *in the galaxy
 * form* — core particles take the hotter colour, arm tips the cooler one — and roughly one in
 * eight is pushed toward white so the cloud sparkles instead of reading as one flat tint. Keyed
 * to the galaxy on purpose: colours must not change during a morph, and the galaxy is the form
 * the palette was designed against.
 */
function paintColors(THREE, attr, galaxy, palette, random) {
  const hot = new THREE.Color(hexToNumber(palette.glyph, 0x4c7dff));
  const cool = new THREE.Color(hexToNumber(palette.starB, 0x2b4a9e));
  const white = new THREE.Color(0xffffff);
  const c = new THREE.Color();
  for (let i = 0; i < COUNT; i += 1) {
    const x = galaxy[i * 3];
    const z = galaxy[i * 3 + 2];
    const r = Math.min(1, Math.hypot(x, z));
    c.copy(hot).lerp(cool, r);
    if (random() < 0.125) c.lerp(white, 0.75);
    attr.setXYZ(i, c.r, c.g, c.b);
  }
  attr.needsUpdate = true;
}

export async function mountSingularity(canvas, { palette } = {}) {
  if (!canvas || !canvas.parentElement) return null;

  let THREE;
  try {
    THREE = await loadThree();
  } catch {
    return null;
  }

  const host = canvas.parentElement;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false, // round sprites over additive blending; edges are never visible anyway
      powerPreference: 'low-power',
    });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 20);
  camera.position.set(0, 0.42, 1.95);
  camera.lookAt(0, 0, 0);

  const random = makeRandom(0x73696e67); // 'sing'
  const forms = [formGalaxy(random), formKnot(random), formShell(random), formSwarm(random)];

  // The per-particle breathing: a fixed phase and amplitude each, applied as a small radial
  // pulse on top of whatever the morph says. This is what keeps a "held" form alive.
  const phases = new Float32Array(COUNT);
  const pulses = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i += 1) {
    phases[i] = random() * Math.PI * 2;
    pulses[i] = 0.004 + random() * 0.012;
  }

  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(forms[0]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const colorAttr = new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3);
  geometry.setAttribute('color', colorAttr);

  // The colour stream is seeded separately from the geometry's, so a palette repaint later
  // (which replays it from the start) sparkles exactly the same particles it did the first time.
  paintColors(THREE, colorAttr, forms[0], palette || {}, makeRandom(0x636f6c72));

  const texture = makeDotTexture(THREE);
  const material = new THREE.PointsMaterial({
    size: 0.034,
    map: texture || undefined,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  // The resting tilt: enough that the galaxy is a disc seen from above-and-aside, not a line.
  points.rotation.x = 0.42;
  scene.add(points);

  // A second, far cheaper cloud behind the first: a few hundred dim stars scattered across the
  // whole band, so the wide margins either side of the morphing shape read as space rather than
  // as empty panel. It never morphs and only drifts with the same slow spin, at a fraction of
  // the rate, which is enough parallax to say "that is further away".
  const FIELD_COUNT = 420;
  const fieldGeometry = new THREE.BufferGeometry();
  const fieldPositions = new Float32Array(FIELD_COUNT * 3);
  for (let i = 0; i < FIELD_COUNT; i += 1) {
    fieldPositions[i * 3] = (random() - 0.5) * 6.5;
    fieldPositions[i * 3 + 1] = (random() - 0.5) * 2.4;
    fieldPositions[i * 3 + 2] = -0.6 - random() * 2.2;
  }
  fieldGeometry.setAttribute('position', new THREE.BufferAttribute(fieldPositions, 3));
  const fieldMaterial = new THREE.PointsMaterial({
    size: 0.02,
    map: texture || undefined,
    color: 0xffffff,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const field = new THREE.Points(fieldGeometry, fieldMaterial);
  scene.add(field);

  let width = 0;
  let height = 0;

  function layout() {
    const rect = host.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = 34 + Math.min(16, (width / height) * 2.2);
    camera.updateProjectionMatrix();
    // The layer covers the whole hero, and on a wide screen the hero's text owns the left half.
    // Pushing the cloud toward the empty right keeps it off the heading; on a narrow screen the
    // text runs the full width anyway, so the cloud sits centred behind it instead.
    const wide = width / height > 1.5;
    points.position.x = wide ? 0.68 : 0;
    field.position.x = wide ? 0.3 : 0;
    // The layer is far taller than the old band, and the cloud's size tracks the canvas height,
    // so unscaled it swallowed the statistics row. Held to a fraction of the stage, it reads as
    // an object *in* the hero rather than a weather system over it.
    points.scale.setScalar(wide ? 0.62 : 0.42);
    points.position.y = wide ? 0.08 : 0.52;
    // On a narrow screen the text runs the full width, so the cloud cannot move aside — it moves
    // up behind the heading and drops to half strength instead, glow rather than obstruction.
    material.opacity = wide ? 0.95 : 0.45;
    fieldMaterial.opacity = wide ? 0.35 : 0.2;
    baseScale = wide ? 0.62 : 0.42;
    baseOpacity = material.opacity;
    baseSize = material.size;
  }
  // The resting values the audio modulation multiplies. Owned by layout(), because they differ
  // between the wide and the narrow arrangement of the hero.
  let baseScale = 0.62;
  let baseOpacity = 0.95;
  let baseSize = material.size;
  layout();

  /**
   * The audio hook. When the page's soundtrack is playing, ui/app.js hands this layer a sampler —
   * a function returning `{ bass, mid, high }`, each 0..1, read from a WebAudio analyser — and
   * the cloud starts listening. `null` unhooks it and the cloud settles back to its resting size.
   *
   * The smoothing lives here, not in the sampler: a fast attack and a slow release per band, so a
   * kick drum snaps the cloud outward and lets it fall back gently — raw analyser values flicker
   * at frame rate and read as noise, not rhythm.
   */
  let audioSampler = null;
  const levels = { bass: 0, mid: 0, high: 0 };

  function follow(current, target, dt) {
    const rate = target > current ? 18 : 3.5;
    return current + (target - current) * Math.min(1, rate * dt);
  }

  let elapsed = 0;
  /** Extra spin the music has wound onto the cloud, accumulated so it never jumps backwards. */
  let audioSpin = 0;

  function frame(dt) {
    // Reduced motion holds the cloud still but keeps it painted: the visitor asked for less
    // movement, not for a blank rectangle. `elapsed` simply stops advancing.
    if (!motion.reduced) elapsed += dt;

    // Listen to the soundtrack, if one is playing. Reduced motion also mutes the *visual*
    // response — the audio keeps playing, but a visitor who asked for stillness gets stillness.
    if (audioSampler && !motion.reduced) {
      const sample = audioSampler();
      levels.bass = follow(levels.bass, sample.bass, dt);
      levels.mid = follow(levels.mid, sample.mid, dt);
      levels.high = follow(levels.high, sample.high, dt);
      audioSpin += dt * levels.mid * 0.9;
    } else if (levels.bass || levels.mid || levels.high) {
      levels.bass = follow(levels.bass, 0, dt);
      levels.mid = follow(levels.mid, 0, dt);
      levels.high = follow(levels.high, 0, dt);
    }

    // Where in the hold-morph-hold cycle are we, and between which two forms?
    const period = HOLD_S + MORPH_S;
    const cycle = elapsed / period;
    const step = Math.floor(cycle) % forms.length;
    const from = forms[step];
    const to = forms[(step + 1) % forms.length];
    const inCycle = (cycle - Math.floor(cycle)) * period;
    const mix = inCycle < HOLD_S ? 0 : easeInOutCubic((inCycle - HOLD_S) / MORPH_S);

    // Treble widens every particle's breath, so hats and rain texture shimmer through the
    // whole cloud rather than moving any one thing.
    const shimmer = 1 + levels.high * 2.6;
    for (let i = 0; i < COUNT; i += 1) {
      const j = i * 3;
      // The breath: a tiny radial pulse per particle, on top of the morph.
      const breathe = 1 + Math.sin(elapsed * 1.4 + phases[i]) * pulses[i] * shimmer;
      positions[j] = (from[j] + (to[j] - from[j]) * mix) * breathe;
      positions[j + 1] = (from[j + 1] + (to[j + 1] - from[j + 1]) * mix) * breathe;
      positions[j + 2] = (from[j + 2] + (to[j + 2] - from[j + 2]) * mix) * breathe;
    }
    geometry.attributes.position.needsUpdate = true;

    // The bass is the pulse of the whole object: the cloud swells on a kick and brightens with
    // it, the way the MagicalBoy-style visualisers breathe with their track.
    points.scale.setScalar(baseScale * (1 + levels.bass * 0.22));
    material.opacity = Math.min(1, baseOpacity * (1 + levels.bass * 0.35));
    material.size = baseSize * (1 + levels.bass * 0.4);

    // The mids drive momentum: melody speeds the rotation up, quiet lets it coast back down.
    points.rotation.y = elapsed * SPIN + audioSpin;
    field.rotation.y = (elapsed * SPIN + audioSpin) * 0.18;
    // A slow secondary sway, so the tilt itself is alive rather than bolted.
    points.rotation.x = 0.42 + Math.sin(elapsed * 0.21) * 0.07;

    renderer.render(scene, camera);
  }

  const removeFrame = motion.add(frame);

  let resizeTimer = 0;
  const onResize = () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(layout, RESIZE_DEBOUNCE_MS);
  };
  window.addEventListener('resize', onResize);

  // Paint the first frame immediately, so the cloud is there before the loop's first tick —
  // and stays there permanently if the visitor prefers reduced motion.
  frame(0);

  return {
    setPalette(next) {
      paintColors(THREE, colorAttr, forms[0], next || {}, makeRandom(0x636f6c72));
      frame(0);
    },
    /** Hook the cloud to a playing soundtrack, or pass null to let it settle. */
    setAudioSource(sampler) {
      audioSampler = typeof sampler === 'function' ? sampler : null;
    },
    dispose() {
      removeFrame();
      window.removeEventListener('resize', onResize);
      window.clearTimeout(resizeTimer);
      geometry.dispose();
      material.dispose();
      fieldGeometry.dispose();
      fieldMaterial.dispose();
      texture?.dispose();
      renderer.dispose();
    },
  };
}
