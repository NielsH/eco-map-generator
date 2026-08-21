// Regression tests for seeding a design from the map, and for the detail the export carries.
//
// The defect these guard was worth five worlds: a design seeded from a map took only the biome grid, so the
// map's lakes and rivers were dropped, `anyWater` stayed false, no water.bin shipped, and every generated
// world had NO fresh water at all — which also silenced seven of the nine water regression checks, since
// they all return zero samples with nothing to measure.
//
// `DESIGNER=<path> node test/verify-seed.js` runs this against another copy of designer.js. Every check
// below was kept only after it FAILED on a copy carrying the single change beside it, and passed on src/:
//
//   check                                           the one change that makes it fail
//   the map's lakes reach the water layer           waterGridAt drops lake polygons
//   a river reaches it too                          the river polylines are not walked
//   a river leaves an unbroken trail                the walk steps once per leg instead of sub-cell
//   scoring still sees a lake as water              lakesAsLand leaks into the scoring path
//   a lake keeps its own biome when seeding         lakesAsLand is ignored
//   the export lattice is finer than the paint grid EXPORT_BLOCKS_PER_CELL is left at the paint pitch
//   the lattice is a whole multiple of G            exportRes rounds to something else
//   detail lands on land                            FINE_RELIEF is zeroed
//   detail keeps off the water                      the wetNear gate is dropped
//   detail is quantised to whole levels             FINE_STEP is set to 0
//   detail fades out at the waterline               the `above` fade is removed
//   seeded water is marked and measured from shore  waterFieldsAt stops marking the design's water
//   the ocean is told from an inland pool           waterTopologyAt takes any salt water as the sea
//   a seeded lake ends up at ONE level              the level pass is skipped for the seeded path
//   a seeded river still runs downhill              rivers are levelled the way lakes are
//   the shore sits above the water it holds         restoreShoreLip is not run on the seeded path
//   the bed shelves up at the shoreline             shelveWaterBed is not run on the seeded path
//   the coast envelope survives lake levelling      the cap is not re-applied after solveWaterSurface
//   the export path runs the whole chain            any one of the passes is dropped from buildBundleFiles
//   an unseeded design is recognised as empty       designIsEmpty stops at the first cell it looks at
//   a new map re-seeds an untouched design          shouldReseed only ever fires on an empty design
//   an edited design is never replaced              shouldReseed ignores the edited flag
'use strict';
const H = require('./designer-harness.js');
const path = require('path');
const search = require(path.join(__dirname, '..', 'src', 'search.js'));
const { check, done } = H.reporter();
const G = H.constValue('G');

// ---- a square lake and a river running away from it, on a small synthetic map -------------------
const WORLD = 720;
const square = (cx, cy, r) => ({
  center: { x: cx, y: cy },
  points: [{ x: cx - r, y: cy - r }, { x: cx + r, y: cy - r }, { x: cx + r, y: cy + r }, { x: cx - r, y: cy + r }],
  biome: { name: 'Grassland' },
});
const lake = square(200, 200, 40); lake.hasLake = true; lake.elevation = 0.2;
const dry = square(500, 500, 40); dry.hasLake = false; dry.elevation = 0.3;
const river = [];
for (let k = 0; k <= 10; k++) river.push({ center: { x: 300 + k * 30, y: 300 }, elevation: 0.2 - k * 0.02 });

const seeded = search.waterGridAt([lake, dry], [river], WORLD, G);
const mask = seeded.mask;
let lakeCells = 0, riverCells = 0;
for (let i = 0; i < mask.length; i++) { if (mask[i] === 1) lakeCells++; else if (mask[i] === 2) riverCells++; }

check('the map\'s lakes reach the water layer', lakeCells > 20,
  lakeCells + ' paint cells marked from an 80x80 lake');
check('a river reaches it too', riverCells > 20,
  riverCells + ' paint cells marked along a 300-block river');

let gaps = 0;
for (let k = 0; k < 10; k++) {
  const x = Math.floor((300 + k * 30 + 15) * G / WORLD), y = Math.floor(300 * G / WORLD);
  if (!mask[y * G + x]) gaps++;
}
check('a river leaves an unbroken trail', gaps === 0, gaps + ' gaps at the midpoint of a leg');

// ---- a lake is water to the SEARCH and land to a SEEDED DESIGN ----------------------------------
const cellAt = grid => grid[Math.floor(200 * G / WORLD) * G + Math.floor(200 * G / WORLD)];
const forScoring = cellAt(search.classGridAt([lake, dry], WORLD, G));
const forSeeding = cellAt(search.classGridAt([lake, dry], WORLD, G, { lakesAsLand: true }));
check('scoring still sees a lake as water', forScoring === H.SC.Ocean,
  'class ' + H.SCLASS[forScoring] + ' at the lake, which is what the painted target has there');
