// Inverse-design search core (Node-requirable; also inlined into the worker AND the main thread).
//
// The map generator has no spatial-placement knobs: WHERE a biome lands is a chaotic function of
// the seed alone (see worldgen's balanceBiome — placement floods a terraced-noise priority field
// whose seed comes off the master RNG). So "reproduce this drawing" is a best-of-N seed lottery,
// not an optimization that converges. This module provides the machinery for that lottery:
//   - a compact "score class" space (11 classes) that both the painter and a generated map map into,
//   - a coarse rasterizer that turns generated polygons into a G x G class grid (a map "signature"),
//   - a wrap-invariant similarity score (the world tiles toroidally, so we compare under the best
//     cyclic shift), blending biome proportions, soft per-cell agreement, and land-shape IoU.
//
// Everything here is deterministic and dependency-free (reads only polygon geometry + biome names).

// ---- score classes -----------------------------------------------------------------------------
// A painter-friendly, generator-hittable subset. Steppe collapses to Grassland and HighDesert to
// Desert (they share rasterized colors in the game anyway); all coasts merge (thin auto-generated
// rings the user can't place precisely); DeepOcean+Ocean merge (shallow-vs-deep is automatic).
const SCLASS = ['Ocean', 'Coast', 'Grassland', 'WarmForest', 'ColdForest', 'RainForest', 'Desert', 'Taiga', 'Tundra', 'Ice', 'Wetland'];
const NUM_CLASSES = SCLASS.length;
const SC = {}; SCLASS.forEach((n, i) => { SC[n] = i; });

// Map a worldgen biome name (+ optional lake flag) to a score class.
const NAME_TO_CLASS = {
  DeepOcean: SC.Ocean, Ocean: SC.Ocean,
  Coast: SC.Coast, ColdCoast: SC.Coast, WarmCoast: SC.Coast,
  Grassland: SC.Grassland, Steppe: SC.Grassland,
  WarmForest: SC.WarmForest, ColdForest: SC.ColdForest, RainForest: SC.RainForest,
  Desert: SC.Desert, HighDesert: SC.Desert,
  Taiga: SC.Taiga, Tundra: SC.Tundra, Ice: SC.Ice, Wetland: SC.Wetland,
};
function classOfName(name, hasLake) {
  if (hasLake) return SC.Ocean;                 // lakes render as water
  const c = NAME_TO_CLASS[name];
  return c === undefined ? SC.Ocean : c;
}

// ---- class-similarity distance (0 = identical, 1 = maximally different) ------------------------
// Land biomes are embedded in a (temperature, moisture) plane so "close" biomes (the forests,
// grassland) get partial credit and "far" ones (desert vs ice) get almost none. Water/coast are
// handled specially. This makes the score forgiving of near-misses and intuitive as a percentage.
const EMB = {
  Grassland: [0.55, 0.45], WarmForest: [0.70, 0.60], ColdForest: [0.35, 0.55], RainForest: [0.80, 0.85],
  Desert: [0.85, 0.10], Taiga: [0.25, 0.50], Tundra: [0.15, 0.40], Ice: [0.02, 0.30], Wetland: [0.60, 0.95],
};
const DIST = (function () {
  const d = [];
  const isLand = c => c >= SC.Grassland;
  for (let a = 0; a < NUM_CLASSES; a++) {
    d.push(new Float32Array(NUM_CLASSES));
    for (let b = 0; b < NUM_CLASSES; b++) {
      if (a === b) { d[a][b] = 0; continue; }
      const an = SCLASS[a], bn = SCLASS[b];
      if (a === SC.Ocean || b === SC.Ocean) {
        // ocean vs coast is a near miss; ocean vs land is total
        d[a][b] = (a === SC.Coast || b === SC.Coast) ? 0.5 : 1.0;
      } else if (a === SC.Coast || b === SC.Coast) {
        d[a][b] = 0.7;                                   // coast vs land: mostly wrong but shoreline-adjacent
      } else if (isLand(a) && isLand(b)) {
        const pa = EMB[an], pb = EMB[bn];
        const dt = pa[0] - pb[0], dm = pa[1] - pb[1];
        d[a][b] = Math.min(1, Math.hypot(dt, dm) / 1.05);  // /~sqrt(2) so max spread ~1
      } else {
        d[a][b] = 1.0;
      }
    }
  }
  return d;
})();

