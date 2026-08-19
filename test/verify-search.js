// Regression test for src/search.js — the scoring that ranks every candidate world in Find mode.
//
// This module decides which seed the user is shown, and it was untested. It is also the one place where a
// bug is invisible by construction: a scorer that ranks the wrong world still returns a number, still fills
// the gallery, and still sorts it. The only way to tell is to check the properties the score CLAIMS.
//
// Chief among them is wrap invariance. The world is a torus with no canonical origin, so a generated map
// that matches the drawing but sits 30 cells to the left is a perfect match — the module says so in its own
// comment ("Wrap-invariant: finds the best cyclic shift") and it is what `bestShift` exists for. If the
// coarse scan and the local refine ever stop covering every offset between them, the score silently drops
// for shifted candidates and good seeds are thrown away.
//
// Unlike the designer suites this module is Node-requirable, so it is imported rather than lifted.
// `SEARCH=<path>` points it at another copy, the way `DESIGNER=<path>` does for the others — which is how
// each check here is shown to have teeth. Every check below was kept only after it FAILED on a copy of
// search.js carrying the single change beside it, and passed on src/:
//
//   check                                        the one change that makes it fail
//   the class-distance table is a metric         the diagonal is 0.1 instead of 0
//   an identical map scores a clean 1            the layout blend's weights sum to 0.9
//   scored the same wherever it sits (64/128)    bestShift's refine window shrinks to +/-1
//   the reported shift actually aligns           the refined shift is reported unwrapped
//   nothing in common scores at the floor        soft becomes 1 - 0.9 * dist
//   the layout weight trades in its direction    the blend ignores the weight
//   the histogram is a distribution              it is not divided by the cell count
//   the downsample counts the whole block        the majority reads only the block's first row
//   every generator biome maps into the space    Steppe is dropped from the name table
//
//   node test/verify-search.js
'use strict';
const path = require('path');
const { SC, SCLASS, NUM_CLASSES, DIST, classOfName, scoreGrids, proportionScore, histogram, bestShift, downsampleMajority } =
  require(process.env.SEARCH ? path.resolve(process.env.SEARCH) : '../src/search.js');
const { reporter } = require('./designer-harness');

const { check, done } = reporter();
const grid = (G, f) => { const g = new Uint8Array(G * G); for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) g[y * G + x] = f(x, y); return g; };
const shifted = (g, G, sx, sy) => grid(G, (x, y) => g[((((y + sy) % G) + G) % G) * G + ((((x + sx) % G) + G) % G)]);

// A drawing with enough structure to align: two land biomes in a blob on an ocean, plus an island that
// makes the shape asymmetric, so only one cyclic shift can line it up.
const design = G => grid(G, (x, y) => {
  if (Math.hypot(x - G * 0.45, y - G * 0.55) < G * 0.28) return y > G * 0.55 ? SC.Grassland : SC.WarmForest;
  if (Math.hypot(x - G * 0.82, y - G * 0.2) < G * 0.08) return SC.Desert;
  return SC.Ocean;
});

// ---------------------------------------------------------------- the distance matrix

// Every score is a mean over this table, so its shape sets what "close" means. It has to be a metric-like
// thing: zero on the diagonal, symmetric, and bounded — the score is reported as a percentage and reads as
// one, which only holds while the distances stay in [0,1].
{
  let asym = 0, diag = 0, oob = 0, allSame = true;
  for (let a = 0; a < NUM_CLASSES; a++) for (let b = 0; b < NUM_CLASSES; b++) {
    if (Math.abs(DIST[a][b] - DIST[b][a]) > 1e-6) asym++;
    if (a === b && DIST[a][b] !== 0) diag++;
    if (DIST[a][b] < 0 || DIST[a][b] > 1) oob++;
    if (a !== b && DIST[a][b] !== 1) allSame = false;
  }
  // Ocean against land must be the maximum, and two forests must not be: partial credit for a near miss is
  // the whole reason the table exists rather than a plain equality count.
  const forests = DIST[SC.WarmForest][SC.ColdForest], extremes = DIST[SC.Desert][SC.Ice];
  check('the class-distance table is a bounded symmetric metric with partial credit',
    asym === 0 && diag === 0 && oob === 0 && !allSame &&
    DIST[SC.Ocean][SC.Grassland] === 1 && forests < 0.5 && forests < extremes,
    asym + ' asymmetric pairs, ' + diag + ' non-zero diagonal, ' + oob + ' outside [0,1]; warm vs cold forest ' +
    forests.toFixed(2) + ', desert vs ice ' + extremes.toFixed(2));
}

