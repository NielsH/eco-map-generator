// A drawn highland has to become a mountain RANGE, not a raised plateau.
//
// The paragraph above the peak pass in designer.js says it plainly: stock's peaks reach 100-115 blocks
// while its 90th percentile sits at 75, so mountains are rare and tall rather than a general elevation.
// The peak pass takes that care. The highland pass did not: `hl` saturates at 1 across an entire drawn
// highland and it multiplied the ridged field raw, so every column in the region gained. Measured on a
// 200-chunk world it lifted the median land 200-250 m inland from 21 blocks to 33 against stock's 7-9,
// and at 120 chunks it did the same thing 150 m inland.
//
// This is measured by drawing the SAME island twice — once with a highland core, once with that core
// painted as ordinary lowland — so the geometry, the distance to the sea and the noise are identical and
// the difference between the two runs IS the highland pass. Anything else would confound the pass with
// the coast-distance ramp, which also rises towards the middle of an island.
//
// Both checks were kept only after they FAILED against the ungated copy and passed against src/:
//
//   check                                        ungated        gated
//   the middle of a highland is not lifted       +27 blocks     +6 blocks     (bound 12)
//   its crests still stand well above it         +31 blocks     +27 blocks    (bound 8; fails at knee 0.8)
//
//   DESIGNER=<path to another copy> node test/verify-highland.js
'use strict';
const { runImageToMaps, reporter, COLOR, landY, WL } = require('./designer-harness');

const { check, done } = reporter();
const S = 192, RES = 448, WORLD = 1200;

/** An island with a wandering coast and a large core, painted with whichever class the core should be. */
function island(coreColor) {
  const px = new Uint8ClampedArray(S * S * 4);
  const put = (x, y, c) => { const o = (y * S + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const cx = x / S - 0.5, cy = y / S - 0.5;
    const a = Math.atan2(cy, cx);
    const r = Math.sqrt(cx * cx + cy * cy) / (0.42 + 0.05 * Math.sin(a * 3.1) + 0.025 * Math.sin(a * 6.7));
    put(x, y, r > 1 ? COLOR.Ocean : r > 0.95 ? COLOR.Coast : r > 0.45 ? COLOR.Grassland : coreColor);
  }
  return { width: S, height: S, data: px };
}

/** Heights over the core, in blocks above sea, for one painting of it. */
function core(coreColor) {
  const m = runImageToMaps(island(coreColor), RES, { mode: 'colors', blocksPerCell: WORLD / RES });
  const out = [];
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const fx = x / RES - 0.5, fy = y / RES - 0.5;
    // well inside the core, so its blurred edge cannot reach: the pass reads a smoothed biome target
    if (Math.sqrt(fx * fx + fy * fy) > 0.42 * 0.32) continue;
    const h = landY(m.height[(RES - 1 - y) * RES + x]);
    if (h > WL) out.push(h - WL);
  }
  out.sort((a, b) => a - b);
  return out;
}

const q = (a, p) => a[Math.floor(a.length * p)];
const high = core(COLOR.Ice);          // an unambiguous highland band
const low = core(COLOR.Grassland);     // the same ground, painted lowland

const dMid = q(high, 0.5) - q(low, 0.5);
const dTop = q(high, 0.98) - q(low, 0.98);

check('painting a highland does not lift the middle of it', dMid <= 12,
  'median over the core rises ' + dMid + ' blocks when it is painted highland (' +
  q(low, 0.5) + ' -> ' + q(high, 0.5) + '), over ' + high.length + ' cells');

check('painting a highland still raises its crests', dTop >= 8,
  'the 98th percentile rises ' + dTop + ' blocks (' + q(low, 0.98) + ' -> ' + q(high, 0.98) + ')');

done();
