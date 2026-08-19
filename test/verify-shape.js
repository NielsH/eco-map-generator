// Regression test for the SHAPE of imported land — where a river meets the sea, and what the ground
// beside a river does. Companion to verify-water.js, which guards the water itself.
//
// Five defects were found in authored worlds and fixed. The first four came together; None of them was catchable by
// verify-water.js: its design has no water near the sea, and none of its checks looks at how the ground
// climbs away from a bank. Each check below is paired with a copy of designer.js that undoes exactly one
// of the four, and was kept only after it was shown to FAIL on that copy and pass on the real source:
//
//   check                                  main    sea    pinstripe  corridor  shelf   bound
//   river arrives at the sea               0       55     0          0         0       0 cells at +5
//   land drawn per cell (CELL_SHARP)       0.90    0.90   0.25       0.90      0.90    >= 0.8
//   bank climb follows the land behind     0.479   0.461  0.479      0.204     0.623   rho >= 0.35
//   climb concentrated in a riser or two   0.683   0.671  0.682      0.710     0.526   >= 0.60
//
// A fifth was added when the water levelling landed, and the four reverts above were regenerated from the
// designer of the day so the table stays honest — an old revert copy predates later fixes and fails checks
// it was never meant to exercise:
//
//   check                                  main    sea    pinstripe  corridor  shelf   level   bound
//   surface tilts along, not across        0.35    0.20   0.35       0.35      0.35    0.65    <= 0.60
//
// Run:  node test/verify-shape.js
//       DESIGNER=<copy> node test/verify-shape.js      (to check a variant)
'use strict';
const { SC, COLOR, FRESH, runImageToMaps, constValue, waterY, landY, WL } = require('./designer-harness');

// A COASTAL design. verify-water.js draws a cone with an ocean ring, and nothing it draws ever reaches
// the sea, so a river mouth has nowhere to happen there; its 20 checks are also calibrated cell by cell on
// that exact drawing, and redrawing it to add a coast would move every one of them. So this is a second
// design rather than an edit to the first.
//
// What it has to contain, and why:
//   * a SEA down one side, with the land rising away from it, so distance-to-sea is a real quantity;
//   * a river whose OUTLET is in the south but whose head loops back to within ~35 m of the coast in the
//     north. A body takes one level per connected group and floods outward from its lowest cell, so a
//     stretch that returns to the coast far from its own outlet inherits the inland level it crossed on
//     the way — which is the perched mouth, and it cannot occur on a design where every course runs
//     straight downhill;
//   * a wide LAGOON at that head. Water more than a few cells from any bank has no bank of its own and
//     takes the body's ring level, and that is the level the coast bound has to cut. A channel narrow
//     enough that every cell touches land never gets a level high enough for the bound to bite;
//   * a low wet BASIN inland beside the course, so the land behind a bank is not the same height
//     everywhere and "the climb follows the land behind it" has a range to follow.
function drawCoast(S) {
  const px = new Uint8ClampedArray(S * S * 4);
  const put = (x, y, c) => { if (x < 0 || y < 0 || x >= S || y >= S) return; const o = (y * S + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; };
  const coastX = y => S * (0.22 + 0.045 * Math.sin(y / S * Math.PI * 2 * 1.4) + 0.018 * Math.sin(y / S * Math.PI * 2 * 3.3));
  for (let y = 0; y < S; y++) {
    const cx = coastX(y);
    for (let x = 0; x < S; x++) {
      if (x < cx) { put(x, y, COLOR.Ocean); continue; }
      const t = (x - cx) / (S - cx);
      put(x, y, t < 0.04 ? COLOR.Coast : t < 0.32 ? COLOR.Grassland : t < 0.58 ? COLOR.ColdForest : COLOR.Taiga);
    }
  }
  for (let y = Math.round(S * 0.36); y < Math.round(S * 0.64); y++)          // the low basin
    for (let x = Math.round(S * 0.62); x < Math.round(S * 0.90); x++) put(x, y, COLOR.Wetland);

  const disc = (x, y, r, c) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) put(x + dx, y + dy, c); };
  const line = (x0, y0, x1, y1, r, c) => {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3);
    for (let k = 0; k <= n; k++) disc(Math.round(x0 + (x1 - x0) * k / n), Math.round(y0 + (y1 - y0) * k / n), r, c);
  };
  disc(Math.round(S * 0.74), Math.round(S * 0.26), Math.round(S * 0.05), FRESH);   // lake on the high ground
  line(S * 0.74, S * 0.26, S * 0.60, S * 0.42, 1, FRESH);                          // down through the basin
  line(S * 0.60, S * 0.42, S * 0.52, S * 0.66, 1, FRESH);
  line(S * 0.52, S * 0.66, coastX(S * 0.80) - S * 0.02, S * 0.80, 1, FRESH);       // and out to the sea
  line(S * 0.74, S * 0.26, S * 0.50, S * 0.18, 1, FRESH);                          // a branch back toward the coast
  const lx = coastX(S * 0.15) + S * 0.03, ly = S * 0.15;
  line(S * 0.50, S * 0.18, lx, ly, 1, FRESH);
  disc(Math.round(lx), Math.round(ly), Math.round(S * 0.05), FRESH);               // ending in a coastal lagoon
  return { width: S, height: S, data: px };
}

