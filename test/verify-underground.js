// The underground editor's lane, run headless: its pure geometry, and the SVG it draws for stock Desert.
//
// The lane lives in build.js's page template and draws into the DOM, so nothing in the suite ever ran it -
// every regression in it surfaced only in a browser, and twice the template literal quietly ate a backslash
// or a backtick on the way to index.html. This lifts the whole main-thread slice from `let terrain = null`
// through the OreVisual IIFE, gives it just enough DOM to render (elements are plain objects that keep
// innerHTML and capture the handlers wired onto them), and checks what it draws for the biome whose
// numbers are pinned in the previous commit: stock Desert, where the second Sand layer is the rock in 43%
// of columns and wins the plurality nowhere.
//
// Checks:
//   bellStops        core at 1, edges faint, monotone in from both ends (the bell, not a ramp)
//   bandLayout       hollow iff live < 0.5 and not last; the last stratum is the ceiling, never hollow
//   spreadLabels     order kept, every gap >= the requested gap
//   clipRuns         contiguous cover of mn..mx; an orphan is off everywhere
//   Desert lane      one hollow band (Sand 1-20, with its liveness), the ceiling label, a band + two edge
//                    grips per stratum, a bar per object with grow grips only on veins, the world-Y edge
//                    (water line, surface band, floor), nothing NaN or undefined
//   stratum drag     moving a band's core keeps its spread and does not jump on grab; an edge grip moves
//                    that edge alone and cannot cross the other
//   template safety  the block build.js holds is byte-identical in index.html
//
//   node test/verify-underground.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const buildSrc = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8');

let fails = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); if (!ok) fails++; }

// ---- lift the main-thread slice: terrain deref + block palette + ore knobs + the OreVisual IIFE ----
const s0 = buildSrc.indexOf('let terrain = null;');
const s1 = buildSrc.indexOf('// ---- block-composition chart');
if (s0 < 0 || s1 < 0) throw new Error('could not find the OreVisual slice in build.js');
const slice = buildSrc.slice(s0, s1);

// a DOM of plain objects: enough for render(), renderList(), renderDetail() and init()
const FORM = { cf_waterLevel: '60', cf_maxGenerationHeight: '120' };
function elementsOf(els) { return function el(id) {
  if (els[id]) return els[id];
  const e = { id: id, innerHTML: '', value: FORM[id] || '', checked: false, style: {}, dataset: {}, onclick: null, handlers: {},
    addEventListener(ev, fn) { this.handlers[ev] = fn; },
    querySelectorAll(q) {
      // the biome chips: one object per data-bi in the HTML the lane just wrote, so a test can click one
      // the same objects for the same HTML, so the onclick render() assigns is the one the test later calls
      if (id === 'ovBiomes' && q === 'button') { if (this.chipsHtml === this.innerHTML) return this.chips; const out = []; let at = 0;
        for (;;) { const i = this.innerHTML.indexOf('data-bi="', at); if (i < 0) break; const j = this.innerHTML.indexOf('"', i + 9);
          out.push({ dataset: { bi: this.innerHTML.slice(i + 9, j) }, onclick: null }); at = j; }
        this.chips = out; this.chipsHtml = this.innerHTML; return out; }
      return []; },
    querySelector() { return null; },
    getBoundingClientRect() { const svg = els.ovLane.innerHTML; const w = +svg.slice(svg.indexOf('width="') + 7).split('"')[0], h = +svg.slice(svg.indexOf('height="') + 8).split('"')[0];
      return { top: 0, left: 0, width: w, height: h }; },
    get viewBox() { return { baseVal: { width: this.getBoundingClientRect().width } }; } };
  els[id] = e; return e;
}; }
const els = {}, el = elementsOf(els);
const documentStub ={ getElementById: el, handlers: {}, addEventListener(ev, fn) { this.handlers[ev] = fn; } };
const lifted = new Function('$', 'document', 'getComputedStyle', 'BlockChart', 'buildExportJson', 'setTimeout', 'clearTimeout',
  slice + '\nreturn { OreVisual, derefTerrain, setTerrain: t => { terrain = t; } };')(
  el, documentStub, () => ({ getPropertyValue: () => '#123456' }), { render() {} }, () => ({}), () => 0, () => {});

