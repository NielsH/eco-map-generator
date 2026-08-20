// Regression test for imported lakes/rivers (src/designer.js `imageToMaps`).
//
// Guards the properties that decide whether water reads as water in game. Eco fills every column
// independently to `60 + 60*waterValue`, so the per-cell level this exports IS what the player sees:
//   * neighbouring water cells must not step much — a big step is a wall of water mid-lake
//   * water must never sit above the LAND beside it — that is water pouring over terrain
//   * a lake basin must be ONE level, or it is a staircase
//   * a lake must be dug to a lake's depth and a channel to a channel's
// Note what is deliberately NOT asserted: distinct levels per body. A river descending a hillside
// legitimately has one per block; counting them flags correct output as broken.
//
// `imageToMaps` is pulled straight out of the real source by brace matching, so this tracks edits to
// designer.js rather than duplicating it. The only stub is the bit of canvas it touches.
//
//   node test/verify-water.js
'use strict';
const { SC, COLOR, FRESH, runImageToMaps, constValue, WL, RELIEF, waterY, landY } = require('./designer-harness');

/** A continent with a round lake and a river running off it to the sea. */
function drawDesign(S) {
  const px = new Uint8ClampedArray(S * S * 4);
  const put = (x, y, c) => { const o = (y * S + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - S / 2, dy = y - S / 2, r = Math.sqrt(dx * dx + dy * dy);
    put(x, y, r < S * 0.40 ? (r < S * 0.16 ? COLOR.Taiga : COLOR.Grassland) : COLOR.Ocean);
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {           // round lake, well inland
    const dx = x - S * 0.44, dy = y - S * 0.44;
    if (dx * dx + dy * dy < (S * 0.075) * (S * 0.075)) put(x, y, FRESH);
  }
  // River from the lake to the coast. It MEANDERS: a dead straight channel has the same bank on both
  // sides, so a per-cell level taken from the banks agrees across it by symmetry and the along-the-bank
  // stepping this design is meant to catch never appears.
  for (let y = Math.round(S * 0.50); y < Math.round(S * 0.86); y++) {
    const off = Math.round(S * 0.045 * Math.sin(y * 0.16));
    for (let x = Math.round(S * 0.43) + off; x < Math.round(S * 0.46) + off; x++) put(x, y, FRESH);
  }
  // A channel running ACROSS the slope, at a constant distance from the middle rather than down it. This is
  // the shape that perches water: the level its uphill bank justifies stands above the ground falling away
  // on the downhill side. A design where every course runs downhill cannot produce the case at all.
  for (let a = -0.75; a < 0.75; a += 0.004) {
    const r = S * 0.30;
    const x = Math.round(S / 2 + Math.cos(a + 2.4) * r), y = Math.round(S / 2 + Math.sin(a + 2.4) * r);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const px2 = x + dx, py2 = y + dy;
      if (px2 >= 0 && px2 < S && py2 >= 0 && py2 < S) put(px2, py2, FRESH);
    }
  }
  return { width: S, height: S, data: px };
}

const RES = 256;
const maps = runImageToMaps(drawDesign(192), RES);
const { water, height, biome } = maps;
const g = RES;
const nbr = i => { const x = i % g, y = (i / g) | 0; return [((x + 1) % g) + y * g, ((x + g - 1) % g) + y * g, x + ((y + 1) % g) * g, x + ((y + g - 1) % g) * g]; };

let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) fails++;
};

let cells = 0; for (let i = 0; i < g * g; i++) if (water[i]) cells++;
check('the drawn lake and river survive import as fresh water', cells > 100, cells + ' water cells');

let maxStep = 0, bigSteps = 0;
for (let i = 0; i < g * g; i++) {
  if (!water[i]) continue;
  for (const n of nbr(i)) { if (!water[n]) continue; const d = Math.abs(waterY(water[i]) - waterY(water[n])); if (d > maxStep) maxStep = d; if (d >= 2) bigSteps++; }
}
// A big step is NOT wrong in itself — a lake draining into a lower channel is a waterfall, and the strict
// no-steps rule belongs to open water (asserted below). What must not happen is roughness everywhere.
let pairs = 0;
for (let i = 0; i < g * g; i++) { if (!water[i]) continue; for (const n of nbr(i)) if (water[n]) pairs++; }
check('water is smooth almost everywhere', bigSteps / pairs < 0.02,
  bigSteps + ' of ' + pairs + ' pairs step 2+ blocks (' + (100 * bigSteps / pairs).toFixed(1) + '%), biggest ' + maxStep);

// Ocean neighbours are excluded: a river mouth is meant to sit above sea level.
let over = 0, worst = 0;
for (let i = 0; i < g * g; i++) {
  if (!water[i]) continue;
  for (const n of nbr(i)) {
    if (water[n] || biome[n] === SC.Ocean) continue;
    const d = waterY(water[i]) - landY(height[n]);
    if (d > 0) { over++; if (d > worst) worst = d; }
  }
}
check('water never sits above the land beside it', over === 0, over + ' cells (worst ' + worst + ' blocks)');

