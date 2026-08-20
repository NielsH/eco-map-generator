// Regression test for the PAINTED path in src/designer.js — the one a hand-drawn map takes.
//
// The other two import suites both go through `imageToMaps`, which is what an IMPORTED picture uses.
// Everything a hand-painted design goes through instead — the brush and flood fill, the ocean distance
// field, `computeHeightField`, `computeTerrain` — had no check at all, and it is what `buildBundleFiles`
// exports whenever there is no untouched image import. It also covers the three shared helpers that
// `imageToMaps` leans on but nothing pins down: the hash `h2`, the value noise `vnR`/`fbm`, and the
// toroidal blur `boxBlurTor`.
//
// The properties here are structural rather than tuned. The world is a TORUS, so:
//   * the noise must repeat exactly over the grid, or the map has a seam down one edge
//   * the blur must be shift-equivariant, or the same terrain shifted blurs differently
//   * a brush stroke must paint the same number of cells wherever it lands
// and the export must be sane in Eco's own arithmetic: a painted river has to hold water.
//
// Pieces are lifted out of the real source by brace matching (test/designer-harness.js), so this tracks
// edits to designer.js rather than duplicating it. `DESIGNER=<path> node test/verify-paint.js` runs it
// against another copy — which is how each check is shown to have teeth. Every check below was kept only
// after it FAILED on a copy of designer.js carrying the single change beside it, and passed on src/:
//
//   check                                        the one change that makes it fail
//   the hash stays in [0,1)                      h2 divides by 2^31 instead of 2^32
//   the noise repeats exactly over the grid      vnR's lattice wrap `w` returns v unchanged
//   the wrap seam is no steeper                  the same
//   the blur conserves, fixes, and wraps         boxBlurTor clamps its window instead of wrapping
//   the ocean distance field ... wraps           oceanDistField's idx clamps instead of wrapping
//   the same design yields the same terrain      a Math.random() in the coast ramp
//   painted elevation survives to the middle     the painted branch scales its value by 0.98
//   height in [0,1], ocean under water           the ocean band is widened by 0.3
//   submerged land confined to the shoreline     HEIGHT_BLUR_PASSES 2 -> 12
//   a painted river holds water                  RIVER_CARVE 0.045 -> 0.008 (shallower than the lip)
//   a painted river not above its bank           RIVER_LIP 0.012 -> -0.02
//   water values zero off the channel            computeTerrain drops its `if (!water[i]) continue`
//   a brush stroke paints the same disc          stampBrush clamps instead of wrapping
//   the two brushes cover the same disc          stampWater's radius is one short
//   flood fill follows the wrap                  floodFill's x neighbours stop at the border
//   the height ramps stay in range               landColor's clamp on t is removed
//
// One clause has no revert of its own: reducing the distance field's two chamfer sweeps to one does NOT
// fail the convergence half of its check, because one forward+backward sweep already converges on every
// design tried. The wrap half is what that check is really holding.
//
//   node test/verify-paint.js
'use strict';
const { run, SC, SCLASS, reporter, waterY, landY } = require('./designer-harness');

const G = 128;                                   // the designer's paint grid
const { check, done } = reporter();
const wrapIdx = (x, y) => (((y % G) + G) % G) * G + (((x % G) + G) % G);

// A design the height field has something to say about: an ocean band down one side, land elsewhere,
// and a river painted across the middle. Ocean at x<20 puts a coast at BOTH x=20 and x=127, so anything
// that mishandles the wrap shows up as a difference between the two.
function makeDesign() {
  const target = new Uint8Array(G * G).fill(SC.Grassland);
  const elev = new Float32Array(G * G), elevPainted = new Uint8Array(G * G);
  const rough = new Float32Array(G * G), water = new Uint8Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const i = y * G + x;
    if (x < 20) target[i] = SC.Ocean;
    else if (x > 90) target[i] = SC.Taiga;
    if (x >= 60 && x < 64) water[i] = 1;
  }
  return { target, elev, elevPainted, rough, water };
}

