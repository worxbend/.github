/**
 * fx/cosmos.js — the three.js sky, and the constellation graphic drawn on top of it.
 *
 * WHAT THIS IS
 * ------------
 * One WebGL canvas holding four layers, painted back to front:
 *
 *   1. nebula      a single large plane running a small noise shader, drifting slowly
 *   2. far stars   a few thousand very small, very dim points
 *   3. near stars  fewer, larger, brighter points blended additively
 *   4. constellation  the actual information graphic: one point per repository, joined by
 *                     lines to the other repositories in the same cluster
 *
 * Only layer 4 carries meaning. Layers 1-3 are the ground it is read against, so they are
 * deliberately quiet and are never hit-tested by the pointer.
 *
 * WHY THE SKY IS ALWAYS THE SAME
 * ------------------------------
 * Positions come from a seeded pseudo-random number generator (a "PRNG" — a function that
 * produces a fixed, repeatable sequence of numbers that only look random). `Math.random()` is
 * never used, because a visitor who returns tomorrow must find the same stars in the same
 * places; a layout that reshuffles on every load would be decoration, not a diagram.
 *
 * WHY IT NEVER TAKES THE PAGE DOWN
 * --------------------------------
 * three.js arrives from a content delivery network (a CDN — someone else's server) through an
 * import map declared in the HTML. That can fail: the network is down, the CDN is blocked, the
 * browser has no WebGL at all. Every one of those paths ends with `mountCosmos` returning
 * `null` instead of throwing, and the page falls back to the CSS-only starfield.
 *
 * WHY THERE IS NO requestAnimationFrame HERE
 * ------------------------------------------
 * The whole page shares one frame loop, in `core/motion.js`. This module registers a callback
 * with `motion.add()` and unregisters it in `dispose()`. A second loop would double the wake-ups
 * a laptop battery pays for and would keep running after the canvas scrolled away.
 */

import * as THREE from 'three';
import { motion } from '../core/motion.js';

/* ------------------------------------------------------------------------------------------ */
/* Tuning constants                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** Field of view in degrees. Narrow enough that parallax reads as depth, not as a fisheye. */
const FOV = 55;

/** Radius of the imaginary sphere the repository nodes are laid out on, in scene units. */
const SPHERE_RADIUS = 46;

/** Resting camera distance from the origin. */
const CAMERA_Z = 118;

/** How far scrolling the page pushes the camera forward, in scene units. */
const DOLLY_RANGE = 26;

/** Pointer parallax amplitude, in scene units, at the edge of the canvas. */
const PARALLAX_X = 9;
const PARALLAX_Y = 5.5;

/** How fast damped values chase their targets. Higher is snappier; this is a gentle drift. */
const POINTER_DAMPING = 3.4;
const SCROLL_DAMPING = 4.5;

/** Duration of the `focus(id)` camera move, in milliseconds. */
const FOCUS_MS = 700;

/** Duration of a `setPalette()` colour cross-fade, in milliseconds. */
const PALETTE_MS = 400;

/** How long a burst of resize notifications must go quiet before the canvas is actually resized. */
const RESIZE_DEBOUNCE_MS = 120;

/** Distance from the camera to the nebula plane. It is parented to the camera, so this is fixed. */
const NEBULA_DISTANCE = 260;

/** Upper bound on how many nodes are laid out, so a bad data file cannot stall the main thread. */
const MAX_NODES = 800;

/**
 * Per-quality-level budgets.
 *
 * `pixelRatio` caps how many device pixels are drawn per CSS pixel. On a "retina" screen the
 * device pixel ratio is 2, which means four times the pixels of a 1 — the single biggest lever
 * on how much work the graphics card does.
 *
 * `nebula: false` at low quality removes the full-screen shader entirely, which is the other
 * expensive thing on the page.
 */
const QUALITY_LEVELS = {
  high: { pixelRatio: 2, farStars: 3200, nearStars: 520, nebula: true, antialias: true },
  medium: { pixelRatio: 1.5, farStars: 1800, nearStars: 320, nebula: true, antialias: false },
  low: { pixelRatio: 1, farStars: 700, nearStars: 140, nebula: false, antialias: false },
};

/**
 * The custom property each logical colour is read from when the caller's palette is missing a
 * value or hands over something unparseable.
 *
 * There is deliberately no table of hex values here. SPEC.md §5 makes tokens.css the only file in
 * the project that knows a colour literal, and a copy kept in JavaScript would be a third one —
 * the token block and the no-attribute fallback block already hold two — so the day an accent is
 * retuned for contrast (which tokens.css records having already happened once for the light
 * theme) the sky would quietly keep painting the old one. Reading the live token instead means
 * the fallback cannot go stale, and it costs one `getComputedStyle` call on a path that only runs
 * when something has already gone wrong.
 */
const SCENE_TOKENS = {
  starA: '--scene-star-a',
  starB: '--scene-star-b',
  starC: '--scene-star-c',
  fog: '--scene-fog',
  link: '--scene-link',
};

/** Last resort if even the token is unset: mid-grey, so the layer is visible but obviously wrong. */
const UNSET_COLOR = 0x808080;

function colorFromToken(key) {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(SCENE_TOKENS[key]);
    const parsed = parseColorString(raw);
    if (parsed) return parsed;
  } catch {
    // getComputedStyle can throw in a detached document; fall through to the last resort.
  }
  return new THREE.Color(UNSET_COLOR);
}

/**
 * The palette object is assembled in `ui/app.js` from `getComputedStyle`, and its key names are
 * that module's decision. Accept several plausible spellings of each token rather than failing
 * hard if the other side writes `sceneStarA` or passes the raw custom-property name.
 */
const PALETTE_ALIASES = {
  starA: ['starA', 'star-a', 'sceneStarA', '--scene-star-a'],
  starB: ['starB', 'star-b', 'sceneStarB', '--scene-star-b'],
  starC: ['starC', 'star-c', 'sceneStarC', '--scene-star-c'],
  fog: ['fog', 'sceneFog', '--scene-fog'],
  link: ['link', 'sceneLink', '--scene-link'],
};

/* ------------------------------------------------------------------------------------------ */
/* Small pure helpers                                                                           */
/* ------------------------------------------------------------------------------------------ */

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

/** Ease-out cubic: fast at the start, settling gently at the end. Used for every camera move. */
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * FNV-1a, a tiny well-known string hash. It turns a repository id into a 32-bit number that can
 * seed the PRNG below, which is how each node gets its own stable, order-independent position:
 * reordering the data file must not move the stars.
 */
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32 — a seeded PRNG in five lines. Given the same seed it always produces the same
 * sequence of numbers in the range 0 (inclusive) to 1 (exclusive), which is exactly what a
 * repeatable star layout needs.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Only accept colour strings three.js is guaranteed to understand, so it never logs a warning. */
const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;

function parseColorString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!COLOR_PATTERN.test(trimmed)) return null;
  try {
    return new THREE.Color(trimmed);
  } catch {
    return null;
  }
}