// 256, as verify-water.js uses. The perched mouth is resolution-sensitive: the level a body takes depends
// on how many of its cells have a bank of their own, which is a count in CELLS, so the same drawing
// exported at 448 gives the lagoon enough shore cells to settle low by itself and the bound never bites.
// The check is guarding the code path, not that resolution — but it is worth knowing that a defect can be
// invisible at one export size and not another, which is a reason to keep the release checks below.
const RES = 256;
const BPC = 1200 / RES;                        // world blocks per export cell, as imageToMaps defaults
const maps = runImageToMaps(drawCoast(192), RES);
const { water, height, biome } = maps;
const g = RES;
const nbr = i => { const x = i % g, y = (i / g) | 0; return [((x + 1) % g) + y * g, ((x + g - 1) % g) + y * g, x + ((y + 1) % g) * g, x + ((y + g - 1) % g) * g]; };
const isSea = i => biome[i] === SC.Ocean && !water[i];

let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) fails++;
};
const sorted = a => a.slice().sort((x, y) => x - y);
const pct = (a, t) => { const s = sorted(a); return s[Math.floor(t * (s.length - 1))]; };

// A river has to ARRIVE at the sea, not stop above it. Vanilla routes every river downhill until it hits
// an ocean cell and then walks the segment back from that mouth, so a mouth is pinned to sea level by
// construction. A painted channel has no router: it takes its level from whatever banks it happens to
// have, and a body floods outward from its own lowest cell, so a stretch that comes back to the coast a
// long way from its outlet carries the inland level it crossed on the way — its own bank then walls the
// sea out. Measured on a real authored world, one stretch sat 6 blocks over a sea 20 m away.
//
// Vanilla's own figure, over seven stock 1200² worlds: fresh water within 30 m of the sea runs p50/p90/max
// +1 (one seed reaches +3), and NONE of it stands +5 or more. Sea level is a fixed datum — Y 60 — so
// unlike a height band this transfers to a synthetic map unchanged. The broken authored world read max +6
// with 6.6% at +5 or more; this design reads max +1 with the bound and max +7 with 26% at +5 without it.
{
  const ds = new Int32Array(g * g).fill(-1), q = [];
  for (let i = 0; i < g * g; i++) if (isSea(i)) { ds[i] = 0; q.push(i); }
  for (let k = 0; k < q.length; k++) { const c = q[k]; for (const n of nbr(c)) if (ds[n] < 0) { ds[n] = ds[c] + 1; q.push(n); } }
  const v = [];
  for (let i = 0; i < g * g; i++) if (water[i] && ds[i] > 0 && ds[i] * BPC <= 30) v.push(waterY(water[i]) - WL);
  const hung = v.filter(x => x >= 5).length;
  check('fresh water arrives at the sea rather than perching over it', v.length >= 50 && hung === 0 && pct(v, 0.9) <= 3,
    v.length + ' fresh cells within 30 m of the sea: p50 +' + pct(v, 0.5) + ', p90 +' + pct(v, 0.9)
    + ', max +' + Math.max.apply(null, v) + ', ' + hung + ' at +5 or more (vanilla: +1/+1/+1, none at +5)');
}

