// Regression test for imported lakes/rivers (src/designer.js `imageToMaps`).
//
// Guards the properties that decide whether water reads as water in game. Eco fills every column
// independently to `60 + 60*waterValue`, so the per-cell level this exports IS what the player sees:
//   * neighbouring water cells must not step much — a big step is a wall of water mid-lake
//   * water must never sit above the LAND beside it — that is water pouring over terrain
//   * a lake basin must be ONE level, or it is a staircase
// Note what is deliberately NOT asserted: distinct levels per body. A river descending a hillside
// legitimately has one per block; counting them flags correct output as broken.
//
// `imageToMaps` is pulled straight out of the real source by brace matching, so this tracks edits to
// designer.js rather than duplicating it. The only stub is the bit of canvas it touches.
//
//   node test/verify-water.js
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.env.DESIGNER || path.join(__dirname, '..', 'src', 'designer.js');
const src = fs.readFileSync(SRC, 'utf8');

function grabFn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' not found in designer.js');
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
function grabConst(name) {
  const m = src.match(new RegExp('^\\s*const ' + name + ' = [\\s\\S]*?;\\s*$', 'm'));
  if (!m) throw new Error('const ' + name + ' not found in designer.js');
  return m[0];
}

const SCLASS = ['Ocean', 'Coast', 'Grassland', 'WarmForest', 'ColdForest', 'RainForest', 'Desert', 'Taiga', 'Tundra', 'Ice', 'Wetland'];
const SC = {}; SCLASS.forEach((n, i) => { SC[n] = i; });
const COLOR = {
  Ocean: [70, 130, 180], Coast: [250, 250, 210], Grassland: [144, 238, 144], WarmForest: [184, 134, 11],
  ColdForest: [34, 139, 34], RainForest: [32, 178, 170], Desert: [244, 164, 96], Taiga: [107, 142, 35],
  Tundra: [189, 183, 107], Ice: [255, 255, 255], Wetland: [0, 100, 0],
};
const FRESH = [30, 144, 255];

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

function makeDocument() {
  return { createElement: function () {
    let buf = null;
    const ctx = {
      imageSmoothingEnabled: false,
      drawImage: function (s, _x, _y, dw, dh) {
        buf = new Uint8ClampedArray(dw * dh * 4);
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          const sx = Math.min(s.width - 1, Math.floor(x * s.width / dw));
          const sy = Math.min(s.height - 1, Math.floor(y * s.height / dh));
          const a = (sy * s.width + sx) * 4, o = (y * dw + x) * 4;
          buf[o] = s.data[a]; buf[o + 1] = s.data[a + 1]; buf[o + 2] = s.data[a + 2]; buf[o + 3] = s.data[a + 3];
        }
      },
      getImageData: function (_x, _y, w, h) { return { data: buf || new Uint8ClampedArray(w * h * 4) }; },
      createImageData: function (w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
      putImageData: function () {},
    };
    return { width: 0, height: 0, getContext: function () { return ctx; } };
  } };
}

function runImageToMaps(img, res) {
  const legend = SCLASS.map(n => ({ rgb: COLOR[n], cls: SC[n], fresh: false }));
  legend.push({ rgb: FRESH, cls: SC.Ocean, fresh: true });
  const body = [grabConst('ECO_BIOME_ELEV'), grabFn('h2'), grabFn('vnR'), grabFn('boxBlurTor'),
    grabFn('imageToMaps'), 'return imageToMaps(RES);'].join('\n');
  const fn = new Function('document', 'importedImg', 'importMode', 'legend', 'SC', 'CN', 'RES', body);
  return fn(makeDocument(), img, 'colors', legend, SC, SCLASS, res);
}

// ---- how Eco turns the exported maps into blocks (WorldGeneratorPlugin / TerrainGenerator)
const WL = 60, RELIEF = 60;
const waterY = wb => WL + Math.trunc(RELIEF * (wb / 255));
const landY = hb => { const v = 2 * (hb / 255) - 1; return v < 0 ? Math.round((v + 1) * WL) : WL + Math.round(v * RELIEF); };

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
    const want = Math.max(1.8, Math.max(1, 2 * ((dIn[i] - 0.5) * BPC) - 1) * 0.4706);
    if (waterY(water[i]) - want < 4) { atFloor++; continue; }   // vanilla bottoms out here too
    const d = Math.abs((waterY(water[i]) - landY(height[i])) - want);
    cells++; off += d; if (d > worstOff) worstOff = d;
  }
  const avg = cells ? off / cells : 99;
  check('depth follows vanilla, deepening away from the bank', cells > 0 && avg < 1.5,
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
// 1.37 and a 1-block cap at 0.93. On this design the same two caps read 2.61 and 1.75 — higher, because
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
  check('the bank is a lip, not a terrace of constant height', cnt > 0 && avg < 2.2,
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

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS ✓');
process.exit(fails ? 1 : 0);
