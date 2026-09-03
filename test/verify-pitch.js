// Every distance inside the export is measured in WORLD BLOCKS, and has to be converted with THIS world's
// pitch — the blocks-per-cell the map will actually be built at.
//
// Two windows divided by a hardcoded `1200 / res` instead of `BPC`, which is only right on a 120-chunk
// world. On a 200-chunk one the trend removal asked for 60 blocks and got 98, and the wetland levelling
// asked for 40 and got 67. Nothing threw and nothing looked wrong in isolation: the world was simply built
// to another world's measurements, and every metric taken off it was quietly answering about a map that
// does not exist.
//
// The check is STATIC because the value is not observable from outside — the pitch is consumed inside
// passes that return nothing, and the only way to see it is to read the source. Blunt, and it cannot see
// through indirection, which is the same trade `free-identifiers.js` makes.
//
// A behavioural companion was written and thrown away: comparing the same drawing at 1200/448 against
// 2000/747 (the same 2.68 blocks per cell) reads 6.0% against 6.3% low ground WITH the bug as well as
// without it, because a window 1.66x too wide still leaves the low tail in much the same place on a
// synthetic island. A check that cannot fail is worse than no check, so it is not here.
//
//   check                                        against the pre-fix copy
//   windows convert with this world's pitch      2 stray lines in imageToMaps divide by (1200 / res)
//
//   DESIGNER=<path to another copy> node test/verify-pitch.js
'use strict';
const fs = require('fs');
const path = require('path');
const { reporter } = require('./designer-harness');

const { check, done } = reporter();
const SRC = process.env.DESIGNER || path.join(__dirname, '..', 'src', 'designer.js');
const src = fs.readFileSync(SRC, 'utf8');

/** The body of imageToMaps, by brace matching. */
function imageToMapsBody() {
  const at = src.indexOf('function imageToMaps(');
  if (at < 0) throw new Error('no imageToMaps in ' + SRC);
  let depth = 0;
  for (let k = src.indexOf('{', at); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(at, k + 1);
  }
  throw new Error('unbalanced braces in imageToMaps');
}

{
  // Comments stripped first: the explanation of this very bug names the number, and a check that trips
  // over its own documentation teaches people to delete the documentation.
  const body = imageToMapsBody()
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(String.fromCharCode(10))
    .map(l => l.replace(/\/\/.*$/, ''))
    .join(String.fromCharCode(10));
  const hits = body.split(String.fromCharCode(10)).filter(l => /\b1200\b/.test(l)).map(l => l.trim());
  const stray = hits.filter(h => h.indexOf('const BPC = blocksPerCell') !== 0);
  check('every window in imageToMaps converts world blocks with this world pitch', stray.length === 0,
    stray.length === 0
      ? hits.length + ' mention of 1200 in code, and it is the documented BPC fallback'
      : stray.length + ' stray: ' + stray.map(h => h.slice(0, 64)).join(' | '));
}

done();