// The land field must be drawn per CELL, not left smooth. A smooth field is locally a plane, whose
// contours are straight parallel lines, and the mod's terrace then draws them: step sizes over dry land
// came out 86/12/2/0 at 1/2/3/4 blocks against vanilla's 69-75/17-22/5-7/1-2 — single-block contour lines
// following the slope, which is the pinstriped landscape. Keeping nearly the whole Voronoi cell edge
// (CELL_SHARP 0.90 rather than 0.25) makes the field cross a terrace level in a cell or two instead.
//
// This one is asserted on the CONSTANT, which is weaker than the rest of this file and worth saying
// plainly. Two reasons, both measured. The defect itself lives past the mod's terrace, which this suite
// does not model, so what it does to the step-size mix cannot be seen here at all. And the exported maps
// barely move: the corridor cell-snap that landed alongside it re-quantises the whole land field onto the
// SAME sites afterwards, so dropping CELL_SHARP to 0.25 changes 6.6% of land cells by 0.04 blocks on
// average at this resolution and about 1% at 448 — the within-cell/across-cell gradient ratio reads 6.99
// against 6.84, which no honest bound separates. The real guard is metrics/globaldelta.js on a generated
// world; this only stops the constant being quietly turned back down.
check('the land field keeps its cell edges rather than smoothing into a plane', constValue('CELL_SHARP') >= 0.8,
  'CELL_SHARP = ' + constValue('CELL_SHARP') + ' (0.25 leaves the field smooth; the terrace then draws its contours)');

// ---- bank rays: from each shoreline cell, walk inland along increasing distance-from-water.
const rays = (() => {
  const d = new Int32Array(g * g).fill(-1), ws = new Float32Array(g * g), q = [];
  for (let i = 0; i < g * g; i++) if (water[i]) { d[i] = 0; ws[i] = waterY(water[i]); q.push(i); }
  for (let k = 0; k < q.length; k++) {
    const c = q[k]; if (d[c] * BPC >= 60) continue;
    for (const n of nbr(c)) if (d[n] < 0 && !water[n] && !isSea(n)) { d[n] = d[c] + 1; ws[n] = ws[c]; q.push(n); }
  }
  const K = Math.max(2, Math.round(14 / BPC));                 // a 14 m walk inland, in cells
  const lo = Math.round(25 / BPC), hi = Math.round(45 / BPC);  // the land BEHIND the bank
  const out = [];
  for (let i = 0; i < g * g; i++) {
    if (d[i] !== 1) continue;
    let c = i, ok = true; const ys = [landY(height[c])];
    for (let k = 0; k < Math.max(K, hi); k++) {
      let nx = -1; for (const n of nbr(c)) if (d[n] === d[c] + 1) { nx = n; break; }
      if (nx < 0) { ok = false; break; }
      c = nx; ys.push(landY(height[c]));
    }
    if (!ok) continue;                                          // ray ran into the sea or off the corridor
    let biggest = 0;
    for (let k = 1; k <= K; k++) { const s = Math.abs(ys[k] - ys[k - 1]); if (s > biggest) biggest = s; }
    let sum = 0, cnt = 0; for (let k = lo; k <= hi && k < ys.length; k++) { sum += ys[k]; cnt++; }
    if (!cnt) continue;
    out.push({ climb: ys[K] - ys[0], biggest, behind: sum / cnt - ws[i] });
  }
  return out;
})();

// How far a bank climbs must follow WHAT IS BEHIND IT. Split vanilla's shores by how high the land 25-45 m
// back stands over the water and its 14 m climb tracks it: at or below the water it gains 0.9-1.4 blocks,
// at +3..4 it gains 2.5-2.7, at +7 and up 3.6-5.9. A fixed profile added to every bank cannot do that. It
// also only ever ADDS height, so wherever the surroundings are lower the corridor climbs away from the
// water anyway and the river ends on a causeway with terraced sides — measured, that version left only 2%
// of shores with the land 25-45 m out below the river, against vanilla's 4-13%.
//
// The statistic is the RANK correlation between the two, which is why it survives this design being far
// steeper than any real map: it asks whether the ordering holds, not how many blocks anything gained. The
// fixed-profile version reads 0.204 here and the real source 0.479, stable to +-0.03 over a range of
// drawn geometries; the bound sits between them. It is deliberately not a bound on the climb itself —
// that is a height, and heights on this design run about twice vanilla's.
{
  const V = rays.filter(r => isFinite(r.behind));
  const rank = key => { const ix = V.map((_, i) => i).sort((a, b) => V[a][key] - V[b][key]); const r = []; ix.forEach((v, i) => { r[v] = i; }); return r; };
  const ra = rank('behind'), rb = rank('climb');
  let s = 0; for (let i = 0; i < V.length; i++) { const dd = ra[i] - rb[i]; s += dd * dd; }
  const n = V.length, rho = 1 - 6 * s / (n * (n * n - 1));
  const band = (a, b) => { const w = V.filter(r => r.behind >= a && r.behind < b); return w.length < 15 ? null : (w.reduce((t, r) => t + r.climb, 0) / w.length).toFixed(1); };
  check('how far a bank climbs follows the land behind it', n > 100 && rho >= 0.35,
    'rank correlation ' + rho.toFixed(3) + ' over ' + n + ' shore rays; mean 14 m climb by the land 25-45 m back: '
    + '0-3 -> ' + band(0, 3) + ', 3-7 -> ' + band(3, 7) + ', 7-15 -> ' + band(7, 15) + ', 15+ -> ' + band(15, 1e9));
}

