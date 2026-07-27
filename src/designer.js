// src/designer.js — "Design a map": draw a target biome layout, invert it to a starting config,
// then run a parallel best-of-N seed search for a real, playable world that resembles the drawing.
//
// Injected RAW into the page (like render3d.js), AFTER the main script, so it can use template
// literals freely and reference the main-thread globals ($, baseCfg, readForm, populateForm,
// generateMap, makeWorker, VT, sharesToWeights, WEIGHT_KEYS, terrain, cfgUsed) and the inlined
// search core (SCLASS, SC, NUM_CLASSES, scoreGrids, histogram).
//
// Honest scope: the generator has NO spatial-placement knobs — where a biome lands is a chaotic
// function of the seed. So this is a lottery scored by similarity, not an optimizer that converges.
// It reliably matches the biome MIX and macro land-shape; exact layout is best-effort (best-of-N).
(function () {
  const G = 64;                          // paint + scoring grid resolution
  const NC = NUM_CLASSES;
  const CN = SCLASS;                     // class id -> name
  // display colors per score class (kept close to the map's biome palette)
  const COL = {
    Ocean: [64, 120, 190], Coast: [246, 238, 188], Grassland: [124, 200, 110], WarmForest: [176, 132, 38],
    ColdForest: [40, 132, 52], RainForest: [42, 172, 158], Desert: [232, 196, 116], Taiga: [110, 140, 60],
    Tundra: [190, 184, 120], Ice: [238, 246, 252], Wetland: [30, 104, 62],
  };
  const LABEL = {
    Ocean: 'Ocean / water', Coast: 'Coast', Grassland: 'Grassland', WarmForest: 'Warm forest',
    ColdForest: 'Cold forest', RainForest: 'Rainforest', Desert: 'Desert', Taiga: 'Taiga',
    Tundra: 'Tundra', Ice: 'Ice', Wetland: 'Wetland',
  };
  // palette order shown to the user (grouped: water, then cool->warm land)
  const PALETTE = ['Ocean', 'Coast', 'Grassland', 'WarmForest', 'ColdForest', 'RainForest', 'Wetland', 'Desert', 'Taiga', 'Tundra', 'Ice'];
  const colCss = c => { const r = COL[CN[c]] || [128, 128, 128]; return 'rgb(' + r[0] + ',' + r[1] + ',' + r[2] + ')'; };
  // class id -> the generator's "min blob count" field
  const CLASS_NUM = { ColdForest: 'numCoolForests', Taiga: 'numTaigas', Tundra: 'numTundras', Ice: 'numIces', WarmForest: 'numWarmForests', Wetland: 'numWetlands', RainForest: 'numRainforests', Desert: 'numDeserts' };

  let target = new Uint8Array(G * G);    // painted target (generation orientation; y=0 is array row 0)
  let brushClass = SC.Grassland, brushSize = 5, tool = 'paint';
  let layoutWeight = 0.6;
  let invBase = null;                    // inverted starting config (all fields), seed varied per candidate
  let pool = [];                         // kept candidates: { seed, grid, s }  (s = score breakdown)
  const POOL_MAX = 120, SHOW = 12;
  let workers = [], running = false, evaluated = 0, tStart = 0, seedSet = new Set(), lastUiPaint = 0;
  let classgridBound = false, painting = false, built = false, cfgBySeed = {}, poolTargetSig = null;

  // ================================================================= styling
  function injectStyle() {
    if (document.getElementById('dsnStyle')) return;
    const s = document.createElement('style'); s.id = 'dsnStyle';
    s.textContent = `
    #designWrap{margin-top:6px}
    .dsnCols{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}
    .dsnLeft{flex:0 0 auto} .dsnRight{flex:1 1 360px;min-width:320px;max-width:560px}
    #dsnCanvasWrap{position:relative;border:0.5px solid var(--border);border-radius:12px;background:var(--surf);padding:8px;line-height:0;display:inline-block}
    #dsnCanvas{border-radius:6px;cursor:crosshair;touch-action:none;image-rendering:pixelated;width:520px;height:520px;max-width:80vw;max-height:80vw}
    .dsnPal{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}
    .dsnPal button{display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 9px}
    .dsnPal button.on{outline:2px solid var(--accent);outline-offset:1px;font-weight:600}
    .dsnPal .sw{width:13px;height:13px;border-radius:3px;border:0.5px solid var(--border2)}
    .dsnTools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0}
    .dsnCard{border:0.5px solid var(--border);border-radius:10px;background:var(--surf);padding:10px 12px;margin:0 0 12px}
    .dsnCard h4{margin:0 0 6px;font-size:13px;font-weight:600}
    .dsnGallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
    .dsnCandidate{border:0.5px solid var(--border);border-radius:8px;background:var(--surf);padding:6px;text-align:center;font-size:11px;color:var(--text2)}
    .dsnCandidate canvas{width:100%;height:auto;border-radius:5px;image-rendering:pixelated;display:block;margin-bottom:4px;cursor:pointer}
    .dsnCandidate .sc{font-size:15px;font-weight:700;color:var(--text)}
    .dsnCandidate button{width:100%;font-size:11px;padding:3px 0;margin-top:4px}
    .dsnCandidate.best{outline:2px solid var(--accent)}
    .dsnBars{display:flex;height:14px;border-radius:4px;overflow:hidden;border:0.5px solid var(--border);margin:6px 0}
    .dsnBars>span{display:block}
    #dsnStatus{font-size:12px;color:var(--text2)}
    .dsnMini{font-size:11px;color:var(--muted)}
    .dsnRange{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2)}
    .dsnRange input[type=range]{flex:1}
    `;
    document.head.appendChild(s);
  }

  // ================================================================= UI build
  function buildUI() {
    injectStyle();
    const host = $('designWrap');
    host.innerHTML =
      '<div class="row" style="margin:2px 0 6px"><strong style="font-size:15px">🎨 Design a map</strong>' +
      '<span class="dsnMini" style="margin-left:6px">draw a target, then search seeds for a real world that resembles it</span>' +
      '<button id="dsnClose" style="margin-left:auto">← Back to map</button></div>' +
      '<div class="dsnMini" style="margin:0 0 10px;max-width:900px">The generator has no way to place a biome at a spot you choose — layout is decided by the seed. So this finds the <b>closest</b> real world by trying many seeds and scoring similarity; it matches the biome mix and land shape well, exact placement only loosely. Every result is a genuine, exportable <code>.eco</code>.</div>' +
      '<div class="dsnCols">' +
        '<div class="dsnLeft">' +
          '<div class="dsnPal" id="dsnPal"></div>' +
          '<div id="dsnCanvasWrap"><canvas id="dsnCanvas" width="' + G + '" height="' + G + '"></canvas></div>' +
          '<div class="dsnTools">' +
            '<span class="dsnRange" style="width:190px">Brush <input type="range" id="dsnBrush" min="1" max="16" value="' + brushSize + '"><span id="dsnBrushV" class="dsnMini">' + brushSize + '</span></span>' +
            '<label class="dsnMini" style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" id="dsnFill"> flood fill</label>' +
            '<button id="dsnSeedFromMap">Seed from current map</button>' +
            '<button id="dsnClear">Clear</button>' +
          '</div>' +
          '<div class="dsnMini">Left-drag paints the selected biome · right-drag erases to ocean · toggle <b>flood fill</b> to bucket-fill a region.</div>' +
        '</div>' +
        '<div class="dsnRight">' +
          '<div class="dsnCard"><h4>1 · Target</h4><div id="dsnAnalysis" class="dsnMini">Draw a layout (or seed it from the current map), then analyze it.</div>' +
            '<div class="dsnBars" id="dsnMixBars" style="display:none"></div>' +
            '<button id="dsnAnalyze" class="primary" style="margin-top:8px">Analyze drawing → set up search</button></div>' +
          '<div class="dsnCard" id="dsnSearchCard" style="opacity:.5;pointer-events:none"><h4>2 · Search</h4>' +
            '<div class="dsnRange" style="margin-bottom:8px">Match&nbsp;<span class="dsnMini">mix</span><input type="range" id="dsnWeight" min="0" max="100" value="' + Math.round(layoutWeight * 100) + '"><span class="dsnMini">layout</span></div>' +
            '<div class="row" style="margin:2px 0"><button id="dsnStart" class="primary">▶ Start search</button><button id="dsnStop" disabled>■ Stop</button>' +
              '<label class="dsnMini" style="display:inline-flex;align-items:center;gap:4px;margin-left:4px" title="Also wobble land% and biome weights ±6% while searching, to explore around the inversion"><input type="checkbox" id="dsnJitter"> vary knobs</label></div>' +
            '<div id="dsnStatus" style="margin-top:8px">idle</div>' +
            '<div class="dsnMini" id="dsnSpeedHint" style="margin-top:6px"></div></div>' +
          '<div class="dsnCard"><h4 style="margin:0 0 6px">3 · Closest worlds <span class="dsnMini" id="dsnGalCount"></span></h4>' +
            '<div id="dsnCompare" style="display:flex;gap:12px;align-items:center;justify-content:center;margin:2px 0 8px">' +
              '<div style="text-align:center"><canvas id="dsnTargetRef" width="' + G + '" height="' + G + '" style="width:88px;height:88px;border-radius:6px;image-rendering:pixelated;border:0.5px solid var(--border)"></canvas><div class="dsnMini">your drawing</div></div>' +
              '<div style="font-size:22px;color:var(--muted)">→</div>' +
              '<div style="text-align:center"><canvas id="dsnBestRef" width="' + G + '" height="' + G + '" style="width:88px;height:88px;border-radius:6px;image-rendering:pixelated;border:0.5px solid var(--border)"></canvas><div class="dsnMini" id="dsnBestLbl">best match</div></div>' +
            '</div>' +
            '<div class="dsnMini" style="margin:2px 0 2px">click any card to apply it as your real world · scores are relative — even the best is an approximation</div>' +
            '<div class="dsnMini" style="margin:0 0 8px"><b>mix</b> = biome proportions · <b>shape</b> = land-mass overlap · <b>fit</b> = biome-type agreement</div>' +
            '<div class="dsnGallery" id="dsnGallery"><div class="dsnMini">No candidates yet — run a search.</div></div></div>' +
        '</div>' +
      '</div>';

    // palette
    const pal = $('dsnPal');
    pal.innerHTML = PALETTE.map(name => {
      const c = SC[name];
      return '<button data-c="' + c + '"><span class="sw" style="background:' + colCss(c) + '"></span>' + LABEL[name] + '</button>';
    }).join('');
    pal.querySelectorAll('button').forEach(b => b.onclick = () => { brushClass = +b.dataset.c; tool = 'paint'; markPalette(); });
    markPalette();

    // tools + wiring
    $('dsnBrush').oninput = e => { brushSize = +e.target.value; $('dsnBrushV').textContent = brushSize; };
    $('dsnClear').onclick = () => { target.fill(SC.Ocean); renderPaint(); };
    $('dsnSeedFromMap').onclick = seedFromMap;
    $('dsnClose').onclick = close;
    $('dsnAnalyze').onclick = analyze;
    $('dsnStart').onclick = startSearch;
    $('dsnStop').onclick = stopSearch;
    $('dsnWeight').oninput = e => { layoutWeight = +e.target.value / 100; rescorePool(); };
    const cv = $('dsnCanvas');
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', onPointer);
    cv.addEventListener('pointermove', e => { if (painting) onPointer(e); });
    window.addEventListener('pointerup', () => { painting = false; });
    built = true;
  }
  function markPalette() { $('dsnPal').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.c === brushClass)); }

  // ================================================================= painter
  // Everything is stored in generation orientation; we DISPLAY flipped-Y to match the map view.
  function drawGrid(canvas, grid, flip) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;                 // canvas is G x G backing store (pixelated upscaled by CSS)
    const img = ctx.createImageData(W, W);
    const d = img.data;
    for (let y = 0; y < W; y++) {
      const gy = flip ? (G - 1 - y) : y;
      for (let x = 0; x < W; x++) {
        const c = grid[gy * G + x], rgb = COL[CN[c]] || [128, 128, 128];
        const o = (y * W + x) * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  function renderPaint() { drawGrid($('dsnCanvas'), target, true); }
  function onPointer(e) {
    const cv = $('dsnCanvas'), r = cv.getBoundingClientRect();
    const dispX = Math.floor((e.clientX - r.left) / r.width * G);
    const dispY = Math.floor((e.clientY - r.top) / r.height * G);
    if (dispX < 0 || dispX >= G || dispY < 0 || dispY >= G) return;
    const gx = dispX, gy = G - 1 - dispY;   // flip display->grid
    const erase = (e.buttons & 2) === 2 || e.button === 2;
    const cls = erase ? SC.Ocean : brushClass;
    if ($('dsnFill').checked && !painting) { floodFill(gx, gy, cls); renderPaint(); return; }
    painting = true;
    stampBrush(gx, gy, cls);
    renderPaint();
  }
  function stampBrush(cx, cy, cls) {
    const rad = brushSize - 1, r2 = (rad + 0.5) * (rad + 0.5);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= G || y < 0 || y >= G) continue;   // clamp (no wrap) for predictable strokes
      target[y * G + x] = cls;
    }
  }
  function floodFill(sx, sy, cls) {
    const from = target[sy * G + sx];
    if (from === cls) return;
    const st = [sy * G + sx];
    while (st.length) {
      const i = st.pop();
      if (target[i] !== from) continue;
      target[i] = cls;
      const x = i % G, y = (i / G) | 0;
      if (x > 0) st.push(i - 1); if (x < G - 1) st.push(i + 1);
      if (y > 0) st.push(i - G); if (y < G - 1) st.push(i + G);
    }
  }
  function seedFromMap() {
    if (typeof result === 'undefined' || !result) { $('dsnAnalysis').textContent = 'Generate a map first, then seed from it.'; return; }
    if (!classgridBound) { worker.addEventListener('message', ev => { if (ev.data && ev.data.type === 'classgrid' && ev.data.grid) { target = new Uint8Array(ev.data.grid); renderPaint(); flashAnalysis('Seeded from the current map. Edit it, then analyze.'); } }); classgridBound = true; }
    worker.postMessage({ type: 'classgrid', G: G });
  }
  function flashAnalysis(msg) { $('dsnAnalysis').innerHTML = '<b>' + msg + '</b>'; }

  // ================================================================= inversion
  // toroidal 4-neighbour connected-component sizes for cells matching pred(i)
  function ccSizes(pred) {
    const seen = new Uint8Array(G * G), sizes = [], st = [];
    for (let i = 0; i < G * G; i++) {
      if (seen[i] || !pred(i)) continue;
      let sz = 0; st.length = 0; st.push(i); seen[i] = 1;
      while (st.length) {
        const c = st.pop(); sz++;
        const x = c % G, y = (c / G) | 0;
        const nb = [((x + 1) % G) + y * G, ((x + G - 1) % G) + y * G, x + ((y + 1) % G) * G, x + ((y + G - 1) % G) * G];
        for (let k = 0; k < 4; k++) { const n = nb[k]; if (!seen[n] && pred(n)) { seen[n] = 1; st.push(n); } }
      }
      sizes.push(sz);
    }
    return sizes.sort((a, b) => b - a);
  }
  function analyze() {
    invBase = null;                              // cleared until a valid analysis succeeds
    const total = G * G;
    const h = histogram(target);                 // fraction per class
    const landFrac = (() => { let s = 0; for (let c = SC.Grassland; c < NC; c++) s += h[c]; return s; })();
    if (landFrac < 0.005) { flashAnalysis('Almost no land drawn — paint some biomes first.'); setSearchEnabled(false); return; }

    // shares of land -> weights (reuse the app's exact biome-mix math)
    const need = name => h[SC[name]] / landFrac;
    const share = {
      coldforest: need('ColdForest'), taiga: need('Taiga'), tundra: need('Tundra'), ice: need('Ice'),
      warmforest: need('WarmForest'), wetland: need('Wetland'), rainforest: need('RainForest'), desert: need('Desert'),
      highdesert: 0, steppe: 0, grassland: 0,
    };
    const weights = sharesToWeights(share);

    const cfg = JSON.parse(JSON.stringify(readForm()));   // start from the current form (size, pointRadius, elevation…)
    for (const k of WEIGHT_KEYS) cfg[k] = +(weights[k] || 0).toFixed(4);

    const L = Math.max(0.03, Math.min(0.97, landFrac));
    cfg.landPercentRange = { min: +L.toFixed(3), max: +L.toFixed(3) };

    // per-biome min blob counts
    const minPatch = 0.004 * total;
    for (const name in CLASS_NUM) {
      const cls = SC[name];
      const n = ccSizes(i => target[i] === cls).filter(s => s >= minPatch).length;
      cfg[CLASS_NUM[name]] = Math.max(0, n);
    }
    // any land biome with weight>0 must have count>=1 or it never spawns
    const WK_NUM = { coolForestWeight: 'numCoolForests', taigaWeight: 'numTaigas', tundraWeight: 'numTundras', iceWeight: 'numIces', warmForestWeight: 'numWarmForests', wetlandWeight: 'numWetlands', rainforestWeight: 'numRainforests', desertWeight: 'numDeserts' };
    for (const wk in WK_NUM) if ((cfg[wk] || 0) > 0.0005 && (cfg[WK_NUM[wk]] || 0) < 1) cfg[WK_NUM[wk]] = 1;

    // continents / islands from the land mask
    const landSizes = ccSizes(i => target[i] >= SC.Grassland);
    const totalLand = landSizes.reduce((a, b) => a + b, 0) || 1;
    const contThresh = 0.04 * total, isleThresh = 0.0025 * total;
    const nc = landSizes.filter(s => s > contThresh).length;
    const ni = landSizes.filter(s => s > isleThresh && s <= contThresh).length;
    const islandArea = landSizes.filter(s => s > isleThresh && s <= contThresh).reduce((a, b) => a + b, 0);
    cfg.numContinentsRange = { min: Math.max(1, nc), max: Math.max(1, nc) };
    cfg.numSmallIslandsRange = { min: Math.max(1, ni), max: Math.max(1, ni) };
    cfg.islandWeight = +Math.max(0, Math.min(0.6, islandArea / totalLand)).toFixed(3);

    invBase = cfg;
    updateSpeedHint();

    // summary UI
    const parts = [];
    for (let c = SC.Grassland; c < NC; c++) if (h[c] > 0.008) parts.push([CN[c], h[c]]);
    parts.sort((a, b) => b[1] - a[1]);
    $('dsnMixBars').style.display = 'flex';
    $('dsnMixBars').innerHTML =
      (h[SC.Ocean] > 0.004 ? '<span title="Ocean" style="flex:0 0 ' + (h[SC.Ocean] * 100).toFixed(2) + '%;background:' + colCss(SC.Ocean) + '"></span>' : '') +
      (h[SC.Coast] > 0.004 ? '<span title="Coast" style="flex:0 0 ' + (h[SC.Coast] * 100).toFixed(2) + '%;background:' + colCss(SC.Coast) + '"></span>' : '') +
      parts.map(([n, f]) => '<span title="' + LABEL[n] + ' ' + (f * 100).toFixed(0) + '% of world" style="flex:0 0 ' + (f * 100).toFixed(2) + '%;background:' + colCss(SC[n]) + '"></span>').join('');
    $('dsnAnalysis').innerHTML =
      'Land <b>' + (landFrac * 100).toFixed(0) + '%</b> · <b>' + Math.max(1, nc) + '</b> continent(s), <b>' + Math.max(1, ni) + '</b> island group(s)<br>' +
      '<span class="dsnMini">mix (of land): ' + parts.slice(0, 6).map(([n, f]) => LABEL[n] + ' ' + (f / landFrac * 100).toFixed(0) + '%').join(' · ') + '</span>';
    setSearchEnabled(true);
    $('dsnStatus').textContent = 'ready — press Start search';
  }
  function setSearchEnabled(on) { const c = $('dsnSearchCard'); c.style.opacity = on ? '' : '.5'; c.style.pointerEvents = on ? '' : 'none'; }

  // ================================================================= search pool
  function poolWorkerCount() { return Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)); }
  function randSeed() { let s; do { s = (Math.floor(Math.random() * 2147483646) + 1) | 0; } while (seedSet.has(s)); return s; }

  function ensureWorkers(cb) {
    if (workers.length) { cb(); return; }
    const n = poolWorkerCount();
    let ready = 0;
    for (let i = 0; i < n; i++) {
      const w = makeWorker(); w._busy = false;
      w.onmessage = ev => onWorkerMsg(w, ev.data);
      w.postMessage({ type: 'init', vt: VT });
      w.postMessage({ type: 'search-init', target: target, G: G, layoutWeight: layoutWeight });
      w._readyCb = () => { if (++ready === n) cb(); };
      workers.push(w);
    }
  }
  function onWorkerMsg(w, m) {
    if (m.type === 'ready') return;                       // init ack
    if (m.type === 'search-ready') { if (w._readyCb) { w._readyCb(); w._readyCb = null; } return; }
    if (m.type === 'search-error') { w._busy = false; if (running) dispatch(w); return; }
    if (m.type === 'search-result') {
      w._busy = false; evaluated++;
      recordCandidate(m);
      if (running) dispatch(w);
      throttledUi();
    }
  }
  function dispatch(w) {
    if (!running || w._busy) return;
    const seed = randSeed(); seedSet.add(seed);
    const cfg = JSON.parse(JSON.stringify(invBase)); cfg.seed = seed;
    if ($('dsnJitter').checked) jitter(cfg);
    cfgBySeed[seed] = cfg;               // remember the exact cfg so Apply reproduces this candidate (esp. with jitter)
    w._busy = true;
    w.postMessage({ type: 'search-eval', cfg: cfg });
  }
  function jitter(cfg) {
    // gentle ±6% multiplicative wobble on land% and each biome weight, to explore near the inversion
    const wob = v => Math.max(0, v * (1 + (Math.random() - 0.5) * 0.12));
    const L = Math.max(0.03, Math.min(0.97, wob(cfg.landPercentRange.min)));
    cfg.landPercentRange = { min: +L.toFixed(3), max: +L.toFixed(3) };
    for (const k of WEIGHT_KEYS) if (cfg[k] > 0) cfg[k] = +wob(cfg[k]).toFixed(4);
  }
  // Combine the weight-independent similarity components into a score for the current layoutWeight.
  // (prop/soft/iou/exact are computed by the worker at the best toroidal shift and don't depend on w,
  // so re-weighting the whole pool is pure arithmetic — no re-scoring of grids on the main thread.)
  function combine(c, w) {
    const layout = 0.5 * c.soft + 0.3 * c.iou + 0.2 * c.exact;
    return { score: (1 - w) * c.prop + w * layout, layout: layout, prop: c.prop, soft: c.soft, iou: c.iou, exact: c.exact };
  }
  function recordCandidate(m) {
    const grid = new Uint8Array(m.grid);
    const comp = { prop: m.prop, soft: m.soft, iou: m.iou, exact: m.exact };
    const s = combine(comp, layoutWeight);
    const cfg = cfgBySeed[m.seed]; delete cfgBySeed[m.seed];
    const item = { seed: m.seed, grid: grid, comp: comp, s: s, cfg: cfg };
    // insert sorted desc by score
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid].s.score < s.score) hi = mid; else lo = mid + 1; }
    pool.splice(lo, 0, item);
    if (pool.length > POOL_MAX) { const dropped = pool.splice(POOL_MAX); for (const d of dropped) if (d.cfg && d.cfg.seed != null) delete cfgBySeed[d.cfg.seed]; }
  }
  function targetSig() {                // cheap FNV-1a hash so we can tell if the drawing changed
    let h = 2166136261 >>> 0;
    for (let i = 0; i < target.length; i++) { h ^= target[i]; h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  function startSearch() {
    if (running) return;
    analyze();                          // always re-derive invBase from the current drawing (keeps it in sync)
    if (!invBase) return;
    const sig = targetSig();            // if the drawing changed, the old pool was scored vs a different target
    if (sig !== poolTargetSig) { pool = []; seedSet = new Set(); cfgBySeed = {}; poolTargetSig = sig; renderGallery(); }
    running = true; tStart = performance.now(); evaluated = 0;
    $('dsnStart').disabled = true; $('dsnStop').disabled = false;
    $('dsnStatus').textContent = 'starting workers…';
    ensureWorkers(() => {
      if (!running) return;             // user may have stopped/closed during worker spin-up
      // (re)sync each worker's target + weight in case the drawing/weight changed since last run
      for (const w of workers) w.postMessage({ type: 'search-init', target: target, G: G, layoutWeight: layoutWeight });
      for (const w of workers) dispatch(w);
    });
  }
  function stopSearch() {
    running = false;
    $('dsnStart').disabled = false; $('dsnStop').disabled = true;
    renderGallery(); updateStatus();
  }
  function rescorePool() {
    // pure arithmetic re-weight of the stored components — instant, no grid work
    for (const it of pool) it.s = combine(it.comp, layoutWeight);
    pool.sort((a, b) => b.s.score - a.s.score);
    renderGallery(); updateStatus();
  }

  // ================================================================= results UI
  function throttledUi() {
    const now = performance.now();
    if (now - lastUiPaint < 250) return;
    lastUiPaint = now;
    renderGallery(); updateStatus();
  }
  function updateSpeedHint() {
    const el = $('dsnSpeedHint'); if (!el) return;
    const ww = (invBase && invBase.worldWidth) || (typeof baseCfg !== 'undefined' && baseCfg ? baseCfg.worldWidth : 72);
    const m = ww * 10;
    const note = ww <= 90 ? 'fast — many candidates/second' : ww <= 130 ? 'moderate — a few candidates/second' : 'slow — big worlds take ~seconds per candidate; let it run longer';
    el.innerHTML = 'World <b>' + m + '×' + m + ' m</b> · ' + poolWorkerCount() + ' parallel workers · ' + note + '.<br>More candidates = better matches. Leave it running and pick from the best.';
  }
  function updateStatus() {
    const secs = (performance.now() - tStart) / 1000;
    const rate = running && secs > 0 ? (evaluated / secs) : 0;
    const best = pool.length ? (pool[0].s.score * 100).toFixed(1) + '%' : '—';
    $('dsnStatus').innerHTML =
      (running ? '<b>searching…</b> ' : 'stopped · ') +
      'evaluated <b>' + evaluated + '</b>' + (running ? ' · ~' + rate.toFixed(1) + '/s' : '') +
      ' · best <b>' + best + '</b> · ' + poolWorkerCount() + ' workers';
  }
  function renderGallery() {
    const gal = $('dsnGallery');
    const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target, true);   // keep the "your drawing" thumbnail in sync
    const bestRef = $('dsnBestRef'), bestLbl = $('dsnBestLbl');
    if (bestRef) { if (pool.length) { drawGrid(bestRef, pool[0].grid, true); if (bestLbl) bestLbl.textContent = 'best match · ' + (pool[0].s.score * 100).toFixed(1) + '%'; } else { bestRef.getContext('2d').clearRect(0, 0, G, G); if (bestLbl) bestLbl.textContent = 'best match'; } }
    $('dsnGalCount').textContent = pool.length ? '(' + pool.length + ' kept)' : '';
    if (!pool.length) { gal.innerHTML = '<div class="dsnMini">No candidates yet — run a search.</div>'; return; }
    const show = pool.slice(0, SHOW);
    gal.innerHTML = show.map((it, i) =>
      '<div class="dsnCandidate' + (i === 0 ? ' best' : '') + '" data-i="' + i + '">' +
        '<canvas width="' + G + '" height="' + G + '" data-i="' + i + '"></canvas>' +
        '<div class="sc">' + (it.s.score * 100).toFixed(1) + '%</div>' +
        '<div>seed ' + it.seed + '</div>' +
        '<div class="dsnMini">mix ' + (it.s.prop * 100).toFixed(0) + ' · shape ' + (it.s.iou * 100).toFixed(0) + ' · fit ' + (it.s.soft * 100).toFixed(0) + '</div>' +
        '<button data-apply="' + i + '">Apply</button>' +
      '</div>').join('');
    gal.querySelectorAll('canvas[data-i]').forEach(c => drawGrid(c, show[+c.dataset.i].grid, true));
    gal.querySelectorAll('button[data-apply]').forEach(b => b.onclick = () => applyCandidate(show[+b.dataset.apply]));
    gal.querySelectorAll('canvas[data-i]').forEach(c => c.onclick = () => applyCandidate(show[+c.dataset.i]));
  }
  function applyCandidate(item) {
    // the candidate's exact cfg (jitter-safe); fall back to invBase+seed for older pool items
    const src = item.cfg || Object.assign(JSON.parse(JSON.stringify(invBase)), { seed: item.seed });
    const cfg = JSON.parse(JSON.stringify(src));
    populateForm(cfg);                    // fills every form field incl. weights + seed; readForm() will reproduce cfg
    close();
    generateMap(cfg);                     // baseCfg is left as the loaded config so "Reset to loaded" still works
  }

  // ================================================================= open / close
  function open() {
    if (typeof baseCfg === 'undefined' || !baseCfg) { $('err').textContent = 'Load a WorldGenerator.eco config first.'; return; }
    if (!built) buildUI();
    // hide the map view + panels (mirror open3D), show the designer
    $('canvasWrap').style.display = 'none'; $('legend').style.display = 'none'; $('stats').style.display = 'none';
    $('view3d').style.display = 'none'; $('expPng').style.display = 'none'; $('designOpen').style.display = 'none';
    const cp = $('chartsPanel'), cfp = $('cfgPanel');
    if (cp) { cp._dsnPrev = cp.style.display; cp.style.display = 'none'; }
    if (cfp) { cfp._dsnPrev = cfp.style.display; cfp.style.display = 'none'; }
    $('designWrap').style.display = 'block';
    // first time in: seed the canvas from the current map so there's something to edit (not blank ocean)
    let empty = true; for (let i = 0; i < target.length; i++) if (target[i] !== SC.Ocean) { empty = false; break; }
    if (empty && typeof result !== 'undefined' && result) seedFromMap();
    updateSpeedHint();
    const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target, true);
    renderPaint();
  }
  function close() {
    stopSearch();
    $('designWrap').style.display = 'none';
    $('canvasWrap').style.display = ''; $('legend').style.display = ''; $('stats').style.display = '';
    $('view3d').style.display = ''; $('expPng').style.display = ''; $('designOpen').style.display = '';
    const cp = $('chartsPanel'), cfp = $('cfgPanel');
    if (cp) cp.style.display = cp._dsnPrev != null ? cp._dsnPrev : '';
    if (cfp) cfp.style.display = cfp._dsnPrev != null ? cfp._dsnPrev : '';
  }

  window.Designer = { open, close };
  const btn = document.getElementById('designOpen');
  if (btn) btn.onclick = open;
})();
