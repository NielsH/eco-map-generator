// A landform is a size in BLOCKS, not a fraction of the map.
//
// `RIDGE_FREQ` counts cycles across the world, so on a bigger map the same mountain range is drawn
// proportionally bigger and the ground between crests proportionally flatter. Stock does the opposite -
// VoronoiWorldGenerator scales its noise by worldWidth/72 - so a hill stays a hill's size however large
// the world is.
//
// Measured on one real drawing, each size exported at the pitch it is actually built at, mean rise per
// cell fell from 0.33 at 120 chunks to 0.20 at 280 and flat share rose from 81% to 86%: a bigger world was
// not getting more mountainous, it was getting emptier.
//
// The comparison here is between two world sizes at the SAME blocks-per-cell, so a cell is the same
// distance on the ground in both and the two numbers are directly comparable. 1200/448 and 2000/747 are
// both 2.68 blocks per cell, which is what the shipped importRes() picks for those worlds anyway.
//
//   check                                     before      after
//   relief is the same size at any world size  ratio 0.65  ratio 0.89   (bound 0.85)
//
//   DESIGNER=<path to another copy> node test/verify-scale.js
'use strict';
const { runImageToMaps, reporter, COLOR, landY, WL } = require('./designer-harness');

const { check, done } = reporter();
const S = 192;

/** An island big enough to hold interior at every size, with a coast that wanders. */
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
const img = island();

/** Mean height change between neighbouring cells — with the pitch fixed, this is roughness per metre. */
function roughness(world, res) {
  const m = runImageToMaps(img, res, { mode: 'colors', blocksPerCell: world / res });
  let sum = 0, n = 0;
  for (let y = 0; y < res; y++) for (let x = 0; x + 1 < res; x++) {
    const a = landY(m.height[y * res + x]), b = landY(m.height[y * res + x + 1]);
    if (a <= WL || b <= WL) continue;
    sum += Math.abs(a - b); n++;
  }
  return n ? sum / n : 0;
}

const small = roughness(1200, 448);     // 2.679 blocks per cell
const big = roughness(2000, 747);       // 2.677 blocks per cell — the same ground per cell
const ratio = small > 0 ? big / small : 0;

check('relief is the same size on a big world as on a small one', ratio >= 0.85,
  'mean rise per cell is ' + small.toFixed(2) + ' at 120 chunks and ' + big.toFixed(2) +
  ' at 200, a ratio of ' + ratio.toFixed(2));

done();