const TERRAIN_PARTS = ['fn:h2', 'fn:vnW', 'fn:fbm', 'fn:oceanDistField', 'const:OCEAN_FALLOFF',
  'const:HEIGHT_BLUR_PASSES', 'const:ECO_BIOME_ELEV', 'const:RIVER_CARVE', 'fn:computeHeightField', 'fn:computeTerrain'];
const terrainArgs = st => ({ G, SC, CN: SCLASS, target: st.target, elev: st.elev, elevPainted: st.elevPainted, rough: st.rough, water: st.water });

const design = makeDesign();
const terrain = run(TERRAIN_PARTS, terrainArgs(design), 'return computeTerrain();');

// ---------------------------------------------------------------- the hash and the noise on it

// h2 feeds every noise octave in both paths. If it ever leaves [0,1) the noise leaves it too, and the
// height field it drives stops meaning "fraction of the world's height".
{
  const r = run(['fn:h2'], {}, `
    let lo = Infinity, hi = -Infinity, low = 0, high = 0;
    for (let y = -200; y < 200; y++) for (let x = -200; x < 200; x++) {
      const v = h2(x, y);
      if (v < lo) lo = v; if (v > hi) hi = v;
      if (v < 0.5) low++; else high++;
    }
    return { lo, hi, low, high };`);
  const balance = Math.min(r.low, r.high) / (r.low + r.high);
  check('the hash stays in [0,1) and does not favour a half', r.lo >= 0 && r.hi < 1 && balance > 0.45,
    r.lo.toFixed(4) + '..' + r.hi.toFixed(4) + ', ' + (100 * balance).toFixed(1) + '% in the smaller half');
}

// The world wraps, so the noise has to repeat EXACTLY over one grid — not approximately. An off-by-one in
// the lattice wrap `w()` leaves the two edges sampling different lattice cells, which prints a seam down
// the map that no amount of blurring removes.
{
  const r = run(['fn:h2', 'fn:vnR', 'fn:vnW', 'fn:fbm'], { G }, `
    const res = 256;
    let vnrPeriod = 0, fbmPeriod = 0, oob = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      for (const P of [10, 26, 64]) {
        const a = vnR(x, y, P, res);
        if (a < 0 || a > 1) oob++;
        vnrPeriod = Math.max(vnrPeriod, Math.abs(a - vnR(x + res, y, P, res)), Math.abs(a - vnR(x, y + res, P, res)));
      }
      const w = fbm(x, y); if (w < 0 || w > 1) oob++;
      fbmPeriod = Math.max(fbmPeriod, Math.abs(w - fbm(x + G, y + G)));
    }
    return { vnrPeriod, fbmPeriod, oob };`);
  check('the noise repeats exactly over the grid and stays in [0,1]',
    r.vnrPeriod === 0 && r.fbmPeriod === 0 && r.oob === 0,
    'worst period error vnR ' + r.vnrPeriod + ', fbm ' + r.fbmPeriod + '; ' + r.oob + ' samples out of range');
}

// Exact repetition is not the same as a smooth join: the value AT the seam has to arrive there gradually
// too, or the last cell before the wrap is a cliff. Compare the step across the seam against the biggest
// step anywhere inside.
{
  const r = run(['fn:h2', 'fn:vnR'], {}, `
    const res = 256; let seam = 0, inner = 0;
    for (let y = 0; y < res; y++) {
      seam = Math.max(seam, Math.abs(vnR(0, y, 26, res) - vnR(res - 1, y, 26, res)));
      seam = Math.max(seam, Math.abs(vnR(y, 0, 26, res) - vnR(y, res - 1, 26, res)));
      for (let x = 1; x < res; x++) inner = Math.max(inner, Math.abs(vnR(x, y, 26, res) - vnR(x - 1, y, 26, res)));
    }
    return { seam, inner };`);
  check('the wrap seam is no steeper than the noise elsewhere', r.seam <= r.inner,
    'seam step ' + r.seam.toFixed(4) + ' against a worst interior step of ' + r.inner.toFixed(4));
}

// ---------------------------------------------------------------- the toroidal blur

