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
  for (let y = Math.round(S * 0.50); y < Math.round(S * 0.86); y++)   // river from the lake to the coast
    for (let x = Math.round(S * 0.43); x < Math.round(S * 0.46); x++) put(x, y, FRESH);
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
check('no wall of water between neighbouring cells', maxStep <= 2, 'biggest step ' + maxStep + ' blocks');
check('no cell pair steps 2+ blocks', bigSteps === 0, bigSteps + ' such pairs');

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
check('water is a sane depth, not a pit', dmin >= 1 && dmax <= 8, dmin + '..' + dmax + ' blocks');

// The round lake must be ONE level. Width = distance from the nearest non-water cell, so the lake basin
// is the wide part; the river is one or two cells across and is allowed to descend.
const dist = new Int16Array(g * g).fill(-1), q = [];
for (let i = 0; i < g * g; i++) if (!water[i]) { dist[i] = 0; q.push(i); }
for (let h = 0; h < q.length; h++) { const c = q[h]; for (const n of nbr(c)) if (dist[n] < 0) { dist[n] = dist[c] + 1; q.push(n); } }
const widest = Math.max.apply(null, Array.from({ length: g * g }, (_, i) => (water[i] ? dist[i] : 0)));
const basin = []; for (let i = 0; i < g * g; i++) if (water[i] && dist[i] >= Math.max(2, widest - 1)) basin.push(i);
const basinLevels = new Set(basin.map(i => waterY(water[i])));
check('the lake basin is a single flat level', basinLevels.size === 1, basin.length + ' cells, ' + basinLevels.size + ' level(s)');

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASS ✓');
process.exit(fails ? 1 : 0);