const eco = JSON.parse(fs.readFileSync(path.join(ROOT, 'WorldGenerator.eco'), 'utf8'));
const terrain = lifted.derefTerrain(eco);
check('stock terrain dereferences', !!(terrain && terrain.Modules && terrain.Modules.length));
lifted.setTerrain(terrain);

// ---- the pure helpers, grabbed by name out of the IIFE ----
function grab(name) {
  const i = buildSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no function ' + name);
  let d = 0;
  for (let k = buildSrc.indexOf('{', i); k < buildSrc.length; k++) {
    if (buildSrc[k] === '{') d++;
    else if (buildSrc[k] === '}' && --d === 0) return buildSrc.slice(i, k + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
const bellLine = buildSrc.slice(buildSrc.indexOf('  const BELL = ['), buildSrc.indexOf('];', buildSrc.indexOf('  const BELL = [')) + 2);
const pure = new Function([bellLine, grab('bellStops'), grab('bandLayout'), grab('spreadLabels'), grab('clipRuns'),
  'return { BELL, bellStops, bandLayout, spreadLabels, clipRuns };'].join('\n'))();

// bellStops: the shading follows the bell's density
{
  const st = pure.bellStops();
  check('bellStops has one stop per quantile at that quantile', st.length === pure.BELL.length && st.every((s, k) => s.off === pure.BELL[k]));
  const mid = (st.length - 1) / 2;
  check('bellStops core is 1, edges faint', st[mid].a === 1 && st[0].a < 0.45 && st[st.length - 1].a < 0.45, 'edges ' + st[0].a.toFixed(3) + ' / ' + st[st.length - 1].a.toFixed(3));
  let monoIn = true; for (let k = 1; k <= mid; k++) if (st[k].a < st[k - 1].a - 1e-9) monoIn = false;
  for (let k = st.length - 2; k >= mid; k--) if (st[k].a < st[k + 1].a - 1e-9) monoIn = false;
  check('bellStops rise monotonically into the core from both edges', monoIn);
}
// bandLayout: hollow means "usually suppressed", and only ever for a non-last stratum
{
  const list = [{ min: 0, max: 0 }, { min: 4, max: 6 }, { min: 1, max: 20 }, { min: 0, max: 20 }, { min: 55, max: 60 }, { min: 58, max: 65 }];
  const alive = [0.99, 0.75, 0.43, 1, 0.97, 0.3];
  const b = pure.bandLayout(list, alive, 120);
  check('bandLayout hollow iff live < 0.5 and not last', b.map(x => x.hollow).join() === 'false,false,true,false,false,false');
  check('bandLayout last stratum is the ceiling', b[5].ceiling && !b[4].ceiling);
  check('bandLayout spans row edges Min+1..Max+1', b[4].top === 56 && b[4].bot === 61 && b[0].top === 1 && b[0].bot === 1);
  check('bandLayout clamps to the axis', pure.bandLayout([{ min: 0, max: 200 }, { min: 300, max: 400 }], [1, 1], 120)[1].min === 120);
}
// spreadLabels: nothing overlaps, nothing reorders
{
  const ys = [100, 50, 52, 300, 55];
  const out = pure.spreadLabels(ys, 11);
  const sorted = ys.map((y, i) => i).sort((a, b) => ys[a] - ys[b]);
  let gapsOk = true; for (let k = 1; k < sorted.length; k++) if (out[sorted[k]] - out[sorted[k - 1]] < 11 - 1e-9) gapsOk = false;
  check('spreadLabels keeps every gap >= 11 and the order', gapsOk && out[1] === 50 && out[2] === 61 && out[4] === 72 && out[0] === 100 && out[3] === 300, out.join());
}
// clipRuns: solid where the parent is usually the rock, hatched elsewhere, contiguous
{
  const prob = new Float64Array(121); for (let d = 10; d <= 57; d++) prob[d] = 0.9;
  const runs = pure.clipRuns(prob, 5, 60, 120);
  check('clipRuns splits 5-60 around a parent present at 10-57', runs.length === 3 && !runs[0].on && runs[1].on && !runs[2].on && runs[0].a === 5 && runs[0].b === 9 && runs[1].a === 10 && runs[1].b === 57 && runs[2].a === 58 && runs[2].b === 60);
  check('clipRuns: an orphan fill is off everywhere', pure.clipRuns(null, 0, 3, 120).every(r => !r.on));
  check('clipRuns clips to the axis', pure.clipRuns(prob, 100, 500, 120).slice(-1)[0].b === 120);
}

// ---- the lane itself, for stock Desert ----
const OV = lifted.OreVisual;
OV.init(); OV.build();
const chips = el('ovBiomes').querySelectorAll('button');
const desertIdx = terrain.Modules.findIndex(m => m.BiomeName === 'Desert');
check('Desert is a chip', desertIdx >= 0 && chips[desertIdx] && typeof chips[desertIdx].onclick === 'function');
chips[desertIdx].onclick();
let svg = el('ovLane').innerHTML;
const count = (hay, needle) => { let n = 0, at = 0; for (;;) { const i = hay.indexOf(needle, at); if (i < 0) return n; n++; at = i + needle.length; } };
const desert = terrain.Modules[desertIdx].Module.BlockDepthRanges;
const nStrata = desert.filter(r => r.BlockType && r.BlockType.Type).length;
const objsAll = []; desert.forEach(r => (r.SubModules || []).forEach(sm => { if (sm.BlockType && sm.BlockType.Type) objsAll.push(sm); }));
const nVeins = objsAll.filter(sm => (sm['$type'] || '').indexOf('Deposit') >= 0).length;
check('Desert lane renders an svg', svg.indexOf('<svg id="ovSvg"') === 0 && svg.slice(-6) === '</svg>');
check('no NaN/undefined in the lane', svg.indexOf('NaN') < 0 && svg.indexOf('undefined') < 0);
check('depth axis, not world Y', svg.indexOf('Depth below the surface') >= 0 && svg.indexOf('World height (Y)') < 0);
check('exactly one hollow band in Desert (Sand 1-20)', count(svg, 'stroke-dasharray="4 3"') === 1, 'got ' + count(svg, 'stroke-dasharray="4 3"'));
const sandLabel = svg.slice(svg.indexOf('Sand ends 1–20'), svg.indexOf('Sand ends 1–20') + 24);
check('the hollow band carries its liveness', svg.indexOf('Sand ends 1–20 · 4') >= 0 && sandLabel.indexOf('%') > 0, sandLabel);
check('the last stratum is labelled as the ceiling', svg.indexOf('Gneiss ends 58–65 · ceiling') >= 0);
check('every stratum has a core handle and two edge grips', [...Array(nStrata).keys()].every(i => count(svg, 'data-sdrag="' + i + '"') === 1 && count(svg, 'data-sedge="' + i + '|min"') === 1 && count(svg, 'data-sedge="' + i + '|max"') === 1));
check('every object has a bar with top/bottom grips', [...Array(objsAll.length).keys()].every(i => count(svg, 'data-drag="' + i + '|t"') === 1 && count(svg, 'data-drag="' + i + '|b"') === 1 && count(svg, 'data-drag="' + i + '|move"') >= 1));
check('grow grips only on veins', count(svg, '|gt"') === nVeins && count(svg, '|gb"') === nVeins, nVeins + ' veins');
check('a fill outside its layer is hatched', count(svg, 'fill="url(#ovHatch)"') >= 1);
check('world-Y edge: surface band, water line, floor', svg.indexOf('surface Y') >= 0 && svg.indexOf('water Y60') >= 0 && svg.indexOf('Y0 under the mean surface') >= 0 && svg.indexOf('world Y under the mean surface (Y') >= 0);
check('the bell gradient and hatch are defined once', count(svg, 'id="ovBell"') === 1 && count(svg, 'id="ovHatch"') === 1);
check('the list still nests and shows liveness', el('ovList').innerHTML.indexOf('class="ovRow sub"') >= 0 && el('ovList').innerHTML.indexOf('lpct') >= 0);

// ---- a stratum drag, through the handlers the lane wired up ----
{
  const svgEl = el('ovSvg'), down = svgEl.handlers.pointerdown, move = documentStub.handlers.pointermove;
  check('pointer handlers are wired', typeof down === 'function' && typeof move === 'function');
  const st = desert.filter(r => r.BlockType && r.BlockType.Type)[4];   // Sandstone 55-60
  const m0 = st.Min, x0 = st.Max;
  // scale: 1000px over max(60, maxD) rows, depth 0 at y=18 (TOPY); grab the core wherever it is - the value must not jump
  const SCd = 1000 / 120, TOPY = 18;
  const y = d => TOPY + d * SCd;
  const ev = (target, clientY) => ({ target: { dataset: target }, clientY: clientY, clientX: 100, preventDefault() {} });
  down(ev({ sdrag: '4' }, y(57.9)));
  move(ev({}, y(57.9)));
  check('grabbing a core does not move it', st.Min === m0 && st.Max === x0, st.Min + '-' + st.Max);
  move(ev({}, y(57.9 + 3)));
  check('dragging the core by 3 rows moves Min and Max together', st.Min === m0 + 3 && st.Max === x0 + 3, st.Min + '-' + st.Max);
  documentStub.handlers.pointerup && documentStub.handlers.pointerup();
  down(ev({ sedge: '4|max' }, y(61)));
  move(ev({}, y(61 + 4)));
  check('dragging the max grip moves only Max', st.Min === m0 + 3 && st.Max === x0 + 7, st.Min + '-' + st.Max);
  documentStub.handlers.pointerup && documentStub.handlers.pointerup();
  down(ev({ sedge: '4|min' }, y(59)));
  move(ev({}, y(59 + 40)));
  check('the min grip cannot cross Max', st.Min === st.Max, st.Min + '-' + st.Max);
  documentStub.handlers.pointerup && documentStub.handlers.pointerup();
  st.Min = m0; st.Max = x0;
  // a fill bar: its top grip moves only min, and a move keeps its span
  const fill = objsAll.findIndex(sm => (sm['$type'] || '').indexOf('Standard') >= 0 && sm.DepthRange && sm.DepthRange.max > sm.DepthRange.min + 1);
  const node = objsAll[fill], fm = node.DepthRange.min, fx = node.DepthRange.max;
  down(ev({ drag: fill + '|move' }, y(fm + 1))); move(ev({}, y(fm + 1 + 5)));
  check('dragging a bar moves its range intact', node.DepthRange.min === fm + 5 && node.DepthRange.max === fx + 5, node.DepthRange.min + '-' + node.DepthRange.max);
  documentStub.handlers.pointerup && documentStub.handlers.pointerup();
  down(ev({ drag: fill + '|t' }, y(fm + 5))); move(ev({}, y(fm + 5 - 2)));
  check('the top grip moves only min', node.DepthRange.min === fm + 3 && node.DepthRange.max === fx + 5, node.DepthRange.min + '-' + node.DepthRange.max);
  documentStub.handlers.pointerup && documentStub.handlers.pointerup();
  node.DepthRange.min = fm; node.DepthRange.max = fx;
}

// ---- the template literal delivered the block untouched ----
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const a = buildSrc.indexOf('const OreVisual = (function () {'), b = buildSrc.indexOf('const BlockChart = (function () {');
  check('OreVisual block is byte-identical in index.html', html.indexOf(buildSrc.slice(a, b)) >= 0);
}

// ---- the strip of real columns: its request/reply path through a fake worker, then the port it rides on ----
{
  // a second lane with a worker, a canvas and a form to read; setTimeout fires at once so the debounce is inert
  const els2 = {}, el2 = elementsOf(els2);
  const posted = []; const fakeWorker = { postMessage(m) { posted.push(m); }, onmessage: null };
  const painted = []; const canvas = { width: 0, height: 0, getContext() { return { fillStyle: '', fillRect(x, y) { painted.push(x + ',' + y); } }; }, toDataURL() { return 'data:image/png;base64,FAKE'; } };
  const doc2 = { getElementById: el2, handlers: {}, addEventListener(ev, fn) { this.handlers[ev] = fn; }, createElement() { return canvas; } };
  const cfg = { worldWidth: 72, seed: 4242, waterLevel: 60, maxGenerationHeight: 120 };
  const lifted2 = new Function('$', 'document', 'getComputedStyle', 'BlockChart', 'buildExportJson', 'setTimeout', 'clearTimeout', 'Worker', 'makeWorker', 'readForm', 'baseCfg', 'VT',
    slice + '\nreturn { OreVisual, setTerrain: t => { terrain = t; } };')(
    el2, doc2, () => ({ getPropertyValue: () => '#123456' }), { render() {} }, () => ({}), fn => { fn(); return 1; }, () => {}, function () {}, () => fakeWorker, () => cfg, cfg, [1, 2, 3]);
  lifted2.setTerrain(terrain);
  lifted2.OreVisual.init(); lifted2.OreVisual.build();
  el2('ovBiomes').querySelectorAll('button')[desertIdx].onclick();
  let svg2 = el2('ovLane').innerHTML;
  const req = posted.filter(m => m.type === 'strip').slice(-1)[0];
  check('the strip worker is initialised with the vector table first', posted[0] && posted[0].type === 'init' && posted[0].vt.length === 3);
  check('a strip is requested for Desert at the current seed and mean surface', !!req && req.biome === 'Desert' && req.cfg.seed === 4242 && req.cfg.worldWidth === 72 && req.n === 48 && req.intHeight === 67, req && JSON.stringify([req.biome, req.cfg, req.n, req.intHeight]));
  check('the lane says it is computing while the worker works', svg2.indexOf('computing real columns') >= 0 && svg2.indexOf('<image') < 0);
  // the reply: 48 columns of 68 blocks, surface at the top of each
  const rows = req.intHeight + 1, cols = [];
  for (let i = 0; i < req.n; i++) { const c = new Array(rows); for (let y = 0; y < rows; y++) c[y] = y === 0 ? 'Eco.World.Blocks.ImpenetrableStoneBlock' : y > rows - 4 ? 'Eco.World.Blocks.DesertSandBlock' : 'Eco.World.Blocks.SandstoneBlock'; cols.push(c); }
  fakeWorker.onmessage({ data: { type: 'strip-done', key: 'stale', cols: cols, x0: 1, z: 1, intHeight: req.intHeight } });
  check('a reply for another key is dropped', el2('ovLane').innerHTML.indexOf('<image') < 0);
  fakeWorker.onmessage({ data: { type: 'strip-done', key: req.key, cols: cols, x0: 360, z: 360, intHeight: req.intHeight } });
  svg2 = el2('ovLane').innerHTML;
  check('the reply paints one pixel per block', painted.length === req.n * rows && canvas.width === req.n && canvas.height === rows, painted.length + ' px');
  const img = svg2.slice(svg2.indexOf('<image'), svg2.indexOf('/>', svg2.indexOf('<image')));
  const SCd = 1000 / 120;
  check('the strip image spans the same rows as the stack, at the stack scale', img.indexOf('height="' + (rows * SCd).toFixed(1) + '"') >= 0 && img.indexOf('preserveAspectRatio="none"') >= 0 && img.indexOf('pixelated') >= 0, img.slice(0, 90));
  // The omission has to be stated where it is READ, not only in a footnote: the strip shows fills, so a
  // grey line at the bottom saying veins are missing was taken for "there is no ore down here".
  check('the strip is captioned with its slice, and says loudly that veins are missing',
    svg2.indexOf('48 real columns at z360, x360–407') >= 0 && svg2.indexOf('data-stripnext') >= 0 &&
    svg2.indexOf('no veins in this view') >= 0 && svg2.indexOf('world-wide pass') >= 0);
  check('the world-Y edge sits to the right of the strip', svg2.indexOf('world Y under the mean surface (Y67)') >= 0 && svg2.indexOf('surface Y61–72') >= 0);
  const before = posted.length;
  el2('ovSvg').handlers.pointerdown({ target: { dataset: { stripnext: '1' } }, clientY: 0, clientX: 0, preventDefault() {} });
  const req2 = posted.slice(-1)[0];
  check('next slice asks for another offset and shows the old strip dimmed meanwhile', posted.length === before + 1 && req2.ofs === 1 && el2('ovLane').innerHTML.indexOf('opacity="0.4"') >= 0);
  // an edit to ANOTHER biome must re-request: every later fill's seed moves with it
  const grass = terrain.Modules.find(m => m.BiomeName === 'Grassland');
  const b0 = posted.length; grass.Module.BlockDepthRanges[0].SubModules.push({ '$type': 'Eco.WorldGenerator.StandardTerrainModule, Eco.WorldGenerator', BlockType: { Type: 'Eco.World.Blocks.DirtBlock, Eco.World' }, DepthRange: { min: 0, max: 1 }, PercentChance: 0.1 });
  fakeWorker.onmessage({ data: { type: 'strip-done', key: req2.key, cols: cols, x0: 0, z: 0, intHeight: req.intHeight } });   // settle the pending request first
  el2('ovBiomes').querySelectorAll('button')[desertIdx].onclick();
  check('a fill added to an earlier biome re-requests the strip', posted.length === b0 + 1 && posted.slice(-1)[0].type === 'strip');
  grass.Module.BlockDepthRanges[0].SubModules.pop();
}

// ---- the port the strip rides on, with the real noise ----
{
  const core = require(path.join(ROOT, 'src', 'core.js')), voxel = require(path.join(ROOT, 'src', 'voxel.js'));
  core.setVectorTable(fs.readFileSync(path.join(ROOT, 'src', 'vectortable.txt'), 'utf8').trim().split(',').map(Number));
  const cfg = { worldWidth: 72, seed: 4242, waterLevel: 60, maxGenerationHeight: 120 };
  const full = voxel.initTerrain(terrain, cfg); full.biomeAt = () => 'Desert';
  const only = voxel.initTerrain(terrain, cfg, 'Desert'); only.biomeAt = () => 'Desert';
  let same = true; for (let i = 0; i < 64 && same; i++) { const x = 100 + i * 7, z = 300 + i * 3;
    const a = voxel.generateColumn(full, x, z, 67), b = voxel.generateColumn(only, x, z, 67); if (a.join() !== b.join()) same = false; }
  check('calibrating one biome gives the same columns as calibrating all (seed order kept)', same);
  const dS = full.biomes.Desert.ranges.flatMap(r => r.subs.filter(s => s.kind === 'scatter')), oS = only.biomes.Desert.ranges.flatMap(r => r.subs.filter(s => s.kind === 'scatter'));
  check('the calibration memo returns the exact bands', dS.length > 0 && dS.every((s, i) => s._nMin === oS[i]._nMin && s._nMax === oS[i]._nMax && s._seed === oS[i]._seed), dS.length + ' fills');
  const r = voxel.biomeStrip(terrain, cfg, 'Desert', 48, 0, 67), r2 = voxel.biomeStrip(terrain, cfg, 'Desert', 48, 0, 67);
  check('biomeStrip: 48 columns of intHeight+1 blocks, world floor at the bottom', r.cols.length === 48 && r.cols.every(c => c.length === 68 && c[0] === voxel.IMPENETRABLE));
  check('biomeStrip is deterministic', JSON.stringify(r) === JSON.stringify(r2));
  const top = r.cols.filter(c => c[67].indexOf('DesertSand') >= 0).length;
  check('Desert columns are Desert Sand at the surface (a 0-0 layer alive in 99% plus a fill)', top >= 44, top + '/48');
  const other = voxel.biomeStrip(terrain, { worldWidth: 72, seed: 99, waterLevel: 60, maxGenerationHeight: 120 }, 'Desert', 48, 0, 67);
  check('another seed digs different ground', JSON.stringify(other.cols) !== JSON.stringify(r.cols));
  const slice1 = voxel.biomeStrip(terrain, cfg, 'Desert', 48, 1, 67);
  check('another slice is elsewhere in the world', slice1.x0 !== r.x0 && slice1.z !== r.z);
}

console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
process.exit(fails ? 1 : 0);