// boxBlurTor is a convolution on a torus, which pins down three things exactly. Mean conservation says it
// neither creates nor destroys height; a constant field being a fixed point says the window and the
// normalisation agree; and shift-equivariance is the one that proves the WRAP — a blur that clamped at the
// edges instead of wrapping would still conserve and still fix a constant, but would blur a shifted field
// differently from the shift of the blurred one.
{
  const res = 48;
  const r = run(['fn:boxBlurTor'], { res }, `
    const n = res * res;
    const mk = f => { const a = new Float32Array(n); for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) a[y * res + x] = f(x, y); return a; };
    const sum = a => { let s = 0; for (const v of a) s += v; return s; };
    let seed = 1; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const base = mk(() => rnd());
    const blurred = base.slice(); const before = sum(blurred);
    boxBlurTor(blurred, res, 2, 2); const after = sum(blurred);
    const SH = 7;
    const shifted = mk((x, y) => base[y * res + ((x + SH) % res)]);
    boxBlurTor(shifted, res, 2, 2);
    let equivar = 0;
    for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) equivar = Math.max(equivar, Math.abs(shifted[y * res + x] - blurred[y * res + ((x + SH) % res)]));
    const flat = mk(() => 0.375); boxBlurTor(flat, res, 3, 2);
    let flatErr = 0; for (const v of flat) flatErr = Math.max(flatErr, Math.abs(v - 0.375));
    // a spike at the origin must reach BOTH sides of the seam
    const spike = mk((x, y) => (x === 0 && y === 0) ? 1 : 0); boxBlurTor(spike, res, 2, 1);
    return { before, after, equivar, flatErr, acrossSeam: spike[res - 1], inside: spike[1] };`);
  const drift = Math.abs(r.after - r.before) / r.before;
  check('the blur conserves the field, fixes a constant, and wraps',
    drift < 1e-6 && r.equivar < 1e-6 && r.flatErr < 1e-6 && r.acrossSeam > 0 && Math.abs(r.acrossSeam - r.inside) < 1e-6,
    'sum drift ' + drift.toExponential(1) + ', shift-equivariance error ' + r.equivar +
    ', constant error ' + r.flatErr + ', spike leaks ' + r.acrossSeam.toFixed(4) + ' across the seam vs ' + r.inside.toFixed(4) + ' inside');
}

// ---------------------------------------------------------------- distance to the ocean

// The distance field multiplies the coast-to-interior ramp, so an error in it is printed onto every slope.
// Two things must hold: it wraps (a cell one step the WRONG way round from the ocean is 1 away, not 107),
// and two chamfer sweeps are enough to converge — the source asserts that in a comment and nothing checked
// it. A field that has not converged has cells sitting above their true distance, which reads as a ridge.
{
  const r = run(['fn:oceanDistField'], { G, SC, target: design.target }, `
    const d = oceanDistField();
    const idx = (x, y) => (((y % G) + G) % G) * G + (((x % G) + G) % G);
    let nonZeroOcean = 0, worstLip = 0;
    for (let i = 0; i < G * G; i++) if (target[i] === 0 && d[i] !== 0) nonZeroOcean++;
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const v = d[idx(x, y)];
      for (const [dx, dy] of [[1, 0], [0, 1]]) worstLip = Math.max(worstLip, Math.abs(v - d[idx(x + dx, y + dy)]));
    }
    // one more full relaxation: on a converged field nothing may drop. The tolerance is 1e-3 because the
    // field is Float32 and a distance accumulated over a hundred chamfer steps drifts by a few 1e-6.
    let lowered = 0, worstDrop = 0;
    const rel = (x, y, nx, ny, w) => { const i = idx(x, y), j = idx(nx, ny); if (d[j] + w < d[i] - 1e-3) { worstDrop = Math.max(worstDrop, d[i] - (d[j] + w)); lowered++; d[i] = d[j] + w; } };
    for (let p = 0; p < 2; p++) {
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) { rel(x, y, x - 1, y, 1); rel(x, y, x, y - 1, 1); rel(x, y, x - 1, y - 1, 1.414); rel(x, y, x + 1, y - 1, 1.414); }
      for (let y = G - 1; y >= 0; y--) for (let x = G - 1; x >= 0; x--) { rel(x, y, x + 1, y, 1); rel(x, y, x, y + 1, 1); rel(x, y, x + 1, y + 1, 1.414); rel(x, y, x - 1, y + 1, 1.414); }
    }
    return { nonZeroOcean, worstLip, lowered, worstDrop, wrapSide: d[idx(G - 1, 5)], nearSide: d[idx(20, 5)] };`);
  check('the ocean distance field is zero on water, wraps, and has converged',
    r.nonZeroOcean === 0 && r.worstLip <= 1.0001 && r.lowered === 0 && r.wrapSide === 1 && r.nearSide === 1,
    r.nonZeroOcean + ' ocean cells non-zero, worst neighbour step ' + r.worstLip.toFixed(3) +
    ', ' + r.lowered + ' cells still droppable (worst ' + r.worstDrop.toFixed(3) + '), both coasts read ' +
    r.nearSide + '/' + r.wrapSide);
}