let dmin = Infinity, dmax = -Infinity;
for (let i = 0; i < g * g; i++) if (water[i]) { const d = waterY(water[i]) - landY(height[i]); if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
// Every column must hold at least a block. The floor is set AFTER the byte rounding, since the export
// loses up to a block of depth on the way out; before that fix 307 columns arrived holding less, and on a
// mirrored map 241 of them were wet on one isle and dry on the other. The shelf deliberately runs shallow
// at the very edge, so 1 is the bound here rather than the 2 the interior holds.
check('water is a sane depth, not a pit', dmin >= 1, dmin + '..' + dmax + ' blocks');

// Depth must FOLLOW VANILLA, which deepens away from the bank without capping: its flood adds
// `depthChange = 2` grays per ring inward from 1 (VoronoiWorldGenerator), one gray being
// 2*(maxGen-waterLevel)/255 = 0.47 blocks on a 60/120 world. Its enclosure test is 8-neighbour, so the
// distance is CHEBYSHEV. One fixed depth instead makes every body the same however wide it is, and a lake
// comes out a puddle — on a real map, water 20 blocks from shore was 3.6 blocks deep against vanilla's
// 18.4. Near the bank the shelf is deliberately DEEPER than vanilla (1.8 blocks against 0.5), because that
// is what holds the bed-to-bank step under the cliff threshold, so the rule there is the deeper of the two.
{
  const dIn = new Int16Array(g * g).fill(-1), qq = [];
  for (let i = 0; i < g * g; i++) if (!water[i]) { dIn[i] = 0; qq.push(i); }
  for (let k = 0; k < qq.length; k++) {
    const c = qq[k], cx = c % g, cy = (c / g) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nb = ((cx + dx + g) % g) + ((cy + dy + g) % g) * g;
      if (dIn[nb] < 0 && water[nb]) { dIn[nb] = dIn[c] + 1; qq.push(nb); }
    }
  }
  const BPC = 1200 / g;                                     // blocks per cell, as imageToMaps defaults
  let cells = 0, off = 0, worstOff = 0, atFloor = 0;
  for (let i = 0; i < g * g; i++) {
    if (!water[i] || dIn[i] < 1) continue;
    // Capped at 8 blocks. Vanilla's rule deepens without limit, which suits channels 6-12 m wide; ours are
    // 16-32 m by design and the same rule takes them to 15, against vanilla's own measured max of 11.
    // It is the CHANNEL cap that applies across this design: its lake drains into the river, so the two
    // are one body, and no body here fills enough of its own box to be dug deeper. The lake cap gets its
    // own design at the end of this file.
    const want = Math.min(8, Math.max(1.8, Math.max(1, 2 * ((dIn[i] - 0.5) * BPC) - 1) * 0.4706));
    if (waterY(water[i]) - want < 4) { atFloor++; continue; }   // vanilla bottoms out here too
    const d = Math.abs((waterY(water[i]) - landY(height[i])) - want);
    cells++; off += d; if (d > worstOff) worstOff = d;
  }
  const avg = cells ? off / cells : 99;
  check('depth follows vanilla up to the cap, deepening away from the bank', cells > 0 && avg < 1.5,
    'off vanilla by ' + avg.toFixed(2) + ' blocks on average, worst ' + worstOff.toFixed(1)
    + ' (' + cells + ' cells, ' + atFloor + ' at the world floor)');
}

// A body gets deeper away from its bank, never shallower. The min/max above cannot see the difference:
// a lake shelved the wrong way round — a deep ring around a shallow middle — has exactly the same range,
// and drains in game, because the middle rounds away to nothing. Bucket the depth by distance from the
// shore and require it not to fall back as you go inward.
{
  const dIn = new Int16Array(g * g).fill(-1), qq = [];
  for (let i = 0; i < g * g; i++) if (!water[i]) { dIn[i] = 0; qq.push(i); }
  for (let k = 0; k < qq.length; k++) { const c = qq[k]; for (const n of nbr(c)) if (dIn[n] < 0) { dIn[n] = dIn[c] + 1; qq.push(n); } }
  const sum = [], cnt = [];
  for (let i = 0; i < g * g; i++) {
    if (!water[i]) continue;
    const d = dIn[i];
    sum[d] = (sum[d] || 0) + (waterY(water[i]) - landY(height[i])); cnt[d] = (cnt[d] || 0) + 1;
  }
  const means = [];
  for (let d = 1; d < sum.length; d++) if (cnt[d] >= 8) means.push([d, sum[d] / cnt[d]]);
  let worstDrop = 0, at = 0;
  for (let k = 1; k < means.length; k++) {
    const drop = means[k - 1][1] - means[k][1];
    if (drop > worstDrop) { worstDrop = drop; at = means[k][0]; }
  }
  // Tolerance is a whole block: depth here is quantised to blocks, so the shelf's first ring wobbles by
  // one either way as its ramp crosses a boundary. The bug this guards against is an inverted shelf, which
  // drops ~2 blocks and holds it across the whole interior — well clear of rounding.
  check('a lake deepens away from its bank, not the reverse', worstDrop <= 1.0,
    means.map(m => 'd' + m[0] + '=' + m[1].toFixed(1)).join(' ') + (worstDrop > 0.5 ? '  <- drops ' + worstDrop.toFixed(1) + ' at d' + at : ''));
}