/** Read one logical colour out of whatever shape the caller's palette object happens to have. */
function pickPaletteColor(palette, key) {
  if (palette && typeof palette === 'object') {
    for (const name of PALETTE_ALIASES[key]) {
      const parsed = parseColorString(palette[name]);
      if (parsed) return parsed;
    }
  }
  return colorFromToken(key);
}

function readPalette(palette) {
  return {
    starA: pickPaletteColor(palette, 'starA'),
    starB: pickPaletteColor(palette, 'starB'),
    starC: pickPaletteColor(palette, 'starC'),
    fog: pickPaletteColor(palette, 'fog'),
    link: pickPaletteColor(palette, 'link'),
  };
}

function normalizeQuality(value) {
  return Object.prototype.hasOwnProperty.call(QUALITY_LEVELS, value) ? value : 'high';
}

/**
 * Is WebGL usable at all?
 *
 * `getContext` returns `null` rather than throwing when the browser cannot give out a 3D context
 * (no graphics driver, too many live contexts on the page, WebGL disabled in settings). Probing on
 * a throwaway canvas means the real canvas is left untouched for the CSS fallback, and the probe
 * context is handed straight back so it does not occupy one of the browser's limited slots.
 */
function supportsWebGL() {
  try {
    const probe = document.createElement('canvas');
    const gl =
      probe.getContext('webgl2') || probe.getContext('webgl') || probe.getContext('experimental-webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * three.js draws in linear light and converts to the screen's colour space in the last line of
 * each built-in shader. Custom shaders have to ask for that conversion themselves, otherwise
 * every colour comes out noticeably dark. The name of the shader chunk that does it changed
 * across three.js releases, so detect which one this build has instead of guessing.
 */
const COLORSPACE_CHUNK = (() => {
  const chunks = (THREE && THREE.ShaderChunk) || {};
  if (chunks.colorspace_fragment) return '#include <colorspace_fragment>';
  if (chunks.encodings_fragment) return '#include <encodings_fragment>';
  return '';
})();

/* ------------------------------------------------------------------------------------------ */
/* Shaders                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * Starfield points.
 *
 * `gl_PointSize` is measured in device pixels, so a point of a fixed size would stay the same on
 * screen no matter how far away it is — which reads as flat. Dividing by the view-space depth
 * makes `aSize` behave like a real diameter in scene units instead, so distant stars shrink.
 * `uPixelScale` converts scene units to device pixels and is recomputed on every resize.
 *
 * Each star carries its own `aMix` (where it sits between the two palette star colours) and
 * `aBright` (a brightness jitter). Keeping the two colours as uniforms rather than baking them
 * into a colour buffer is what makes a theme change cost two uniform writes instead of rewriting
 * thousands of floats every frame of the cross-fade.
 */
const STAR_VERTEX_SHADER = `
attribute float aSize;
attribute float aMix;
attribute float aBright;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uPixelScale;
varying vec3 vColor;

void main() {
  vColor = mix(uColorA, uColorB, aMix) * aBright;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-viewPosition.z, 1.0);
  gl_PointSize = clamp(aSize * uPixelScale / depth, 1.0, 96.0);
  gl_Position = projectionMatrix * viewPosition;
}
`;

/**
 * Constellation nodes.
 *
 * These carry an explicit per-node colour, because that colour is *data* — it encodes the
 * repository's primary language — and so must not drift when the theme changes.
 */
const NODE_VERTEX_SHADER = `
attribute float aSize;
attribute vec3 aColor;
uniform float uPixelScale;
varying vec3 vColor;

void main() {
  vColor = aColor;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-viewPosition.z, 1.0);
  gl_PointSize = clamp(aSize * uPixelScale / depth, 2.0, 160.0);
  gl_Position = projectionMatrix * viewPosition;
}
`;

/**
 * Shared point fragment shader. `gl_PointCoord` is the position inside the square the graphics
 * card rasterises for a point, from (0,0) to (1,1) — sampling the soft round sprite with it is
 * what turns that square into a glow.
 */
const POINT_FRAGMENT_SHADER = `
uniform sampler2D uMap;
uniform float uOpacity;
varying vec3 vColor;

void main() {
  vec4 texel = texture2D(uMap, gl_PointCoord);
  float alpha = texel.a * uOpacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor, alpha);
  ${COLORSPACE_CHUNK}
}
`;

/** Constellation links: one colour for all of them, one alpha per vertex. */
const LINK_VERTEX_SHADER = `
attribute float aAlpha;
varying float vAlpha;

void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LINK_FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;

void main() {
  float alpha = vAlpha * uOpacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor, alpha);
  ${COLORSPACE_CHUNK}
}
`;

const NEBULA_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Nebula.
 *
 * This covers the entire viewport, so every line of it is paid for by every pixel on screen.
 * It uses *value noise*: hash the corners of a grid cell into four numbers and blend between
 * them. Stacking four of those at doubling frequencies ("octaves") gives cloud-like structure —
 * this is a fractal Brownian motion, "fbm", sum. No texture is fetched and no trigonometry runs,
 * which is what keeps it affordable full-screen.
 *
 * One extra noise sample warps the coordinates before the stack, which breaks up the grid
 * alignment that plain value noise otherwise shows. Total cost: five noise samples per pixel.
 */
const NEBULA_FRAGMENT_SHADER = `
varying vec2 vUv;
uniform float uTime;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uAspect;
uniform vec2 uOffset;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.56);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * valueNoise(p);
    p = p * 2.07 + vec2(19.3, 7.7);
    amplitude *= 0.5;
  }
  return sum;
}

void main() {
  vec2 centred = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec2 p = centred * 2.4 + uOffset;
  float t = uTime * 0.015;

  float warp = valueNoise(p * 0.7 + vec2(t, -t * 0.6));
  float n = fbm(p + warp * 0.6 + vec2(t * 0.3, t * 0.2));

  // Push most of the frame to zero so the nebula reads as a few drifting banks of fog rather
  // than an even haze over everything.
  n = smoothstep(0.44, 0.96, n);

  float vignette = 1.0 - smoothstep(0.30, 1.15, length(centred) * 2.0);
  float alpha = n * vignette * uOpacity;
  if (alpha < 0.002) discard;

  gl_FragColor = vec4(uColor * (0.55 + n * 0.9), alpha);
  ${COLORSPACE_CHUNK}
}
`;

/* ------------------------------------------------------------------------------------------ */
/* The soft round star sprite                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * Points are drawn as squares. Multiplying by a radial-gradient texture is what makes them round
 * and gives them a halo. Drawing it here on a 2D canvas, once, avoids shipping an image file and
 * avoids a per-pixel `length()`/`smoothstep()` in the fragment shader.
 */
function createStarSprite() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0.0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.18, 'rgba(255,255,255,0.92)');
  gradient.addColorStop(0.42, 'rgba(255,255,255,0.32)');
  gradient.addColorStop(0.72, 'rgba(255,255,255,0.07)');
  gradient.addColorStop(1.0, 'rgba(255,255,255,0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------------------------------------ */
/* Layout                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Keep only entries that can actually be drawn, and drop duplicate ids. */
function sanitizeNodes(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const node of input) {
    if (!node || typeof node !== 'object') continue;
    const id = typeof node.id === 'string' ? node.id : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      cluster: typeof node.cluster === 'string' && node.cluster ? node.cluster : 'labs',
      lang: typeof node.lang === 'string' ? node.lang : '',
      weight: Number.isFinite(node.weight) ? Math.max(0, node.weight) : 0,
      color: typeof node.color === 'string' ? node.color : null,
    });
    if (out.length >= MAX_NODES) break;
  }
  return out;
}