// ---- coarse rasterizer: generated polygons -> G x G class grid ---------------------------------
// Fill polygons into an intermediate R x R grid (R chosen a few px per Voronoi cell), then
// majority-downsample to G x G. Scanline fill writes modulo R so the world wraps seamlessly.
function fillPolyR(pts, R, cid, grid) {
  const n = pts.length;
  if (n < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { const y = pts[i].y; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const yStart = Math.ceil(minY - 0.5), yEnd = Math.floor(maxY - 0.5);
  const xs = [];
  for (let yi = yStart; yi <= yEnd; yi++) {
    const sy = yi + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const y0 = pts[j].y, y1 = pts[i].y;
      if ((y0 <= sy && y1 > sy) || (y1 <= sy && y0 > sy)) {
        const t = (sy - y0) / (y1 - y0);
        xs.push(pts[j].x + t * (pts[i].x - pts[j].x));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const wy = ((yi % R) + R) % R;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xStart = Math.ceil(xs[k] - 0.5), xEnd = Math.floor(xs[k + 1] - 0.5);
      for (let xi = xStart; xi <= xEnd; xi++) {
        const wx = ((xi % R) + R) % R;
        grid[wy * R + wx] = cid;
      }
    }
  }
}

function rasterClassR(polys, worldSize, R) {
  const grid = new Uint8Array(R * R);   // 0 == Ocean, matching the server clearing biome map to ocean
  const sc = R / worldSize;
  const sp = [];
  for (let pi = 0; pi < polys.length; pi++) {
    const p = polys[pi];
    const cid = classOfName(p.biome.name, p.hasLake);
    const pts = p.points, n = pts.length;
    const cx = p.center.x * sc, cy = p.center.y * sc;
    sp.length = n;
    for (let i = 0; i < n; i++) {
      const x = pts[i].x * sc, y = pts[i].y * sc;
      const dx = x - cx, dy = y - cy, len = Math.hypot(dx, dy) || 1;
      sp[i] = { x: x + dx / len * 0.9, y: y + dy / len * 0.9 };   // fudge ~1px so cells overlap (no seam gaps)
    }
    fillPolyR(sp, R, cid, grid);
  }
  return grid;
}

function downsampleMajority(grid, R, G) {
  const out = new Uint8Array(G * G);
  const bs = R / G;
  const tally = new Int32Array(NUM_CLASSES);
  for (let gy = 0; gy < G; gy++) {
    const y0 = Math.floor(gy * bs), y1 = Math.max(y0 + 1, Math.min(R, Math.floor((gy + 1) * bs)));
    for (let gx = 0; gx < G; gx++) {
      const x0 = Math.floor(gx * bs), x1 = Math.max(x0 + 1, Math.min(R, Math.floor((gx + 1) * bs)));
      tally.fill(0);
      for (let y = y0; y < y1; y++) { const row = y * R; for (let x = x0; x < x1; x++) tally[grid[row + x]]++; }
      let best = 0, bc = -1;
      for (let c = 0; c < NUM_CLASSES; c++) if (tally[c] > bc) { bc = tally[c]; best = c; }
      out[gy * G + gx] = best;
    }
  }
  return out;
}

// Turn generated polygons into the G x G class-grid "signature" used for scoring & previews.
function classGridAt(polys, worldSize, G) {
  const R = Math.min(worldSize, Math.max(4 * G, 256));   // a few intermediate px per coarse cell
  return downsampleMajority(rasterClassR(polys, worldSize, R), R, G);
}

// ---- similarity scoring ------------------------------------------------------------------------
function histogram(grid) {
  const h = new Float64Array(NUM_CLASSES);
  for (let i = 0; i < grid.length; i++) h[grid[i]]++;
  const inv = grid.length ? 1 / grid.length : 0;
  for (let c = 0; c < NUM_CLASSES; c++) h[c] *= inv;
  return h;
}
function proportionScore(target, cand) {
  const ht = histogram(target), hc = histogram(cand);
  let tvd = 0; for (let c = 0; c < NUM_CLASSES; c++) tvd += Math.abs(ht[c] - hc[c]);
  return 1 - 0.5 * tvd;   // 1 - total-variation distance, in [0,1]
}
// mean class-distance between target and cand shifted by (sx,sy); lower is better
function meanDistAt(target, cand, G, sx, sy) {
  let sum = 0;
  for (let y = 0; y < G; y++) {
    const cyr = (((y + sy) % G) + G) % G;
    for (let x = 0; x < G; x++) {
      const cxr = (((x + sx) % G) + G) % G;
      sum += DIST[target[y * G + x]][cand[cyr * G + cxr]];
    }
  }
  return sum / (G * G);
}
// Best toroidal shift (minimizing mean class-distance) via a coarse full scan + local refine.
// A global scan is used (not a centroid seed) because a mostly-land map has no meaningful land
// centroid, so a local search would miss the true alignment. Cost is ~4M distance lookups at the
// designer's G=128 — trivial next to the ~1s it takes to generate the candidate being scored.
function bestShift(target, cand, G) {
  const stride = Math.max(1, Math.round(G / 16));   // ~constant coarse-scan positions, so cost stays ~O(cells) not O(G^4)
  let bx = 0, by = 0, best = Infinity;
  for (let sy = 0; sy < G; sy += stride) for (let sx = 0; sx < G; sx += stride) {
    const d = meanDistAt(target, cand, G, sx, sy);
    if (d < best) { best = d; bx = sx; by = sy; }
  }
  if (stride > 1) {
    const r = stride - 1;
    const cx = bx, cy = by;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      const d = meanDistAt(target, cand, G, cx + dx, cy + dy);
      if (d < best) { best = d; bx = ((cx + dx) % G + G) % G; by = ((cy + dy) % G + G) % G; }
    }
  }
  return { sx: bx, sy: by, dist: best };
}
// Score a candidate class grid against the target. opts.layoutWeight in [0,1] trades biome-mix
// fidelity (0) against spatial-layout fidelity (1). Wrap-invariant: finds the best cyclic shift.
function scoreGrids(target, cand, G, opts) {
  opts = opts || {};
  const w = opts.layoutWeight == null ? 0.6 : opts.layoutWeight;
  const prop = proportionScore(target, cand);

  const bs = bestShift(target, cand, G);
  const bestSx = bs.sx, bestSy = bs.sy, bestDist = bs.dist;

  // metrics at the best shift
  let exact = 0, inter = 0, uni = 0;
  for (let y = 0; y < G; y++) {
    const cyr = (((y + bestSy) % G) + G) % G;
    for (let x = 0; x < G; x++) {
      const cxr = (((x + bestSx) % G) + G) % G;
      const t = target[y * G + x], c = cand[cyr * G + cxr];
      if (t === c) exact++;
      const lt = t !== SC.Ocean, lc = c !== SC.Ocean;
      if (lt || lc) { uni++; if (lt && lc) inter++; }
    }
  }
  const cells = G * G;
  const soft = 1 - bestDist;               // partial-credit agreement
  const exactFrac = exact / cells;
  const iou = uni ? inter / uni : 1;       // land-shape overlap
  const layout = 0.5 * soft + 0.3 * iou + 0.2 * exactFrac;
  const score = (1 - w) * prop + w * layout;
  return { score, prop, soft, exact: exactFrac, iou, layout, shift: [bestSx, bestSy] };
}

if (typeof module !== 'undefined') module.exports = { SCLASS, NUM_CLASSES, SC, DIST, classOfName, classGridAt, scoreGrids, proportionScore, rasterClassR, downsampleMajority, histogram, bestShift };