// CliffExtruder builds a rock face wherever two columns differ by 5 blocks or more, and for a water
// column the top SOLID block is the bed — not the surface. So the step it measures at a shoreline is
// (bank above the water) + (depth of the water), and a bed a fixed depth down plus any bank at all
// cleared it: 52.9% of shoreline pairs on a generated world, which is a stone retaining wall around
// every lake and river. Nothing else here catches it — the water is level, the banks are low, and no
// bed is dry; the defect is only in the difference between them.
{
  let shorePairs = 0, walls = 0, worstStep = 0;
  for (let i = 0; i < g * g; i++) {
    if (!water[i]) continue;
    const bed = landY(height[i]);
    for (const nb of nbr(i)) {
      if (water[nb] || biome[nb] === SC.Ocean) continue;      // the sea has its own shelf and keeps its cliffs
      shorePairs++;
      const step = landY(height[nb]) - bed;
      if (step > worstStep) worstStep = step;
      if (step >= 5) walls++;
    }
  }
  check('the shoreline step stays under the cliff threshold', walls === 0,
    walls + ' of ' + shorePairs + ' shoreline pairs step 5+ blocks bed-to-bank, worst ' + worstStep);
}

// The round lake must be ONE level. Width = distance from the nearest non-water cell, so the lake basin
// is the wide part; the river is one or two cells across and is allowed to descend.
const dist = new Int16Array(g * g).fill(-1), q = [];
for (let i = 0; i < g * g; i++) if (!water[i]) { dist[i] = 0; q.push(i); }
for (let h = 0; h < q.length; h++) { const c = q[h]; for (const n of nbr(c)) if (dist[n] < 0) { dist[n] = dist[c] + 1; q.push(n); } }
const widest = Math.max.apply(null, Array.from({ length: g * g }, (_, i) => (water[i] ? dist[i] : 0)));
const basin = []; for (let i = 0; i < g * g; i++) if (water[i] && dist[i] >= Math.max(2, widest - 1)) basin.push(i);
const basinLevels = new Set(basin.map(i => waterY(water[i])));
check('the lake basin is a single flat level', basinLevels.size === 1, basin.length + ' cells, ' + basinLevels.size + ' level(s)');

// Ground beyond the rim must be ALLOWED to sit below the water. This is the bowl test, and it is the whole
// point of taking the level from the immediate ring: when the surface was instead the minimum over a ~54 m
// radius, nothing within that radius could be lower by construction, so the ground could only rise away
// from the water. Vanilla has no such rule — 30-45% of the ground 20 m from its fresh water is below the
// water line, because it contains a lake with its own rim and lets the terrain beyond do as it likes.
{
  let beyond = 0, below = 0;
  // distance from water, outward over land
  const dw = new Int16Array(g * g).fill(-1), qq = [];
  for (let i = 0; i < g * g; i++) if (water[i]) { dw[i] = 0; qq.push(i); }
  for (let k = 0; k < qq.length; k++) {
    const c = qq[k]; if (dw[c] >= 15) continue;
    for (const n of nbr(c)) if (dw[n] < 0 && !water[n]) { dw[n] = dw[c] + 1; qq.push(n); }
  }
  // nearest water surface, carried outward with the same walk
  const ws = new Float32Array(g * g), q2 = [], seen = new Uint8Array(g * g);
  for (let i = 0; i < g * g; i++) if (water[i]) { ws[i] = waterY(water[i]); seen[i] = 1; q2.push(i); }
  for (let k = 0; k < q2.length; k++) {
    const c = q2[k]; if (dw[c] >= 15) continue;
    for (const n of nbr(c)) if (!seen[n] && dw[n] > 0) { seen[n] = 1; ws[n] = ws[c]; q2.push(n); }
  }
  for (let i = 0; i < g * g; i++) {
    if (water[i] || biome[i] === SC.Ocean || dw[i] < 5 || dw[i] > 15) continue;
    beyond++; if (landY(height[i]) < ws[i]) below++;
  }
  // Calibrated on this design: min-propagating the level gives 3.2%, taking it from the ring gives 7.1%,
  // vanilla runs 30-45%. The bound sits between the first two, so reinstating a reach-based minimum fails
  // here. It is deliberately well under vanilla — this design is a smooth cone, which has far fewer
  // hollows to find than vanilla's per-cell elevation does.
  const pct = beyond ? below / beyond * 100 : 0;
  check('ground beyond the rim may sit below the water', beyond > 0 && pct >= 5,
    below + ' of ' + beyond + ' cells 5-15 away are below the water line (' + pct.toFixed(1) + '%) — vanilla runs 30-45%');
}

// Open water must be dead flat everywhere, not just at the very middle. A gentle ramp across a lake
// quantises to whole blocks and shows up in game as a ridged bed under otherwise flat water — which is
// far more obvious than the numbers suggest, so it gets its own check.
let openPairs = 0, openStepped = 0;
for (let i = 0; i < g * g; i++) {
  if (!water[i] || dist[i] < 4) continue;
  for (const n of nbr(i)) { if (!water[n] || dist[n] < 4) continue; openPairs++; if (waterY(water[i]) !== waterY(water[n])) openStepped++; }
}
check('open water has no ridges in it', openStepped === 0, openStepped + ' stepped pairs of ' + openPairs);

