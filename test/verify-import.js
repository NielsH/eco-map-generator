// Regression test for the front half of the image import in src/designer.js — the legend.
//
// verify-water and verify-shape both start from a legend handed in ready-made, so everything that DECIDES
// the legend was untested: `nearestClass`, `buildLegend`, `assignLegendIdx`, `buildBrightness`, and the
// brightness branch of `imageToMaps` (which the other two suites never enter at all). That decode is where
// a mistake is quietest — the map still generates, it just generates the wrong biomes, and a colour that
// loses its legend slot is silently remapped to whatever is nearest.
//
// The properties here are the ones a decode cannot get wrong and still be a decode:
//   * every pixel is accounted for — the counts add up to the opaque pixels, none invented, none dropped
//   * an exact palette colour decodes to its own biome, and to nothing else
//   * the colour path must not BLEND: an averaging resample turns every biome edge into a blend colour,
//     and those blends compete for the legend's 12 slots against biomes that cover 1% of the map
//   * brightness bands are monotone in luminance, or a photo's tone structure is scrambled
//
// The stubbed canvas honours `imageSmoothingEnabled`, so the no-blending check has something to fail on.
//
// `DESIGNER=<path> node test/verify-import.js` runs this against another copy of designer.js. Every check
// below was kept only after it FAILED on a copy carrying the single change beside it, and passed on src/:
//
//   check                                        the one change that makes it fail
//   every palette colour decodes to its biome    nearestClass's loop starts at 1
//   the fresh colour catches itself and no biome its tolerance widens from 45 to 90
//   a slot for every paintable colour            MAX_LEGEND 12 -> 11
//   the full palette keeps every colour          the colour key quantises >> 6 instead of >> 4
//   the tail folds in without losing a pixel     buildLegend stops adding the folded count
//   near-identical shades share one slot         the bucket's colour is not its mean
//   an exact colour gets its own entry           assignLegendIdx stops checking the alpha
//   brightness bands monotone and equalised      bands come from the value, not the rank
//   a flat or transparent image still decodes    the ramp loop builds one band short
//   the exported maps are well formed            the biome buffer is allocated half size
//   land above sea level and sea below it        the finalize floor/cap is removed
//   the same picture makes the same world        a Math.random() in the relief
//   importing does not invent biomes             (covered by the buffer-size revert)
//   resampling does not blend new biomes         imageSmoothingEnabled forced true on the colour path
//   a tone ramp exports in ramp order            the brightness rank is inverted
//
//   node test/verify-import.js
'use strict';
const { run, runImageToMaps, paletteLegend, SC, SCLASS, COLOR, FRESH, reporter } = require('./designer-harness');

const G = 128;                                   // the grid buildLegend/assignLegendIdx work on
const NC = SCLASS.length;
const { check, done } = reporter();

// Everything the legend decode needs, lifted from the real source.
const PARTS = ['const:ECO_BIOME_COLOR', 'const:FRESH_COLOR', 'const:isFreshRGB', 'const:MAX_LEGEND',
  'const:BRIGHT_RAMP', 'fn:nearestClass', 'fn:buildLegend', 'fn:assignLegendIdx', 'fn:buildBrightness'];
const ARGS = { G, SC, CN: SCLASS, NC };

/** An image whose pixels are handed out by a callback; `fill` returns [r,g,b] or [r,g,b,a]. */
function image(S, fill) {
  const data = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const c = fill(x, y), o = (y * S + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c.length > 3 ? c[3] : 255;
  }
  return { width: S, height: S, data };
}

// ---------------------------------------------------------------- the colour table

// The palette a user paints with and the table the import decodes against are the same list of Eco colours,
// so decoding a colour must return the biome it was painted as. The metric is weighted (2/4/3 on r/g/b),
// which is exactly the sort of thing that can be retuned into a state where two neighbouring biomes swap.
{
  const r = run(PARTS, ARGS, `
    const wrong = [], missing = [];
    for (let c = 0; c < NC; c++) {
      const p = ECO_BIOME_COLOR[CN[c]];
      if (!p) { missing.push(CN[c]); continue; }
      const got = nearestClass(p[0], p[1], p[2]);
      if (got !== c) wrong.push(CN[c] + ' decoded as ' + CN[got]);
    }
    return { wrong, missing };`);
  check('every palette colour decodes back to its own biome', r.wrong.length === 0 && r.missing.length === 0,
    r.wrong.length ? r.wrong.join('; ') : (r.missing.length ? 'no colour for ' + r.missing.join(', ') : 'all ' + NC + ' classes'));
}