// ---------------------------------------------------------------- the score

// A grid against itself is the definition of a perfect match, and every component has to say so — a
// component that saturates below 1 caps the whole scale and squashes the top of the gallery together.
{
  const G = 64, t = design(G), s = scoreGrids(t, t, G);
  check('a map identical to the drawing scores a clean 1',
    s.score === 1 && s.prop === 1 && s.soft === 1 && s.exact === 1 && s.iou === 1 && s.shift[0] === 0 && s.shift[1] === 0,
    'score ' + s.score + ' (mix ' + s.prop + ', soft ' + s.soft + ', exact ' + s.exact + ', shape ' + s.iou + ') at shift ' + s.shift);
}

// The point of the module. A candidate that IS the drawing, moved, must still score 1 — including the two
// awkward cases: a shift landing exactly on a coarse-scan position, and one landing as far from every
// coarse position as an offset can get.
{
  for (const G of [64, 128]) {
    const t = design(G);
    const stride = Math.max(1, Math.round(G / 16));
    const offsets = [[7, 5], [stride, 0], [G >> 1, G >> 1], [stride >> 1, G - (stride >> 1)], [1, G - 1]];
    let worst = 1, at = null;
    for (const [sx, sy] of offsets) {
      const s = scoreGrids(t, shifted(t, G, sx, sy), G);
      if (s.score < worst) { worst = s.score; at = [sx, sy]; }
    }
    check('a ' + G + '² map is scored the same wherever it sits on the torus', worst === 1,
      'worst of ' + offsets.length + ' shifts (coarse stride ' + stride + ') scored ' + worst.toFixed(6) + (at ? ' at ' + at : ''));
  }
}

// The shift `bestShift` reports is applied to the candidate to build the preview alignment, so it has to be
// the actual offset, not merely one that scores well.
{
  const G = 64, t = design(G);
  const bad = [];
  // (1,1) is the awkward one: the alignment that undoes it is (G-1,G-1), which a refine step reaches from
  // the coarse origin by stepping NEGATIVE — so a report that forgot to wrap would hand back -1.
  for (const [sx, sy] of [[9, 3], [40, 61], [0, 17], [1, 1]]) {
    const b = bestShift(t, shifted(t, G, sx, sy), G);
    // shifting the candidate by (sx,sy) means the alignment that undoes it is (G-sx, G-sy)
    if (b.dist !== 0 || b.sx !== (G - sx) % G || b.sy !== (G - sy) % G) bad.push([sx, sy] + ' -> ' + [b.sx, b.sy] + ' d=' + b.dist);
  }
  check('the reported shift is the one that actually aligns the two maps', bad.length === 0,
    bad.length ? bad.join('; ') : 'three offsets recovered exactly, at distance 0');
}

// A candidate with nothing in common must score at the bottom, or the gallery's ordering means nothing at
// the end that matters — the seeds being discarded.
{
  const G = 64;
  const allOcean = grid(G, () => SC.Ocean), allDesert = grid(G, () => SC.Desert);
  const s = scoreGrids(allOcean, allDesert, G);
  check('a map with nothing in common scores at the floor',
    s.score === 0 && s.prop === 0 && s.soft === 0 && s.iou === 0 && s.exact === 0,
    'all-ocean against all-desert scored ' + s.score + ' (mix ' + s.prop + ', shape ' + s.iou + ')');
}