// Big drops are fine — a lake falling into a lower channel is a waterfall — but never out in open water.
let midOpen = 0;
for (let i = 0; i < g * g; i++) {
  if (!water[i] || dist[i] < 4) continue;
  for (const n of nbr(i)) { if (!water[n] || dist[n] < 4) continue; if (Math.abs(waterY(water[i]) - waterY(water[n])) >= 3) midOpen++; }
}
check('no wall of water out in open water', midOpen === 0, midOpen + ' such pairs');


// The ring touching the water must not stand proud of the ground BEHIND it. Its own height is decided by
// the water in front — floored just over the surface so it holds the water in — while the ground behind is
// shaped by the valley pass, which stops lifting some way UNDER the surface. Those two heights need not
// meet, and where they do not the bank comes out as a kerb running along the water with the field behind
// it lower. Measured on a real map, the ring stood 0.94 blocks over the ground behind it at p90 and 2.4 at
// worst, against vanilla's 0.00 and 1.4.
{
  const d = new Int16Array(g * g).fill(-1), qq = [];
  for (let i = 0; i < g * g; i++) if (water[i]) { d[i] = 0; qq.push(i); }
  for (let k = 0; k < qq.length; k++) { const c = qq[k]; if (d[c] >= 3) continue;
    for (const n of nbr(c)) if (d[n] < 0 && !water[n]) { d[n] = d[c] + 1; qq.push(n); } }
  const st = [];
  for (let i = 0; i < g * g; i++) {
    if (d[i] !== 1 || biome[i] === SC.Ocean) continue;
    let mx = -Infinity;
    for (const n of nbr(i)) if (d[n] === 2 && biome[n] !== SC.Ocean) { const s = landY(height[i]) - landY(height[n]); if (s > mx) mx = s; }
    if (mx > -Infinity) st.push(mx);
  }
  st.sort((a, b) => a - b);
  // The bound is on the WORST cell, not a percentile: most of the ring is already flush either way, and it
  // is the occasional kerb that shows. Vanilla tops out at 1.4 blocks over the ground behind it.
  const worst = st.length ? st[st.length - 1] : 0;
  check('the bank does not stand proud of the ground behind it', st.length > 0 && worst <= 1,
    'ring sits at worst ' + worst.toFixed(1) + ' blocks over the ground behind it, p90 '
    + st[Math.floor(0.9 * (st.length - 1))].toFixed(1) + ' (' + st.length + ' cells)');
}

// Ground LOWER than the water beside it must be lifted toward it, not left at its full depth. The valley
// pass used to relax in one direction only — it pulled high ground down and did nothing at all to a cell
// already below the water — so where a course ran past lower terrain the bank stood at the top of the
// whole fall. Measured at world resolution with the mod's terrace applied, the ground 20 m out from a bank
// fell 4.1 blocks below it against vanilla's 2.9, and 5.6 at 30 m against 4.1. On the test design the
// same measure reads p90 4.0 blocks before and 3.0 after, over 179 cells and 97.
{
  const d = new Int16Array(g * g).fill(-1), ws = new Float32Array(g * g), qq = [];
  for (let i = 0; i < g * g; i++) if (water[i]) { d[i] = 0; ws[i] = waterY(water[i]); qq.push(i); }
  for (let k = 0; k < qq.length; k++) {
    const c = qq[k]; if (d[c] >= 10) continue;
    for (const n of nbr(c)) if (d[n] < 0 && !water[n]) { d[n] = d[c] + 1; ws[n] = ws[c]; qq.push(n); }
  }
  const falls = [];
  for (let i = 0; i < g * g; i++) {
    if (water[i] || d[i] < 1 || d[i] > 6 || biome[i] === SC.Ocean) continue;
    const drop = ws[i] - landY(height[i]);
    if (drop > 0) falls.push(drop);
  }
  falls.sort((a, b) => a - b);
  const p90 = falls.length ? falls[Math.floor(0.9 * (falls.length - 1))] : 0;
  check('ground below a bank is lifted toward the water, not left at its full depth', falls.length === 0 || p90 <= 3.5,
    falls.length + ' cells within 6 of a bank sit below its water, p90 ' + p90.toFixed(1) + ' blocks down');
}

// A MIRRORED map must hold water in mirrored places. Both maps leave here as bytes and Eco truncates the
// water one, so a column can lose most of a block of depth on the way out; where that takes it under a
// block, Eco fills the column to nothing. The terrain noise under the two halves of a mirrored world is
// NOT mirrored, so the two halves round differently and the water goes missing on ONE side — a river that
// runs on one isle and not on its twin. Measured on a real mirrored map before this was fixed: 307 columns
// held under a block and 241 of them were wet on one isle and dry on the other.
{
  // Drawn at the grid resolution so the decode is 1:1 — at 192 into a 256 grid, mirrored source pixels do
  // not land on mirrored cells and the water mask comes out lopsided for that reason alone.
  const src = drawDesign(RES);
  const S = src.width, px = Uint8ClampedArray.from(src.data);
  for (let y = 0; y < S; y++) for (let x = 0; x < S / 2; x++) {          // make the SOURCE exactly mirrored
    const a = (y * S + x) * 4, b = (y * S + ((S - x) % S)) * 4;
    px[b] = px[a]; px[b + 1] = px[a + 1]; px[b + 2] = px[a + 2]; px[b + 3] = px[a + 3];
  }
  const m = runImageToMaps({ width: S, height: S, data: px }, RES);
  let wet = 0, lopsided = 0;
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const i = y * RES + x, j = y * RES + ((RES - x) % RES);
    const a = m.water[i] ? waterY(m.water[i]) - landY(m.height[i]) : 0;
    const b = m.water[j] ? waterY(m.water[j]) - landY(m.height[j]) : 0;
    if (a >= 1) { wet++; if (b < 1) lopsided++; }
  }
  check('a mirrored map holds water in mirrored places', wet > 0 && lopsided === 0,
    lopsided + ' of ' + wet + ' water columns are wet on one side and dry on its mirror');
}

