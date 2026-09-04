// The land is made of cells, and neighbouring cells are DIFFERENT heights.
//
// Every land cell already took one height from a jittered-grid site (cellFlatten), the way stock draws
// one elevation per Voronoi polygon. But the site read the smooth field, so two neighbours 17 blocks
// apart differed by about a block and a half - half a terrace level - and the mod's terrace merged them
// onto one level. Measured on the owner's 200-chunk map at the export's own pitch (2.68 blocks per cell,
// against three stock worlds sampled at the same pitch): 29% of the land sat inside a level 13x13-cell
// sheet (35 m) where stock has 1.5-3.3%, and the largest single-level region was 33,000 cells against
// 4,300-4,800. Stock is not "gathered" - its height change is LESS concentrated than ours (the top tenth
// of neighbour pairs carry 57-60% of it against our 75-84%) - it simply has 1.7x the relief at every lag
// from one cell to sixteen, as more risers of the same size mix, because each polygon carries a random
// term of several blocks. Ours carried none; and the valley pass then flattened every river corridor to
// one shoulder height, which is where the very largest sheet (233,000 world columns) came from.
//
// So each cell now departs from the smooth field by its own random offset, kept through the valley pass,
// and the check is the sheet itself: after the mod's terrace rule, how much land lies inside a level
// 13x13-cell square, on a synthetic island at the shipped 200-chunk pitch.
//
//   check                                  before   after   stock (three 200-chunk worlds)
//   land inside a level 35 m sheet          15.7%    0.5%   1.5-3.3%
//
// The largest single-level region was tried as a second check and thrown away: on a disc island it is
// the coastal apron (the first 45 blocks in from the sea, where the offset is gated off on purpose), and
// it read 17,100 cells before against 10,300 after - it moves with the coastal ramp, not with this.
//
//   DESIGNER=<path to another copy> node test/verify-sheets.js
'use strict';
const { runImageToMaps, reporter, COLOR, WL } = require('./designer-harness');

const { check, done } = reporter();
const S = 192;

/** An island big enough to hold interior at the shipped pitch, with a coast that wanders. */
function island() {
  const px = new Uint8ClampedArray(S * S * 4);
  const put = (x, y, c) => { const o = (y * S + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const cx = x / S - 0.5, cy = y / S - 0.5;
    const a = Math.atan2(cy, cx);
    const r = Math.sqrt(cx * cx + cy * cy) / (0.46 + 0.035 * Math.sin(a * 3.1) + 0.02 * Math.sin(a * 6.7));
    put(x, y, r > 1 ? COLOR.Ocean : r > 0.96 ? COLOR.Coast : r > 0.55 ? COLOR.Grassland : COLOR.ColdForest);
  }
  return { width: S, height: S, data: px };
}

/** The mod's terrace (MapUpscale.Terrace: 41 points over [-1,1], eased with power 4), then the game's rounding. */
function terracedY(hb) {
  const v = 2 * (hb / 255) - 1, spacing = 2 / 40;
  let ip = 0; for (; ip < 41; ip++) if (v < -1 + ip * spacing) break;
  const i0 = Math.max(0, Math.min(40, ip - 1)), i1 = Math.max(0, Math.min(40, ip));
  const v0 = -1 + i0 * spacing, v1 = -1 + i1 * spacing;
  const t = i0 === i1 ? v1 : v0 + (v1 - v0) * Math.pow((v - v0) / (v1 - v0), 4);
  return t < 0 ? Math.round((t + 1) * WL) : WL + Math.round(t * 60);
}

const WORLD = 2000, RES = 747;              // the pitch importRes() picks for a 200-chunk world: 2.68 blocks per cell
const m = runImageToMaps(island(), RES, { mode: 'colors', blocksPerCell: WORLD / RES });
const n = RES * RES;
const y = new Int16Array(n), land = new Uint8Array(n);
let nLand = 0;
for (let j = 0; j < n; j++) { y[j] = terracedY(m.height[j]); land[j] = y[j] > WL && m.water[j] === 0 ? 1 : 0; nLand += land[j]; }

/** Share of land inside at least one k x k window that is all land at one height. */
function sheetShare(k) {
  const anchor = new Uint8Array(n);
  for (let yy = 0; yy < RES; yy++) for (let xx = 0; xx < RES; xx++) {
    const h = y[yy * RES + xx]; let ok = true;
    for (let dy = 0; ok && dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const j = ((yy + dy) % RES) * RES + (xx + dx) % RES;
      if (!land[j] || y[j] !== h) { ok = false; break; }
    }
    if (ok) anchor[yy * RES + xx] = 1;
  }
  const inside = new Uint8Array(n);
  for (let yy = 0; yy < RES; yy++) for (let xx = 0; xx < RES; xx++) {
    if (!anchor[yy * RES + xx]) continue;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) inside[((yy + dy) % RES) * RES + (xx + dx) % RES] = 1;
  }
  let c = 0; for (let j = 0; j < n; j++) if (inside[j] && land[j]) c++;
  return c / nLand;
}

const sheet = sheetShare(13);
check('little land lies inside a level 35 m sheet', sheet <= 0.05,
  (100 * sheet).toFixed(1) + '% of ' + nLand + ' land cells sit inside a level 13x13-cell square (stock 1.5-3.3%)');

done();
