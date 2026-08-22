// What one "Find a map" candidate costs, and that making it cheaper did not change the world it produces.
//
// Find mode runs generate() once per candidate on every worker, continuously, for as long as the user
// leaves it running. That makes generate()'s RETAINED footprint a hard limit on the feature rather than a
// detail: at eight workers a candidate that holds 300 MB is 2.4 GB of live data, and users were losing the
// browser tab on larger worlds. Nothing in the suite measured it, so it was free to grow.
//
// The cost lived in `adjacentPolygons`, whose per-(range, start) memo hangs off `polys` and therefore
// survived for as long as the caller held the result. It stored Sets of small integers - an order of
// magnitude more expensive than the integers - and was never released. On a 120-chunk world it was 223 MB
// of the 297 MB a finished candidate held.
//
// Both checks were shown to FAIL against the copy before the fix and pass against src/:
//
//   check                                        against the pre-fix copy
//   a finished candidate is small                297 MB retained at 120 chunks, against a 64 MB bound
//   the cache does not outlive generate()        polys._adjCache present on the returned object
//
// The third check is the one that makes the other two safe to have made: the world itself is pinned, so a
// future "optimisation" that saves memory by generating something different fails here.
//
//   WORLDGEN=<path to another checkout's src> node test/verify-memory.js
//
// Re-execs itself with --expose-gc when needed: retained memory cannot be told from uncollected garbage
// without a forced collection, and a check that cannot tell those apart is not a check.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!global.gc) {
  const r = require('child_process').spawnSync(process.execPath, ['--expose-gc', __filename],
    { stdio: 'inherit', env: process.env });
  process.exit(r.status === null ? 1 : r.status);
}

const SRC = process.env.WORLDGEN || path.join(__dirname, '..', 'src');
const core = require(path.join(SRC, 'core.js'));
const geo = require(path.join(SRC, 'geo.js'));
const worldgen = require(path.join(SRC, 'worldgen.js'));
const search = require(path.join(SRC, 'search.js'));
core.setVectorTable(fs.readFileSync(path.join(SRC, 'vectortable.txt'), 'utf8').trim().split(',').map(Number));
worldgen.bind(core, geo);

// parseConfig lives in the page template, so lift it the way the other drivers do
const buildSrc = fs.readFileSync(path.join(SRC, '..', 'build.js'), 'utf8');
function grab(name) {
  const i = buildSrc.indexOf('function ' + name + '(');
  let d = 0;
  for (let k = buildSrc.indexOf('{', i); k < buildSrc.length; k++) {
    if (buildSrc[k] === '{') d++;
    else if (buildSrc[k] === '}' && --d === 0) return buildSrc.slice(i, k + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
const parseConfig = new Function([grab('findByKey'), buildSrc.match(/^const rng = .*$/m)[0],
  grab('parseConfig'), 'return parseConfig;'].join('\n'))();
const baseCfg = parseConfig(fs.readFileSync(path.join(SRC, '..', 'WorldGenerator.eco'), 'utf8'));

let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) fails++;
};
const MB = b => (b / 1048576).toFixed(0) + ' MB';
const settle = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const cfgAt = (worldWidth, seed) => Object.assign(JSON.parse(JSON.stringify(baseCfg)), { worldWidth, seed });

// ---- what one candidate retains, at the size the reports came from
{
  const RETAINED_MAX = 64 * 1048576;         // measured 16 MB after the fix, 297 MB before it
  const before = settle();
  const res = worldgen.generate(cfgAt(120, 4242), { biomesOnly: true });
  const grid = search.classGridAt(res.polys, res.worldSize, 128);
  const after = settle();
  const held = after - before;
  check('a finished candidate is small enough to run eight of at once', held <= RETAINED_MAX,
    'retains ' + MB(held) + ' on a 120-chunk world (' + res.polys.length + ' polygons, grid ' + grid.length + ')');
  check('the neighbourhood cache does not outlive generate()',
    res.polys._adjCache === undefined && res.polys._adjStamp === undefined,
    res.polys._adjCache === undefined ? 'released at both exits' : 'still attached to the returned polygons');
}

// ---- and the world is the same one it always was
{
  const fingerprint = (worldWidth, seed, biomesOnly) => {
    const res = worldgen.generate(cfgAt(worldWidth, seed), { biomesOnly: biomesOnly });
    const h = crypto.createHash('sha256');
    h.update([res.worldSize, res.landPercent, res.numContinents, res.numSmallIslands,
      res.numLakes, res.numRivers, res.polys.length].join('|'));
    for (const p of res.polys)
      h.update(`${p.biome}|${p.elevation}|${p.temperature}|${p.moisture}|${p.hasRiver}|${p.hasLake}|${p.maxElevation};`);
    const grid = search.classGridAt(res.polys, res.worldSize, 128);
    h.update(Buffer.from(grid.buffer, grid.byteOffset, grid.length));
    return h.digest('hex').slice(0, 20);
  };
  // Pinned from the pre-fix source, so these are the worlds the generator produced before any of this.
  const PINNED = { '72/1/biomes': '1f0ce9411fe191fa0a53', '72/1/full': '7cb7c8cdfa52e1c45cce' };
  const got = { '72/1/biomes': fingerprint(72, 1, true), '72/1/full': fingerprint(72, 1, false) };
  const bad = Object.keys(PINNED).filter(k => PINNED[k] !== got[k]);
  check('the generated world is unchanged', bad.length === 0,
    bad.length ? bad.map(k => k + ': ' + got[k] + ' != ' + PINNED[k]).join('; ')
               : 'biomes-only and full generation both match the pinned fingerprints');
}

console.log(fails === 0 ? 'ALL PASS ✓' : fails + ' FAILURES ✗');
process.exit(fails === 0 ? 0 : 1);
