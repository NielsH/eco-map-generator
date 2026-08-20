// Runs the designer's `imageToMaps` headlessly, so the import pipeline can be checked without a browser.
//
// The function is pulled straight out of the real source by brace matching, so the suites track edits to
// designer.js rather than duplicating it. The only stub is the bit of canvas it touches. `DESIGNER=<path>`
// points the whole thing at another copy of designer.js — which is how a check is shown to have teeth:
// revert one fix in a copy and the check that guards it must fail.
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
// A declaration runs to the `;` that ends a line — a trailing `// comment` is part of that line, so it has
// to be allowed for or the match runs on into whatever follows and lifts a stray function with it.
function grabDecl(kw, name) {
  const m = src.match(new RegExp('^[ \\t]*' + kw + ' ' + name + ' = [\\s\\S]*?;[ \\t]*(//[^\\n]*)?$', 'm'));
  if (!m) throw new Error(kw + ' ' + name + ' not found in designer.js');
  return m[0];
}
function grabConst(name) { return grabDecl('const', name); }
/** Same, for a module-level `let` (the designer keeps its mutable painting state in those). */
function grabLet(name) { return grabDecl('let', name); }
/** The numeric value of a `const NAME = <number>;` anywhere in designer.js, for checks that guard a tuning constant. */
function constValue(name) {
  const m = src.match(new RegExp('\\bconst ' + name + ' = (-?[0-9.]+)'));
  if (!m) throw new Error('const ' + name + ' not found in designer.js');
  return Number(m[1]);
}

const SCLASS = ['Ocean', 'Coast', 'Grassland', 'WarmForest', 'ColdForest', 'RainForest', 'Desert', 'Taiga', 'Tundra', 'Ice', 'Wetland'];
const SC = {}; SCLASS.forEach((n, i) => { SC[n] = i; });
const COLOR = {
  Ocean: [70, 130, 180], Coast: [250, 250, 210], Grassland: [144, 238, 144], WarmForest: [184, 134, 11],
  ColdForest: [34, 139, 34], RainForest: [32, 178, 170], Desert: [244, 164, 96], Taiga: [107, 142, 35],
  Tundra: [189, 183, 107], Ice: [255, 255, 255], Wetland: [0, 100, 0],
};
const FRESH = [30, 144, 255];

// The stub honours `imageSmoothingEnabled`, because whether the colour path smooths is the whole
// difference between a clean biome map and one full of blend colours. Smoothed sampling is bilinear
// rather than the browser's box filter — close enough to tell "blends" from "does not blend", which is
// all any check here asks of it, and no check pins a smoothed pixel value.
function makeDocument() {
  return { createElement: function () {
    let buf = null;
    const ctx = {
      imageSmoothingEnabled: false,
      drawImage: function (s, _x, _y, dw, dh) {
        buf = new Uint8ClampedArray(dw * dh * 4);
        const smooth = ctx.imageSmoothingEnabled;
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          const o = (y * dw + x) * 4;
          if (!smooth) {
            const sx = Math.min(s.width - 1, Math.floor(x * s.width / dw));
            const sy = Math.min(s.height - 1, Math.floor(y * s.height / dh));
            const a = (sy * s.width + sx) * 4;
            buf[o] = s.data[a]; buf[o + 1] = s.data[a + 1]; buf[o + 2] = s.data[a + 2]; buf[o + 3] = s.data[a + 3];
            continue;
          }
          const fx = (x + 0.5) * s.width / dw - 0.5, fy = (y + 0.5) * s.height / dh - 0.5;
          const x0 = Math.max(0, Math.min(s.width - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(s.height - 1, Math.floor(fy)));
          const x1 = Math.min(s.width - 1, x0 + 1), y1 = Math.min(s.height - 1, y0 + 1);
          const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
          for (let ch = 0; ch < 4; ch++) {
            const a = s.data[(y0 * s.width + x0) * 4 + ch], b = s.data[(y0 * s.width + x1) * 4 + ch];
            const c = s.data[(y1 * s.width + x0) * 4 + ch], e = s.data[(y1 * s.width + x1) * 4 + ch];
            buf[o + ch] = (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
          }
        }
      },
      getImageData: function (_x, _y, w, h) { return { data: buf || new Uint8ClampedArray(w * h * 4) }; },
      createImageData: function (w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
      putImageData: function () {},
    };
    return { width: 0, height: 0, getContext: function () { return ctx; } };
  } };
}

/** The legend the painter's own palette produces: one entry per biome colour, plus the fresh-water colour. */
function paletteLegend() {
  const legend = SCLASS.map(n => ({ rgb: COLOR[n], cls: SC[n], fresh: false }));
  legend.push({ rgb: FRESH, cls: SC.Ocean, fresh: true });
  return legend;
}

/** opts: { mode: 'colors'|'brightness', legend, blocksPerCell } */
function runImageToMaps(img, res, opts) {
  opts = opts || {};
  const legend = opts.legend || paletteLegend();
  const body = [grabConst('ECO_BIOME_ELEV'), grabFn('h2'), grabFn('vnR'), grabFn('boxBlurTor'),
    grabFn('imageToMaps'), 'return imageToMaps(RES, BPC);'].join('\n');
  const fn = new Function('document', 'importedImg', 'importMode', 'legend', 'SC', 'CN', 'RES', 'BPC', body);
  return fn(makeDocument(), img, opts.mode || 'colors', legend, SC, SCLASS, res, opts.blocksPerCell);
}

// Lift a set of pieces out of designer.js and run a snippet against them, so a check can reach a helper
// the module never exports. `parts` names them as 'fn:name' / 'const:NAME' / 'let:NAME'; `args` becomes the
// sandbox's parameters, which is how the module-level painting state is both supplied and left writable.
function run(parts, args, body) {
  const pre = parts.map(p => {
    const i = p.indexOf(':'), kind = p.slice(0, i), name = p.slice(i + 1);
    if (kind === 'fn') return grabFn(name);
    if (kind === 'const') return grabConst(name);
    if (kind === 'let') return grabLet(name);
    throw new Error('unknown part kind: ' + p);
  }).join('\n');
  const keys = Object.keys(args);
  return new Function(...keys, pre + '\n' + body)(...keys.map(k => args[k]));
}

// ---- how Eco turns the exported maps into blocks (WorldGeneratorPlugin / TerrainGenerator)
const WL = 60, RELIEF = 60;
const waterY = wb => WL + Math.trunc(RELIEF * (wb / 255));
const landY = hb => { const v = 2 * (hb / 255) - 1; return v < 0 ? Math.round((v + 1) * WL) : WL + Math.round(v * RELIEF); };

/** The shared PASS/FAIL reporter every suite uses. Returns `fails()` and the `check` to call. */
function reporter() {
  let fails = 0;
  const check = (name, ok, detail) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
    if (!ok) fails++;
  };
  return { check, done: () => { console.log(fails === 0 ? 'ALL PASS ✓' : fails + ' FAILURES ✗'); process.exit(fails === 0 ? 0 : 1); } };
}

module.exports = { SRC, grabFn, grabConst, grabLet, constValue, run, SCLASS, SC, COLOR, FRESH,
  paletteLegend, makeDocument, runImageToMaps, reporter, WL, RELIEF, waterY, landY };