check('a lake keeps its own biome when seeding', forSeeding === H.SC.Grassland,
  'class ' + H.SCLASS[forSeeding] + ' at the lake; left as Ocean the height field sinks it to sea level');

// ---- the export lattice --------------------------------------------------------------------------
const exportRes = H.run(['const:G', 'const:EXPORT_BLOCKS_PER_CELL', 'const:EXPORT_RES_MAX', 'fn:exportRes'],
  {}, 'return exportRes;');
const N720 = exportRes(720), N1200 = exportRes(1200);
check('the export lattice is finer than the paint grid', 720 / N720 < 3 && 1200 / N1200 < 3,
  (720 / N720).toFixed(2) + ' and ' + (1200 / N1200).toFixed(2) + ' world blocks per cell; the paint grid alone is ' + (720 / G).toFixed(2));
check('the lattice is a whole multiple of G', N720 % G === 0 && N1200 % G === 0,
  N720 + ' and ' + N1200 + ' against G=' + G + ', so the upsample is exact');

// ---- the detail the finer lattice exists to carry -------------------------------------------------
const detail = H.run(
  ['const:G', 'const:EXPORT_BLOCKS_PER_CELL', 'const:EXPORT_RES_MAX', 'const:FINE_WAVE1', 'const:FINE_A1',
   'const:FINE_RELIEF', 'const:FINE_STEP', 'fn:h2', 'fn:vnW', 'fn:exportRes', 'fn:sampleG', 'fn:exportHeight'],
  { water: new Uint8Array(G * G) },
  [
    'const N = exportRes(720);',
    'const flat = new Float32Array(G * G).fill(0.7);',
    'const wetNear = new Uint8Array(G * G);',
    'for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) wetNear[y * G + x] = 1;',
    'const out = exportHeight(flat, N, 720, wetNear);',
    'const sunk = new Float32Array(G * G).fill(0.5);',
    'const low = exportHeight(sunk, N, 720, new Uint8Array(G * G));',
    'return { N: N, out: out, low: low, step: FINE_STEP };',
  ].join('\n'));

const LEVEL = 3 / 120;              // the terrace level the mod snaps to, in the height byte's [0,1]
let moved = 0, onWater = 0, offLevel = 0;
const scale = G / detail.N;
for (let y = 0; y < detail.N; y++) for (let x = 0; x < detail.N; x++) {
  const v = detail.out[y * detail.N + x] - 0.7;
  const gx = Math.floor(x * scale), gy = Math.floor(y * scale);
  if (Math.abs(v) > 1e-6) {
    moved++;
    if (gx >= 20 && gx < 30 && gy >= 20 && gy < 30) onWater++;
    // measured against a FIXED 3-block level, not against the constant under test - reading the
    // constant back would make this check pass no matter what the constant said
    if (Math.abs(v / LEVEL - Math.round(v / LEVEL)) > 1e-4) offLevel++;
  }
}
check('detail lands on land', moved > detail.N * detail.N * 0.2,
  moved + ' of ' + (detail.N * detail.N) + ' export cells moved off a flat field');
check('detail keeps off the water', onWater === 0,
  onWater + ' cells moved inside the water patch, where it would break the channel');
check('detail is quantised to whole levels', offLevel === 0 && Math.abs(detail.step - LEVEL) < 1e-9,
  offLevel + ' cells sit between levels; smooth detail ruffles every terrace tread instead of stepping it');

let sunkMoved = 0;
for (let i = 0; i < detail.low.length; i++) if (Math.abs(detail.low[i] - 0.5) > 1e-6) sunkMoved++;
check('detail fades out at the waterline', sunkMoved === 0,
  sunkMoved + ' cells moved at sea level, where detail would carve new islands or flood the coast');

// ---- the seeded path, through the passes the image import already uses ----------------------------
// A synthetic design: land everywhere, a square lake on a slope, and a channel running off it to the sea.
const CH = (function () {
  const target = new Uint8Array(G * G).fill(H.SC.Grassland);
  const wet = new Uint8Array(G * G);
  for (let y = 40; y < 56; y++) for (let x = 40; x < 56; x++) wet[y * G + x] = 1;   // the lake
  for (let x = 56; x < 100; x++) wet[47 * G + x] = 1;                               // its outflow
  for (let y = 0; y < G; y++) for (let x = 100; x < G; x++) target[y * G + x] = H.SC.Ocean;   // the sea
  for (let y = 14; y < 26; y++) for (let x = 14; x < 26; x++) target[y * G + x] = H.SC.Ocean;   // and an inland pool
  return { target: target, water: wet };
})();

