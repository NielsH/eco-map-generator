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
//   a seeded lake ends up at ONE level              levelSeededWater takes each cell's height, not the basin
//   a seeded river still runs downhill              rivers are levelled with the lakes
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

// ---- a seeded lake comes out at one level, and a seeded river still descends ----------------------
const state = (function () {
  const target = new Uint8Array(G * G).fill(H.SC.Grassland);
  const water = new Uint8Array(G * G);
  for (let y = 40; y < 52; y++) for (let x = 40; x < 52; x++) water[y * G + x] = 1;   // a lake
  for (let x = 52; x < 70; x++) water[46 * G + x] = 2;                                // its outflow
  return { target: target, water: water, elev: new Float32Array(G * G), elevPainted: new Uint8Array(G * G),
           rough: new Float32Array(G * G), SC: H.SC, CN: H.SCLASS };
})();
const level = H.run(
  ['const:G', 'const:ECO_BIOME_ELEV', 'const:HEIGHT_BLUR_PASSES', 'const:OCEAN_FALLOFF', 'fn:h2', 'fn:vnW',
   'fn:fbm', 'fn:oceanDistField', 'fn:computeHeightField', 'fn:levelSeededWater'],
  state,
  [
    'levelSeededWater();',
    'const h = computeHeightField();',
    'const lake = [], riv = [];',
    'for (let y = 40; y < 52; y++) for (let x = 40; x < 52; x++) lake.push(h[y * G + x]);',
    'for (let x = 52; x < 70; x++) riv.push(h[46 * G + x]);',
    'return { lake: lake, riv: riv };',
  ].join('\n'));

const spread = Math.max.apply(null, level.lake) - Math.min.apply(null, level.lake);
check('a seeded lake ends up at ONE level', spread < 1e-5,
  'the lake spans ' + (spread * 120).toFixed(2) + ' blocks of surface; a lake is one level by definition');
const falls = level.riv.filter((v, i) => i > 0 && v < level.riv[i - 1]).length;
check('a seeded river still runs downhill', falls >= (level.riv.length - 1) * 0.3,
  falls + ' of ' + (level.riv.length - 1) + ' steps descend; levelling it would make an inlet, not a river');

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
