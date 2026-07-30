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
  // authored-world layers (for the "export a real world" flow, distinct from the seed search)
  let elev = new Float32Array(G * G);          // painted elevation [0..1], 0.5 = sea level
  let elevPainted = new Uint8Array(G * G);     // 1 where the user painted elevation (else biome-derived default)
  let water = new Uint8Array(G * G);           // 1 where the user painted a river/lake (carved + water-filled)
  let paintMode = 'biome';                     // 'biome' | 'elevation' | 'water'
  let elevValue = 0.66;                        // current elevation brush value
  const RIVER_CARVE = 0.045, RIVER_LIP = 0.012; // channel depth + how far the water sits below the banks (in [0,1] height)

  // Exact Eco biome colors (System.Drawing names, ARGB) for the exported biome map, keyed by score class.
  const ECO_BIOME_COLOR = {
    Ocean: [70, 130, 180], Coast: [250, 250, 210], Grassland: [144, 238, 144], WarmForest: [184, 134, 11],
    ColdForest: [34, 139, 34], RainForest: [32, 178, 170], Desert: [244, 164, 96], Taiga: [107, 142, 35],
    Tundra: [189, 183, 107], Ice: [255, 255, 255], Wetland: [0, 100, 0],
  };
  // Default elevation BAND per biome as [low, high] (0.5 = sea level), derived from Eco's own biome
  // elevation ranges. Unpainted land is placed within its band by distance-to-ocean (coast=low,
  // interior=high) + noise, mirroring a regular server: coastal lowlands rising to interior hills, with
  // cold/mountain biomes taller. Blurred so biome edges are slopes.
  const ECO_BIOME_ELEV = {
    Ocean: [0.18, 0.44], Coast: [0.50, 0.54], Grassland: [0.52, 0.66], WarmForest: [0.54, 0.70],
    ColdForest: [0.54, 0.74], RainForest: [0.53, 0.68], Desert: [0.51, 0.60], Wetland: [0.51, 0.60],
    Taiga: [0.60, 0.80], Tundra: [0.64, 0.85], Ice: [0.70, 0.88],
  };
  const HEIGHT_BLUR_PASSES = 2;   // box-blur passes; enough to soften biome-height steps without washing out relief
  let layoutWeight = 0.6;
  let invBase = null;                    // inverted starting config (all fields), seed varied per candidate
  let pool = [];                         // kept candidates: { seed, grid, s }  (s = score breakdown)
  const POOL_MAX = 120, SHOW = 12;
  let workers = [], running = false, evaluated = 0, tStart = 0, seedSet = new Set(), lastUiPaint = 0;
  let classgridBound = false, painting = false, built = false, cfgBySeed = {}, poolTargetSig = null;
  let undoStack = [], lastGX = -1, lastGY = -1;
  // image-import color legend: dominant source colors + their (user-overridable) biome assignment
  let legend = [];               // [{ rgb:[r,g,b], count, cls }]
  let imgLegendIdx = null;       // Int16Array(G*G) legend index per image cell (-1 = transparent -> ocean)
  const MAX_LEGEND = 12;         // cap on distinct source colors offered for remapping

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
    .dsnLegend{margin:8px 0 0;padding:8px 10px;border:0.5px solid var(--border);border-radius:8px;background:var(--surf)}
    .dsnLegend .lgHead{font-size:12px;color:var(--text2);margin-bottom:7px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .dsnLegend .lgRows{display:flex;flex-wrap:wrap;gap:7px}
    .dsnLegend .lgRow{display:flex;align-items:center;gap:6px;font-size:11px;border:0.5px solid var(--border);border-radius:6px;padding:3px 6px;background:var(--bg)}
    .dsnLegend .lgSw{width:16px;height:16px;border-radius:4px;border:0.5px solid var(--border2);flex:0 0 auto}
    .dsnLegend .lgPct{color:var(--muted);min-width:26px;text-align:right}
    .dsnLegend select{font-size:11px;padding:1px 2px}
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
            '<button id="dsnUndo" title="Undo (Ctrl+Z)">↶ Undo</button>' +
            '<button id="dsnSeedFromMap">Seed from current map</button>' +
            '<button id="dsnImport" title="Map an image\'s colors to biomes — auto-nearest, then remap any color you like">📁 Import image</button>' +
            '<input type="file" id="dsnImgFile" accept="image/*" style="display:none">' +
            '<button id="dsnClear">Clear</button>' +
          '</div>' +
          '<div class="dsnTools" style="margin-top:0">' +
            '<span class="dsnMini">Paint</span><span class="seg" id="dsnPaintMode"><button type="button" data-pm="biome" class="on">Biomes</button><button type="button" data-pm="elevation">Elevation</button><button type="button" data-pm="water">Water</button></span>' +
            '<span class="dsnRange" id="dsnElevWrap" style="width:210px;display:none">Height <input type="range" id="dsnElev" min="0" max="100" value="' + Math.round(elevValue * 100) + '"><span id="dsnElevV" class="dsnMini"></span></span>' +
          '</div>' +
          '<div class="dsnMini">Left-drag paints · right-drag erases · <b>flood fill</b> bucket-fills a biome region. <b>Elevation</b>: sculpt height (unpainted areas use a natural biome-based default). <b>Water</b>: paint rivers/lakes — they carve a channel and fill with water (route them downhill along your terrain).</div>' +
          '<div id="dsnLegendWrap" class="dsnLegend" style="display:none"></div>' +
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
          '<div class="dsnCard"><h4 style="margin:0 0 4px">4 · Authored world <span class="dsnMini">(exact — no search)</span></h4>' +
            '<div class="dsnMini" style="margin:0 0 8px">Export your drawing as a real world: the biome + height maps + config become a bundle for the <code>EcoWorldGenCLI</code> tool, which generates a stock-loadable <code>.eco</code> save whose biomes match your drawing <b>exactly</b> (needs the C# tool + an Eco server build).</div>' +
            '<button id="dsnExport" class="primary">⬇ Export authored world (.zip)</button>' +
            '<div class="dsnMini" id="dsnExportStatus" style="margin-top:8px"></div></div>' +
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
    $('dsnClear').onclick = () => { pushUndo(); target.fill(SC.Ocean); elevPainted.fill(0); water.fill(0); hideLegend(); renderPaint(); };
    $('dsnUndo').onclick = undo;
    $('dsnSeedFromMap').onclick = seedFromMap;
    $('dsnImport').onclick = () => $('dsnImgFile').click();
    $('dsnImgFile').onchange = e => { const f = e.target.files[0]; if (f) importImage(f); e.target.value = ''; };
    $('dsnClose').onclick = close;
    $('dsnAnalyze').onclick = analyze;
    $('dsnStart').onclick = startSearch;
    $('dsnStop').onclick = stopSearch;
    $('dsnWeight').oninput = e => { layoutWeight = +e.target.value / 100; rescorePool(); };
    $('dsnExport').onclick = exportBundle;
    $('dsnPaintMode').querySelectorAll('button').forEach(b => b.onclick = () => {
      paintMode = b.dataset.pm;
      $('dsnPaintMode').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.pm === paintMode));
      $('dsnElevWrap').style.display = paintMode === 'elevation' ? '' : 'none';
      renderPaint();
    });
    $('dsnElev').oninput = e => { elevValue = +e.target.value / 100; $('dsnElevV').textContent = elevLabel(elevValue); };
    $('dsnElevV').textContent = elevLabel(elevValue);
    const cv = $('dsnCanvas');
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => { pushUndo(); onPointer(e); });
    cv.addEventListener('pointermove', e => { if (painting) onPointer(e); });
    window.addEventListener('pointerup', () => { painting = false; lastGX = -1; lastGY = -1; });
    window.addEventListener('keydown', e => { if ($('designWrap').style.display === 'none') return; if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); } });
    built = true;
  }
  function markPalette() { $('dsnPal').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.c === brushClass)); }
  function elevLabel(v) { return v < 0.45 ? 'deep water' : v < 0.52 ? 'sea level' : v < 0.65 ? 'lowland' : v < 0.8 ? 'hills' : 'peaks'; }

  // ================================================================= image import
  // nearest biome (by weighted RGB distance) to a source color — green-weighted like human vision
  function nearestClass(r, g, b) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < NC; c++) {
      const p = ECO_BIOME_COLOR[CN[c]]; if (!p) continue;
      const dr = r - p[0], dg = g - p[1], db = b - p[2], d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  // Cluster the image's pixels into its dominant colors (the legend). Colors are quantized to 16
  // levels/channel and bucketed; the biggest buckets are kept, the tail is merged into the nearest.
  function buildLegend(d) {
    const buckets = new Map();
    for (let i = 0; i < G * G; i++) {
      const o = i * 4; if (d[o + 3] < 128) continue;         // transparent -> handled as ocean, not a legend color
      const key = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
      let b = buckets.get(key);
      if (!b) { b = { r: 0, g: 0, bl: 0, n: 0 }; buckets.set(key, b); }
      b.r += d[o]; b.g += d[o + 1]; b.bl += d[o + 2]; b.n++;
    }
    const all = [...buckets.values()].map(b => ({ rgb: [Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.bl / b.n)], count: b.n }));
    all.sort((a, b) => b.count - a.count);
    const kept = all.slice(0, MAX_LEGEND);
    for (const e of all.slice(MAX_LEGEND)) {                 // fold rare colors into the nearest kept color
      let bi = 0, bd = Infinity;
      for (let k = 0; k < kept.length; k++) { const p = kept[k].rgb, dr = e.rgb[0] - p[0], dg = e.rgb[1] - p[1], db = e.rgb[2] - p[2], dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; bi = k; } }
      kept[bi].count += e.count;
    }
    for (const e of kept) e.cls = nearestClass(e.rgb[0], e.rgb[1], e.rgb[2]);   // default assignment = nearest biome
    return kept;
  }
  // Per-cell legend index (which dominant color each pixel belongs to); -1 = transparent.
  function assignLegendIdx(d) {
    const idx = new Int16Array(G * G);
    for (let i = 0; i < G * G; i++) {
      const o = i * 4;
      if (d[o + 3] < 128) { idx[i] = -1; continue; }
      let bi = 0, bd = Infinity;
      for (let k = 0; k < legend.length; k++) { const p = legend[k].rgb, dr = d[o] - p[0], dg = d[o + 1] - p[1], db = d[o + 2] - p[2], dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; bi = k; } }
      idx[i] = bi;
    }
    return idx;
  }
  // Paint the target from the stored per-cell legend + each legend color's current biome assignment.
  function applyLegend() {
    const count = {};
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const i = y * G + x, li = imgLegendIdx[i];
      const cls = li < 0 ? SC.Ocean : legend[li].cls;
      target[(G - 1 - y) * G + x] = cls;                     // flip Y so the image reads upright in the display
      count[cls] = (count[cls] || 0) + 1;
    }
    renderPaint();
    const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target, true);
    return count;
  }
  function flashMix(count) {
    const top = Object.keys(count).map(k => [LABEL[CN[+k]], count[k]]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]).join(', ');
    flashAnalysis('Imported image → biomes (' + top + '). Remap any color below, edit, or Analyze — then export.');
  }
  // The color→biome legend UI: one row per dominant color, with a biome dropdown that re-maps live.
  function renderLegend() {
    const wrap = $('dsnLegendWrap'); if (!wrap) return;
    if (!legend.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
    const total = G * G;
    const opts = PALETTE.map(n => '<option value="' + SC[n] + '">' + LABEL[n] + '</option>').join('');
    wrap.innerHTML =
      '<div class="lgHead"><b>Image colors → biomes</b><span class="dsnMini">pick a biome for each color — the map updates live</span>' +
      '<button id="lgAuto" style="margin-left:auto" title="Reset every color to its nearest biome">Auto (nearest)</button></div>' +
      '<div class="lgRows">' + legend.map((e, i) => {
        const pct = Math.round(e.count / total * 100);
        return '<div class="lgRow"><span class="lgSw" style="background:rgb(' + e.rgb[0] + ',' + e.rgb[1] + ',' + e.rgb[2] + ')"></span>' +
          '<span class="lgPct">' + (pct < 1 ? '<1' : pct) + '%</span>' +
          '<select data-i="' + i + '">' + opts + '</select></div>';
      }).join('') + '</div>';
    wrap.style.display = '';
    wrap.querySelectorAll('select').forEach(sel => {
      sel.value = legend[+sel.dataset.i].cls;
      sel.onchange = () => { pushUndo(); legend[+sel.dataset.i].cls = +sel.value; flashMix(applyLegend()); };
    });
    $('lgAuto').onclick = () => { pushUndo(); legend.forEach(e => e.cls = nearestClass(e.rgb[0], e.rgb[1], e.rgb[2])); renderLegend(); flashMix(applyLegend()); };
  }
  function hideLegend() { legend = []; imgLegendIdx = null; const w = $('dsnLegendWrap'); if (w) { w.style.display = 'none'; w.innerHTML = ''; } }
  // Load an image, stretch it to the world grid, cluster its colors, and map each color to a biome
  // (nearest by default — the user can then remap any color via the legend below the canvas).
  function importImage(file) {
    const img = new Image();
    img.onload = () => {
      pushUndo();
      const c = document.createElement('canvas'); c.width = G; c.height = G;
      const cx = c.getContext('2d'); cx.imageSmoothingEnabled = true;
      cx.drawImage(img, 0, 0, G, G);                          // stretch to the square world grid
      const d = cx.getImageData(0, 0, G, G).data;
      legend = buildLegend(d);
      imgLegendIdx = assignLegendIdx(d);
      paintMode = 'biome'; markPaintMode();
      const count = applyLegend();
      renderLegend();
      flashMix(count);
    };
    img.onerror = () => flashAnalysis('Could not read that image.');
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.readAsDataURL(file);
  }
  function markPaintMode() { const t = $('dsnPaintMode'); if (t) t.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.pm === paintMode)); const w = $('dsnElevWrap'); if (w) w.style.display = paintMode === 'elevation' ? '' : 'none'; }

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
  function renderPaint() {
    if (paintMode === 'elevation') drawHeight($('dsnCanvas'));
    else if (paintMode === 'water') drawWaterView($('dsnCanvas'));
    else drawGrid($('dsnCanvas'), target, true);
  }
  // biomes with the painted rivers/lakes overlaid in blue
  function drawWaterView(canvas) {
    drawGrid(canvas, target, true);
    const ctx = canvas.getContext('2d'), W = canvas.width, img = ctx.getImageData(0, 0, W, W), d = img.data;
    for (let y = 0; y < W; y++) { const gy = G - 1 - y; for (let x = 0; x < W; x++) { if (water[gy * G + x]) { const o = (y * W + x) * 4; d[o] = 30; d[o + 1] = 110; d[o + 2] = 230; } } }
    ctx.putImageData(img, 0, 0);
  }
  function pushUndo() { undoStack.push({ t: target.slice(), e: elev.slice(), p: elevPainted.slice(), w: water.slice() }); if (undoStack.length > 40) undoStack.shift(); }
  function undo() { if (!undoStack.length) return; const s = undoStack.pop(); target = s.t; elev = s.e; elevPainted = s.p; water = s.w; renderPaint(); }
  function onPointer(e) {
    const cv = $('dsnCanvas'), r = cv.getBoundingClientRect();
    const dispX = Math.floor((e.clientX - r.left) / r.width * G);
    const dispY = Math.floor((e.clientY - r.top) / r.height * G);
    if (dispX < 0 || dispX >= G || dispY < 0 || dispY >= G) return;
    const gx = dispX, gy = G - 1 - dispY;   // flip display->grid
    const erase = (e.buttons & 2) === 2 || e.button === 2;
    if (paintMode === 'elevation') {
      const v = erase ? -1 : elevValue;     // right-drag reverts to the biome-derived default
      if (painting && lastGX >= 0) stampLine(lastGX, lastGY, gx, gy, v, stampElev); else stampElev(gx, gy, v);
      painting = true; lastGX = gx; lastGY = gy; renderPaint(); return;
    }
    if (paintMode === 'water') {
      const v = erase ? 0 : 1;              // right-drag erases the river/lake
      if (painting && lastGX >= 0) stampLine(lastGX, lastGY, gx, gy, v, stampWater); else stampWater(gx, gy, v);
      painting = true; lastGX = gx; lastGY = gy; renderPaint(); return;
    }
    const cls = erase ? SC.Ocean : brushClass;
    if ($('dsnFill').checked && !painting) { floodFill(gx, gy, cls); renderPaint(); return; }
    // interpolate along the drag so fast strokes don't leave gaps between discrete stamps
    if (painting && lastGX >= 0) stampLine(lastGX, lastGY, gx, gy, cls); else stampBrush(gx, gy, cls);
    painting = true; lastGX = gx; lastGY = gy;
    renderPaint();
  }
  function stampElev(cx, cy, v) {
    const rad = brushSize - 1, r2 = (rad + 0.5) * (rad + 0.5);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx, y = cy + dy; if (x < 0 || x >= G || y < 0 || y >= G) continue;
      const i = y * G + x;
      if (v < 0) { elevPainted[i] = 0; } else { elev[i] = v; elevPainted[i] = 1; }
    }
  }
  function stampWater(cx, cy, v) {
    const rad = brushSize - 1, r2 = (rad + 0.5) * (rad + 0.5);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx, y = cy + dy; if (x < 0 || x >= G || y < 0 || y >= G) continue;
      water[y * G + x] = v;
    }
  }
  // Smooth value-noise (2 octaves, deterministic) for gentle within-biome roll.
  function h2(x, y) { let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177) | 0; return ((n ^ (n >>> 16)) >>> 0) / 4294967295; }
  // value noise on a lattice that WRAPS every P cells, so it tiles seamlessly across the toroidal world
  function vnW(x, y, P) { const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0; const w = v => ((v % P) + P) % P; const a = h2(w(x0), w(y0)), b = h2(w(x0 + 1), w(y0)), c = h2(w(x0), w(y0 + 1)), d = h2(w(x0 + 1), w(y0 + 1)); const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty); return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy; }
  // fractal (multi-octave) noise, seamless across the wrap (each octave tiles: k lattice cells span G)
  function fbm(x, y) { const u = x / G, v = y / G; return 0.5 * vnW(u * 5, v * 5, 5) + 0.3 * vnW(u * 12 + 3, v * 12 + 7, 12) + 0.2 * vnW(u * 27 + 1, v * 27 + 2, 27); }
  // toroidal distance (in cells) to the nearest ocean cell — chamfer transform with wrapped neighbors
  function oceanDistField() {
    const INF = 1e6, d = new Float32Array(G * G);
    for (let i = 0; i < G * G; i++) d[i] = target[i] === SC.Ocean ? 0 : INF;
    const idx = (x, y) => (((y % G) + G) % G) * G + (((x % G) + G) % G);
    const rel = (x, y, nx, ny, w) => { const i = idx(x, y), j = idx(nx, ny); if (d[j] + w < d[i]) d[i] = d[j] + w; };
    for (let pass = 0; pass < 2; pass++) {   // 2 full sweeps so distances propagate around the torus
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) { rel(x, y, x - 1, y, 1); rel(x, y, x, y - 1, 1); rel(x, y, x - 1, y - 1, 1.414); rel(x, y, x + 1, y - 1, 1.414); }
      for (let y = G - 1; y >= 0; y--) for (let x = G - 1; x >= 0; x--) { rel(x, y, x + 1, y, 1); rel(x, y, x, y + 1, 1); rel(x, y, x + 1, y + 1, 1.414); rel(x, y, x - 1, y + 1, 1.414); }
    }
    return d;
  }

  // Full-field height in [0,1]. Unpainted land is placed within its biome's [low,high] band by distance
  // to the coast (shore=low, interior=high) plus multi-octave rolling relief; ocean stays below sea
  // level. Painted values override. Blurred so biome edges are slopes, not cliffs.
  const OCEAN_FALLOFF = 16, RELIEF_AMP = 0.10;
  function computeHeightField() {
    const dist = oceanDistField();
    let a = new Float32Array(G * G);
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const i = y * G + x;
      if (elevPainted[i]) { a[i] = elev[i]; continue; }
      const band = ECO_BIOME_ELEV[CN[target[i]]] || [0.52, 0.62], lo = band[0], hi = band[1];
      if (target[i] === SC.Ocean) { a[i] = lo + (hi - lo) * fbm(x, y); continue; }           // below sea level -> water
      const fall = Math.min(1, dist[i] / OCEAN_FALLOFF), s = fall * fall * (3 - 2 * fall);    // smoothstep coast->inland
      const base = lo + (hi - lo) * s;                                                        // rise from shore to interior
      a[i] = Math.max(0.505, base + (fbm(x, y) - 0.5) * RELIEF_AMP * (0.4 + 0.6 * s));         // rolling hills, gentler near shore
    }
    let b = new Float32Array(G * G);
    for (let p = 0; p < HEIGHT_BLUR_PASSES; p++) {
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = ((x + dx) % G + G) % G, yy = ((y + dy) % G + G) % G; sum += a[yy * G + xx]; }   // wrapped neighbours (toroidal)
        b[y * G + x] = sum / 9;
      }
      const t = a; a = b; b = t;
    }
    return a;
  }
  // Final terrain for export + height preview: the base field, with painted rivers/lakes carved into a
  // channel and a matching water-surface value per cell (0 elsewhere). height/water are both [0,1].
  function computeTerrain() {
    const height = computeHeightField();               // f_land (fresh array; safe to carve in place)
    const waterVal = new Float32Array(G * G);
    for (let i = 0; i < G * G; i++) {
      if (!water[i]) continue;
      const fLand = height[i];
      waterVal[i] = Math.max(0, Math.min(1, 2 * (fLand - RIVER_LIP) - 1));   // water surface, just below the banks
      height[i] = Math.max(0.02, fLand - RIVER_CARVE);                       // carve the channel bottom
    }
    return { height, waterVal };
  }
  function drawHeight(canvas) {
    const t = computeTerrain();
    const ctx = canvas.getContext('2d'), W = canvas.width, img = ctx.createImageData(W, W), d = img.data;
    for (let y = 0; y < W; y++) { const gy = G - 1 - y; for (let x = 0; x < W; x++) {
      const i = gy * G + x, b = Math.max(0, Math.min(255, Math.round(t.height[i] * 255))), o = (y * W + x) * 4;
      const isWater = target[i] === SC.Ocean || water[i];   // tint water (ocean + rivers/lakes) so it reads as terrain
      d[o] = isWater ? 40 : b; d[o + 1] = isWater ? 70 : b; d[o + 2] = isWater ? 120 : b; d[o + 3] = 255;
    } }
    ctx.putImageData(img, 0, 0);
  }
  function stampLine(x0, y0, x1, y1, val, fn) {
    fn = fn || stampBrush;
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    if (steps === 0) { fn(x1, y1, val); return; }
    for (let s = 0; s <= steps; s++) fn(Math.round(x0 + (x1 - x0) * s / steps), Math.round(y0 + (y1 - y0) * s / steps), val);
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
    pushUndo();
    if (!classgridBound) { worker.addEventListener('message', ev => { if (ev.data && ev.data.type === 'classgrid' && ev.data.grid) { target = new Uint8Array(ev.data.grid); hideLegend(); renderPaint(); flashAnalysis('Seeded from the current map. Edit it, then analyze.'); } }); classgridBound = true; }
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

  // ================================================================= authored-world export
  // Render a G x G grid to a PNG (generation orientation, no flip — the mod reads pixel (x,y) as world
  // (x,z)). Returns a Uint8Array of PNG bytes. `pix(x,y)` -> [r,g,b].
  function gridToPng(pix) {
    return new Promise(resolve => {
      const cv = document.createElement('canvas'); cv.width = G; cv.height = G;
      const ctx = cv.getContext('2d'), img = ctx.createImageData(G, G), d = img.data;
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) { const c = pix(x, y), o = (y * G + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
      ctx.putImageData(img, 0, 0);
      cv.toBlob(b => b.arrayBuffer().then(ab => resolve(new Uint8Array(ab))), 'image/png');
    });
  }
  // minimal STORE-method zip (no compression; PNGs are already compressed)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function strBytes(s) { return new TextEncoder().encode(s); }
  function makeZip(files) {                       // files: [{name, data:Uint8Array}]
    const chunks = [], central = []; let offset = 0;
    const u16 = v => [v & 255, (v >> 8) & 255], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    for (const f of files) {
      const name = strBytes(f.name), crc = crc32(f.data), sz = f.data.length;
      const local = [].concat([0x50, 0x4b, 0x03, 0x04], u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(sz), u32(sz), u16(name.length), u16(0));
      const lh = new Uint8Array(local.length + name.length + sz); lh.set(local, 0); lh.set(name, local.length); lh.set(f.data, local.length + name.length);
      chunks.push(lh);
      const cen = [].concat([0x50, 0x4b, 0x01, 0x02], u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(sz), u32(sz), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      const ch = new Uint8Array(cen.length + name.length); ch.set(cen, 0); ch.set(name, cen.length); central.push(ch);
      offset += lh.length;
    }
    const cenSize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array([].concat([0x50, 0x4b, 0x05, 0x06], u16(0), u16(0), u16(files.length), u16(files.length), u32(cenSize), u32(offset), u16(0)));
    const total = offset + cenSize + end.length, out = new Uint8Array(total); let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    for (const c of central) { out.set(c, p); p += c.length; }
    out.set(end, p);
    return out;
  }
  function downloadBlob(bytes, name, type) {
    const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function buildBundleFiles() {
    const cfg = buildExportJson();              // the WorldGenerator.eco (main-thread), current form values
    // Raw maps (what the mod actually reads — unambiguous, no PNG decode). Generation orientation, row-major.
    const terrain = computeTerrain();           // carved height + water-surface per cell
    const biomeBin = new Uint8Array(G * G);     // per-cell score-class index (matches the mod's BIOME_BY_INDEX)
    const heightBin = new Uint8Array(G * G);    // per-cell height byte 0..255 (mod maps to [-1,1], then bilinear-upscales)
    const waterBin = new Uint8Array(G * G);     // per-cell water surface as waterValue*255 (0 = sea level; mod fills to it)
    let anyWater = false;
    for (let i = 0; i < G * G; i++) {
      biomeBin[i] = target[i];
      heightBin[i] = Math.max(0, Math.min(255, Math.round(terrain.height[i] * 255)));
      waterBin[i] = Math.max(0, Math.min(255, Math.round(terrain.waterVal[i] * 255)));
      if (water[i]) anyWater = true;
    }
    // PNGs kept for human inspection only (not read by the mod).
    const biomePng = await gridToPng((x, y) => water[y * G + x] ? [40, 90, 200] : (ECO_BIOME_COLOR[CN[target[y * G + x]]] || ECO_BIOME_COLOR.Ocean));
    const heightPng = await gridToPng((x, y) => { const b = heightBin[y * G + x]; return [b, b, b]; });
    const files = [
      { name: 'WorldGenerator.eco', data: strBytes(JSON.stringify(cfg, null, 2)) },
      { name: 'biome.bin', data: biomeBin },
      { name: 'height.bin', data: heightBin },
      { name: 'biome.png', data: biomePng },
      { name: 'height.png', data: heightPng },
      { name: 'authored.json', data: strBytes('{ "enabled": true, "source": "eco-map-generator" }') },
    ];
    if (anyWater) files.push({ name: 'water.bin', data: waterBin });   // only when rivers/lakes were painted
    return { size: (cfg && findWorldWidth(cfg)) || 72, files: files };
  }
  async function exportBundle() {
    if (typeof baseCfg === 'undefined' || !baseCfg) { $('dsnExportStatus').textContent = 'Load a config first.'; return; }
    $('dsnExportStatus').textContent = 'building bundle…';
    try {
      const b = await buildBundleFiles();
      downloadBlob(makeZip(b.files), 'authored-world-' + b.size + 'x' + b.size + '.zip', 'application/zip');
      $('dsnExportStatus').innerHTML = '<b>Exported authored-world-' + b.size + 'x' + b.size + '.zip</b> — unzip, then run: EcoWorldGenCLI --server &lt;server&gt; --bundle &lt;dir&gt; --out Game.eco';
    } catch (e) { $('dsnExportStatus').textContent = 'Export error: ' + e.message; }
  }
  function findWorldWidth(j) { let r = null; (function w(o) { if (!o || typeof o !== 'object' || r) return; if (Object.prototype.hasOwnProperty.call(o, 'WorldWidth')) { r = o.WorldWidth; return; } for (const k in o) w(o[k]); })(j); return r; }

  // test/automation hook: returns the bundle files base64-encoded (no download prompt)
  async function bundleBase64() {
    const b = await buildBundleFiles();
    const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
    const out = { size: b.size }; for (const f of b.files) out[f.name] = b64(f.data); return out;
  }

  window.Designer = { open, close, bundleBase64 };
  const btn = document.getElementById('designOpen');
  if (btn) btn.onclick = open;
})();