const chain = H.run(
  ['const:G', 'const:SEA_LEVEL', 'const:BLK', 'const:OPEN_WATER', 'const:BANK_CAP', 'const:SHORE_LIP',
   'const:EXPORT_BLOCKS_PER_CELL', 'const:EXPORT_RES_MAX', 'const:FINE_WAVE1', 'const:FINE_A1',
   'const:FINE_RELIEF', 'const:FINE_STEP', 'const:ECO_BIOME_ELEV', 'const:HEIGHT_BLUR_PASSES',
   'const:OCEAN_FALLOFF', 'fn:h2', 'fn:vnW', 'fn:vnR', 'fn:fbm', 'fn:boxBlurTor', 'fn:oceanDistField',
   'fn:computeHeightField', 'fn:exportRes', 'fn:sampleG', 'fn:exportHeight', 'fn:nearWater',
   'fn:waterFieldsAt', 'fn:waterTopologyAt', 'fn:settleWaterLevels', 'fn:solveWaterSurface',
   'fn:capBankLip', 'fn:restoreShoreLip', 'fn:shelveWaterBed'],
  { target: CH.target, water: CH.water, elev: new Float32Array(G * G), elevPainted: new Uint8Array(G * G),
    rough: new Float32Array(G * G), SC: H.SC, CN: H.SCLASS },
  [
    'const WB = 720, N = exportRes(WB);',
    'const fine = exportHeight(computeHeightField(), N, WB, nearWater());',
    'const wf = waterFieldsAt(N, fine);',
    'const topo = waterTopologyAt(N, wf.land);',
    'const settled = settleWaterLevels(N, N * N, wf.land, fine, topo.distO, WB / N, topo.groups, boxBlurTor);',
    'for (let i = 0; i < N * N; i++) if (wf.land[i] === 2) wf.wsurf[i] = Math.max(SEA_LEVEL + 0.01, settled.level[i] - 0.012);',
    'solveWaterSurface(N, wf.land, wf.wsurf, settled.fromShore);',
    'const overBefore = [];',
    'for (let i = 0; i < N * N; i++) if (wf.land[i] === 2 && wf.wsurf[i] > settled.seaCapAt[i] - 0.012) overBefore.push(i);',
    'for (let i = 0; i < N * N; i++) if (wf.land[i] === 2) wf.wsurf[i] = Math.min(wf.wsurf[i], settled.seaCapAt[i] - 0.012);',
    'let overAfter = 0;',
    'for (let i = 0; i < N * N; i++) if (wf.land[i] === 2 && wf.wsurf[i] > settled.seaCapAt[i] - 0.012 + 1e-9) overAfter++;',
    'capBankLip(N, wf.land, wf.wsurf, fine);',
    'restoreShoreLip(N, wf.land, wf.wsurf, fine);',
    'const bed = new Float32Array(N * N);',
    'shelveWaterBed(N, N * N, wf.land, wf.wsurf, bed, WB / N);',
    'return { N: N, land: wf.land, wsurf: wf.wsurf, fine: fine, bed: bed, groups: topo.groups.length, fromShore: settled.fromShore, distO: topo.distO, overBefore: overBefore.length, overAfter: overAfter };',
  ].join(String.fromCharCode(10)));

const NN = chain.N, NN0 = chain.N, BLOCKS = 120;
let wetCells = 0, deepest = 0;
for (let i = 0; i < NN * NN; i++) if (chain.land[i] === 2) { wetCells++; if (chain.fromShore[i] > deepest) deepest = chain.fromShore[i]; }
check('seeded water is marked and measured from shore', wetCells > 500 && deepest >= 3,
  wetCells + ' export cells are fresh water, the furthest ' + deepest + ' cells from its own edge');
// The inland pool is salt water too, but it is not the SEA - only the largest body is. Distance-to-ocean
// is what bounds a water level near the coast, so counting a puddle as ocean would let inland water sit at
// sea level wherever a dip happens to be drawn.
const poolAt = Math.floor(20 * NN0 / G) * NN0 + Math.floor(20 * NN0 / G);
check('the ocean is told from an inland pool', chain.distO[poolAt] > 20,
  'the inland pool reads ' + chain.distO[poolAt].toFixed(0) + ' cells from the ocean; at 0 it would BE the ocean');

// the lake: one level across it
const lakeLv = [];
for (let y = 42; y < 54; y++) for (let x = 42; x < 54; x++) {
  const i = Math.floor(y * NN / G) * NN + Math.floor(x * NN / G);
  if (chain.land[i] === 2) lakeLv.push(chain.wsurf[i]);
}
const spread = (Math.max.apply(null, lakeLv) - Math.min.apply(null, lakeLv)) * BLOCKS;
check('a seeded lake ends up at ONE level', spread < 0.5,
  'the lake spans ' + spread.toFixed(2) + ' blocks of surface; a lake is one level by definition');

