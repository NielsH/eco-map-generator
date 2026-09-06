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

// ---- the ghost: selecting a vein draws one deposit, to scale, in its grow window ----
// This replaced the strip of real columns. The strip could never show a vein - growth draws from one world
// random in traversal order and competes through a global dedup map, so a slice of it cannot be computed -
// and it showed fills, which made its silence read as "no ore here". The deposit it could not draw is the
// thing you wanted to see, and this draws it.
{
  const els2 = {}, el2 = elementsOf(els2);
  const doc2 = { getElementById: el2, handlers: {}, addEventListener(ev, fn) { this.handlers[ev] = fn; }, createElement() { return { getContext() { return {}; } }; } };
  const cfg = { worldWidth: 72, seed: 4242, waterLevel: 60, maxGenerationHeight: 120 };
  const lifted2 = new Function('$', 'document', 'getComputedStyle', 'BlockChart', 'buildExportJson', 'setTimeout', 'clearTimeout', 'readForm', 'baseCfg',
    slice + '\nreturn { OreVisual, setTerrain: t => { terrain = t; } };')(
    el2, doc2, () => ({ getPropertyValue: () => '#123456' }), { render() {} }, () => ({}), fn => { fn(); return 1; }, () => {}, () => cfg, cfg);
  lifted2.setTerrain(terrain);
  lifted2.OreVisual.init(); lifted2.OreVisual.build();
  el2('ovBiomes').querySelectorAll('button')[desertIdx].onclick();
  const noSel = el2('ovLane').innerHTML;
  check('nothing is drawn until a vein is selected', noSel.indexOf('one deposit') < 0);

  // Select a vein the way the lane does it: its own move handle. Only a vein gets grow-window grips, so a
  // data-drag index that appears with "|gt" is a vein.
  const gt = noSel.indexOf('|gt"');
  const idx = gt < 0 ? null : noSel.slice(noSel.lastIndexOf('data-drag="', gt) + 11, gt);
  check('the Desert lane offers a vein to select', idx !== null && /^[0-9]+$/.test(idx), String(idx));
  if (idx !== null) {
    el2('ovSvg').handlers.pointerdown({ target: { dataset: { drag: idx + '|move' } }, clientX: 0, clientY: 0, preventDefault() {} });
    doc2.handlers.pointerup && doc2.handlers.pointerup();
    const svg2 = el2('ovLane').innerHTML;
    check('selecting a vein draws one deposit with what a drill gets from it',
      /one deposit, a drill passes ~[0-9]+ of its [0-9]+ tall/.test(svg2), svg2.slice(Math.max(0, svg2.indexOf('one deposit') - 8), svg2.indexOf('one deposit') + 52));
    // The lane once captioned the reach band "a column digs ~16 blocks of it" while the note said a drill
    // passes 5. Both were on screen at once and only one was right; the picture is the one people read.
    check('the lane shows no reach band at all - it was read as thickness every time',
      svg2.indexOf('a column digs') < 0 && svg2.indexOf('ore can sit anywhere') < 0,
      'a reach caption is back on the drawing');
    check('the soft grow window is drawn around it, dashed',
      svg2.indexOf('stroke-dasharray="3 3"') >= 0 && svg2.indexOf('grows within') >= 0);
    // the drawing and the detail panel must not drift apart - they read the same veinExtent
    const m1 = svg2.match(/a drill passes ~[0-9]+ of its ([0-9]+) tall[\s\S]{0,4}([0-9]+) wide/);
    const m2 = el2('ovDetail').innerHTML.match(/it is ([0-9]+) tall and ([0-9]+) wide/);
    check('the drawing and the note agree on the size', !!m1 && !!m2 && m1[1] === m2[1] && m1[2] === m2[2],
      m1 && m2 ? m1[1] + 'x' + m1[2] + ' drawn vs ' + m2[1] + 'x' + m2[2] + ' written' : 'no match');
  }
  // The height of ONE deposit is not what a column digs through: each deposit's window hangs under its own
  // seed's surface, so across a biome's relief the windows slide past each other and the ore reaches across
  // a much thicker band. Settings of 20-24 over Desert's 11 blocks of relief prospect as 16 blocks solid,
  // where the panel used to promise 5.
  {
    const desert = terrain.Modules.find(m => m.BiomeName === 'Desert');
    const layer = desert.Module.BlockDepthRanges.find(r => (r.SubModules || []).some(x => /Deposit/.test(x['$type'] || '')));
    const v = layer.SubModules.find(x => /Deposit/.test(x['$type'] || ''));
    v.SpawnPercentChance = 0.0015; v.DepthRange = { min: 20, max: 24 }; v.DepositDepthRange = { min: 20, max: 24 };
    v.BlocksCountRange = { min: 1000, max: 5000 };
    v.DirectionWeights = [{ X: 4, Y: 1, Z: 4 }]; v.WeightVariance = { X: 3, Y: 1, Z: 3 };
    lifted2.OreVisual.build();
    const gt2 = el2('ovLane').innerHTML.indexOf('|gt"');
    const i2 = el2('ovLane').innerHTML.slice(el2('ovLane').innerHTML.lastIndexOf('data-drag="', gt2) + 11, gt2);
    el2('ovSvg').handlers.pointerdown({ target: { dataset: { drag: i2 + '|move' } }, clientX: 0, clientY: 0, preventDefault() {} });
    const note = el2('ovDetail').innerHTML;
    const one = note.match(/it is ([0-9]+) tall/);
    const band = note.match(/within about ([0-9]+) blocks of depth/);
    const relief = note.match(/rolls over ([0-9]+) blocks/);
    check('the note separates one deposit from what a column digs through',
      !!one && !!band && !!relief && +band[1] === +one[1] + +relief[1],
      one && band && relief ? one[1] + ' tall + ' + relief[1] + ' relief = ' + band[1] + ' band' : 'no match');
    check('the depth it turns up at still spans the 16 blocks the relief gives it',
      !!band && band[1] === '16', band && band[1]);
      // The number people act on: a flat sheet spreads thin, so its median column holds far less than its
    // own height. Blobs of the same size fill the window instead. This is the lever for "5 layers thick".
    check('it says the ore per column and that the engine will warn at this rate',
      note.indexOf('blocks of ore per column') >= 0 && note.indexOf('engine will warn at load') >= 0);
    const drill = note.match(/drill through one passes about ([0-9]+) block/);
    check('the note leads with what a drill passes through, and a sheet is thinner than it is tall',
      !!drill && !!one && +drill[1] < +one[1], drill && one ? drill[1] + ' drilled vs ' + one[1] + ' tall' : 'no match');
    v.DirectionWeights = [{ X: 1, Y: 1, Z: 1 }]; v.WeightVariance = { X: 1, Y: 1, Z: 1 };
    v.BlocksCountRange = { min: 500, max: 500 };
    lifted2.OreVisual.build();
    el2('ovSvg').handlers.pointerdown({ target: { dataset: { drag: i2 + '|move' } }, clientX: 0, clientY: 0, preventDefault() {} });
    const blobDrill = el2('ovDetail').innerHTML.match(/drill through one passes about ([0-9]+) block/);
    check('the same window as blobs fills it instead of spreading', !!blobDrill && +blobDrill[1] >= 5, blobDrill && blobDrill[1]);
  }
  check('no strip is requested any more', el2('ovLane').innerHTML.indexOf('real columns') < 0);
}