// The fresh-water colour is what makes a drawn river a LAKE rather than sea, and it is matched by a box of
// +/-45 per channel rather than by nearest-neighbour. So it has to be far enough from every biome colour
// that no painted biome falls inside that box — a biome that did would come out as water across the map.
{
  const r = run(PARTS, ARGS, `
    const caught = [], margins = [];
    for (let c = 0; c < NC; c++) {
      const p = ECO_BIOME_COLOR[CN[c]]; if (!p) continue;
      if (isFreshRGB(p[0], p[1], p[2])) caught.push(CN[c]);
      margins.push([CN[c], Math.max(Math.abs(p[0] - FRESH_COLOR[0]), Math.abs(p[1] - FRESH_COLOR[1]), Math.abs(p[2] - FRESH_COLOR[2]))]);
    }
    margins.sort((a, b) => a[1] - b[1]);
    return { caught, self: isFreshRGB(FRESH_COLOR[0], FRESH_COLOR[1], FRESH_COLOR[2]), closest: margins[0] };`);
  check('the fresh-water colour catches itself and no biome', r.caught.length === 0 && r.self,
    'nearest biome is ' + r.closest[0] + ' at ' + r.closest[1] + ' (the test is < 45 on every channel)');
}

// The painter offers 11 biomes plus fresh water, and the legend keeps 12 colours. That is not slack — it is
// exact, and a 13th paintable colour would silently evict the least-used biome from a map drawn with the
// full palette. This is the check that says so out loud.
{
  const r = run(PARTS, ARGS, 'return { MAX_LEGEND, NC };');
  check('the legend has a slot for every paintable colour', r.MAX_LEGEND >= r.NC + 1,
    'MAX_LEGEND is ' + r.MAX_LEGEND + ' for ' + r.NC + ' biomes + fresh water = ' + (r.NC + 1) + ' colours');
}

// ---------------------------------------------------------------- buildLegend

// A design using the whole palette must survive the decode intact: 12 entries, one per colour, each
// decoding to its own class, with the fresh-water one flagged fresh and pointed at Ocean.
{
  const cols = SCLASS.map(n => COLOR[n]).concat([FRESH]);
  const r = run(PARTS, { ...ARGS, cols }, `
    const d = new Uint8ClampedArray(G * G * 4);
    for (let i = 0; i < G * G; i++) { const c = cols[i % cols.length], o = i * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
    const L = buildLegend(d);
    let total = 0, freshN = 0; for (const e of L) { total += e.count; if (e.fresh) freshN++; }
    const classes = new Set(L.filter(e => !e.fresh).map(e => e.cls));
    const defaulted = L.every(e => e.def === e.cls);
    return { n: L.length, total, freshN, classes: classes.size, defaulted };`);
  check('a design drawn in the full palette keeps every colour',
    r.n === cols.length && r.classes === NC && r.freshN === 1 && r.total === G * G && r.defaulted,
    r.n + ' legend entries for ' + cols.length + ' colours, ' + r.classes + ' of ' + NC + ' biomes kept, ' +
    r.freshN + ' flagged fresh, ' + r.total + ' of ' + (G * G) + ' pixels accounted for');
}

// Beyond 12 colours the tail is FOLDED into the nearest kept colour rather than discarded, so the counts
// still add up to every opaque pixel. The counts drive the percentages the user picks a remapping from; a
// fold that dropped its count instead would understate exactly the colours that most need attention.
{
  const r = run(PARTS, ARGS, `
    const d = new Uint8ClampedArray(G * G * 4);
    let opaque = 0;
    for (let i = 0; i < G * G; i++) {
      const o = i * 4;
      if (i % 7 === 0) { d[o + 3] = 0; continue; }              // transparent: not a legend colour at all
      d[o] = (i * 37) % 256; d[o + 1] = (i * 91) % 256; d[o + 2] = (i * 13) % 256; d[o + 3] = 255;
      opaque++;
    }
    const L = buildLegend(d);
    let total = 0; for (const e of L) total += e.count;
    legend = L;
    const idx = assignLegendIdx(d);
    let clear = 0, oob = 0;
    for (let i = 0; i < G * G; i++) { if (idx[i] < 0) clear++; else if (idx[i] >= L.length) oob++; }
    return { n: L.length, total, opaque, clear, oob, cap: MAX_LEGEND };`);
  check('a many-coloured image folds its tail in without losing a pixel',
    r.n === r.cap && r.total === r.opaque && r.oob === 0 && r.clear === Math.ceil(G * G / 7),
    r.n + ' entries (cap ' + r.cap + '), counts total ' + r.total + ' against ' + r.opaque +
    ' opaque pixels, ' + r.clear + ' transparent cells left unassigned, ' + r.oob + ' out-of-range indices');
}