// ---------------------------------------------------------------- the height field

// Two calls with the same design must agree exactly. The field is noise-driven but seedless — it is a pure
// function of the drawing — and the export, the 3D preview and the on-screen height view each recompute it
// independently, so anything stateful in there makes the picture disagree with the world it ships.
{
  const again = run(TERRAIN_PARTS, terrainArgs(design), 'return computeTerrain();');
  let diff = 0;
  for (let i = 0; i < G * G; i++) if (terrain.height[i] !== again.height[i] || terrain.waterVal[i] !== again.waterVal[i]) diff++;
  check('the same design always yields the same terrain', diff === 0, diff + ' cells differed between two runs');
}

// Painted elevation is a promise to the user: the middle of a patch painted at 0.80 has to come out at
// 0.80. The blur is the risk — it runs after the painted values are written, so a wider one would drag the
// interior toward its surroundings.
{
  const st = makeDesign();
  for (let y = 40; y < 88; y++) for (let x = 40; x < 88; x++) { const i = y * G + x; st.elev[i] = 0.80; st.elevPainted[i] = 1; st.water[i] = 0; }
  const h = run(TERRAIN_PARTS, terrainArgs(st), 'return computeHeightField();');
  let worst = 0;
  for (let y = 48; y < 80; y++) for (let x = 48; x < 80; x++) worst = Math.max(worst, Math.abs(h[y * G + x] - 0.80));
  check('painted elevation survives to the middle of the patch', worst < 1e-6,
    'worst deviation ' + worst.toExponential(2) + ' from the painted 0.80');
}

// The whole field is a fraction of the world's height, so it has to stay in [0,1]; and what the user drew
// as ocean has to come out below sea level, or the sea shows up as land in the export.
{
  let lo = Infinity, hi = -Infinity, oceanDry = 0;
  for (let i = 0; i < G * G; i++) {
    const v = terrain.height[i];
    if (v < lo) lo = v; if (v > hi) hi = v;
    if (design.target[i] === SC.Ocean && v >= 0.5) oceanDry++;
  }
  check('height stays in [0,1] and painted ocean stays under water', lo >= 0 && hi <= 1 && oceanDry === 0,
    'range ' + lo.toFixed(4) + '..' + hi.toFixed(4) + ', ' + oceanDry + ' ocean cells at or above sea level');
}

// Painted LAND is floored just over sea level before the blur, and the blur then pulls the cells nearest
// the coast back under it — a soft beach rather than a wall, which is what the field is for. What must not
// happen is that reaching inland: a submerged cell well away from the water is a hole in the map. The
// bound is the blur's own reach (2 passes of a 3x3 window = 2 cells), plus a cell of slack.
{
  const dist = run(['fn:oceanDistField'], { G, SC, target: design.target }, 'return oceanDistField();');
  let inland = 0, worstDist = 0, sunk = 0;
  for (let i = 0; i < G * G; i++) {
    if (design.target[i] === SC.Ocean || design.water[i] || terrain.height[i] >= 0.5) continue;
    sunk++;
    worstDist = Math.max(worstDist, dist[i]);
    if (dist[i] > 3) inland++;
  }
  check('submerged land is confined to the shoreline the blur softens', inland === 0,
    sunk + ' land cells sit below sea level, none further than ' + worstDist.toFixed(1) + ' cells from the ocean (' + inland + ' beyond 3)');
}

// ---------------------------------------------------------------- the painted river