// The ground NEAR the water must sit close to its level on BOTH sides of that level. Climbing away from
// the water without stopping is a trench cut through a plateau; being left UNDER the water line is an
// aqueduct, with the field falling away beside the course. This is different from the trench check
// further down, which bounds the worst rise anywhere within 20 m and so still passes when the ground
// climbs steadily the whole way.
//
// Height over FRESH water by distance, measured on eight stock worlds (seven 1200² seeds plus a 720²
// real save) — min-max across them:
//        1 m      3 m      6 m     10 m     15 m     20 m     30 m     40 m
//     0.2-0.4  0.5-0.8  1.1-1.8  1.8-2.7  1.9-2.8  1.8-2.7  1.6-2.7  1.5-2.8
// A valley that climbs for about 10 m and then plateaus. Over the 6-20 m band that is a mean of 1.8-2.7
// blocks, a p90 of 3-7, and 1.7-6.1% of the land sitting below the water line.
//
// Those absolute numbers do NOT transfer to this suite. Its map is a cone with a course drawn down it,
// far steeper than anything the generator makes, and the design reads about twice vanilla's height at
// every percentile here (p90 10 against vanilla's 3-7). So the two bounds are calibrated on this map's own
// behaviour and assert a shape rather than vanilla's figures:
//   * p90 <= 14 blocks — the band does not climb away into a wall;
//   * under 1.5% of it below the water — the ground beside the course is not left under the water it is
//     holding. Deliberately TIGHTER than vanilla's 1.7-6.1%, and it would fail vanilla's own worlds:
//     vanilla's rivers run through terrain that was already low, this map's are drawn down a cone, so
//     any sunken ground here is ground nothing lifted. Further out it may sink, and the rim check above
//     requires exactly that at 23-70 m; this band is where the relaxation is supposed to have run.
//
// What was here before was a mean under 5, justified by a vanilla figure of "0.7-1.1 blocks flat from
// 3 m out to 40 m" that no world measures — the profile above is what eight of them measure. It also had
// no teeth: the mean reads 4.5 on this design and 4.5 again with the valley relaxation deleted outright,
// because that pass barely moves ground already above the water and only the sunken side changes, so the
// two cancel. Scores now — this design 10 / 0.2%, a valley-profiled candidate 12 / 0.0%, no valley pass
// at all 10 / 4.8%, pull-down-only 10 / 4.8%, and two variants that let the bank climb straight to the
// hillside 16 / 0.2% and 23 / 0.2%.
{
  const mpc = 1200 / g;
  const d = new Int16Array(g * g).fill(-1), ws = new Float32Array(g * g), qq = [];
  for (let i = 0; i < g * g; i++) if (water[i]) { d[i] = 0; ws[i] = waterY(water[i]); qq.push(i); }
  for (let k = 0; k < qq.length; k++) {
    const c = qq[k]; if (d[c] * mpc >= 24) continue;
    for (const n of nbr(c)) if (d[n] < 0 && !water[n]) { d[n] = d[c] + 1; ws[n] = ws[c]; qq.push(n); }
  }
  const rise = [];
  for (let i = 0; i < g * g; i++) {
    if (water[i] || d[i] < 1 || biome[i] === SC.Ocean) continue;
    const m = d[i] * mpc; if (m < 6 || m > 20) continue;
    rise.push(landY(height[i]) - ws[i]);
  }
  rise.sort((a, b) => a - b);
  const p90 = rise.length ? rise[Math.floor(0.9 * (rise.length - 1))] : 99;
  const sunk = rise.filter(v => v < 0).length;
  const pct = rise.length ? 100 * sunk / rise.length : 99;
  check('the ground beside the water is near its level', rise.length > 0 && p90 <= 14 && pct < 1.5,
    'land 6-20 m out: p90 ' + p90 + ' blocks over the water, ' + sunk + ' of ' + rise.length
    + ' cells (' + pct.toFixed(1) + '%) below it');
}

