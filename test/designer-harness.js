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
function grabConst(name) {
  const m = src.match(new RegExp('^\\s*const ' + name + ' = [\\s\\S]*?;\\s*$', 'm'));
  if (!m) throw new Error('const ' + name + ' not found in designer.js');
  return m[0];
}
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

module.exports = { SRC, grabFn, grabConst, constValue, SCLASS, SC, COLOR, FRESH, runImageToMaps, WL, RELIEF, waterY, landY };