// Eco fills a column to `60 + trunc(60 * waterByte/255)` and reads the land byte as its bed, so whether a
// painted river holds water is decided entirely by the gap between the two BYTES this exports. The gap is
// RIVER_CARVE - RIVER_LIP wide before rounding, and if those two constants ever cross, every painted river
// in every exported world is a dry ditch — with nothing on screen to say so, because the designer's own
// preview draws the water from `waterVal` regardless.
{
  const depths = [];
  for (let i = 0; i < G * G; i++) {
    if (!design.water[i]) continue;
    const wb = Math.max(0, Math.min(255, Math.round(terrain.waterVal[i] * 255)));
    const hb = Math.max(0, Math.min(255, Math.round(terrain.height[i] * 255)));
    depths.push(waterY(wb) - landY(hb));
  }
  depths.sort((a, b) => a - b);
  check('a painted river holds water once it is quantised to bytes', depths.length > 0 && depths[0] >= 1,
    depths.length + ' cells, depth ' + depths[0] + '..' + depths[depths.length - 1] + ' blocks');
}

// And it must not hold water ABOVE its own bank — that is a river running along the top of a levee. The
// surface is set from the UNCARVED height, so the margin is RIVER_LIP alone, roughly one block; whether it
// survives the byte rounding is exactly what this measures.
{
  let over = 0, worst = -Infinity;
  for (let i = 0; i < G * G; i++) {
    if (!design.water[i]) continue;
    const x = i % G, y = (i / G) | 0;
    const wy = waterY(Math.round(terrain.waterVal[i] * 255));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const j = wrapIdx(x + dx, y + dy);
      if (design.water[j] || design.target[j] === SC.Ocean) continue;
      const d = wy - landY(Math.round(terrain.height[j] * 255));
      if (d > 0) over++;
      if (d > worst) worst = d;
    }
  }
  check('a painted river does not stand above its own bank', over === 0,
    over + ' cells over the bank beside them, closest approach ' + worst + ' blocks');
}

// Carving may not punch through the floor, and a cell with no water painted on it must export a water
// value of exactly 0 — the mod reads any non-zero byte as "fill this column".
{
  let dry = 0, floor = 0, band = 0;
  for (let i = 0; i < G * G; i++) {
    if (!design.water[i] && terrain.waterVal[i] !== 0) dry++;
    if (terrain.height[i] < 0.02) floor++;
    if (terrain.waterVal[i] < 0 || terrain.waterVal[i] > 1) band++;
  }
  check('water values are zero off the painted channel and in band on it', dry === 0 && floor === 0 && band === 0,
    dry + ' dry cells carrying water, ' + floor + ' below the carve floor, ' + band + ' out of [0,1]');
}

// ---------------------------------------------------------------- brush, line and fill

// The brush is a disc on a torus, so it paints the same COUNT wherever its centre lands. Stamping in a
// corner is the case that matters: a stroke there has to appear in all four corners, and an implementation
// that clipped instead of wrapping would quietly paint fewer cells at the edge than in the middle.
{
  const r = run(['fn:stampBrush', 'fn:stampLine'], { G, brushSize: 5 }, `
    const count = (cx, cy) => { target = new Uint8Array(G * G); stampBrush(cx, cy, 3); let n = 0; for (const v of target) if (v === 3) n++; return n; };
    let target = new Uint8Array(G * G);
    const middle = count(64, 64), corner = count(0, 0), edge = count(G - 1, 40);
    stampBrush(0, 0, 3);
    const corners = [target[0], target[G - 1], target[(G - 1) * G], target[G * G - 1]];
    // a line must cover both ends, and wrap when drawn the short way round the seam
    target = new Uint8Array(G * G);
    stampLine(2, 10, 20, 10, 4);
    const ends = target[10 * G + 2] === 4 && target[10 * G + 20] === 4;
    return { middle, corner, edge, corners, ends };`);
  check('a brush stroke paints the same disc wherever it lands, wrapping at the edges',
    r.middle === r.corner && r.middle === r.edge && r.corners.every(v => v === 3) && r.ends,
    'cells painted: middle ' + r.middle + ', corner ' + r.corner + ', edge ' + r.edge + '; all four corners hit: ' + r.corners.every(v => v === 3));
}