// Colours are bucketed on the top 4 bits per channel, so near-identical shades share a slot and the entry
// carries their AVERAGE. Anti-aliased artwork depends on it: without the quantisation a hand-drawn map's
// hundreds of near-duplicate shades would fill all 12 slots before a real biome got one.
{
  const r = run(PARTS, ARGS, `
    const d = new Uint8ClampedArray(G * G * 4);
    for (let i = 0; i < G * G; i++) { const o = i * 4, v = (i % 2) ? 0 : 10; d[o] = 100 + v; d[o + 1] = 100; d[o + 2] = 100; d[o + 3] = 255; }
    const L = buildLegend(d);
    return { n: L.length, rgb: [...L[0].rgb], count: L[0].count };`);
  check('near-identical shades share one legend slot, averaged', r.n === 1 && r.rgb[0] === 105 && r.count === G * G,
    r.n + ' entry at rgb(' + r.rgb.join(',') + ') — the mean of 100 and 110 — covering ' + r.count + ' pixels');
}

// A pixel that IS a legend colour must be assigned that legend entry, and a transparent one must be left at
// -1 so `applyLegend` can turn it into ocean rather than into whatever colour happens to be nearest black.
{
  const r = run(PARTS, ARGS, `
    legend = [{ rgb: [10, 20, 30] }, { rgb: [200, 40, 60] }, { rgb: [30, 200, 90] }];
    const d = new Uint8ClampedArray(G * G * 4);
    for (let i = 0; i < G * G; i++) {
      const o = i * 4, k = i % 4;
      if (k === 3) { d[o + 3] = 0; continue; }
      const c = legend[k].rgb; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    const idx = assignLegendIdx(d);
    let wrong = 0, clear = 0;
    for (let i = 0; i < G * G; i++) { const k = i % 4; if (k === 3) { if (idx[i] === -1) clear++; else wrong++; } else if (idx[i] !== k) wrong++; }
    return { wrong, clear };`);
  check('an exact legend colour is assigned its own entry, transparency none',
    r.wrong === 0 && r.clear === G * G / 4, r.wrong + ' misassigned, ' + r.clear + ' transparent cells left at -1');
}

// ---------------------------------------------------------------- brightness mode

// Brightness mode is histogram-EQUALISED — the band comes from a pixel's rank, not its value — so a dark or
// low-contrast photo still uses the whole ramp. Two things must hold: the ordering (brighter never lands on
// a darker biome, or the terrain reads inside out) and the count, which is what equalisation buys.
{
  const r = run(PARTS, ARGS, `
    let legend = [], imgLegendIdx = null;
    const d = new Uint8ClampedArray(G * G * 4);
    // a DIM gradient using a sixth of the tonal range: equalisation has to stretch it over the full ramp
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) { const o = (y * G + x) * 4, v = 20 + Math.round(40 * x / (G - 1)); d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255; }
    buildBrightness(d);
    let total = 0; for (const e of legend) total += e.count;
    let inversions = 0;
    for (let y = 0; y < G; y++) for (let x = 1; x < G; x++) if (imgLegendIdx[y * G + x] < imgLegendIdx[y * G + x - 1]) inversions++;
    const counts = legend.map(e => e.count);
    const spread = Math.min(...counts) / Math.max(...counts);
    const ordered = legend.every((e, b) => b === 0 || e.rgb[0] > legend[b - 1].rgb[0]);
    return { bands: legend.length, ramp: BRIGHT_RAMP.length, total, inversions, spread, ordered, empty: counts.filter(c => c === 0).length };`);
  check('brightness bands are monotone in tone and equalised across the ramp',
    r.bands === r.ramp && r.total === G * G && r.inversions === 0 && r.empty === 0 && r.spread > 0.5 && r.ordered,
    r.bands + ' bands, ' + r.total + ' of ' + (G * G) + ' pixels placed, ' + r.inversions +
    ' tone inversions, ' + r.empty + ' bands empty, smallest/largest band ' + r.spread.toFixed(2));
}