/**
 * Give every cluster its own patch of sky.
 *
 * The axes are spread with a Fibonacci sphere — walking down the sphere in even height steps
 * while turning by the golden angle each time. That distributes any number of clusters evenly
 * without the clumping a random draw would produce. The z component is then squashed so the
 * lobes fan out across the screen rather than lining up behind one another, which is what makes
 * the groups read as separate constellations from a camera that only moves a little.
 */
function clusterAxes(clusterIds, seedText) {
  const axes = new Map();
  const count = clusterIds.length || 1;
  const GOLDEN_ANGLE = 2.399963229728653;

  clusterIds.forEach((id, index) => {
    const height = 1 - (2 * index + 1) / count;
    const ring = Math.sqrt(Math.max(0, 1 - height * height));
    const theta = index * GOLDEN_ANGLE;

    // A small seeded nudge so two different seeds give visibly different skies, while the same
    // seed always gives the same one.
    const rand = mulberry32(hashString(`${seedText}|axis|${id}`));
    const wobble = (rand() - 0.5) * 0.24;

    const axis = new THREE.Vector3(
      ring * Math.cos(theta + wobble),
      ring * Math.sin(theta + wobble) * 0.78,
      height * 0.55,
    );
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
    axes.set(id, axis.normalize());
  });

  return axes;
}

/** Two unit vectors at right angles to `axis`, so a direction can be built around it. */
function basisAround(axis, out1, out2) {
  const seed = Math.abs(axis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  out1.set(seed.x, seed.y, seed.z).cross(axis).normalize();
  out2.copy(axis).cross(out1).normalize();
}

/**
 * Place one node inside its cluster's lobe.
 *
 * A cone around the cluster axis is sampled with the cosine trick — picking `cos(angle)`
 * uniformly instead of `angle` — which spreads nodes evenly over the cap of the sphere rather
 * than piling them up at the centre of the lobe.
 */
function placeNode(axis, rand, weightNorm, tangentA, tangentB, out) {
  const CONE = 0.52; // radians, roughly 30 degrees
  const cosMax = Math.cos(CONE);
  const cosAngle = 1 - rand() * (1 - cosMax);
  const sinAngle = Math.sqrt(Math.max(0, 1 - cosAngle * cosAngle));
  const phi = rand() * Math.PI * 2;

  out.copy(axis).multiplyScalar(cosAngle);
  out.addScaledVector(tangentA, sinAngle * Math.cos(phi));
  out.addScaledVector(tangentB, sinAngle * Math.sin(phi));

  // Heavier nodes sit slightly nearer the camera, so the important ones are also the closest.
  const radius = SPHERE_RADIUS * (0.68 + rand() * 0.34 - weightNorm * 0.08);
  out.multiplyScalar(radius);
  return out;
}

/**
 * Push overlapping nodes apart.
 *
 * Random placement inevitably drops two stars almost on top of each other, and two stars that
 * overlap cannot both be clicked. This is a handful of deterministic relaxation passes: for every
 * pair closer than `MIN_SEPARATION`, move both halfway out of the overlap. No randomness is
 * involved, so the result stays identical between visits.
 */
function relaxWithinCluster(positions, indices) {
  const MIN_SEPARATION = 4.6;
  const PASSES = 4;
  const delta = new THREE.Vector3();

  for (let pass = 0; pass < PASSES; pass += 1) {
    for (let a = 0; a < indices.length; a += 1) {
      for (let b = a + 1; b < indices.length; b += 1) {
        const ia = indices[a] * 3;
        const ib = indices[b] * 3;
        delta.set(
          positions[ib] - positions[ia],
          positions[ib + 1] - positions[ia + 1],
          positions[ib + 2] - positions[ia + 2],
        );
        const distance = delta.length();
        if (distance >= MIN_SEPARATION) continue;

        // Exactly coincident points have no direction to separate along, so invent one.
        if (distance < 1e-4) delta.set(0.5, 0.35, 0.2);
        const push = ((MIN_SEPARATION - distance) * 0.5) / Math.max(distance, 1e-4);

        positions[ia] -= delta.x * push;
        positions[ia + 1] -= delta.y * push;
        positions[ia + 2] -= delta.z * push;
        positions[ib] += delta.x * push;
        positions[ib + 1] += delta.y * push;
        positions[ib + 2] += delta.z * push;
      }
    }
  }
}

/**
 * Build every CPU-side buffer the constellation needs. This runs once per mount and is pure
 * arithmetic — no WebGL — so it survives a lost graphics context untouched.
 */
function buildLayout(nodes, seedText, palette) {
  const count = nodes.length;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const ids = new Array(count);
  const indexById = new Map();
  const fallbackColorIndices = [];

  // Normalise weight into 0..1 so node size does not depend on whether weights are stars,
  // percentages or anything else.
  let minWeight = Infinity;
  let maxWeight = -Infinity;
  for (const node of nodes) {
    if (node.weight < minWeight) minWeight = node.weight;
    if (node.weight > maxWeight) maxWeight = node.weight;
  }
  const weightSpan = maxWeight - minWeight;

  const byCluster = new Map();
  nodes.forEach((node, index) => {
    ids[index] = node.id;
    indexById.set(node.id, index);
    if (!byCluster.has(node.cluster)) byCluster.set(node.cluster, []);
    byCluster.get(node.cluster).push(index);
  });

  const clusterIds = [...byCluster.keys()].sort();
  const axes = clusterAxes(clusterIds, seedText);

  const tangentA = new THREE.Vector3();
  const tangentB = new THREE.Vector3();
  const point = new THREE.Vector3();
  const fallbackColor = palette.starB;

  for (const clusterId of clusterIds) {
    const axis = axes.get(clusterId);
    basisAround(axis, tangentA, tangentB);

    for (const index of byCluster.get(clusterId)) {
      const node = nodes[index];
      const weightNorm = weightSpan > 0 ? (node.weight - minWeight) / weightSpan : 0.5;

      // Seeding from the node id (not from its position in the array) is what keeps a star in
      // place when the catalog is reordered or another repository is added next to it.
      const rand = mulberry32(hashString(`${seedText}|node|${node.id}`));
      placeNode(axis, rand, weightNorm, tangentA, tangentB, point);

      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;

      // Size in scene units. The square root keeps a very popular repository from dwarfing the
      // rest of the sky the way a linear scale would.
      sizes[index] = 0.70 + 1.9 * Math.sqrt(weightNorm);

      const explicit = parseColorString(node.color);
      const colour = explicit || fallbackColor;
      if (!explicit) fallbackColorIndices.push(index);
      colors[index * 3] = colour.r;
      colors[index * 3 + 1] = colour.g;
      colors[index * 3 + 2] = colour.b;
    }
  }

  for (const clusterId of clusterIds) {
    relaxWithinCluster(positions, byCluster.get(clusterId));
  }

  const links = buildLinks(positions, byCluster);

  return {
    count,
    positions,
    sizes,
    baseSizes: Float32Array.from(sizes),
    colors,
    ids,
    indexById,
    fallbackColorIndices,
    linkPositions: links.positions,
    linkAlphas: links.alphas,
  };
}

/**
 * Join same-cluster neighbours.
 *
 * Every node is linked to its two nearest cluster-mates. Nearest-neighbour rather than
 * everything-to-everything is deliberate: a fully connected cluster of ten repositories is
 * forty-five lines and reads as a blob, while two links each traces a shape the eye can follow.
 * Pairs are de-duplicated, and a link longer than the cutoff is dropped rather than drawn
 * stretched across the sky.
 *
 * Alpha is per vertex and falls off with length, so short, tight links look solid and long ones
 * fade out instead of ending abruptly.
 */
function buildLinks(positions, byCluster) {
  const NEIGHBOURS = 2;
  const MAX_LENGTH = SPHERE_RADIUS * 0.62;
  const pairs = new Set();
  const segments = [];

  for (const indices of byCluster.values()) {
    if (indices.length < 2) continue;

    for (const index of indices) {
      const ax = positions[index * 3];
      const ay = positions[index * 3 + 1];
      const az = positions[index * 3 + 2];

      // Small clusters, so an O(n^2) scan per node is cheaper than building a spatial index.
      const candidates = [];
      for (const other of indices) {
        if (other === index) continue;
        const dx = positions[other * 3] - ax;
        const dy = positions[other * 3 + 1] - ay;
        const dz = positions[other * 3 + 2] - az;
        candidates.push({ other, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) });
      }
      // Tie-break on index so the same set of links comes out on every visit.
      candidates.sort((a, b) => a.distance - b.distance || a.other - b.other);

      for (let n = 0; n < Math.min(NEIGHBOURS, candidates.length); n += 1) {
        const { other, distance } = candidates[n];
        if (distance > MAX_LENGTH) continue;
        const key = index < other ? `${index}:${other}` : `${other}:${index}`;
        if (pairs.has(key)) continue;
        pairs.add(key);
        segments.push({ a: index, b: other, distance });
      }
    }
  }

  const linkPositions = new Float32Array(segments.length * 6);
  const linkAlphas = new Float32Array(segments.length * 2);

  segments.forEach((segment, i) => {
    const fade = clamp(1 - segment.distance / MAX_LENGTH, 0, 1);
    const alpha = 0.10 + 0.55 * Math.pow(fade, 1.4);

    for (let end = 0; end < 2; end += 1) {
      const node = end === 0 ? segment.a : segment.b;
      const at = i * 6 + end * 3;
      linkPositions[at] = positions[node * 3];
      linkPositions[at + 1] = positions[node * 3 + 1];
      linkPositions[at + 2] = positions[node * 3 + 2];
      linkAlphas[i * 2 + end] = alpha;
    }
  });

  return { positions: linkPositions, alphas: linkAlphas };
}

