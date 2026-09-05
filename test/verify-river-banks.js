// Regression test: an imported river wears the biome it FLOWS THROUGH, not one label for its whole length.
//
// `imageToMaps` groups water into connected bodies and gives each one a biome, because water cells are
// still ground with something growing on the bank. That label used to be a single majority vote over the
// whole body — right for a compact lake, wrong for a river, which is one connected group from source to
// sea. A trunk crossing grassland, desert, rainforest and cold forest came out labelled Grassland end to
// end, and since the label is what the banks read as, both shores of the river turned to grassland for its
// entire run. Reported from a real 4 km2 world whose river crossed four biomes.
//
// The fix seeds each water cell that touches land with the majority biome of its OWN land neighbours and
// floods that inward, so every stretch keeps its local bank.
//
//   check                                          against the pre-fix copy
//   a river keeps the biome of each stretch        the whole trunk is labelled with one majority biome
//   the majority side does not swallow the rest    the minority bank's stretch reads as the majority's
//   a compact lake still takes its shore biome     (unchanged - guards the fix from over-reaching)
//
// `DESIGNER=<path> node test/verify-river-banks.js` runs this against another copy of designer.js, which
// is how the teeth were shown: restore the old per-group vote in a copy and the first two checks fail.
//
//   node test/verify-river-banks.js
'use strict';
const { SC, COLOR, FRESH, runImageToMaps } = require('./designer-harness');

const RES = 448;
const put = (d, x, y, c) => { const o = (y * RES + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; };

// An island split into an unequal pair of biomes so the old majority vote has a clear winner: desert over
// the western two thirds, cold forest over the eastern third, with a river running west to east through
// both and reaching the sea at each end.
const ISLE_LO = 60, ISLE_HI = 388, SPLIT = 280;      // SPLIT past the middle => desert is the majority bank
const RIVER_LO = 210, RIVER_HI = 218;
function drawing() {
  const d = new Uint8ClampedArray(RES * RES * 4);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) put(d, x, y, COLOR.Ocean);
  for (let y = ISLE_LO; y <= ISLE_HI; y++) for (let x = ISLE_LO; x <= ISLE_HI; x++)
    put(d, x, y, x < SPLIT ? COLOR.Desert : COLOR.ColdForest);
  for (let y = RIVER_LO; y <= RIVER_HI; y++) for (let x = ISLE_LO - 8; x <= ISLE_HI + 8; x++) put(d, x, y, FRESH);
  return { width: RES, height: RES, data: d };
}

const maps = runImageToMaps(drawing(), RES, { mode: 'colors', blocksPerCell: 2000 / RES });
const biome = maps.biome;
// imageToMaps flips Y, so read the row the river was drawn on back through the same flip
const at = (x, y) => biome[(RES - 1 - y) * RES + x];
const midY = (RIVER_LO + RIVER_HI) >> 1;

let fails = 0;
function check(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
}

// Sample well inside each stretch, clear of the seam where either answer is defensible.
const westSamples = [], eastSamples = [];
for (let x = ISLE_LO + 20; x < SPLIT - 20; x += 7) westSamples.push(at(x, midY));
for (let x = SPLIT + 20; x < ISLE_HI - 20; x += 7) eastSamples.push(at(x, midY));
const frac = (arr, v) => arr.filter(b => b === v).length / arr.length;

check('the river through the desert reads as desert', frac(westSamples, SC.Desert) > 0.95,
  (100 * frac(westSamples, SC.Desert)).toFixed(0) + '% of ' + westSamples.length + ' samples');
check('the minority bank keeps its own biome', frac(eastSamples, SC.ColdForest) > 0.95,
  (100 * frac(eastSamples, SC.ColdForest)).toFixed(0) + '% of ' + eastSamples.length + ' samples');
check('the trunk is not painted one colour end to end',
  frac(westSamples, SC.Desert) > 0.95 && frac(eastSamples, SC.Desert) < 0.05,
  'desert share east of the seam ' + (100 * frac(eastSamples, SC.Desert)).toFixed(0) + '%');

// A compact lake sits in one biome, so per-cell and per-group agree: this guards the fix from regressing
// the case it was built around.
{
  const d = drawing().data;
  for (let y = RIVER_LO; y <= RIVER_HI; y++) for (let x = ISLE_LO - 8; x <= ISLE_HI + 8; x++)
    put(d, x, y, x < SPLIT ? COLOR.Desert : COLOR.ColdForest);          // erase the river
  for (let y = 120; y <= 150; y++) for (let x = 120; x <= 150; x++) put(d, x, y, FRESH);   // a pond in the desert
  const b2 = runImageToMaps({ width: RES, height: RES, data: d }, RES, { mode: 'colors', blocksPerCell: 2000 / RES }).biome;
  const pond = [];
  for (let y = 128; y <= 142; y += 3) for (let x = 128; x <= 142; x += 3) pond.push(b2[(RES - 1 - y) * RES + x]);
  check('a compact lake still takes its shore biome', pond.every(b => b === SC.Desert),
    pond.filter(b => b === SC.Desert).length + '/' + pond.length + ' cells desert');
}

console.log(fails ? fails + ' FAILURES ✗' : 'ALL PASS ✓');
process.exit(fails ? 1 : 0);