// A flat image has no tonal range to equalise. It must still produce the full ramp of legend entries (the
// UI lists one row per band) with every pixel in one of them, rather than dividing by a zero span.
{
  const r = run(PARTS, ARGS, `
    let legend = [], imgLegendIdx = null;
    const d = new Uint8ClampedArray(G * G * 4);
    for (let i = 0; i < G * G; i++) { const o = i * 4; d[o] = d[o + 1] = d[o + 2] = 128; d[o + 3] = 255; }
    buildBrightness(d);
    let total = 0, nan = 0;
    for (const e of legend) { total += e.count; if (!Number.isFinite(e.count)) nan++; }
    let bad = 0; for (let i = 0; i < G * G; i++) if (!(imgLegendIdx[i] >= 0 && imgLegendIdx[i] < legend.length)) bad++;
    // and an entirely transparent image, where the opaque set is empty
    let legend2 = legend, idx2 = imgLegendIdx;
    legend = []; imgLegendIdx = null;
    const t = new Uint8ClampedArray(G * G * 4);
    buildBrightness(t);
    let clear = 0; for (let i = 0; i < G * G; i++) if (imgLegendIdx[i] === -1) clear++;
    return { bands: legend2.length, ramp: BRIGHT_RAMP.length, total, nan, bad, clear, transparentBands: legend.length };`);
  check('a flat or fully transparent image still decodes',
    r.total === G * G && r.nan === 0 && r.bad === 0 && r.clear === G * G && r.bands === r.ramp && r.transparentBands === r.ramp,
    'flat: ' + r.total + ' pixels in ' + r.bands + ' of ' + r.ramp + ' bands, ' + r.bad + ' out of range; transparent: ' +
    r.clear + ' cells at -1 across ' + r.transparentBands + ' bands');
}

// ---------------------------------------------------------------- imageToMaps, both modes

// Whatever the mode, the three exported maps have to be readable by the mod: one value per cell at the
// requested resolution, every biome a real class, and the same input twice giving the same world.
function invariants(label, maps, res) {
  let badClass = 0, wet = 0, nan = 0;
  for (let i = 0; i < res * res; i++) {
    if (maps.biome[i] >= NC) badClass++;
    if (maps.water[i] > 0) wet++;
    if (!Number.isFinite(maps.height[i]) || !Number.isFinite(maps.water[i])) nan++;
  }
  check(label + ': the exported maps are well formed',
    maps.res === res && maps.biome.length === res * res && maps.height.length === res * res &&
    maps.water.length === res * res && badClass === 0 && nan === 0,
    'res ' + maps.res + ', ' + badClass + ' biome ids outside 0..' + (NC - 1) + ', ' + nan + ' non-finite values, ' + wet + ' water cells');
  return wet;
}

const RES = 128;

// Colours mode, on a plain island. The land/sea split is the invariant that matters here: the finalize step
// floors land at 0.505 and caps sea at 0.495, so in BYTES land is >= 129 and sea <= 126 with nothing
// between. A land cell that arrives below that is a hole in the coast; a sea cell above it is dry seabed.
{
  const S = 96;
  const img = image(S, (x, y) => (Math.hypot(x - S / 2, y - S / 2) < S * 0.35 ? COLOR.Grassland : COLOR.Ocean));
  const maps = runImageToMaps(img, RES);
  invariants('colours', maps, RES);

  const LAND_FLOOR = Math.round(0.505 * 255), SEA_CAP = Math.round(0.495 * 255);
  let landLow = 0, seaHigh = 0, land = 0;
  for (let i = 0; i < RES * RES; i++) {
    if (maps.water[i]) continue;                              // a lake bed is allowed anywhere
    if (maps.biome[i] === SC.Ocean) { if (maps.height[i] > SEA_CAP) seaHigh++; } else { land++; if (maps.height[i] < LAND_FLOOR) landLow++; }
  }
  check('colours: land exports above sea level and sea below it', landLow === 0 && seaHigh === 0 && land > 100,
    landLow + ' of ' + land + ' land cells under byte ' + LAND_FLOOR + ', ' + seaHigh + ' sea cells over byte ' + SEA_CAP);

  const again = runImageToMaps(img, RES);
  let diff = 0;
  for (let i = 0; i < RES * RES; i++) if (maps.biome[i] !== again.biome[i] || maps.height[i] !== again.height[i] || maps.water[i] !== again.water[i]) diff++;
  check('colours: the same picture always makes the same world', diff === 0, diff + ' cells differed between two imports');

  const present = new Set();
  for (let i = 0; i < RES * RES; i++) present.add(maps.biome[i]);
  check('colours: importing does not invent biomes at an edge', present.size === 2 && present.has(SC.Ocean) && present.has(SC.Grassland),
    'classes present: ' + [...present].map(c => SCLASS[c]).join(', '));
}