/** Starfield buffers for a spherical shell between `innerRadius` and `outerRadius`. */
function buildStarShell(count, innerRadius, outerRadius, minSize, maxSize, seedText) {
  const rand = mulberry32(hashString(seedText));
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const mixes = new Float32Array(count);
  const brights = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    // Uniform directions on a sphere: pick the height uniformly, then the angle around it.
    const height = rand() * 2 - 1;
    const ring = Math.sqrt(Math.max(0, 1 - height * height));
    const theta = rand() * Math.PI * 2;
    // Cube root of a uniform number spreads points evenly through the shell's volume rather than
    // bunching them against the inner surface.
    const radius = innerRadius + (outerRadius - innerRadius) * Math.cbrt(rand());

    positions[i * 3] = ring * Math.cos(theta) * radius;
    positions[i * 3 + 1] = height * radius;
    positions[i * 3 + 2] = ring * Math.sin(theta) * radius;

    sizes[i] = minSize + (maxSize - minSize) * Math.pow(rand(), 2.2);
    mixes[i] = rand();
    brights[i] = 0.55 + rand() * 0.45;
  }

  return { positions, sizes, mixes, brights };
}

function starGeometry(shell) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(shell.positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(shell.sizes, 1));
  geometry.setAttribute('aMix', new THREE.BufferAttribute(shell.mixes, 1));
  geometry.setAttribute('aBright', new THREE.BufferAttribute(shell.brights, 1));
  return geometry;
}

/* ------------------------------------------------------------------------------------------ */
/* mountCosmos                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Build the sky on `canvas`.
 *
 * @param {HTMLCanvasElement} canvas the target canvas; it must keep its size from CSS, because
 *   this module never writes to its style.
 * @param {object} [options]
 * @param {object} [options.palette] parsed `--scene-*` tokens: `{ starA, starB, starC, fog, link }`
 *   as `#rrggbb` strings. Missing or unreadable values fall back to the Foundation theme's.
 * @param {'high'|'medium'|'low'} [options.quality='high'] detail budget; anything else is treated
 *   as `'high'`.
 * @param {Array<{id:string,cluster?:string,lang?:string,weight?:number,color?:string}>} [options.nodes]
 *   the repositories to plot. `id` is required and must be unique; everything else has a default.
 * @param {string} [options.seed='worxbend'] changes the layout while keeping it repeatable.
 * @returns {Promise<{dispose,setPalette,setQuality,resize,focus}|null>} `null` when WebGL is
 *   unavailable — never a thrown error.
 */