// The score is a weighted blend, so the weight has to actually move it, in the direction it says: a
// candidate with the right MIX in the wrong PLACES gains as the weight moves toward mix.
{
  const G = 64;
  const t = design(G);
  const scrambled = grid(G, (x, y) => t[((y * 37 + x * 53) % (G * G))]);   // same cells, no layout left
  const layout = scoreGrids(t, scrambled, G, { layoutWeight: 1 }).score;
  const mix = scoreGrids(t, scrambled, G, { layoutWeight: 0 }).score;
  const mid = scoreGrids(t, scrambled, G, { layoutWeight: 0.6 }).score;
  check('the layout weight trades layout against mix in the direction it claims',
    mix > layout && mid > layout && mid < mix,
    'the same scrambled map scores ' + layout.toFixed(3) + ' on layout alone, ' + mid.toFixed(3) +
    ' at the default 0.6, and ' + mix.toFixed(3) + ' on mix alone');
}

// ---------------------------------------------------------------- the pieces underneath

// The histogram is a probability distribution over classes; the proportion score is one minus half its
// total-variation distance, which is only in [0,1] while the histogram sums to 1.
{
  const G = 64, t = design(G), h = histogram(t);
  let sum = 0, neg = 0;
  for (const v of h) { sum += v; if (v < 0) neg++; }
  const half = grid(G, (x, y) => (x < G / 2 ? SC.Ocean : SC.Desert));
  const other = grid(G, (x, y) => (y < G / 2 ? SC.Ocean : SC.Desert));
  check('the class histogram is a distribution and the mix score ignores placement',
    Math.abs(sum - 1) < 1e-12 && neg === 0 && proportionScore(half, other) === 1 && proportionScore(t, t) === 1,
    'histogram sums to ' + sum + '; two maps with the same halves in different places score ' + proportionScore(half, other));
}

// The rasterizer's downsample is a MAJORITY vote, and the vote has to see the whole block. Each 4x4 block
// here is 9 Taiga to 7 Ocean, with the Ocean in the first row and a half — so anything that samples the
// block rather than counting all of it returns the minority, and a thin coast eats the land behind it.
{
  const R = 128, G = 32, bs = R / G;
  const src = new Uint8Array(R * R);
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const iy = y % bs, ix = x % bs;
    src[y * R + x] = (iy * bs + ix) < 7 ? SC.Ocean : SC.Taiga;   // 7 of 16 Ocean, laid out first
  }
  const out = downsampleMajority(src, R, G);
  let wrong = 0;
  for (let i = 0; i < G * G; i++) if (out[i] !== SC.Taiga) wrong++;
  check('the majority downsample counts the whole block, not a corner of it', wrong === 0,
    wrong + ' of ' + (G * G) + ' blocks came out as the 7-of-16 minority instead of the 9-of-16 majority');
}

// Every biome the generator can produce has to land in the score space, and a lake has to read as water
// wherever it sits — a name that fell through would be scored as ocean and quietly reward the wrong maps.
{
  const names = ['DeepOcean', 'Ocean', 'Coast', 'ColdCoast', 'WarmCoast', 'Grassland', 'Steppe', 'WarmForest',
    'ColdForest', 'RainForest', 'Desert', 'HighDesert', 'Taiga', 'Tundra', 'Ice', 'Wetland'];
  const unmapped = names.filter(n => n !== 'DeepOcean' && n !== 'Ocean' && classOfName(n, false) === SC.Ocean);
  const lakes = names.every(n => classOfName(n, true) === SC.Ocean);
  const covered = new Set(names.map(n => classOfName(n, false)));
  check('every generator biome maps into the score space, and a lake reads as water',
    unmapped.length === 0 && lakes && covered.size === NUM_CLASSES && classOfName('NotABiome', false) === SC.Ocean,
    unmapped.length ? 'unmapped: ' + unmapped.join(', ') : names.length + ' names cover all ' + NUM_CLASSES + ' classes');
}

done();