// Nothing but the colours drawn may appear, and the case that proves it is a DOWNSCALE — a source finer
// than the export grid, which is what any real artwork is. An averaging resample puts a ring of blend
// colours around every shape, and a blend does not decode to either of the colours it came from: halfway
// between the ocean blue and the ice white is nearest to GRASSLAND, so a smoothed import of an ice cap on
// the sea grows a green shoreline that was never drawn. This is the check that holds the colour path to
// nearest-neighbour sampling.
{
  const S = 256;
  const img = image(S, (x, y) => (Math.hypot(x - S / 2, y - S / 2) < S * 0.30 ? COLOR.Ice : COLOR.Ocean));
  const maps = runImageToMaps(img, RES);
  const tally = {};
  for (let i = 0; i < RES * RES; i++) tally[maps.biome[i]] = (tally[maps.biome[i]] || 0) + 1;
  const present = Object.keys(tally).map(Number);
  const invented = present.filter(c => c !== SC.Ocean && c !== SC.Ice);
  check('colours: resampling a fine drawing does not blend new biomes into it', invented.length === 0,
    'classes present: ' + present.map(c => SCLASS[c] + ' ' + tally[c]).join(', ') +
    (invented.length ? ' — ' + invented.map(c => SCLASS[c]).join('/') + ' were never drawn' : ''));
}

// Brightness mode, which neither of the other suites enters. A photo is a continuous tone field, so what
// must hold is the ORDER: the ramp runs dark-to-light from ocean to ice, so a brighter part of the picture
// must not come out lower than a darker one.
{
  const S = 96;
  const img = image(S, (x, y) => { const v = Math.round(255 * (0.5 + 0.5 * Math.sin(x * 0.15) * Math.cos(y * 0.13))); return [v, v, v]; });
  const ramp = ['Ocean', 'Wetland', 'ColdForest', 'Taiga', 'RainForest', 'Grassland', 'WarmForest', 'Desert', 'Tundra', 'Coast', 'Ice'];
  const legend = ramp.map((n, b) => { const g = Math.round(255 * b / (ramp.length - 1)); return { rgb: [g, g, g], cls: SC[n], fresh: false }; });
  const maps = runImageToMaps(img, RES, { mode: 'brightness', legend });
  invariants('brightness', maps, RES);

  // A vertical tone ramp, dark at the source's top. The whole chain — rank, band, ramp, class, and the Y
  // flip on the way out — has to preserve that order, so reading the exported biomes back as ramp positions
  // must give a monotone slope with no inversion anywhere. Height is deliberately NOT asserted monotone:
  // the elevation pass shapes it by distance to the sea, and on a torus the bright top row neighbours the
  // dark bottom one, so the highest ground correctly lands in the middle rather than at the bright end.
  const ramped = image(S, (x, y) => { const v = Math.round(255 * y / (S - 1)); return [v, v, v]; });
  const rmaps = runImageToMaps(ramped, RES, { mode: 'brightness', legend });
  const pos = {}; ramp.forEach((n, b) => { pos[SC[n]] = b; });
  let inversions = 0, span = 0;
  for (let x = 0; x < RES; x++) {
    for (let y = 1; y < RES; y++) if (pos[rmaps.biome[y * RES + x]] > pos[rmaps.biome[(y - 1) * RES + x]]) inversions++;
    span += pos[rmaps.biome[x]] - pos[rmaps.biome[(RES - 1) * RES + x]];
  }
  check('brightness: a tone ramp exports as biomes in ramp order', inversions === 0 && span / RES > 8,
    inversions + ' inversions against the tone, spanning ' + (span / RES).toFixed(1) + ' of the ramp\'s ' + (ramp.length - 1) + ' steps');
}

done();