// Water must not stand on an EMBANKMENT. Taking the level from the immediate ring alone lets a course
// running along a slope take the level its uphill bank justifies; the restore then raises the downhill
// bank to hold it, and the ground beyond falls away — in game, an aqueduct. Measured on a real map, 7.1%
// of water cells stood more than 2 blocks over the lowest ground within 20 m, and a version that routed
// courses along contours to lengthen them reached 17.8%, with drops of 10.8 blocks. Vanilla runs 2.4-6.0%.
// Bounding the level by the average height of the surrounding ground takes this design's figure to 0.
{
  const R = Math.max(2, Math.round(20 / (1200 / g)));
  let cells = 0, perched = 0, worstDrop = 0;
  for (let i = 0; i < g * g; i++) {
    if (!water[i]) continue;
    let lowest = Infinity;
    const seen = new Uint8Array(g * g), st = [[i, 0]]; seen[i] = 1;
    while (st.length) {
      const [c, d] = st.pop(); if (d >= R) continue;
      for (const n of nbr(c)) {
        if (seen[n]) continue; seen[n] = 1;
        if (!water[n] && biome[n] !== SC.Ocean) { const y = landY(height[n]); if (y < lowest) lowest = y; }
        st.push([n, d + 1]);
      }
    }
    if (!isFinite(lowest)) continue;
    const drop = waterY(water[i]) - lowest;
    cells++; if (drop > 2) perched++; if (drop > worstDrop) worstDrop = drop;
  }
  const pct = cells ? 100 * perched / cells : 0;
  check('the water is not standing on an embankment', cells > 0 && pct < 6,
    perched + ' of ' + cells + ' water cells sit 2+ blocks over the lowest ground within 20 m ('
    + pct.toFixed(1) + '%), worst ' + worstDrop);
}

// The first ring of land must be a LIP, not a terrace. Capping it at a fixed height over the water makes
// the cap bind along most of the shoreline, and every cell it binds ends up at exactly that height — a
// flat-topped ledge of constant height following the channel, which reads as masonry rather than as
// ground. Vanilla's first ring averages 0.3-0.45 blocks over its water; a 2-block cap put a real map at
// 1.37, a 1-block cap 0.93, and a half-block cap 0.45 — vanilla's own figure. On this design the caps
// read 2.61 / 1.75 / 1.45 respectively — higher throughout, because
// the ring here is quantised to whole blocks and the design is a steep cone — so the bound sits between
// those two. It is on the average, since the floor under it is the shoreline restore, which must keep the
// land above the water it holds back.
{
  let sum = 0, cnt = 0, atCap = new Map();
  for (let i = 0; i < g * g; i++) {
    if (water[i]) continue;
    let s = -Infinity;
    for (const n of nbr(i)) if (water[n] && waterY(water[n]) > s) s = waterY(water[n]);
    if (s === -Infinity) continue;
    const v = landY(height[i]) - s;
    sum += v; cnt++;
    const k = Math.round(v * 2) / 2; atCap.set(k, (atCap.get(k) || 0) + 1);
  }
  const avg = cnt ? sum / cnt : 0;
  let top = 0, topAt = 0; for (const [k, v] of atCap) if (v > top) { top = v; topAt = k; }
  check('the bank is a lip, not a terrace of constant height', cnt > 0 && avg < 1.5,
    'first ring averages ' + avg.toFixed(2) + ' blocks over the water; commonest height ' + topAt
    + ' blocks on ' + (100 * top / cnt).toFixed(0) + '% of it');
}

// The ring of water touching the bank must not step. Eco fills every column separately, so two touching
// water cells that disagree render as a step — and a channel is only a few cells wide, so a step in that
// ring runs ALONG the shoreline rather than down the river: a waterfall the length of the bank. Taking
// each cell's level from its own four neighbours produces exactly that, since neighbouring cells see
// different banks.
//
// This measures the RAW disagreement, not the rounded block step. The rounded count is unusable here: the
// design's surface sits near a block boundary, so it swings between 7% and 40% of bank pairs on changes
// that move the surface by a hundredth of a block. The raw level is finer than a block (255 steps over 60)
// and orders the three versions cleanly — 0.077 before the ring-average level, 0.132 with it, 0.053 once
// the surface is averaged along the water. On a real map the same change takes the bank ring from 41.5%
// of its pairs stepping a whole block to 6.2%.
{
  const dIn = new Int16Array(g * g).fill(-1), qq = [];
  for (let i = 0; i < g * g; i++) if (!water[i]) { dIn[i] = 0; qq.push(i); }
  for (let k = 0; k < qq.length; k++) { const c = qq[k]; for (const nb of nbr(c)) if (dIn[nb] < 0 && water[nb]) { dIn[nb] = dIn[c] + 1; qq.push(nb); } }
  let ring = 0, ringStep = 0, worstRing = 0;
  for (let i = 0; i < g * g; i++) {
    if (dIn[i] !== 1) continue;
    for (const nb of nbr(i)) {
      if (dIn[nb] !== 1 || nb < i) continue;
      const d = Math.abs(water[i] - water[nb]) * (RELIEF / 255);      // the raw level, not the rounded block
      ring++; ringStep += d; if (d > worstRing) worstRing = d;
    }
  }
  const avg = ring ? ringStep / ring : 0;
  check('the water touching the bank does not step along it', ring > 0 && avg < 0.10,
    'neighbouring bank cells differ by ' + avg.toFixed(3) + ' blocks on average, worst ' + worstRing.toFixed(2) + ' (' + ring + ' pairs)');
}