// The climb has to be CONCENTRATED, not spread evenly. Vanilla relaxes its valleys on polygons — one
// height per Voronoi cell — so a bank is cell-sized plateaus with the rise on the boundaries, and those
// boundaries are irregular and in a different place on every stretch. A corridor left as a smooth function
// of distance-to-water instead draws a contour line at every block, parallel to the river the whole way:
// concentric shelving, which reads as rice terraces. Measured on a generated world, a 14 m walk inland
// crossed 3.0 separate risers against vanilla's 1.8-2.1, at the same total height gained — so counting the
// height is useless here and only its distribution tells the two apart.
//
// The statistic is the share of a ray's 14 m climb carried by its single biggest riser, which is a ratio
// and so carries over from a design this steep. Snapping the corridor onto the cell grid gives 0.683;
// without it, 0.526. Both are stable to +-0.01 across drawn geometries and the same measure on
// verify-water.js's own design reads 0.686 and 0.527, so the bound is not an artefact of this drawing.
{
  const V = rays.filter(r => r.climb >= 2);        // a ray that barely climbs has no distribution to speak of
  const share = V.reduce((t, r) => t + r.biggest / r.climb, 0) / V.length;
  const risers = V.reduce((t, r) => t + (r.biggest >= r.climb ? 1 : 0), 0);
  check('the climb inland is concentrated in a riser or two, not spread into shelves', V.length > 100 && share >= 0.60,
    'the biggest riser carries ' + (100 * share).toFixed(1) + '% of the 14 m climb on average over ' + V.length
    + ' rays, and the whole of it on ' + (100 * risers / V.length).toFixed(0) + '%');
}

// A river's surface may vary ALONG its length — that is a river descending — but not ACROSS it, which is one
// bank sitting a block over the other. A channel drawn over a hillside takes a high level from its uphill
// side and a low one from its downhill side, and nothing above removes that tilt: the flood only stops a
// cell sitting below the water that reached it, and a plain average shrinks a cross-slope and a descent
// alike. Measured on a real world it left 7.6% of fresh water on a lengthwise split against vanilla's
// 0.7-3.0%, while steps down the flow were already in band.
//
// Scale-free on purpose: the ratio of how much the surface moves across the channel to how much it moves
// along it. Levelling drives the across term toward nothing and leaves the along term alone, so the ratio
// collapses; without it the two are comparable. An absolute bound in blocks would be calibrated on this
// fixture's drawing, which is the mistake the near-water check in verify-water.js made.
{
  const wet = i => water[i] > 0;
  // the local across-channel normal, from the gradient of the water mask
  const mask = new Float32Array(g * g);
  for (let i = 0; i < g * g; i++) mask[i] = wet(i) ? 1 : 0;
  let across = 0, alongSum = 0, nAcross = 0, nAlong = 0;
  for (let y = 1; y < g - 1; y++) for (let x = 1; x < g - 1; x++) {
    const j = y * g + x;
    if (!wet(j)) continue;
    const gx = mask[j + 1] - mask[j - 1], gy = mask[j + g] - mask[j - g];
    const len = Math.hypot(gx, gy);
    if (len < 0.5) continue;                       // interior of a wide body has no usable axis
    const nx = gx / len, ny = gy / len;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const k = j + dx + dy * g;
      if (!wet(k)) continue;
      const d = Math.abs(water[j] - water[k]);   // exported bytes; the ratio is scale-free
      const dot = Math.abs(dx * nx + dy * ny);     // 1 = across the channel, 0 = along it
      if (dot > 0.85) { across += d; nAcross++; } else if (dot < 0.5) { alongSum += d; nAlong++; }
    }
  }
  const a = nAcross ? across / nAcross : 0, b = nAlong ? alongSum / nAlong : 0;
  const ratio = b > 1e-9 ? a / b : (a > 1e-9 ? 99 : 0);
  check('the water surface tilts along the channel, not across it', nAcross > 20 && nAlong > 20 && ratio <= 0.60,
    'across/along movement ' + ratio.toFixed(2) + '  (across ' + a.toFixed(4) + ' over ' + nAcross
    + ' pairs, along ' + b.toFixed(4) + ' over ' + nAlong + ')');
}


console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS ✓');
process.exit(fails ? 1 : 0);