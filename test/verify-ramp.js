// The coastal ramp is a DISTANCE inland, not a fraction of the map.
//
// `OCEAN_DIST = 0.13 * res` spanned 13% of the world whatever the world was — 155 m on a 120-chunk map,
// 259 m on a 200-chunk one — and because it multiplies the relief, the ground kept climbing for the whole
// of it. That is the dome. Stock does not do this: it reaches 6 blocks by 40 m and then plateaus at 7-9,
// at every world size, because its relief comes from noise rather than from distance to the sea.
//
// Measured here as the distance at which the climb is done: the first band whose median height reaches
// 90% of the far-interior median. A ramp defined in blocks finishes at the same distance on both worlds;
// a ramp defined as a fraction finishes later on the bigger one, and that is the whole bug.
//
//   check                                     against a fractional ramp
//   the climb finishes at 1200 blocks         130 m  (passes either way — 13% of a small world IS short)
//   the climb finishes at 2000 blocks         beyond 200 m, against a bound of 150
//
//   DESIGNER=<path to another copy> node test/verify-ramp.js
'use strict';
const { runImageToMaps, reporter, COLOR, landY, WL } = require('./designer-harness');

const { check, done } = reporter();
const S = 192, RES = 448;

/** A big round island, so there is a lot of ground at every distance from the sea. */
function island() {
  const px = new Uint8ClampedArray(S * S * 4);
  const put = (x, y, c) => { const o = (y * S + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const cx = x / S - 0.5, cy = y / S - 0.5;
    const a = Math.atan2(cy, cx);
    const r = Math.sqrt(cx * cx + cy * cy) / (0.46 + 0.03 * Math.sin(a * 3.1));
    put(x, y, r > 1 ? COLOR.Ocean : r > 0.96 ? COLOR.Coast : COLOR.Grassland);
  }
  return { width: S, height: S, data: px };
}
const img = island();

/** Where the climb away from the sea is done, in world blocks. */
function climbEndsAt(world) {
  const m = runImageToMaps(img, RES, { mode: 'colors', blocksPerCell: world / RES });
  const BPC = world / RES;
  const sea = new Uint8Array(RES * RES);
  for (let i = 0; i < m.height.length; i++) if (landY(m.height[i]) <= WL) sea[i] = 1;
  const d = new Int32Array(RES * RES).fill(1 << 28), q = [];
  for (let i = 0; i < RES * RES; i++) if (sea[i]) { d[i] = 0; q.push(i); }
  for (let k = 0; k < q.length; k++) {
    const c = q[k], nd = d[c] + 1, x = c % RES, y = (c / RES) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = (((y + dy) % RES + RES) % RES) * RES + (((x + dx) % RES + RES) % RES);
      if (d[n] > nd) { d[n] = nd; q.push(n); }
    }
  }
  const band = new Map();
  for (let i = 0; i < RES * RES; i++) {
    const h = landY(m.height[i]);
    if (h <= WL) continue;
    const b = Math.floor(Math.round(d[i] * BPC) / 25) * 25;
    if (!band.has(b)) band.set(b, []);
    band.get(b).push(h - WL);
  }
  const med = b => { const v = (band.get(b) || []).sort((p, r) => p - r); return v.length >= 200 ? v[v.length >> 1] : null; };
  const deep = [];
  for (const b of [...band.keys()].sort((a, b) => a - b)) if (b >= 200) { const v = med(b); if (v != null) deep.push(v); }
  if (!deep.length) throw new Error('no interior on this island at world ' + world);
  const plateau = deep.sort((a, b) => a - b)[deep.length >> 1];
  for (const b of [...band.keys()].sort((a, b) => a - b)) {
    const v = med(b);
    if (v != null && v >= 0.9 * plateau) return { at: b, plateau };
  }
  return { at: Infinity, plateau };
}

for (const world of [1200, 2000]) {
  const { at, plateau } = climbEndsAt(world);
  check('the climb away from the sea is done within 150 m on a ' + (world / 10) + '-chunk world', at <= 150,
    'median height reaches 90% of its interior value (' + plateau + ' blocks) by ' +
    (at === Infinity ? 'never' : at + ' m'));
}

done();