// No cell may sit above EVERY water neighbour. A waterfall is higher than some and lower than others; a
// cell higher than all of them is a spike, and renders as a lump of bed with a puddle on top standing
// mid-channel. Note this design does not currently produce one — the spikes came from a bank estimate
// under open water on a real map — so this is a guard, not a reproduction. The demonstration lives in the
// PR's measurement of a generated world.
{
  let spikes = 0, worstSpike = 0;
  for (let i = 0; i < g * g; i++) {
    if (!water[i]) continue;
    let mx = -Infinity;
    for (const n of nbr(i)) if (water[n] && waterY(water[n]) > mx) mx = waterY(water[n]);
    if (mx === -Infinity) continue;
    const up = waterY(water[i]) - mx;
    if (up >= 2) { spikes++; if (up > worstSpike) worstSpike = up; }
  }
  check('no water cell perches above all of its neighbours', spikes === 0,
    spikes + ' spikes, worst ' + worstSpike + ' blocks over every neighbour');
}

// Banks must be a valley, not a trench. The measure is the one that matches what a player sees: for each
// shoreline cell, how high the ground gets within 20 m of it. A mean over distance rings hides this — it
// pools flat lake shores with steep river gorges and reads as gentle while a tenth of the shoreline is a
// cliff — so this checks the upper percentiles.
{
  const REACH = Math.max(2, Math.round(20 / (1200 / g)));       // 20 world blocks, in export cells
  const dw = new Int16Array(g * g).fill(-1), qq = [];
  for (let i = 0; i < g * g; i++) if (water[i]) { dw[i] = 0; qq.push(i); }
  for (let k = 0; k < qq.length; k++) {
    const c = qq[k]; if (dw[c] >= REACH) continue;
    for (const n of nbr(c)) if (dw[n] < 0 && !water[n]) { dw[n] = dw[c] + 1; qq.push(n); }
  }
  const rises = [];
  for (let i = 0; i < g * g; i++) {
    if (dw[i] !== 1) continue;
    let mx = landY(height[i]);
    const seen = new Set([i]), st = [[i, 0]];
    while (st.length) {
      const [c, d] = st.pop(); if (d >= REACH) continue;
      for (const n of nbr(c)) { if (seen.has(n) || water[n] || dw[n] < 0) continue; seen.add(n); const y = landY(height[n]); if (y > mx) mx = y; st.push([n, d + 1]); }
    }
    rises.push(mx - WL);
  }
  rises.sort((a, b) => a - b);
  const P = t => rises.length ? rises[Math.floor(t * rises.length)] : 0;
  // Calibrated on this design, which is a far steeper cone of a continent than a real map: the fixed-slope
  // carve this replaced gives p90 32, the relaxation gives p90 22. The bound sits between them, so it
  // catches a return to a slope-limited carve without tripping on ordinary retuning of the pull or reach.
  check('fresh-water banks are a valley, not a trench', P(0.9) <= 26,
    'median ' + P(0.5) + ', p90 ' + P(0.9) + ', max ' + (rises[rises.length - 1] || 0) + ' blocks within 20 m');
}

// ---- a LAKE gets a deeper bed than a channel, and nothing else does ------------------------------
//
// The bed is capped at 8 blocks because a deep channel cuts like a canyon. A lake has no such problem,
// and a stock world's are not 8 either: over seven of them fresh water reaches 10-12 blocks at p99 and
// 13-17 at worst, and their ~2,500-cell lakes run 11-14 deep. `imageToMaps` separates the two by SHAPE,
// the way WorldGenAnalysis/metrics/lakes.js does when it measures a generated world — a body's area
// against the area of its own bounding box.
//
// So this design draws four bodies of the SAME width, wide enough that vanilla's ramp wants far more
// than the cap in every one of them, and leaves that ratio as the only thing separating them: a round
// lake, a winding river, and a pair of diagonal bars whose lengths land either side of the threshold
// (a 45-degree bar of width h and length w fills 2wh/(w+h)² of its box, so length alone moves it).
// Each body is drawn well clear of the others, since two that touch are one body to the test.
function drawBodies(S) {
  const px = new Uint8ClampedArray(S * S * 4);
  const put = (x, y, c) => { if (x < 0 || y < 0 || x >= S || y >= S) return; const o = (y * S + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - S / 2, dy = y - S / 2, r = Math.sqrt(dx * dx + dy * dy);
    put(x, y, r < S * 0.47 ? (r < S * 0.18 ? COLOR.Taiga : COLOR.Grassland) : COLOR.Ocean);
  }
  const disc = (cx, cy, rad) => { for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++)
    if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) put(x, y, FRESH); };
  // A 45-degree bar: |u| <= w/2 across the long axis, |v| <= h/2 across the short one.
  const bar = (cx, cy, w, h) => { const R = Math.ceil((w + h) / 2);
    for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) {
      const u = (x - cx + y - cy) / Math.SQRT2, v = (x - cx - y + cy) / Math.SQRT2;
      if (Math.abs(u) <= w / 2 && Math.abs(v) <= h / 2) put(x, y, FRESH);
    } };
  disc(Math.round(S * 0.30), Math.round(S * 0.28), Math.round(S * 0.080));    // the lake
  bar(Math.round(S * 0.71), Math.round(S * 0.27), S * 0.150, S * 0.052);      // short bar: fills ~0.38 of its box
  bar(Math.round(S * 0.71), Math.round(S * 0.66), S * 0.235, S * 0.052);      // long bar:  fills ~0.29
  // The river: a meander of the same width. Its bends are what keep its body from filling its own box —
  // the excursion sets the box's height while only the channel itself is water.
  for (let t = 0; t <= 1; t += 0.0015) {
    const x = Math.round(S * (0.13 + 0.37 * t)), y = Math.round(S * (0.72 + 0.12 * Math.sin(t * 2 * Math.PI)));
    disc(x, y, Math.round(S * 0.024));
  }
  return { width: S, height: S, data: px };
}