// The elevation and water brushes are the same disc with a different payload, and they carry the extra
// promise that the roughness baked at paint time lands on exactly the cells the brush covered.
{
  // 0.0625 rather than a rounder number: `rough` is a Float32Array, so anything not exactly representable
  // comes back changed and the comparison would fail on the storage, not on the brush.
  const r = run(['fn:stampElev', 'fn:stampWater'], { G, brushSize: 4, elevValue: 0.7, paintRoughness: 0.0625 }, `
    let elev = new Float32Array(G * G), elevPainted = new Uint8Array(G * G), rough = new Float32Array(G * G), water = new Uint8Array(G * G);
    stampElev(1, 1, 0.7);
    stampWater(1, 1, 1);
    let painted = 0, wet = 0, roughOff = 0, mismatch = 0;
    for (let i = 0; i < G * G; i++) {
      if (elevPainted[i]) { painted++; if (rough[i] !== paintRoughness) roughOff++; }
      if (water[i]) wet++;
      if (!!elevPainted[i] !== !!water[i]) mismatch++;
    }
    const wrapped = elevPainted[(G - 1) * G + (G - 1)];
    stampElev(1, 1, -1);                                     // a negative value is the eraser
    let left = 0; for (let i = 0; i < G * G; i++) if (elevPainted[i]) left++;
    return { painted, wet, roughOff, mismatch, wrapped, left };`);
  check('the elevation and water brushes cover the same wrapped disc, and erasing clears it',
    r.painted > 0 && r.painted === r.wet && r.mismatch === 0 && r.roughOff === 0 && r.wrapped === 1 && r.left === 0,
    r.painted + ' cells painted, ' + r.wet + ' wet, ' + r.roughOff + ' carrying the wrong roughness, corner cell wrapped: ' +
    (r.wrapped === 1) + ', ' + r.left + ' left after erasing');
}

// Flood fill has to follow the torus too. The region here is a stripe drawn ACROSS the seam — four cells on
// each side of x=0 — so a fill started at x=0 can only reach the other half by wrapping. A fill that treated
// the border as a wall would leave those cells behind, which is what the user sees as half a painted
// peninsula refusing to fill.
{
  const r = run(['fn:floodFill'], { G, SC }, `
    const target = new Uint8Array(G * G).fill(2);
    const inStripe = x => x < 4 || x >= G - 4;
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (inStripe(x)) target[y * G + x] = 5;
    floodFill(0, 32, 7);
    let filled = 0, leaked = 0;
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const v = target[y * G + x];
      if (inStripe(x)) { if (v === 7) filled++; } else if (v !== 2) leaked++;
    }
    const before = target.slice();
    floodFill(0, 32, 7);                                     // filling with the colour already there is a no-op
    let moved = 0; for (let i = 0; i < G * G; i++) if (before[i] !== target[i]) moved++;
    return { filled, leaked, moved };`);
  check('flood fill follows the wrap and stops at the region boundary',
    r.filled === 8 * G && r.leaked === 0 && r.moved === 0,
    r.filled + ' of ' + (8 * G) + ' stripe cells filled, ' + r.leaked + ' leaked outside, refill moved ' + r.moved);
}

// ---------------------------------------------------------------- the height view's colour ramps

// These only draw the preview, but they run over every cell of an arbitrary height field, so an
// out-of-range lookup would be a NaN in the canvas rather than a visible wrong colour.
{
  const r = run(['const:SEA_LEVEL', 'const:LAND_RAMP', 'fn:lerp3', 'fn:landColor', 'fn:waterColor'], {}, `
    let bad = 0;
    for (let k = -20; k <= 120; k++) {
      const h = k / 100;
      for (const c of [landColor(h), waterColor(h), landColor(h, 0.4), waterColor(h, 0.4)])
        for (const v of c) if (!Number.isFinite(v) || v < 0 || v > 255) bad++;
    }
    const deep = waterColor(0), shallow = waterColor(SEA_LEVEL);
    return { bad, deepens: deep[2] < shallow[2] };`);
  check('the height ramps stay inside the colour range and deepen with depth', r.bad === 0 && r.deepens,
    r.bad + ' channel values out of range');
}

done();