export async function mountCosmos(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  if (typeof document === 'undefined') return null;
  if (!supportsWebGL()) return null;

  const seedText = typeof options.seed === 'string' && options.seed ? options.seed : 'worxbend';
  const nodes = sanitizeNodes(options.nodes);

  /* ---- persistent state (survives a lost graphics context) --------------------------------- */

  let disposed = false;
  let contextLost = false;
  let restoreAttempted = false;
  let needsRender = true;
  let frame = 0;
  let elapsed = 0;

  let quality = normalizeQuality(options.quality);
  const colors = readPalette(options.palette);
  const layout = buildLayout(nodes, seedText, colors);

  /** Colour cross-fade state, driven from the shared loop instead of its own timer. */
  const colorFade = { active: false, progress: 0, from: null, to: null };

  /** Damped pointer, in normalised device coordinates: -1..1 on each axis, (0,0) at the centre. */
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, ndcX: 0, ndcY: 0, inside: false, overCanvas: false };

  /** Damped scroll progress, 0 at the top of the document, 1 at the bottom. */
  const scroll = { value: 0, target: 0, range: 1, measuredAt: 0 };

  /** Where the camera sits and what it looks at, before parallax and dolly are added. */
  const cameraBase = new THREE.Vector3(0, 0, CAMERA_Z);
  const cameraAim = new THREE.Vector3(0, 0, 0);

  /** `focus(id)` tween. */
  const focusTween = {
    active: false,
    progress: 0,
    fromBase: new THREE.Vector3(),
    toBase: new THREE.Vector3(),
    fromAim: new THREE.Vector3(),
    toAim: new THREE.Vector3(),
  };

  let hoverIndex = -1;
  let hoverAmount = 0;
  const pressPoint = { x: 0, y: 0, valid: false };

  /* ---- graphics objects (rebuilt after a context loss) ------------------------------------- */

  let renderer = null;
  let scene = null;
  let camera = null;
  let sprite = null;
  let farStars = null;
  let nearStars = null;
  let nodePoints = null;
  let linkSegments = null;
  let nebula = null;
  let constellation = null;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const scratch = new THREE.Vector3();

  /** Everything the graphics card is holding for us, so `dispose()` can be exhaustive. */
  let owned = { geometries: [], materials: [], textures: [] };

  const track = (bucket, object) => {
    if (object) owned[bucket].push(object);
    return object;
  };

  /* ---- construction ------------------------------------------------------------------------ */

  function levels() {
    return QUALITY_LEVELS[quality];
  }

  function buildGraphics() {
    const level = levels();

    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: level.antialias,
      powerPreference: 'high-performance',
      // Refusing a slow context would leave integrated-graphics machines with no sky at all,
      // and the adaptive quality in motion.js already handles a slow machine gracefully.
      failIfMajorPerformanceCaveat: false,
    });

    // three.js does not throw when the context is missing on every build, so check directly.
    if (typeof renderer.getContext === 'function' && !renderer.getContext()) {
      throw new Error('no WebGL context');
    }

    renderer.setClearColor(0x000000, 0);
    if ('outputColorSpace' in renderer && THREE.SRGBColorSpace) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 900);
    camera.position.copy(cameraBase);
    // The nebula is parented to the camera, and a camera only updates its children's transforms
    // once it is itself part of the scene graph.
    scene.add(camera);

    sprite = track('textures', createStarSprite());
    // Every point in the scene is multiplied by this sprite, so without it nothing would be
    // visible at all. Failing here hands the page back to the CSS-only starfield, which is a
    // better outcome than an empty black rectangle.
    if (!sprite) throw new Error('no 2D context for the star sprite');

    buildStarfields();
    buildNebula();
    buildConstellation();

    pushColorsToMaterials();
    applyResize();
    needsRender = true;
  }

  function starMaterial({ opacity, additive }) {
    return track(
      'materials',
      new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: sprite },
          uOpacity: { value: opacity },
          uPixelScale: { value: 600 },
          uColorA: { value: new THREE.Color() },
          uColorB: { value: new THREE.Color() },
        },
        vertexShader: STAR_VERTEX_SHADER,
        fragmentShader: POINT_FRAGMENT_SHADER,
        transparent: true,
        // Stars never hide one another: writing depth would let a near star punch a hole in the
        // glow of the one behind it.
        depthWrite: false,
        depthTest: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      }),
    );
  }

  function buildStarfields() {
    const level = levels();

    const farShell = buildStarShell(level.farStars, 150, 300, 0.16, 0.44, `${seedText}|far`);
    farStars = new THREE.Points(track('geometries', starGeometry(farShell)), starMaterial({ opacity: 0.42, additive: false }));
    farStars.frustumCulled = false;
    farStars.renderOrder = 1;
    scene.add(farStars);

    const nearShell = buildStarShell(level.nearStars, 62, 140, 0.45, 1.5, `${seedText}|near`);
    nearStars = new THREE.Points(track('geometries', starGeometry(nearShell)), starMaterial({ opacity: 0.9, additive: true }));
    nearStars.frustumCulled = false;
    nearStars.renderOrder = 2;
    scene.add(nearStars);
  }

  /**
   * Swap a starfield's buffers for a different star count.
   *
   * How many stars there are is baked into the geometry, so changing it means a new geometry.
   * The old one is disposed and struck off the owned list in the same breath, otherwise
   * `dispose()` would later call `dispose()` on it a second time and the list would grow every
   * time the quality changed.
   */
  function replaceStarGeometry(points, shell) {
    const previous = points.geometry;
    points.geometry = track('geometries', starGeometry(shell));
    previous.dispose();
    owned.geometries = owned.geometries.filter((geometry) => geometry !== previous);
  }

  function buildNebula() {
    const material = track(
      'materials',
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color() },
          uOpacity: { value: 0.55 },
          uAspect: { value: 1 },
          uOffset: { value: new THREE.Vector2(0, 0) },
        },
        vertexShader: NEBULA_VERTEX_SHADER,
        fragmentShader: NEBULA_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );

    // A unit plane that gets scaled to fill the view on resize, so a window resize never needs a
    // new geometry.
    nebula = new THREE.Mesh(track('geometries', new THREE.PlaneGeometry(1, 1)), material);
    nebula.position.set(0, 0, -NEBULA_DISTANCE);
    nebula.renderOrder = 0;
    nebula.frustumCulled = false;
    if (levels().nebula) camera.add(nebula);
    else nebula.visible = false;
  }

  function buildConstellation() {
    constellation = new THREE.Group();
    scene.add(constellation);

    if (layout.count > 0) {
      const geometry = track('geometries', new THREE.BufferGeometry());
      geometry.setAttribute('position', new THREE.BufferAttribute(layout.positions, 3));
      geometry.setAttribute('aSize', new THREE.BufferAttribute(layout.sizes, 1));
      geometry.setAttribute('aColor', new THREE.BufferAttribute(layout.colors, 3));

      const material = track(
        'materials',
        new THREE.ShaderMaterial({
          uniforms: {
            uMap: { value: sprite },
            uOpacity: { value: 1 },
            uPixelScale: { value: 600 },
          },
          vertexShader: NODE_VERTEX_SHADER,
          fragmentShader: POINT_FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        }),
      );

      nodePoints = new THREE.Points(geometry, material);
      nodePoints.frustumCulled = false;
      nodePoints.renderOrder = 4;
      constellation.add(nodePoints);
    }

    if (layout.linkPositions.length > 0) {
      const geometry = track('geometries', new THREE.BufferGeometry());
      geometry.setAttribute('position', new THREE.BufferAttribute(layout.linkPositions, 3));
      geometry.setAttribute('aAlpha', new THREE.BufferAttribute(layout.linkAlphas, 1));

      const material = track(
        'materials',
        new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: new THREE.Color() },
            uOpacity: { value: 0.85 },
          },
          vertexShader: LINK_VERTEX_SHADER,
          fragmentShader: LINK_FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        }),
      );

      linkSegments = new THREE.LineSegments(geometry, material);
      linkSegments.frustumCulled = false;
      linkSegments.renderOrder = 3;
      constellation.add(linkSegments);
    }
  }

  /* ---- colours ----------------------------------------------------------------------------- */

  /** Copy the current colour values into every uniform and buffer that displays them. */
  function pushColorsToMaterials() {
    if (farStars) {
      // The far field is a single flat colour, so both ends of the mix are the same value.
      farStars.material.uniforms.uColorA.value.copy(colors.starC);
      farStars.material.uniforms.uColorB.value.copy(colors.starC);
    }
    if (nearStars) {
      nearStars.material.uniforms.uColorA.value.copy(colors.starA);
      nearStars.material.uniforms.uColorB.value.copy(colors.starB);
    }
    if (linkSegments) linkSegments.material.uniforms.uColor.value.copy(colors.link);
    if (nebula) nebula.material.uniforms.uColor.value.copy(colors.fog);

    // Nodes keep their own language colour. Only the ones that never had one follow the palette.
    if (nodePoints && layout.fallbackColorIndices.length > 0) {
      const attribute = nodePoints.geometry.getAttribute('aColor');
      for (const index of layout.fallbackColorIndices) {
        layout.colors[index * 3] = colors.starB.r;
        layout.colors[index * 3 + 1] = colors.starB.g;
        layout.colors[index * 3 + 2] = colors.starB.b;
      }
      attribute.needsUpdate = true;
    }
  }

  /* ---- sizing ------------------------------------------------------------------------------ */

  /**
   * Convert scene units to device pixels for the point shaders.
   *
   * A point `d` units across, `z` units from the camera, covers `d / (2 z tan(fov/2))` of the
   * viewport height. Multiplying by the height of the drawing buffer in pixels gives the value
   * `gl_PointSize` wants, and folding everything except `z` into one uniform keeps the vertex
   * shader down to a single divide.
   */
  function updatePixelScale(heightCss) {
    if (!renderer) return;
    const ratio = renderer.getPixelRatio();
    const heightDevice = Math.max(1, heightCss * ratio);
    const scale = (heightDevice * 0.5) / Math.tan(THREE.MathUtils.degToRad(FOV) * 0.5);
    if (farStars) farStars.material.uniforms.uPixelScale.value = scale;
    if (nearStars) nearStars.material.uniforms.uPixelScale.value = scale;
    if (nodePoints) nodePoints.material.uniforms.uPixelScale.value = scale;
  }

  function updateNebulaScale(aspect) {
    if (!nebula) return;
    const visibleHeight = 2 * NEBULA_DISTANCE * Math.tan(THREE.MathUtils.degToRad(FOV) * 0.5);
    // A little oversize, so the pointer parallax offset never drags an edge into view.
    nebula.scale.set(visibleHeight * aspect * 1.2, visibleHeight * 1.2, 1);
    nebula.material.uniforms.uAspect.value = aspect;
  }

  function measureScrollRange() {
    const doc = document.documentElement;
    scroll.range = Math.max(1, doc.scrollHeight - window.innerHeight);
    scroll.measuredAt = Date.now();
  }

  function applyResize() {
    if (disposed || !renderer || !camera) return;

    const width = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const height = Math.max(1, canvas.clientHeight || canvas.height || 1);
    const cap = levels().pixelRatio;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    // `false` leaves the canvas element's CSS size alone: the stylesheet owns the layout, this
    // module owns only the number of pixels drawn into it.
    renderer.setSize(width, height, false);

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    updatePixelScale(height);
    updateNebulaScale(camera.aspect);
    measureScrollRange();
    needsRender = true;
  }

  /* ---- input ------------------------------------------------------------------------------- */

  /**
   * Translate a pointer event into the two coordinate systems this module needs.
   *
   * Parallax follows the pointer wherever it is over the canvas, because the canvas usually sits
   * behind the whole page and the drift should track the pointer anyway. Hit-testing is stricter
   * and only runs when the canvas itself received the event: clicking a button that happens to
   * sit over a star must not also select the star.
   */
  function readPointer(event) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    pointer.inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    // Normalised device coordinates: the range WebGL and the raycaster expect, -1 to 1 with the
    // origin at the centre of the canvas and y pointing up.
    pointer.ndcX = x * 2 - 1;
    pointer.ndcY = -(y * 2 - 1);
    pointer.overCanvas = pointer.inside && event.target === canvas;
    return true;
  }

  function onPointerMove(event) {
    if (!readPointer(event)) return;

    if (pointer.inside) {
      pointer.targetX = clamp(pointer.ndcX, -1, 1);
      pointer.targetY = clamp(pointer.ndcY, -1, 1);
    } else {
      pointer.targetX = 0;
      pointer.targetY = 0;
      if (hoverIndex !== -1) setHover(-1);
    }
  }

  function onPointerLeaveWindow() {
    pointer.inside = false;
    pointer.overCanvas = false;
    pointer.targetX = 0;
    pointer.targetY = 0;
    if (hoverIndex !== -1) setHover(-1);
  }

  function onPointerDown(event) {
    pressPoint.x = event.clientX;
    pressPoint.y = event.clientY;
    pressPoint.valid = event.target === canvas;
    if (pressPoint.valid) readPointer(event);
  }

  function onPointerUp(event) {
    if (!pressPoint.valid) return;
    pressPoint.valid = false;

    // Ignore a press that turned into a drag — someone selecting text or panning the page did
    // not mean to pick a star.
    const moved = Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y);
    if (moved > 6) return;

    // A touch screen has no hover: the first this module hears about a finger is the tap itself,
    // so there may be no hovered star yet. Hit-test once, here, using the camera matrices the
    // last frame left behind.
    if (hoverIndex === -1) {
      readPointer(event);
      if (pointer.overCanvas) hitTest();
    }
    if (hoverIndex === -1) return;

    emit('star:select', { id: layout.ids[hoverIndex] });
  }

  function onScroll() {
    // `scrollHeight` forces the browser to recompute layout, so re-measure at most once a second
    // rather than on every scroll event.
    if (Date.now() - scroll.measuredAt > 1000) measureScrollRange();
    scroll.target = clamp((window.scrollY || window.pageYOffset || 0) / scroll.range, 0, 1);
  }

  function emit(type, detail) {
    canvas.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }

  function setHover(index) {
    if (index === hoverIndex) return;

    // Return the star that was hovered to its resting size straight away, so two enlarged stars
    // can never be on screen at once.
    if (hoverIndex !== -1 && nodePoints) {
      layout.sizes[hoverIndex] = layout.baseSizes[hoverIndex];
      nodePoints.geometry.getAttribute('aSize').needsUpdate = true;
    }

    hoverIndex = index;
    hoverAmount = 0;
    needsRender = true;
    emit('star:hover', { id: index === -1 ? null : layout.ids[index] });

    // A pointer cursor is the only affordance a canvas can offer, and it costs one style write.
    canvas.style.cursor = index === -1 ? '' : 'pointer';
  }

  /**
   * Hit-test the constellation.
   *
   * Only `nodePoints` is passed to the raycaster, so the starfields are never candidates however
   * close the pointer comes to them. The threshold is how far, in scene units, the ray may pass
   * from a point and still count as a hit — generous on purpose, because the smallest stars are
   * only a few pixels across and would otherwise be unclickable. Scaling it with camera distance
   * keeps that tolerance roughly constant in screen pixels as the scroll dolly moves in and out.
   */
  function hitTest() {
    if (!nodePoints || !camera) return;

    ndc.set(pointer.ndcX, pointer.ndcY);
    raycaster.params.Points.threshold = camera.position.distanceTo(cameraAim) * 0.024;
    raycaster.setFromCamera(ndc, camera);

    const hits = raycaster.intersectObject(nodePoints, false);
    if (hits.length === 0) {
      setHover(-1);
      return;
    }

    // The raycaster sorts by depth, but the star the pointer is closest to on screen is the one
    // the visitor means — pick the smallest miss distance instead.
    let best = hits[0];
    for (let i = 1; i < hits.length; i += 1) {
      if (hits[i].distanceToRay < best.distanceToRay) best = hits[i];
    }
    setHover(typeof best.index === 'number' ? best.index : -1);
  }

  /* ---- frame ------------------------------------------------------------------------------- */

  function update(dt, totalElapsed) {
    if (disposed || contextLost || !renderer) return;

    const reduced = !!(motion && motion.reduced);
    frame += 1;
    elapsed = totalElapsed;

    if (reduced) {
      // Reduced motion means the camera holds completely still: no pointer drift, and no dolly
      // either. Scroll-linked camera movement is one of the things that makes people motion-sick,
      // so it goes with the rest of the ambient animation rather than counting as interaction.
      pointer.x = 0;
      pointer.y = 0;
      scroll.value = 0;

      // A `focus(id)` call is a deliberate action — a keyboard selection, or opening a project
      // from the command palette — so the camera still has to end up looking at that star. What
      // reduced motion forbids is the seven-hundred-millisecond flight to get there. Landing the
      // tween on its target in one frame keeps the destination and drops the animation.
      //
      // This is what stops a pointer sweeping down the catalogue from swinging the sky
      // continuously: each card would otherwise start a fresh ease-out before the last finished.
      if (focusTween.active) {
        cameraBase.copy(focusTween.toBase);
        cameraAim.copy(focusTween.toAim);
        focusTween.progress = 1;
        focusTween.active = false;
        needsRender = true;
      }
    } else {
      // Exponential damping: the fraction of the remaining distance covered in this frame,
      // worked out from `dt` so the feel does not change with the frame rate. A plain
      // "move 10% of the way each frame" would drift twice as fast on a 120 Hz screen.
      const pointerK = 1 - Math.exp(-dt * POINTER_DAMPING);
      const scrollK = 1 - Math.exp(-dt * SCROLL_DAMPING);
      pointer.x += (pointer.targetX - pointer.x) * pointerK;
      pointer.y += (pointer.targetY - pointer.y) * pointerK;
      scroll.value += (scroll.target - scroll.value) * scrollK;
    }

    if (colorFade.active) {
      colorFade.progress = Math.min(1, colorFade.progress + (dt * 1000) / PALETTE_MS);
      const t = easeOut(colorFade.progress);
      for (const key of Object.keys(colors)) {
        colors[key].copy(colorFade.from[key]).lerp(colorFade.to[key], t);
      }
      pushColorsToMaterials();
      if (colorFade.progress >= 1) colorFade.active = false;
      needsRender = true;
    }

    if (focusTween.active) {
      focusTween.progress = Math.min(1, focusTween.progress + (dt * 1000) / FOCUS_MS);
      const t = easeOut(focusTween.progress);
      cameraBase.copy(focusTween.fromBase).lerp(focusTween.toBase, t);
      cameraAim.copy(focusTween.fromAim).lerp(focusTween.toAim, t);
      if (focusTween.progress >= 1) focusTween.active = false;
      needsRender = true;
    }

    // Hit-testing on every other frame is invisible to a visitor and halves the cost of the one
    // part of this module that touches JavaScript objects per node.
    if (nodePoints && pointer.overCanvas && frame % 2 === 0) hitTest();

    // Grow the hovered star over a few frames rather than snapping, so the feedback reads as a
    // response rather than a glitch.
    if (hoverIndex !== -1 && nodePoints) {
      const target = 1;
      if (hoverAmount < target - 0.001) {
        hoverAmount += (target - hoverAmount) * (1 - Math.exp(-dt * 12));
        layout.sizes[hoverIndex] = layout.baseSizes[hoverIndex] * (1 + 0.95 * hoverAmount);
        nodePoints.geometry.getAttribute('aSize').needsUpdate = true;
        needsRender = true;
      }
    }

    camera.position.set(
      cameraBase.x + pointer.x * PARALLAX_X,
      cameraBase.y + pointer.y * PARALLAX_Y,
      cameraBase.z - scroll.value * DOLLY_RANGE,
    );
    camera.lookAt(cameraAim);

    if (!reduced) {
      // The starfields turn very slowly, which is what stops the sky from looking like a
      // photograph. The constellation deliberately does not: it is a diagram, and a diagram that
      // drifts is one whose stars are harder to click.
      if (farStars) farStars.rotation.y = elapsed * 0.004;
      if (nearStars) nearStars.rotation.y = elapsed * 0.009;
      if (constellation) constellation.rotation.y = Math.sin(elapsed * 0.05) * 0.035;
      if (nebula && nebula.visible) {
        nebula.material.uniforms.uTime.value = elapsed;
        nebula.material.uniforms.uOffset.value.set(pointer.x * 0.06, pointer.y * 0.04);
      }
    }

    // With reduced motion in force nothing drifts, so redraw only when something actually
    // changed — a still frame costs nothing to leave on screen.
    if (reduced && !needsRender) return;

    renderer.render(scene, camera);
    needsRender = false;
  }

  /* ---- context loss ------------------------------------------------------------------------ */

  /**
   * The browser can take the graphics context away at any time — the machine went to sleep, the
   * driver reset, another tab asked for too much. Calling `preventDefault()` is what tells it we
   * intend to recover; without that call it never fires `webglcontextrestored`.
   */
  function onContextLost(event) {
    event.preventDefault();
    contextLost = true;
  }

  function onContextRestored() {
    if (disposed || restoreAttempted) return;
    // One attempt only. A context that keeps dying is a machine that cannot run this scene, and
    // retrying forever would make that worse rather than better.
    restoreAttempted = true;
    try {
      // The size buffer is reused by the rebuilt geometry, so hand back the enlarged size of
      // whatever was hovered when the context went away — otherwise that one star comes back
      // permanently swollen.
      if (hoverIndex !== -1) {
        layout.sizes[hoverIndex] = layout.baseSizes[hoverIndex];
        setHover(-1);
      }
      releaseGraphics({ forceLoss: false });
      buildGraphics();
      contextLost = false;
    } catch {
      contextLost = true;
    }
  }

  /* ---- teardown ---------------------------------------------------------------------------- */

  /**
   * Hand back everything the graphics card is holding.
   *
   * Geometries, materials and textures each own memory on the card that garbage collection
   * cannot reach, so each one needs an explicit `dispose()`. `forceContextLoss()` is the last
   * step: it releases the context itself, which browsers cap at roughly sixteen per page.
   */
  function releaseGraphics({ forceLoss }) {
    if (nebula && nebula.parent) nebula.parent.remove(nebula);
    if (constellation && constellation.parent) constellation.parent.remove(constellation);
    if (scene) {
      // Detach everything before disposing it, so nothing is left pointing at freed memory.
      for (const child of scene.children.slice()) scene.remove(child);
    }

    for (const geometry of owned.geometries) geometry.dispose();
    for (const material of owned.materials) material.dispose();
    for (const texture of owned.textures) texture.dispose();
    owned = { geometries: [], materials: [], textures: [] };

    if (renderer) {
      try {
        renderer.dispose();
        // Skipping this during a context restore matters: the context we would be throwing away
        // is the fresh one the browser has this moment handed back.
        if (forceLoss && typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
      } catch {
        // A renderer whose context has already gone can throw here; there is nothing left to fix.
      }
    }

    renderer = null;
    scene = null;
    camera = null;
    sprite = null;
    farStars = null;
    nearStars = null;
    nodePoints = null;
    linkSegments = null;
    nebula = null;
    constellation = null;
  }

  /* ---- wiring ------------------------------------------------------------------------------ */

  try {
    buildGraphics();
  } catch {
    releaseGraphics({ forceLoss: true });
    return null;
  }

  const pointerOptions = { passive: true };
  window.addEventListener('pointermove', onPointerMove, pointerOptions);
  window.addEventListener('pointerdown', onPointerDown, pointerOptions);
  window.addEventListener('pointerup', onPointerUp, pointerOptions);
  window.addEventListener('blur', onPointerLeaveWindow);
  window.addEventListener('scroll', onScroll, pointerOptions);
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  /**
   * A `ResizeObserver` watches the canvas element itself, which a `window` resize listener cannot
   * do: the canvas also changes size when a sidebar opens, when the layout reflows, or when the
   * mobile browser's address bar slides away. Debouncing matters because dragging a window edge
   * fires this continuously, and reallocating the drawing buffer on every one of those is what
   * makes a resize stutter.
   */
  let resizeTimer = 0;
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(applyResize, RESIZE_DEBOUNCE_MS);
        })
      : null;
  if (observer) observer.observe(canvas);

  onScroll();

  const removeFromLoop =
    motion && typeof motion.add === 'function' ? motion.add(update, { priority: -5 }) : null;

  /* ---- public surface ---------------------------------------------------------------------- */

  return {
    /**
     * Cross-fade every palette-driven colour to a new theme. Snapping would make a theme change
     * feel like a page reload; four hundred milliseconds reads as the same sky under new light.
     */
    setPalette(palette) {
      if (disposed) return;
      const next = readPalette(palette);
      colorFade.from = {};
      colorFade.to = {};
      for (const key of Object.keys(colors)) {
        colorFade.from[key] = colors[key].clone();
        colorFade.to[key] = next[key];
      }
      colorFade.progress = 0;
      colorFade.active = true;
      needsRender = true;
    },

    /**
     * Change the detail budget. Star counts are properties of the geometry, so the buffers are
     * rebuilt rather than partially drawn; the nebula is switched out of the scene graph entirely
     * at `'low'`, because a full-screen noise shader is the single most expensive thing here.
     */
    setQuality(next) {
      if (disposed) return;
      const normalized = normalizeQuality(next);
      if (normalized === quality) return;
      quality = normalized;
      if (!renderer || !scene) return;

      const level = levels();

      if (farStars) replaceStarGeometry(farStars, buildStarShell(level.farStars, 150, 300, 0.16, 0.44, `${seedText}|far`));
      if (nearStars) replaceStarGeometry(nearStars, buildStarShell(level.nearStars, 62, 140, 0.45, 1.5, `${seedText}|near`));

      if (nebula && camera) {
        nebula.visible = level.nebula;
        if (level.nebula && !nebula.parent) camera.add(nebula);
        if (!level.nebula && nebula.parent) nebula.parent.remove(nebula);
      }

      applyResize();
    },

    /** Re-read the canvas size now, without waiting for the debounce. */
    resize() {
      if (disposed) return;
      window.clearTimeout(resizeTimer);
      applyResize();
    },

    /**
     * Aim the camera at one repository over about seven hundred milliseconds, ease-out.
     *
     * The camera is placed in front of the star rather than on the line from the origin through
     * it, which keeps the rest of the sky in shot instead of flying through the middle of it.
     * Passing `null`, or an id that is not in the catalog, returns to the resting view.
     *
     * @returns {boolean} true when the id was found.
     */
    focus(id) {
      if (disposed) return false;

      focusTween.fromBase.copy(cameraBase);
      focusTween.fromAim.copy(cameraAim);

      const index = id == null ? undefined : layout.indexById.get(id);
      if (index === undefined || !nodePoints) {
        focusTween.toBase.set(0, 0, CAMERA_Z);
        focusTween.toAim.set(0, 0, 0);
      } else {
        scratch.fromBufferAttribute(nodePoints.geometry.getAttribute('position'), index);
        constellation.updateMatrixWorld();
        scratch.applyMatrix4(constellation.matrixWorld);
        focusTween.toAim.copy(scratch);
        focusTween.toBase.set(scratch.x, scratch.y, scratch.z + 62);
      }

      focusTween.progress = 0;
      focusTween.active = true;
      needsRender = true;
      return index !== undefined;
    },

    /**
     * Shut everything down. Safe to call twice — the second call finds `disposed` already set and
     * returns, which matters because a page teardown and a theme switch can both reach for it.
     */
    dispose() {
      if (disposed) return;
      disposed = true;

      if (removeFromLoop) removeFromLoop();

      window.removeEventListener('pointermove', onPointerMove, pointerOptions);
      window.removeEventListener('pointerdown', onPointerDown, pointerOptions);
      window.removeEventListener('pointerup', onPointerUp, pointerOptions);
      window.removeEventListener('blur', onPointerLeaveWindow);
      window.removeEventListener('scroll', onScroll, pointerOptions);
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      canvas.removeEventListener('webglcontextrestored', onContextRestored, false);

      if (observer) observer.disconnect();
      window.clearTimeout(resizeTimer);
      canvas.style.cursor = '';

      releaseGraphics({ forceLoss: true });
    },
  };
}

export default mountCosmos;