// ---- the port the strip rides on, with the real noise ----
{
  const core = require(path.join(ROOT, 'src', 'core.js')), voxel = require(path.join(ROOT, 'src', 'voxel.js'));
  core.setVectorTable(fs.readFileSync(path.join(ROOT, 'src', 'vectortable.txt'), 'utf8').trim().split(',').map(Number));
  const cfg = { worldWidth: 72, seed: 4242, waterLevel: 60, maxGenerationHeight: 120 };
  const full = voxel.initTerrain(terrain, cfg); full.biomeAt = () => 'Desert';
  const again = voxel.initTerrain(terrain, cfg); again.biomeAt = () => 'Desert';
  let same = true; for (let i = 0; i < 64 && same; i++) { const x = 100 + i * 7, z = 300 + i * 3;
    const a = voxel.generateColumn(full, x, z, 67), b = voxel.generateColumn(again, x, z, 67); if (a.join() !== b.join()) same = false; }
  check('the same terrain calibrates to the same ground twice', same);
  const dS = full.biomes.Desert.ranges.flatMap(r => r.subs.filter(s => s.kind === 'scatter'));
  const oS = again.biomes.Desert.ranges.flatMap(r => r.subs.filter(s => s.kind === 'scatter'));
  check('the calibration memo returns the exact bands', dS.length > 0 && dS.every((s, i) => s._nMin === oS[i]._nMin && s._nMax === oS[i]._nMax && s._seed === oS[i]._seed), dS.length + ' fills');
  const other = voxel.initTerrain(terrain, { worldWidth: 72, seed: 99, waterLevel: 60, maxGenerationHeight: 120 }); other.biomeAt = () => 'Desert';
  check('another seed digs different ground',
    voxel.generateColumn(other, 360, 360, 67).join() !== voxel.generateColumn(full, 360, 360, 67).join());
}

console.log(fails ? '\n' + fails + ' check(s) failed' : '\nall checks passed');
process.exit(fails ? 1 : 0);