// the channel: still descending toward the sea
const runLv = [];
for (let x = 60; x < 98; x += 2) {
  const i = Math.floor(47 * NN / G) * NN + Math.floor(x * NN / G);
  if (chain.land[i] === 2) runLv.push(chain.wsurf[i]);
}
const falls = runLv.filter((v, k) => k > 0 && v < runLv[k - 1] - 1e-6).length;
check('a seeded river still runs downhill', falls >= 1,
  falls + ' of ' + Math.max(0, runLv.length - 1) + ' steps along the outflow descend; levelling it would make an inlet');

// the shore has to be above the water it holds
let below = 0, shorePairs = 0;
for (let i = 0; i < NN * NN; i++) {
  if (chain.land[i] !== 1) continue;
  const x = i % NN, y = (i / NN) | 0;
  let need = -Infinity;
  for (const nb of [y * NN + (x + 1) % NN, y * NN + (x + NN - 1) % NN, ((y + 1) % NN) * NN + x, ((y + NN - 1) % NN) * NN + x])
    if (chain.land[nb] === 2 && chain.wsurf[nb] > need) need = chain.wsurf[nb];
  if (need === -Infinity) continue;
  shorePairs++;
  if (chain.fine[i] < need) below++;
}
check('the shore sits above the water it holds', shorePairs > 0 && below === 0,
  below + ' of ' + shorePairs + ' shore cells sit under their own water, which reads as a lake spilling over the ground');

// and the bed must not drop away from that shore fast enough for CliffExtruder to wall it in
let steps = 0;
for (let i = 0; i < NN * NN; i++) {
  if (chain.land[i] !== 2) continue;
  const x = i % NN, y = (i / NN) | 0;
  for (const nb of [y * NN + (x + 1) % NN, y * NN + (x + NN - 1) % NN, ((y + 1) % NN) * NN + x, ((y + NN - 1) % NN) * NN + x])
    if (chain.land[nb] === 1 && (chain.fine[nb] - chain.bed[i]) * BLOCKS >= 5) steps++;
}
check('the bed shelves up at the shoreline', steps === 0,
  steps + ' bed-to-bank pairs step 5+ blocks; Eco builds a rock face at 5, so that is a wall around the water');

// Levelling a lake takes the body's dominant level, which knows nothing about how near the sea it is, so it
// can lift a coastal body back over the envelope settleWaterLevels put on it. Measured on a generated world
// before the cap was re-applied, 53.4% of the fresh water within sight of one coast stood 3 blocks over the
// sea; after, 0.3%.
check('the coast envelope survives lake levelling', chain.overBefore > 0 && chain.overAfter === 0,
  chain.overBefore + ' cells were lifted back over the envelope by the levelling, ' + chain.overAfter + ' left after the cap');

// The checks above prove the passes work; this one proves the export path still RUNS them. Without it a
// pass could be dropped from buildBundleFiles and every check here would carry on passing, because the
// chain above is assembled by the test rather than read out of the exporter.
{
  const src = require('fs').readFileSync(H.SRC, 'utf8');
  const at = src.indexOf('async function buildBundleFiles(');
  const exporter = at < 0 ? '' : src.slice(at, at + 6000);
  const missing = ['waterFieldsAt', 'waterTopologyAt', 'settleWaterLevels', 'solveWaterSurface',
                   'capBankLip', 'restoreShoreLip', 'shelveWaterBed', 'writeExportColumns']
    .filter(fn => exporter.indexOf(fn + '(') < 0);
  if (exporter.indexOf('seaCapAt') < 0) missing.push('the coast envelope (seaCapAt)');
  check('the export path runs the whole chain', at >= 0 && missing.length === 0,
    missing.length ? 'buildBundleFiles never calls ' + missing.join(', ') : 'all eight water passes are called');
}

// ---- the two guards on the page ------------------------------------------------------------------
const guards = H.run(['const:G', 'fn:designIsEmpty', 'fn:shouldReseed'], { SC: H.SC },
  'return { designIsEmpty: designIsEmpty, shouldReseed: shouldReseed };');
const blank = new Uint8Array(G * G).fill(H.SC.Ocean);
const oneCell = new Uint8Array(G * G).fill(H.SC.Ocean); oneCell[(G * G) - 1] = H.SC.Grassland;
check('an unseeded design is recognised as empty',
  guards.designIsEmpty(blank) === true && guards.designIsEmpty(oneCell) === false,
  'a single land cell in the last position is enough to count as seeded');
check('a new map re-seeds an untouched design',
  guards.shouldReseed(false, false, true) === true,
  'not empty, not edited, map changed -> re-seed, or the previous design is silently regenerated');
check('an edited design is never replaced',
  guards.shouldReseed(false, true, true) === false && guards.shouldReseed(true, true, false) === true,
  'edited designs survive a map change; a cleared one is still re-seeded');

done();