{
  const S = 320, R2 = 256;
  const m2 = runImageToMaps(drawBodies(S), R2);
  const wet = i => m2.water[i] > 0;
  const nb2 = i => { const x = i % R2, y = (i / R2) | 0; return [((x + 1) % R2) + y * R2, ((x + R2 - 1) % R2) + y * R2, x + ((y + 1) % R2) * R2, x + ((y + R2 - 1) % R2) * R2]; };
  const OLD_CAP = constValue('MAX_DEPTH');            // what every body used to be held to
  const LAKE_FILL = constValue('LAKE_FILL');
  const LAKE_MAX = constValue('LAKE_MAX_DEPTH');
  const seen = new Uint8Array(R2 * R2), bodies = [];
  for (let i = 0; i < R2 * R2; i++) {
    if (!wet(i) || seen[i]) continue;
    const st = [i]; seen[i] = 1; const cells = [];
    while (st.length) { const c = st.pop(); cells.push(c); for (const n of nb2(c)) if (wet(n) && !seen[n]) { seen[n] = 1; st.push(n); } }
    if (cells.length < 40) continue;                  // stray specks left by the resample
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, deepest = 0;
    for (const c of cells) {
      const x = c % R2, y = (c / R2) | 0;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      const d = waterY(m2.water[c]) - landY(m2.height[c]); if (d > deepest) deepest = d;
    }
    bodies.push({ cells, fill: cells.length / ((x1 - x0 + 1) * (y1 - y0 + 1)), deepest });
  }
  // In fill order the design's four bodies are: the round lake, the short bar, then the long bar and
  // the river. Which side of the threshold each bar lands on IS the threshold, so the split is pinned
  // to the design rather than read back out of LAKE_FILL — a check that recomputes its own expectation
  // from the constant it is guarding moves with it and can never fail.
  bodies.sort((a, b) => b.fill - a.fill);
  const shown = bodies.map(b => 'fill ' + b.fill.toFixed(2) + ' -> ' + b.deepest + ' blocks (' + b.cells.length + ' cells)').join(', ');
  const lakes = bodies.slice(0, 2), chans = bodies.slice(2);
  check('the design draws the four bodies it means to', bodies.length === 4, shown);

  // Every body here is wide enough that vanilla's ramp asks for far more than the cap, so a body that
  // came out AT the old cap is one the cap held — which is what makes the split meaningful.
  check('a drawn lake is dug deeper than the old fixed cap', lakes.every(b => b.deepest > OLD_CAP),
    'the round lake and the short bar reach ' + lakes.map(b => b.deepest).join(' and ')
    + ' blocks, against the old cap of ' + OLD_CAP);
  check('a drawn river keeps its shallow bed', chans.every(b => b.deepest <= OLD_CAP),
    'the long bar and the meander reach ' + chans.map(b => b.deepest).join(' and ')
    + ' blocks, against the cap of ' + OLD_CAP);
  // The two bars differ in nothing but length, so they carry the same width and the same demand for
  // depth to either side of the threshold. Without the fill test both would go the same way.
  check('the deepening splits the bodies exactly where the shape test does',
    lakes[1].fill >= LAKE_FILL && chans[0].fill < LAKE_FILL && lakes[1].deepest > chans[0].deepest,
    'threshold ' + LAKE_FILL + ' — ' + shown);
  // Depth stays inside the range a stock world holds — it is a lake bed, not a shaft. 17 is the deepest
  // fresh water measured over seven of them.
  const STOCK_MAX_DEPTH = 17;
  check('no bed is dug past the deepest fresh water a stock world holds',
    LAKE_MAX <= STOCK_MAX_DEPTH && bodies.every(b => b.deepest <= STOCK_MAX_DEPTH),
    'bound ' + LAKE_MAX + ' against a stock world\'s ' + STOCK_MAX_DEPTH + ', deepest here '
    + Math.max.apply(null, bodies.map(b => b.deepest)) + ' blocks');
  // Deepening the middle must not cost the lake its single surface: the level pass runs before the bed
  // is cut, so the two are independent, and this is what says so.
  const lakeLevels = lakes.map(b => new Set(b.cells.map(c => waterY(m2.water[c]))).size);
  check('a deepened lake still comes out at ONE level', lakeLevels.every(k => k === 1),
    lakes.map((b, k) => b.cells.length + ' cells/' + lakeLevels[k] + ' level(s)').join(', '));
  // And the bed stays under its own surface everywhere, however deep the body is allowed to go.
  let dry = 0, worst = 99;
  for (let i = 0; i < R2 * R2; i++) if (wet(i)) { const d = waterY(m2.water[i]) - landY(m2.height[i]); if (d < 1) dry++; if (d < worst) worst = d; }
  check('the bed never reaches its own water surface', dry === 0, dry + ' columns holding no water, shallowest ' + worst + ' blocks');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS ✓');
process.exit(fails ? 1 : 0);
