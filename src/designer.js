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
  const G = 128;                         // paint + scoring grid resolution (finer = more drawable detail; bestShift stride scales with G)
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
  let rough = new Float32Array(G * G);         // per-cell micro-relief amount, baked from the brush at paint time
  let water = new Uint8Array(G * G);           // 1 where the user painted a river/lake (carved + water-filled)
  let paintMode = 'biome';                     // 'biome' | 'elevation' | 'water'
  let designMode = 'design';                    // 'design' (paint → exact export/3D) | 'find' (paint → seed search)
  let elevValue = 0.66;                        // current elevation brush value
  let paintRoughness = 0.08;                   // natural micro-relief added to painted areas (0 = perfectly flat)
  const RIVER_CARVE = 0.045, RIVER_LIP = 0.012; // channel depth + how far the water sits below the banks (in [0,1] height)

  // Exact Eco biome colors (System.Drawing names, ARGB) for the exported biome map, keyed by score class.
  const ECO_BIOME_COLOR = {
    Ocean: [70, 130, 180], Coast: [250, 250, 210], Grassland: [144, 238, 144], WarmForest: [184, 134, 11],
    ColdForest: [34, 139, 34], RainForest: [32, 178, 170], Desert: [244, 164, 96], Taiga: [107, 142, 35],
    Tundra: [189, 183, 107], Ice: [255, 255, 255], Wetland: [0, 100, 0],
  };
  // A distinct "fresh water" colour for import: cells this colour become lakes/rivers (freshwater above
  // sea level) even when they touch the sea, so a river drawn to the coast stays fresh, not ocean.
  const FRESH_COLOR = [30, 144, 255];
  const isFreshRGB = (r, g, b) => Math.abs(r - FRESH_COLOR[0]) < 45 && Math.abs(g - FRESH_COLOR[1]) < 45 && Math.abs(b - FRESH_COLOR[2]) < 45;
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
  const POOL_MAX = 120, SHOW_STEP = 12;
  let galShow = 12, gallerySort = 'score', galleryMin = 0;   // gallery view state (Find mode)
  let workers = [], running = false, evaluated = 0, tStart = 0, seedSet = new Set(), lastUiPaint = 0;
  let classgridBound = false, painting = false, built = false, cfgBySeed = {}, poolTargetSig = null;
  let undoStack = [], lastGX = -1, lastGY = -1;
  let lastTerrain = null;                       // last computed {height,waterVal} — for the elevation hover readout
  // image-import color legend: dominant source colors + their (user-overridable) biome assignment
  let legend = [];               // [{ rgb:[r,g,b], count, cls }]
  let imgLegendIdx = null;       // Int16Array(G*G) legend index per image cell (-1 = transparent -> ocean)
  const MAX_LEGEND = 12;         // cap on distinct source colors offered for remapping
  let importMode = 'colors';     // 'colors' (nearest hue) | 'brightness' (luminance ramp — better for photos)
  let lastImgData = null;        // last decoded G*G RGBA, so switching import mode re-maps without re-loading
  let importedImg = null;        // the decoded source Image, kept so export can resample it at high resolution
  let paintedSinceImport = false; // once the user hand-edits an import, export falls back to the 64² grid
  const IMPORT_RES = 448;        // biome/height resolution exported for a pure image import (finer = steeper, less-terraced terrain)
  // dark -> light biome ramp for brightness mode (low/dark = deep water, high/light = snow), reads as terrain
  const BRIGHT_RAMP = ['Ocean', 'Wetland', 'ColdForest', 'Taiga', 'RainForest', 'Grassland', 'WarmForest', 'Desert', 'Tundra', 'Coast', 'Ice'];

  // Hosted generation service (eco-worldgen-service). Override for local testing: window.ECO_WORLDGEN_API = 'http://localhost:3010'.
  const WORLDGEN_API = ((typeof window !== 'undefined' && window.ECO_WORLDGEN_API) || 'https://tools.factoreco.org/map').replace(/\/$/, '');
  const WORLDGEN_MAX_SIZE = 200;   // service cap (MAX_WORLD_SIZE); world size must be a multiple of 4 in 12..this
  let genPollTimer = null;         // inline status poll started after "Generate Eco save"

  // ================================================================= styling
  function injectStyle() {
    if (document.getElementById('dsnStyle')) return;
    const s = document.createElement('style'); s.id = 'dsnStyle';
    s.textContent = `
    #designWrap{margin-top:6px}
    .dsnCols{display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}
    .dsnLeft{flex:0 0 auto;max-width:calc(var(--cw) + 20px);--cw:min(880px,64vw,88vh)} .dsnRight{flex:1 1 320px;min-width:300px;max-width:460px}
    .dsnLeft .dsnMini{max-width:var(--cw)}
    #dsnCanvasWrap{position:relative;border:0.5px solid var(--border);border-radius:12px;background:var(--surf);padding:8px;line-height:0;display:inline-block}
    #dsnCanvas{border-radius:6px;cursor:crosshair;touch-action:none;image-rendering:pixelated;width:var(--cw);height:var(--cw)}
    .dsnPal{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}
    .dsnPal button{display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 9px}
    .dsnPal button.on{outline:2px solid var(--accent);outline-offset:1px;font-weight:600}
    .dsnPal .sw{width:13px;height:13px;border-radius:3px;border:0.5px solid var(--border2)}
    .dsnTools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0}
    .dsnCard{border:0.5px solid var(--border);border-radius:10px;background:var(--surf);padding:10px 12px;margin:0 0 12px}
    .dsnCard h4{margin:0 0 6px;font-size:13px;font-weight:600}
    .dsnField{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2);margin:5px 0}
    .dsnField>span:first-child{flex:0 0 96px}
    .dsnField input{width:76px;font-size:12px;padding:3px 6px;border-radius:6px;border:0.5px solid var(--border);background:var(--bg);color:var(--text)}
    .dsnField .dsnMini{flex:1}
    .dsnSectionLbl{font-size:12px;font-weight:600;color:var(--text2);margin:16px 0 6px;padding-top:12px;border-top:0.5px solid var(--border)}
    .dsnSectionLbl i{color:var(--muted);font-weight:500}
    .dsnGallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
    #dsnFindGallery{margin-top:16px;border-top:0.5px solid var(--border);padding-top:12px}
    #dsnFindGallery .dsnGallery{grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
    .dsnGalBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px}
    .dsnGalBar select{font-size:12px;padding:2px 6px;border-radius:6px;border:0.5px solid var(--border);background:var(--surf);color:var(--text)}
    #dsnCompare{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin:10px 0 12px}
    .dsnCmp{text-align:center}
    .dsnCmp canvas{width:120px;height:120px;border-radius:8px;image-rendering:pixelated;border:0.5px solid var(--border);display:block}
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
    .dsnLegend{margin:8px 0 0;padding:8px 10px;border:0.5px solid var(--border);border-radius:8px;background:var(--surf);width:var(--cw);box-sizing:border-box}
    .dsnLegend .lgHead{font-size:12px;color:var(--text2);margin-bottom:7px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .dsnLegend .lgRows{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
    .dsnLegend .lgRow{display:flex;align-items:center;gap:6px;font-size:11px;border:0.5px solid var(--border);border-radius:6px;padding:3px 6px;background:var(--bg)}
    .dsnLegend .lgRow select{flex:1;min-width:0}
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
      '<div class="row" style="margin:2px 0 10px"><strong style="font-size:15px" id="dsnTitle">🎨 Design a map</strong>' +
      '<span class="dsnMini" id="dsnSubtitle" style="margin-left:6px">paint a world → preview it in 3D → generate it exactly</span>' +
      '<button id="dsnClose" style="margin-left:auto">← Back to map</button></div>' +
      '<div class="dsnCols">' +
        '<div class="dsnLeft">' +
          '<div class="dsnPal" id="dsnPal"></div>' +
          '<div id="dsnCanvasWrap"><canvas id="dsnCanvas" width="' + G + '" height="' + G + '"></canvas></div>' +
          '<div class="dsnTools">' +
            '<span class="dsnRange" style="width:190px">Brush <input type="range" id="dsnBrush" min="1" max="16" value="' + brushSize + '"><span id="dsnBrushV" class="dsnMini">' + brushSize + '</span></span>' +
            '<label class="dsnMini" style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" id="dsnFill"> flood fill</label>' +
            '<button id="dsnUndo" title="Undo (Ctrl+Z)">↶ Undo</button>' +
            '<button id="dsnSeedFromMap">Seed from current map</button>' +
            '<button id="dsnImport" title="Map an image\'s colors to biomes — auto-nearest, then remap any color you like. Water enclosed by land imports as a lake; paint water #1E90FF for fresh rivers/lakes (even to the coast).">📁 Import image</button>' +
            '<input type="file" id="dsnImgFile" accept="image/*" style="display:none">' +
            '<button id="dsnImportDesign" title="Load a design .zip (e.g. the input re-downloaded from the generation service) to keep tuning it">📂 Import design</button>' +
            '<input type="file" id="dsnDesignFile" accept=".zip,application/zip" style="display:none">' +
            '<button id="dsnClear">Clear</button>' +
          '</div>' +
          '<div class="dsnTools" style="margin-top:0">' +
            '<span class="dsnMini">Paint</span><span class="seg" id="dsnPaintMode"><button type="button" data-pm="biome" class="on">Biomes</button><button type="button" data-pm="elevation">Elevation</button><button type="button" data-pm="water">Water</button></span>' +
            '<span class="dsnRange" id="dsnElevWrap" style="display:none;gap:14px;flex-wrap:wrap">' +
              '<span class="dsnRange" style="gap:6px">Height <input type="range" id="dsnElev" min="0" max="100" value="' + Math.round(elevValue * 100) + '" style="width:120px"><span id="dsnElevV" class="dsnMini"></span></span>' +
              '<span class="dsnRange" style="gap:6px" title="Natural variation the brush bakes into what you paint NEXT. Change it between strokes to make some areas smooth and others rugged. 0 = perfectly flat.">Roughness <input type="range" id="dsnRough" min="0" max="100" value="' + Math.round(paintRoughness / 0.16 * 100) + '" style="width:100px"><span id="dsnRoughV" class="dsnMini"></span></span>' +
            '</span>' +
          '</div>' +
          '<div id="dsnElevLegend" style="display:none;margin:2px 0 0;max-width:320px">' +
            '<div class="dsnMini" id="dsnElevRead" style="margin-bottom:4px"></div>' +
            '<div style="position:relative">' +
              '<canvas id="dsnElevBar" width="280" height="16" style="width:100%;height:16px;display:block;border-radius:4px;border:0.5px solid var(--border)"></canvas>' +
              '<div id="dsnElevMark" style="position:absolute;top:-3px;left:0;width:2px;height:22px;background:var(--text);box-shadow:0 0 0 1px rgba(0,0,0,.45)"></div>' +
            '</div>' +
            '<div class="dsnMini" style="display:flex;justify-content:space-between;margin-top:1px"><span>deep</span><span>◄ sea</span><span>hills</span><span>peak</span></div>' +
          '</div>' +
          '<div class="dsnMini">Left-drag paints · right-drag erases · <b>flood fill</b> bucket-fills a biome region. <b>Elevation</b>: sculpt height (unpainted areas use a natural biome-based default). <b>Water</b>: paint rivers/lakes — they carve a channel and fill with water (route them downhill along your terrain).</div>' +
          '<div id="dsnLegendWrap" class="dsnLegend" style="display:none"></div>' +
          '<div id="dsnWrapPrev" style="margin-top:8px">' +
            '<div class="dsnMini" style="margin-bottom:4px">Wrap preview — your map tiled 2×2. The world is a torus: it joins across these <b>dashed seams</b>. Strokes wrap around, so paint straight across a border and it continues on the far side — the edges line up automatically.</div>' +
            '<canvas id="dsnWrapCv" width="256" height="256" style="width:230px;height:230px;image-rendering:pixelated;border:0.5px solid var(--border);border-radius:8px"></canvas>' +
          '</div>' +
        '</div>' +
        '<div class="dsnRight">' +
          // "Design a map" mode: exact authored world (+ 3D preview)
          '<div id="dsnRightDesign">' +
          '<div class="dsnCard" id="dsnWorldCard"><h4 style="margin:0 0 8px">World settings</h4>' +
            '<label class="dsnField"><span>World size</span><input type="number" id="dsnWorldW" min="8" max="600" step="4"><span class="dsnMini" id="dsnWorldMeta"></span></label>' +
            '<label class="dsnField" title="Sea-level height. Terrain below it is underwater in the preview and the generated world."><span>Water level</span><input type="number" id="dsnWaterLvl" min="0" max="255" step="1"><span class="dsnMini">block height of the sea</span></label>' +
            '<label class="dsnField" title="Vertical scale — how tall the highest terrain can be. Bigger = more dramatic mountains."><span>Max height</span><input type="number" id="dsnMaxGen" min="10" max="255" step="1"><span class="dsnMini">peak terrain height</span></label>' +
          '</div>' +
          '<div class="dsnCard"><h4 style="margin:0 0 4px">Generate Eco save <span class="dsnMini">— compatible with Eco v14</span></h4>' +
            '<div class="dsnMini" style="margin:0 0 8px">Sends your design to the generation service and gives you a link to download the finished <code>.eco</code> world (biomes + terrain match your drawing <b>exactly</b>). Generation takes a few minutes — bookmark the link and come back any time.</div>' +
            '<div class="row" style="gap:6px"><button id="dsnGenSave" class="primary">☁ Generate Eco save</button>' +
            '<button id="dsnPreview3D" title="Fly through your design in the 3D voxel world">🧊 3D preview</button></div>' +
            '<div id="dsnGenStatus" style="margin-top:8px"></div></div>' +
          '</div>' +
          // "Find a map" mode: closest naturally-generated world (seed search)
          '<div id="dsnRightFind" style="display:none">' +
          '<div class="dsnCard"><h4>1 · Target</h4><div id="dsnAnalysis" class="dsnMini">Draw the layout you want (or seed it from the current map), then analyze it.</div>' +
            '<div class="dsnBars" id="dsnMixBars" style="display:none"></div>' +
            '<button id="dsnAnalyze" class="primary" style="margin-top:8px">Analyze drawing → set up search</button></div>' +
          '<div class="dsnCard" id="dsnSearchCard" style="opacity:.5;pointer-events:none"><h4>2 · Search</h4>' +
            '<div class="dsnMini" style="margin:0 0 8px">The generator can\'t place a biome where you choose — layout comes from the seed. This tries many seeds and keeps the closest by biome mix + land shape (exact placement only loosely).</div>' +
            '<div class="dsnRange" style="margin-bottom:8px">Match&nbsp;<span class="dsnMini">mix</span><input type="range" id="dsnWeight" min="0" max="100" value="' + Math.round(layoutWeight * 100) + '"><span class="dsnMini">layout</span></div>' +
            '<div class="row" style="margin:2px 0"><button id="dsnStart" class="primary">▶ Start search</button><button id="dsnStop" disabled>■ Stop</button>' +
              '<label class="dsnMini" style="display:inline-flex;align-items:center;gap:4px;margin-left:4px" title="Also wobble land% and biome weights ±6% while searching, to explore around the inversion"><input type="checkbox" id="dsnJitter"> vary knobs</label></div>' +
            '<div id="dsnStatus" style="margin-top:8px">idle</div>' +
            '<div class="dsnMini" id="dsnSpeedHint" style="margin-top:6px"></div></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      // "Find a map" full-width results gallery (ecoatlas-style tiles + filters)
      '<div id="dsnFindGallery" style="display:none">' +
        '<div class="dsnGalBar">' +
          '<strong style="font-size:15px">Closest worlds</strong><span class="dsnMini" id="dsnGalCount"></span>' +
          '<span class="dsnMini" style="margin-left:auto">Sort</span>' +
          '<select id="dsnSort"><option value="score">Overall</option><option value="prop">Biome mix</option><option value="iou">Land shape</option><option value="soft">Biome fit</option></select>' +
          '<span class="dsnRange" style="width:200px" title="Hide results below this overall score"><span class="dsnMini">min score</span><input type="range" id="dsnMinScore" min="0" max="100" value="0"><span class="dsnMini" id="dsnMinScoreV">0%</span></span>' +
        '</div>' +
        '<div id="dsnCompare">' +
          '<div class="dsnCmp"><canvas id="dsnTargetRef" width="' + G + '" height="' + G + '"></canvas><div class="dsnMini">your drawing</div></div>' +
          '<div style="font-size:26px;color:var(--muted)">→</div>' +
          '<div class="dsnCmp"><canvas id="dsnBestRef" width="' + G + '" height="' + G + '"></canvas><div class="dsnMini" id="dsnBestLbl">best match</div></div>' +
          '<div class="dsnMini" style="max-width:380px;align-self:center">Click any tile to apply it as your real world. Scores are relative — even the best is an approximation.<br><b>mix</b> = biome proportions · <b>shape</b> = land-mass overlap · <b>fit</b> = biome-type agreement</div>' +
        '</div>' +
        '<div class="dsnGallery" id="dsnGallery"><div class="dsnMini">No candidates yet — run a search.</div></div>' +
        '<div class="row" style="margin-top:12px;justify-content:center"><button id="dsnShowMore" style="display:none">Show more</button></div>' +
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
    $('dsnClear').onclick = () => { pushUndo(); target.fill(SC.Ocean); elevPainted.fill(0); rough.fill(0); water.fill(0); hideLegend(); renderPaint(); };
    $('dsnUndo').onclick = undo;
    $('dsnSeedFromMap').onclick = seedFromMap;
    $('dsnImport').onclick = () => $('dsnImgFile').click();
    $('dsnImgFile').onchange = e => { const f = e.target.files[0]; if (f) importImage(f); e.target.value = ''; };
    $('dsnImportDesign').onclick = () => $('dsnDesignFile').click();
    $('dsnDesignFile').onchange = e => { const f = e.target.files[0]; if (f) importDesignZip(f); e.target.value = ''; };
    $('dsnClose').onclick = close;
    $('dsnAnalyze').onclick = analyze;
    $('dsnStart').onclick = startSearch;
    $('dsnStop').onclick = stopSearch;
    $('dsnWeight').oninput = e => { layoutWeight = +e.target.value / 100; rescorePool(); };
    $('dsnSort').onchange = e => { gallerySort = e.target.value; renderGallery(); };
    $('dsnMinScore').oninput = e => { galleryMin = +e.target.value / 100; $('dsnMinScoreV').textContent = e.target.value + '%'; renderGallery(); };
    $('dsnShowMore').onclick = () => { galShow += SHOW_STEP; renderGallery(); };
    // infinite scroll: auto-load more tiles as the Show-more sentinel nears the viewport bottom
    window.addEventListener('scroll', maybeAutoLoad, { passive: true });
    window.addEventListener('resize', maybeAutoLoad, { passive: true });
    $('dsnPreview3D').onclick = preview3D;
    $('dsnGenSave').onclick = generateSave;
    wireWorldFields();
    $('dsnPaintMode').querySelectorAll('button').forEach(b => b.onclick = () => { paintMode = b.dataset.pm; markPaintMode(); renderPaint(); });
    $('dsnElev').oninput = e => { elevValue = +e.target.value / 100; $('dsnElevV').textContent = elevLabel(elevValue); drawElevLegend(); };
    $('dsnElevV').textContent = elevLabel(elevValue);
    $('dsnRough').oninput = e => { paintRoughness = +e.target.value / 100 * 0.16; $('dsnRoughV').textContent = roughLabel(paintRoughness); };   // applies to the NEXT strokes, not existing paint
    $('dsnRoughV').textContent = roughLabel(paintRoughness);
    const cv = $('dsnCanvas');
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => { pushUndo(); onPointer(e); });
    cv.addEventListener('pointermove', e => { if (painting) onPointer(e); updateElevReadout(e); });
    cv.addEventListener('pointerleave', () => { if (paintMode === 'elevation') drawElevLegend(); });
    window.addEventListener('pointerup', () => { painting = false; lastGX = -1; lastGY = -1; });
    window.addEventListener('keydown', e => { if ($('designWrap').style.display === 'none') return; if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); } });
    built = true;
  }
  function markPalette() { $('dsnPal').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.c === brushClass)); }
  function elevLabel(v) { return v < 0.45 ? 'deep water' : v < 0.52 ? 'sea level' : v < 0.65 ? 'lowland' : v < 0.8 ? 'hills' : 'peaks'; }
  function formatElev(v) { return Math.round(v * 100) + ' · ' + elevLabel(v); }
  function roughLabel(r) { return r < 0.005 ? 'flat' : r < 0.05 ? 'subtle' : r < 0.11 ? 'natural' : 'rugged'; }
  // Draw the hypsometric scale bar (matches the map's ramp) with a sea-level tick + a marker at the brush.
  function drawElevLegend() {
    const cv = $('dsnElevBar'); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    for (let x = 0; x < W; x++) { const hh = x / (W - 1), c = hh < SEA_LEVEL ? waterColor(hh) : landColor(hh); ctx.fillStyle = 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'; ctx.fillRect(x, 0, 1, H); }
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(Math.round(SEA_LEVEL * W), 0, 1, H);   // sea line
    const mk = $('dsnElevMark'); if (mk) mk.style.left = 'calc(' + (elevValue * 100) + '% - 1px)';
    const rd = $('dsnElevRead'); if (rd) rd.innerHTML = 'Brush paints <b>' + formatElev(elevValue) + '</b> — hover the map to read a spot';
  }
  // Live readout of the elevation under the cursor while in elevation mode (reads the last rendered field).
  function updateElevReadout(e) {
    if (paintMode !== 'elevation' || !lastTerrain) return;
    const cv = $('dsnCanvas'), r = cv.getBoundingClientRect();
    const dispX = Math.floor((e.clientX - r.left) / r.width * G), dispY = Math.floor((e.clientY - r.top) / r.height * G);
    const rd = $('dsnElevRead'); if (!rd) return;
    if (dispX < 0 || dispX >= G || dispY < 0 || dispY >= G) return;
    const i = (G - 1 - dispY) * G + dispX, hv = lastTerrain.height[i];
    const isW = target[i] === SC.Ocean || water[i] || hv < SEA_LEVEL;
    rd.innerHTML = 'Here: <b>' + formatElev(hv) + (isW ? ' · underwater' : '') + '</b> &nbsp;·&nbsp; brush: <b>' + formatElev(elevValue) + '</b>';
  }

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
    for (const e of kept) { e.fresh = isFreshRGB(e.rgb[0], e.rgb[1], e.rgb[2]); e.cls = e.fresh ? SC.Ocean : nearestClass(e.rgb[0], e.rgb[1], e.rgb[2]); e.def = e.cls; }   // fresh-water colour -> lake; else nearest biome
    return kept;
  }
  // Brightness mode: map each pixel's luminance onto the dark->light biome ramp, histogram-equalized so
  // a low-contrast/dark image still uses the full ramp. Preserves tonal structure (best for photos).
  // Sets `legend` (one gray band per ramp step) + `imgLegendIdx` (band per cell) directly.
  function buildBrightness(d) {
    const nB = BRIGHT_RAMP.length, lum = new Float32Array(G * G), idx = new Int16Array(G * G), opaque = [];
    for (let i = 0; i < G * G; i++) {
      const o = i * 4;
      if (d[o + 3] < 128) { idx[i] = -1; lum[i] = -1; continue; }
      const L = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      lum[i] = L; opaque.push(L);
    }
    opaque.sort((a, b) => a - b);
    const N = opaque.length || 1;
    const rankOf = L => { let lo = 0, hi = opaque.length; while (lo < hi) { const m = (lo + hi) >> 1; if (opaque[m] < L) lo = m + 1; else hi = m; } return lo; };
    const counts = new Array(nB).fill(0);
    for (let i = 0; i < G * G; i++) {
      if (idx[i] === -1) continue;
      let b = Math.floor(rankOf(lum[i]) / N * nB); if (b >= nB) b = nB - 1;
      idx[i] = b; counts[b]++;
    }
    imgLegendIdx = idx;
    legend = [];
    for (let b = 0; b < nB; b++) { const g = Math.round(255 * b / (nB - 1)), cls = SC[BRIGHT_RAMP[b]]; legend.push({ rgb: [g, g, g], count: counts[b], cls: cls, def: cls }); }
  }
  // Build the legend + per-cell assignment for the current import mode.
  function mapImage(d) {
    if (importMode === 'brightness') buildBrightness(d);
    else { legend = buildLegend(d); imgLegendIdx = assignLegendIdx(d); }
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
    flashAnalysis('Imported image → biomes (' + top + '). Remap any band below, edit, or Analyze — then generate.');
  }
  // Re-run the mapping in a different mode, then refresh. The decode itself depends on the mode (colours
  // nearest, tone smoothed), so the image is re-decoded rather than re-read from the cached grid.
  function setImportMode(m) {
    if (!importedImg || importMode === m) { importMode = m; return; }
    pushUndo(); importMode = m;
    lastImgData = decodeToGrid(importedImg);
    mapImage(lastImgData); renderLegend(); flashMix(applyLegend());
  }
  // Legend UI: one row per source color (or brightness band) with a live biome dropdown, plus a
  // Colors/Brightness mode toggle — Brightness maps luminance onto a terrain ramp (best for photos).
  function renderLegend() {
    const wrap = $('dsnLegendWrap'); if (!wrap) return;
    if (!legend.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
    const total = G * G, bright = importMode === 'brightness';
    const opts = PALETTE.map(n => '<option value="' + SC[n] + '">' + LABEL[n] + '</option>').join('');
    wrap.innerHTML =
      '<div class="lgHead"><b>' + (bright ? 'Brightness → biomes' : 'Image colors → biomes') + '</b>' +
      '<span class="seg" id="lgMode"><button type="button" data-im="colors"' + (bright ? '' : ' class="on"') + '>Colors</button>' +
      '<button type="button" data-im="brightness"' + (bright ? ' class="on"' : '') + '>Brightness</button></span>' +
      '<span class="dsnMini">' + (bright ? 'dark→light mapped to a terrain ramp' : 'nearest hue per color') + ' · <b>Brightness</b> suits photos</span>' +
      '<button id="lgAuto" style="margin-left:auto" title="Reset every entry to its default biome">Auto</button></div>' +
      '<div class="lgRows">' + legend.map((e, i) => {
        const pct = Math.round(e.count / total * 100);
        return '<div class="lgRow"><span class="lgSw" style="background:rgb(' + e.rgb[0] + ',' + e.rgb[1] + ',' + e.rgb[2] + ')"></span>' +
          '<span class="lgPct">' + (pct < 1 ? '<1' : pct) + '%</span>' +
          '<select data-i="' + i + '">' + opts + '</select></div>';
      }).join('') + '</div>';
    wrap.style.display = '';
    wrap.querySelectorAll('#lgMode button').forEach(b => b.onclick = () => setImportMode(b.dataset.im));
    wrap.querySelectorAll('select').forEach(sel => {
      sel.value = legend[+sel.dataset.i].cls;
      sel.onchange = () => { pushUndo(); legend[+sel.dataset.i].cls = +sel.value; flashMix(applyLegend()); };
    });
    $('lgAuto').onclick = () => { pushUndo(); legend.forEach(e => e.cls = e.def); renderLegend(); flashMix(applyLegend()); };
  }
  function hideLegend() { legend = []; imgLegendIdx = null; lastImgData = null; importedImg = null; paintedSinceImport = false; const w = $('dsnLegendWrap'); if (w) { w.style.display = 'none'; w.innerHTML = ''; } }
  // Resample the ORIGINAL imported image at a higher resolution and produce aligned biome + height maps
  // (bypassing the coarse 64² paint grid) so a photo/portrait exports with far sharper features. Uses the
  // current legend + mode; height follows the picture (dark/low = deep water, light/high = land) so the
  // land/water outline stays crisp and matched to the biome tint.
  // toroidal separable box blur (in place); spreads biome-edge height steps into gentle slopes
  function boxBlurTor(a, res, r, passes) {
    const tmp = new Float32Array(res * res), inv = 1 / (2 * r + 1), wrap = (v) => ((v % res) + res) % res;
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < res; y++) { const row = y * res; let sum = 0; for (let k = -r; k <= r; k++) sum += a[row + wrap(k)];
        for (let x = 0; x < res; x++) { tmp[row + x] = sum * inv; sum += a[row + wrap(x + r + 1)] - a[row + wrap(x - r)]; } }
      for (let x = 0; x < res; x++) { let sum = 0; for (let k = -r; k <= r; k++) sum += tmp[wrap(k) * res + x];
        for (let y = 0; y < res; y++) { a[y * res + x] = sum * inv; sum += tmp[wrap(y + r + 1) * res + x] - tmp[wrap(y - r) * res + x]; } }
    }
  }
  // value/fractal noise over the res grid (toroidal), reusing the painter's hash h2 — for within-biome relief
  function vnR(x, y, P, res) { const fx = x / res * P, fy = y / res * P, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, w = v => ((v % P) + P) % P; const a = h2(w(x0), w(y0)), b = h2(w(x0 + 1), w(y0)), c = h2(w(x0), w(y0 + 1)), e = h2(w(x0 + 1), w(y0 + 1)), sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty); return (a + (b - a) * sx) * (1 - sy) + (c + (e - c) * sx) * sy; }
  function fbmR(x, y, res) { return 0.5 * vnR(x, y, 10, res) + 0.3 * vnR(x, y, 26, res) + 0.2 * vnR(x, y, 64, res); }
  function imageToMaps(res) {
    const c = document.createElement('canvas'); c.width = res; c.height = res;
    // Nearest-neighbour upscale for colour (biome) maps so discrete biome colours stay pure — interpolation
    // would blend e.g. blue+white into a false "Grassland/Coast" ring around lakes. Photos use smoothing.
    const cx = c.getContext('2d'); cx.imageSmoothingEnabled = (importMode === 'brightness'); cx.drawImage(importedImg, 0, 0, res, res);
    const d = cx.getImageData(0, 0, res, res).data, n = res * res;
    const biome = new Uint8Array(n), height = new Uint8Array(n);
    const hf = new Float32Array(n), land = new Uint8Array(n);   // base height + land mask, in FINAL orientation
    const fresh = new Uint8Array(n);                            // 1 where the source used the fresh-water colour
    // per-biome base height (mild compression toward a common mean keeps biome edges from being cliffs;
    // real rolling-hill relief is added on top below). SEA = 0.5.
    const LAND_MEAN = 0.60, COMPRESS = 0.65, SEA = 0.5;
    const put = (x, y, cls, h01, isLand) => { const j = (res - 1 - y) * res + x; biome[j] = cls; hf[j] = h01; land[j] = isLand ? 1 : 0; };   // flip Y like the 64² path
    if (importMode === 'brightness') {
      const lum = new Float32Array(n), trans = new Uint8Array(n), op = [];
      for (let i = 0; i < n; i++) { const o = i * 4; if (d[o + 3] < 128) { trans[i] = 1; continue; } const L = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; lum[i] = L; op.push(L); }
      op.sort((a, b) => a - b); const N = op.length || 1, nB = legend.length;
      const rank = L => { let lo = 0, hi = op.length; while (lo < hi) { const m = (lo + hi) >> 1; if (op[m] < L) lo = m + 1; else hi = m; } return lo; };
      for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
        const i = y * res + x;
        if (trans[i]) { put(x, y, SC.Ocean, 0.30, 0); continue; }
        const rf = rank(lum[i]) / N; let b = Math.floor(rf * nB); if (b >= nB) b = nB - 1;
        const h01 = 0.32 + 0.53 * rf;                          // dark→deep water .. light→peaks
        put(x, y, legend[b].cls, h01, h01 >= SEA ? 1 : 0);
      }
    } else {
      for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
        const o = (y * res + x) * 4;
        let cls, isFresh = false;
        if (d[o + 3] < 128) cls = SC.Ocean;
        else { let bi = 0, bd = Infinity; for (let k = 0; k < legend.length; k++) { const p = legend[k].rgb, dr = d[o] - p[0], dg = d[o + 1] - p[1], db = d[o + 2] - p[2], dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; bi = k; } } cls = legend[bi].cls; isFresh = !!legend[bi].fresh; }
        const isOcean = cls === SC.Ocean;
        const band = ECO_BIOME_ELEV[CN[cls]] || [0.52, 0.62], mid = (band[0] + band[1]) / 2;
        put(x, y, cls, isOcean ? 0.30 : LAND_MEAN + (mid - LAND_MEAN) * COMPRESS, isOcean ? 0 : 1);
        if (isFresh) fresh[(res - 1 - y) * res + x] = 1;
      }
    }
    const nbr4 = j => { const x = j % res, y = (j / res) | 0; return [((x + 1) % res) + y * res, ((x + res - 1) % res) + y * res, x + ((y + 1) % res) * res, x + ((y + res - 1) % res) * res]; };
    // ---- classify water FIRST: the main sea (largest salt component) vs enclosed lakes + fresh water. This
    //      lets elevation be measured from the SEA only, so rivers/lakes inside the land don't flatten it.
    const water = new Uint8Array(n), bed = new Float32Array(n), wsurf = new Float32Array(n);
    const isSea = new Uint8Array(n); const groups = [];
    {
      const sc = new Int32Array(n).fill(-1); const sSize = []; let sid = 0;   // salt-water components; largest = sea
      for (let s = 0; s < n; s++) {
        if (land[s] !== 0 || fresh[s] || sc[s] >= 0) continue;
        const st = [s]; sc[s] = sid; let sz = 0;
        while (st.length) { const c = st.pop(); sz++; for (const q of nbr4(c)) if (land[q] === 0 && !fresh[q] && sc[q] < 0) { sc[q] = sid; st.push(q); } }
        sSize.push(sz); sid++;
      }
      let seaId = -1, seaSz = -1; for (let i = 0; i < sSize.length; i++) if (sSize[i] > seaSz) { seaSz = sSize[i]; seaId = i; }
      for (let j = 0; j < n; j++) if (land[j] === 0 && !fresh[j] && sc[j] === seaId) isSea[j] = 1;
      const salt = new Map();
      for (let j = 0; j < n; j++) if (land[j] === 0 && !fresh[j] && sc[j] !== seaId) (salt.get(sc[j]) || salt.set(sc[j], []).get(sc[j])).push(j);
      for (const g of salt.values()) groups.push(g);
      const fc = new Int32Array(n).fill(-1); let fid = 0; const fmap = new Map();   // fresh-water components (always lakes)
      for (let s = 0; s < n; s++) { if (!fresh[s] || fc[s] >= 0) continue; const st = [s]; fc[s] = fid; while (st.length) { const c = st.pop(); for (const q of nbr4(c)) if (fresh[q] && fc[q] < 0) { fc[q] = fid; st.push(q); } } fid++; }
      for (let j = 0; j < n; j++) if (fresh[j]) (fmap.get(fc[j]) || fmap.set(fc[j], []).get(fc[j])).push(j);
      for (const g of fmap.values()) groups.push(g);
    }
    // ---- Eco-style elevation (mirrors VoronoiWorldGenerator): relief rises with distance to the SEA
    //      (coast low -> interior high, ^power), textured by ridged noise into mountain ranges, and nudged
    //      by each biome's (spatially-smoothed) elevation band. Continuous field => natural transitions.
    const distO = new Int16Array(n).fill(-1);
    { const q = []; for (let i = 0; i < n; i++) if (isSea[i]) { distO[i] = 0; q.push(i); } for (let h = 0; h < q.length; h++) { const c = q[h]; for (const nb of nbr4(c)) if (distO[nb] < 0) { distO[nb] = distO[c] + 1; q.push(nb); } } }
    const OCEAN_DIST = 0.13 * res, EPOW = 1.8;                                    // reach full height ~13% inland -> steeper coasts
    const aboveMid = cls => { const b = ECO_BIOME_ELEV[CN[cls]] || [0.52, 0.62]; return Math.max(0, ((b[0] + b[1]) / 2 - 0.5) * 2); };   // biome target elevation above sea, [0,1]
    const tgt = new Float32Array(n); for (let j = 0; j < n; j++) tgt[j] = land[j] === 1 ? aboveMid(biome[j]) : 0;
    boxBlurTor(tgt, res, Math.max(3, Math.round(res / 42)), 2);                   // smooth the biome nudge so borders ramp, not step
    const ridged = (x, y) => { let s = 0, amp = 1, fr = 9, norm = 0; for (let o = 0; o < 5; o++) { const nz = vnR(x, y, fr, res); s += amp * (1 - Math.abs(2 * nz - 1)); norm += amp; amp *= 0.55; fr *= 2; } return s / norm; };   // ridged multifractal [0,1], more/steeper ranges
    const MAXH = 0.92;                                                           // interior peaks reach near the world's max height
    for (let j = 0; j < n; j++) {
      if (land[j] !== 1) continue;
      const x = j % res, y = (j / res) | 0;
      const nd = distO[j] < 0 ? 1 : Math.min(1, distO[j] / OCEAN_DIST);
      const maxE = Math.pow(nd, EPOW);                                            // ocean-distance ceiling: coasts stay low (beaches), interiors rise
      const relief = (0.10 + 0.90 * Math.pow(ridged(x, y), 1.3)) * MAXH;          // sharper, taller ridged mountain ranges (deep valleys -> high peaks)
      const nudge = (tgt[j] - 0.25) * 0.40;                                       // high-elevation biomes trend higher
      const above = Math.max(0.02, Math.min(maxE, relief + nudge + (vnR(x, y, 24, res) - 0.5) * 0.06));
      hf[j] = 0.5 + above * 0.5;                                                  // designer frac (0.5 = sea)
    }
    // Per-cell water surface, from the land it touches. Only cells ON the shore have a real constraint —
    // the bank they sit against. Cells out in the middle of a lake have none, so they take the LOWEST bank
    // within MIN_REACH: a lake is then level with its lowest shore (which is where it would drain), while a
    // channel, whose every cell is a shore cell, still follows the ground down. Carrying the FIRST bank to
    // arrive instead (a plain BFS) is what used to tilt lakes, since which shore won was arbitrary.
    const MIN_REACH = 20;
    const surf = new Float32Array(n).fill(Infinity); const lakeSet = new Set();
    for (const cells of groups) for (const j of cells) lakeSet.add(j);
    for (const j of lakeSet) { let mn = Infinity; for (const nb of nbr4(j)) if (land[nb] === 1 && hf[nb] < mn) mn = hf[nb]; surf[j] = mn; }
    for (let r = 0; r < MIN_REACH; r++) {
      let moved = 0;
      for (const j of lakeSet) { let mn = surf[j]; for (const nb of nbr4(j)) if (lakeSet.has(nb) && surf[nb] < mn) mn = surf[nb]; if (mn < surf[j]) { surf[j] = mn; moved++; } }
      if (!moved) break;
    }
    // MIN_REACH is a fixed number of steps, so the middle of a lake wider than that is never reached and
    // the flood ramps across it — in game, a corrugated bed under otherwise flat water. Level the OPEN
    // WATER separately: cells this far from any shore share one surface, however wide the lake. A drawn
    // river is only a few cells across, so it has no open water at all and is left completely alone —
    // which is what keeps it descending instead of turning into a level canal.
    const OPEN_WATER = 4;
    const fromShore = new Int16Array(n).fill(-1);
    { const q = [];
      for (let j = 0; j < n; j++) if (!lakeSet.has(j)) { fromShore[j] = 0; q.push(j); }
      for (let h = 0; h < q.length; h++) { const c = q[h]; for (const nb of nbr4(c)) if (fromShore[nb] < 0) { fromShore[nb] = fromShore[c] + 1; q.push(nb); } } }
    {
      const open = []; for (const j of lakeSet) if (fromShore[j] >= OPEN_WATER) open.push(j);
      const seen = new Set();
      for (const s0 of open) {                                                 // one level per open-water body
        if (seen.has(s0)) continue;
        const stack = [s0], patch = []; seen.add(s0); let mn = surf[s0];
        while (stack.length) {
          const c = stack.pop(); patch.push(c);
          if (surf[c] < mn) mn = surf[c];
          for (const nb of nbr4(c)) if (fromShore[nb] >= OPEN_WATER && lakeSet.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
        }
        for (const j of patch) surf[j] = mn;
        // pull the surrounding shallows down to it too, so the rim does not stand above the middle
        for (const j of patch) for (const nb of nbr4(j)) if (lakeSet.has(nb) && fromShore[nb] < OPEN_WATER && surf[nb] > mn) surf[nb] = mn;
      }
    }
    // Water sits in FLAT pools, in a valley it CARVES for itself.
    //
    // Pinning each cell's surface to its nearest bank (surf[] above) makes water follow the mountains it
    // was drawn across: one body then spans tens of blocks and Eco, which fills every column separately,
    // renders it as a jagged cascade. Pooling alone cannot fix that — the range is in the terrain, not in
    // the choice of levels. So relax the surface first, then carve the land to match.
    const BLK = 1 / 120;                  // one world block, in designer frac (Y = 60 + (2h-1)*60)
    const MAX_WATER_STEP = 0.5 * BLK;     // biggest rise allowed between neighbouring water cells
    const BANK_SLOPE = 3 * BLK;           // how fast the carved valley wall climbs away from the water
    const CARVE_REACH = 6;                // cells the valley carve reaches (beyond this, terrain is left alone)
    const FLAT_TOL = 1.5 * BLK;           // cells this close in height count as one pool, and level together
    const surfOf = j => (isFinite(surf[j]) ? surf[j] : 0.55);
    // Priority flood, spreading out from each body's LOWEST cell and always expanding the lowest water
    // next. Each cell takes
    //     level = surf <= parent ? parent : min(surf, parent + MAX_WATER_STEP)
    // which does both jobs at once and needs no lake-vs-river test. A dip surrounded by higher ground can
    // never sit below the water that reached it, so a basin fills to its rim and comes out DEAD FLAT; a
    // channel running downhill keeps its own profile, capped so it descends in small steps rather than
    // dropping the height of the ridge it was drawn across.
    const level = new Float32Array(n);
    for (const cells of groups) {
      let start = cells[0]; for (const j of cells) if (surfOf(j) < surfOf(start)) start = j;
      const inGroup = new Set(cells), done = new Set([start]);
      level[start] = surfOf(start);
      const heap = [[level[start], start]];                                   // binary min-heap on assigned level
      const push = (k, v) => { heap.push([k, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
      while (heap.length) {
        const [, c] = pop();
        for (const nb of nbr4(c)) {
          if (!inGroup.has(nb) || done.has(nb)) continue;
          done.add(nb);
          const s = surfOf(nb), lv = level[c];
          // Open water takes its level outright. Ramping into it at MAX_WATER_STEP a cell — correct for a
          // channel climbing away from its outlet — would tilt the whole surface of a lake entered from
          // below, and that tilt is exactly the ridged bed seen through flat water. A lake meeting a lower
          // river simply falls at the outlet, which is what a real one does.
          level[nb] = s <= lv ? lv : (fromShore[nb] >= OPEN_WATER ? s : Math.min(s, lv + MAX_WATER_STEP));
          push(level[nb], nb);
        }
      }
    }
    // No pass is needed here to stop a pool topping its banks. The shoreline restore after the blur puts
    // any land touching water a block above it, which contains the water by construction. An earlier
    // clamp-each-flat-region-to-its-lowest-bank step did the same job twice and made things worse: it cut a
    // lake into pieces and dropped each one to whatever bank was nearest, turning a level surface into a
    // staircase — measured, it took one lake from 6 levels to 13, and removing it took corrugation in open
    // water from 7.2% of neighbouring pairs to 0 with overflow still at 0. What remains are real waterfalls
    // where a lake meets a lower channel, all of them at outlets and none mid-lake.
    for (const cells of groups) {
      const tally = {}; for (const j of cells) for (const nb of nbr4(j)) if (land[nb] === 1) tally[biome[nb]] = (tally[biome[nb]] || 0) + 1;
      let lb = SC.Grassland, bc = -1; for (const k in tally) if (tally[k] > bc) { bc = tally[k]; lb = +k; }   // majority shore biome
      for (const j of cells) {
        const surface = Math.max(SEA + 0.01, level[j] - 0.012);                   // just under the surrounding bank
        const bottom = Math.max(0.03, surface - 0.03);
        biome[j] = lb; land[j] = 2; water[j] = Math.max(1, Math.min(255, Math.round((2 * surface - 1) * 255))); bed[j] = bottom; hf[j] = surface; wsurf[j] = surface;
      }
    }
    // Carve the valley. Relaxing the surface can drop it well below the ridge it was drawn across, which
    // would leave the water at the bottom of a sheer slot. Walk outward from the water and pull land down
    // to at most BANK_SLOPE per cell above the water it drains to, so banks rise away from the shoreline
    // instead of walling it. Only ever lowers, and stops as soon as the limit no longer binds — so terrain
    // away from water (and every coastal cliff) is untouched.
    {
      const lim = new Float32Array(n).fill(Infinity), dist = new Int16Array(n), q = [];
      for (let j = 0; j < n; j++) if (land[j] === 2) { lim[j] = hf[j]; q.push(j); }
      for (let h = 0; h < q.length; h++) {
        const c = q[h], next = lim[c] + BANK_SLOPE, d = dist[c] + 1;
        if (d > CARVE_REACH) continue;                                         // a valley, not a global reshape
        for (const nb of nbr4(c)) {
          if (land[nb] !== 1 || next >= lim[nb]) continue;                     // keep walking even where it
          lim[nb] = next; dist[nb] = d; q.push(nb);                            // doesn't bite — terrain may
          if (next < hf[nb]) hf[nb] = next;                                    // rise again further out
        }
      }
    }
    // minimal smoothing — keep the ridged relief steep (just knock off single-pixel noise + shoreline step)
    boxBlurTor(hf, res, Math.max(1, Math.round(res / 140)), 1);
    // The blur averages across the shoreline, and water cells sit low, so it drags the banks down with them
    // — far enough, in places, to leave the bank UNDER the water it is holding back, which reads in game as
    // a lake spilling over the terrain. Put the shore back: any land touching water sits a block above it.
    for (let j = 0; j < n; j++) {
      if (land[j] !== 1) continue;
      let need = -Infinity;
      for (const nb of nbr4(j)) if (land[nb] === 2 && wsurf[nb] > need) need = wsurf[nb];
      if (need > -Infinity && hf[j] < need + BLK) hf[j] = need + BLK;
    }
    // finalize: lakes hold water above their (fixed) bed; other land keeps its relief above sea; sea stays deep
    for (let j = 0; j < n; j++) {
      let h = land[j] === 2 ? bed[j] : (land[j] ? Math.max(0.505, hf[j]) : Math.min(hf[j], 0.44));
      height[j] = Math.max(0, Math.min(255, Math.round(h * 255)));
    }
    return { res, biome, height, water };
  }
  // Decode the source image onto the G x G paint grid. Colour maps must NOT be smoothed, for the same
  // reason imageToMaps doesn't smooth them: an averaging downscale turns every biome boundary into blend
  // colours, and those blends compete for the MAX_LEGEND slots. A small biome loses — an ice cap at ~1% of
  // land never survives a 448 -> 128 downscale, and gets silently remapped to whatever colour is nearest.
  // Brightness mode does want the averaging, since it is reading tone off a photo.
  function decodeToGrid(img) {
    const c = document.createElement('canvas'); c.width = G; c.height = G;
    const cx = c.getContext('2d'); cx.imageSmoothingEnabled = (importMode === 'brightness');
    cx.drawImage(img, 0, 0, G, G);                          // stretch to the square world grid
    return cx.getImageData(0, 0, G, G).data;
  }
  // Load an image, stretch it to the world grid, cluster its colors, and map each color to a biome
  // (nearest by default — the user can then remap any color via the legend below the canvas).
  function importImage(file) {
    const img = new Image();
    img.onload = () => {
      pushUndo();
      const d = decodeToGrid(img);
      lastImgData = d; importedImg = img; paintedSinceImport = false;
      mapImage(d);
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
  function markPaintMode() {
    const t = $('dsnPaintMode'); if (t) t.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.pm === paintMode));
    const isElev = paintMode === 'elevation';
    const w = $('dsnElevWrap'); if (w) w.style.display = isElev ? '' : 'none';
    const lg = $('dsnElevLegend'); if (lg) { lg.style.display = isElev ? '' : 'none'; if (isElev) drawElevLegend(); }
  }

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
    drawWrapPreview();
  }
  // Tile the current view 2×2 so the toroidal seams (left↔right, top↔bottom) are visible while drawing.
  function drawWrapPreview() {
    const pv = $('dsnWrapCv'); if (!pv) return;
    const src = $('dsnCanvas'), ctx = pv.getContext('2d'), W = pv.width, h = W / 2;
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) ctx.drawImage(src, 0, 0, src.width, src.height, i * h, j * h, h, h);
    ctx.strokeStyle = 'rgba(255,70,70,.85)'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(h + .5, 0); ctx.lineTo(h + .5, W); ctx.moveTo(0, h + .5); ctx.lineTo(W, h + .5); ctx.stroke(); ctx.setLineDash([]);
  }
  // biomes with the painted rivers/lakes overlaid in blue
  function drawWaterView(canvas) {
    drawGrid(canvas, target, true);
    const ctx = canvas.getContext('2d'), W = canvas.width, img = ctx.getImageData(0, 0, W, W), d = img.data;
    for (let y = 0; y < W; y++) { const gy = G - 1 - y; for (let x = 0; x < W; x++) { if (water[gy * G + x]) { const o = (y * W + x) * 4; d[o] = 30; d[o + 1] = 110; d[o + 2] = 230; } } }
    ctx.putImageData(img, 0, 0);
  }
  function pushUndo() { undoStack.push({ t: target.slice(), e: elev.slice(), p: elevPainted.slice(), w: water.slice(), r: rough.slice() }); if (undoStack.length > 40) undoStack.shift(); }
  function undo() { if (!undoStack.length) return; const s = undoStack.pop(); target = s.t; elev = s.e; elevPainted = s.p; water = s.w; rough = s.r; renderPaint(); }
  function onPointer(e) {
    const cv = $('dsnCanvas'), r = cv.getBoundingClientRect();
    const dispX = Math.floor((e.clientX - r.left) / r.width * G);
    const dispY = Math.floor((e.clientY - r.top) / r.height * G);
    if (dispX < 0 || dispX >= G || dispY < 0 || dispY >= G) return;
    paintedSinceImport = true;              // hand edits win over the imported image at export time
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
      const x = ((cx + dx) % G + G) % G, y = ((cy + dy) % G + G) % G;
      const i = y * G + x;
      if (v < 0) { elevPainted[i] = 0; } else { elev[i] = v; elevPainted[i] = 1; rough[i] = paintRoughness; }   // bake the brush's roughness per cell
    }
  }
  function stampWater(cx, cy, v) {
    const rad = brushSize - 1, r2 = (rad + 0.5) * (rad + 0.5);
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = ((cx + dx) % G + G) % G, y = ((cy + dy) % G + G) % G;
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
  const OCEAN_FALLOFF = G / 4, RELIEF_AMP = 0.10;   // coast→interior ramp, kept proportional to grid size
  function computeHeightField() {
    const dist = oceanDistField();
    let a = new Float32Array(G * G);
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const i = y * G + x;
      if (elevPainted[i]) {                                             // painted: add the per-cell micro-relief baked at paint time
        const v = elev[i] + (fbm(x, y) - 0.5) * rough[i];
        a[i] = elev[i] >= 0.505 ? Math.max(0.505, v) : v;               // painted land stays above sea (no accidental puddles)
        continue;
      }
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
  // ---- elevation visualization: hypsometric tint + hillshade + contours ----------------------------
  // Sea level in the [0,1] height field; below is water, above is land (matches computeHeightField).
  const SEA_LEVEL = 0.5, HS_Z = 22, CONTOUR = 0.05;    // HS_Z exaggerates slope for shading; CONTOUR = isoline spacing
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  // hypsometric land ramp keyed by height ABOVE sea, normalized to [0,1]: sand→green→tan→brown→rock→snow
  const LAND_RAMP = [[0, [236, 226, 170]], [0.08, [186, 208, 128]], [0.20, [120, 178, 96]], [0.38, [176, 172, 96]], [0.55, [156, 120, 72]], [0.74, [120, 92, 72]], [0.90, [198, 196, 198]], [1, [255, 255, 255]]];
  function landColor(h, sea) { sea = sea == null ? SEA_LEVEL : sea; let t = (h - sea) / (1 - sea); t = t < 0 ? 0 : t > 1 ? 1 : t; for (let k = 1; k < LAND_RAMP.length; k++) { if (t <= LAND_RAMP[k][0]) { const a = LAND_RAMP[k - 1], b = LAND_RAMP[k], u = (t - a[0]) / ((b[0] - a[0]) || 1); return lerp3(a[1], b[1], u); } } return LAND_RAMP[LAND_RAMP.length - 1][1]; }
  function waterColor(h, sea) { sea = sea == null ? SEA_LEVEL : sea; let dd = (sea - h) / sea; dd = dd < 0 ? 0 : dd > 1 ? 1 : dd; return lerp3([120, 175, 215], [16, 38, 86], Math.pow(dd, 0.6)); }  // shallow→deep blue
  // A relief-shaded, colour-graded height view: colour tells absolute height, shading + contour lines
  // reveal the shape (and make small paint changes visible). One backing pixel per grid cell.
  function drawHeight(canvas) {
    const t = computeTerrain(); lastTerrain = t; const h = t.height;
    const ctx = canvas.getContext('2d'), W = canvas.width, img = ctx.createImageData(W, W), d = img.data;
    const hAt = (dx, dy) => h[(((G - 1 - dy) % G + G) % G) * G + ((dx % G + G) % G)];   // display→grid, wrapped (toroidal)
    for (let y = 0; y < W; y++) { const gy = G - 1 - y; for (let x = 0; x < W; x++) {
      const i = gy * G + x, hv = h[i], o = (y * W + x) * 4;
      const isW = target[i] === SC.Ocean || water[i] || hv < SEA_LEVEL;
      const c = isW ? waterColor(hv) : landColor(hv);
      // hillshade: surface normal vs a NW light; flat ground stays at the base tint (shade≈1)
      const dzdx = (hAt(x + 1, y) - hAt(x - 1, y)) * HS_Z, dzdy = (hAt(x, y + 1) - hAt(x, y - 1)) * HS_Z;
      const nz = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      let sh = (0.5206 * (dzdx + dzdy) + 0.6767) * nz / 0.6767;
      sh = sh < 0.42 ? 0.42 : sh > 1.6 ? 1.6 : sh;
      let r = c[0] * sh, g = c[1] * sh, bl = c[2] * sh;
      if (!isW) {   // contour line where the height band changes (darken slightly) — quantitative + shows edits
        const a0 = Math.floor((hv - SEA_LEVEL) / CONTOUR);
        if (a0 !== Math.floor((hAt(x + 1, y) - SEA_LEVEL) / CONTOUR) || a0 !== Math.floor((hAt(x, y + 1) - SEA_LEVEL) / CONTOUR)) { r *= 0.72; g *= 0.72; bl *= 0.72; }
      }
      d[o] = r > 255 ? 255 : r; d[o + 1] = g > 255 ? 255 : g; d[o + 2] = bl > 255 ? 255 : bl; d[o + 3] = 255;
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
      const x = ((cx + dx) % G + G) % G, y = ((cy + dy) % G + G) % G;   // torus: strokes wrap to the opposite edge
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
      const x = i % G, y = (i / G) | 0;   // torus: regions that touch a border continue on the opposite edge
      st.push(((x + G - 1) % G) + y * G); st.push(((x + 1) % G) + y * G);
      st.push(x + ((y + G - 1) % G) * G); st.push(x + ((y + 1) % G) * G);
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
  // infinite scroll: load the next page when the Show-more sentinel nears the viewport bottom
  function maybeAutoLoad() {
    if (designMode !== 'find') return;
    const dw = $('designWrap'); if (!dw || dw.style.display === 'none') return;
    const sm = $('dsnShowMore'); if (!sm || sm.style.display === 'none') return;
    if (sm.getBoundingClientRect().top < window.innerHeight + 300) { galShow += SHOW_STEP; renderGallery(); }
  }
  function renderGallery() {
    const gal = $('dsnGallery');
    const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target, true);   // keep the "your drawing" thumbnail in sync
    const bestRef = $('dsnBestRef'), bestLbl = $('dsnBestLbl');
    if (bestRef) { if (pool.length) { drawGrid(bestRef, pool[0].grid, true); if (bestLbl) bestLbl.textContent = 'best match · ' + (pool[0].s.score * 100).toFixed(1) + '%'; } else { bestRef.getContext('2d').clearRect(0, 0, G, G); if (bestLbl) bestLbl.textContent = 'best match'; } }
    if (!pool.length) { $('dsnGalCount').textContent = ''; gal.innerHTML = '<div class="dsnMini">No candidates yet — run a search.</div>'; const sm = $('dsnShowMore'); if (sm) sm.style.display = 'none'; return; }
    // sort a copy by the chosen key, filter by min overall score, page with galShow (Find-mode gallery)
    const list = pool.filter(it => it.s.score >= galleryMin).slice().sort((a, b) => b.s[gallerySort] - a.s[gallerySort]);
    $('dsnGalCount').textContent = '(' + list.length + (galleryMin > 0 ? ' of ' + pool.length : '') + ' kept)';
    const show = list.slice(0, galShow);
    gal.innerHTML = show.map((it, i) =>
      '<div class="dsnCandidate' + (i === 0 ? ' best' : '') + '" data-i="' + i + '">' +
        '<canvas width="' + G + '" height="' + G + '" data-i="' + i + '"></canvas>' +
        '<div class="sc">' + (it.s.score * 100).toFixed(1) + '%</div>' +
        '<div>seed ' + it.seed + '</div>' +
        '<div class="dsnMini">mix ' + (it.s.prop * 100).toFixed(0) + ' · shape ' + (it.s.iou * 100).toFixed(0) + ' · fit ' + (it.s.soft * 100).toFixed(0) + '</div>' +
        '<button data-apply="' + i + '">Apply this world</button>' +
      '</div>').join('');
    gal.querySelectorAll('canvas[data-i]').forEach(c => drawGrid(c, show[+c.dataset.i].grid, true));
    gal.querySelectorAll('button[data-apply]').forEach(b => b.onclick = () => applyCandidate(show[+b.dataset.apply]));
    gal.querySelectorAll('canvas[data-i]').forEach(c => c.onclick = () => applyCandidate(show[+c.dataset.i]));
    const sm = $('dsnShowMore'); if (sm) { const more = list.length - show.length; sm.style.display = more > 0 ? '' : 'none'; sm.textContent = more > 0 ? 'Show more (' + more + ')' : 'Show more'; }
  }
  function applyCandidate(item) {
    // the candidate's exact cfg (jitter-safe); fall back to invBase+seed for older pool items
    const src = item.cfg || Object.assign(JSON.parse(JSON.stringify(invBase)), { seed: item.seed });
    const cfg = JSON.parse(JSON.stringify(src));
    populateForm(cfg);                    // fills every form field incl. weights + seed; readForm() will reproduce cfg
    close();
    generateMap(cfg);                     // baseCfg is left as the loaded config so "Reset to loaded" still works
  }

  // ---- world settings (size / water / height): the only config knobs that shape an authored world ----
  // Two-way bound to the main form's #cf_* inputs, which readForm()/buildExportJson() read live at
  // export/preview time — so mirroring the value there is all that's needed (no separate state).
  const WORLD_FIELDS = [['dsnWorldW', 'cf_worldWidth'], ['dsnWaterLvl', 'cf_waterLevel'], ['dsnMaxGen', 'cf_maxGenerationHeight']];
  function updateWorldMeta() {
    const el = $('dsnWorldW'), m = $('dsnWorldMeta'); if (!m) return;
    const w = el ? parseInt(el.value, 10) : NaN;
    m.textContent = isFinite(w) ? (w + ' chunks · ' + (w * 10) + '×' + (w * 10) + ' m') : '';
  }
  function syncWorldFields() {                 // pull current main-form values into the designer inputs
    for (const [d, c] of WORLD_FIELDS) { const src = $(c), dst = $(d); if (src && dst) dst.value = src.value; }
    updateWorldMeta();
  }
  function wireWorldFields() {                 // designer input → mirror onto the main form's #cf_* input
    for (const [d, c] of WORLD_FIELDS) {
      const dst = $(d); if (!dst) continue;
      dst.oninput = () => { const src = $(c); if (src) src.value = dst.value; updateWorldMeta(); };
    }
  }

  // ================================================================= open / close
  function open(mode) {
    if (typeof baseCfg === 'undefined' || !baseCfg) { $('err').textContent = 'Load a WorldGenerator.eco config first.'; return; }
    if (!built) buildUI();
    designMode = mode === 'find' ? 'find' : 'design';
    const t = $('dsnTitle'), st = $('dsnSubtitle'), find = designMode === 'find';
    if (t) t.textContent = find ? '🔍 Find a map' : '🎨 Design a map';
    if (st) st.textContent = find ? 'paint the layout you want, then search seeds for the closest real world' : 'paint a world → preview it in 3D → generate it exactly';
    $('dsnRightDesign').style.display = find ? 'none' : '';
    $('dsnRightFind').style.display = find ? '' : 'none';
    if (!find) syncWorldFields();   // reflect the current config's size/water/height on the Design page

    $('dsnFindGallery').style.display = find ? '' : 'none';
    // hide the map view + panels (mirror open3D), show the designer
    $('canvasWrap').style.display = 'none'; $('legend').style.display = 'none'; $('stats').style.display = 'none';
    const sb = $('surfaceBar'); if (sb) sb.style.display = 'none';   // hide the map's cfg sidebar → left column (designer + Underground) goes full width
    const cfp = $('cfgPanel');
    if (cfp) { cfp._dsnPrev = cfp.style.display; cfp.style.display = 'none'; }
    $('designWrap').style.display = 'block';   // Underground (#chartsPanel) stays visible below, usable while designing
    // first time in: seed the canvas from the current map so there's something to edit (not blank ocean)
    let empty = true; for (let i = 0; i < target.length; i++) if (target[i] !== SC.Ocean) { empty = false; break; }
    if (empty && typeof result !== 'undefined' && result) seedFromMap();
    updateSpeedHint();
    const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target, true);
    renderPaint();
  }
  function close() {
    stopSearch();
    clearTimeout(genPollTimer);   // stop any inline generation-status poll
    $('designWrap').style.display = 'none';
    $('canvasWrap').style.display = ''; $('legend').style.display = ''; $('stats').style.display = '';
    const sb = $('surfaceBar'); if (sb) sb.style.display = '';
    const cfp = $('cfgPanel');
    if (cfp) cfp.style.display = cfp._dsnPrev != null ? cfp._dsnPrev : '';
  }

  // ================================================================= authored-world export
  // Render a G x G grid to a PNG for HUMAN inspection. `pix(x,y)` reads generation orientation (row 0 =
  // south, as the mod reads the .bin), but we write it flipped-Y so the PNG reads north-up like the editor
  // and the in-game map — matching what the user drew. (The mod never reads these PNGs; it reads the .bin,
  // which stays generation orientation.) Returns a Uint8Array of PNG bytes.
  function gridToPng(pix) {
    return new Promise(resolve => {
      const cv = document.createElement('canvas'); cv.width = G; cv.height = G;
      const ctx = cv.getContext('2d'), img = ctx.createImageData(G, G), d = img.data;
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) { const c = pix(x, y), o = ((G - 1 - y) * G + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
      ctx.putImageData(img, 0, 0);
      cv.toBlob(b => b.arrayBuffer().then(ab => resolve(new Uint8Array(ab))), 'image/png');
    });
  }
  // minimal STORE-method zip (no compression; PNGs are already compressed)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function strBytes(s) { return new TextEncoder().encode(s); }
  // typed-array <-> base64 (for round-tripping the editable design layers in design.json)
  function abToB64(buf) { const u8 = new Uint8Array(buf); let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function b64ToU8(b64) { const s = atob(b64); const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }
  // minimal reader for our STORE-method zips: returns { name: Uint8Array }
  function unzipStore(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = {}; let p = 0;
    while (p + 30 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
      const method = dv.getUint16(p + 8, true), compSize = dv.getUint32(p + 18, true);
      const nameLen = dv.getUint16(p + 26, true), extraLen = dv.getUint16(p + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
      const dataStart = p + 30 + nameLen + extraLen;
      out[name] = method === 0 ? bytes.subarray(dataStart, dataStart + compSize) : null;   // STORE only
      p = dataStart + compSize;
    }
    return out;
  }
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
    // A pure image import exports hi-res biome + height straight from the source image (the coarse 64²
    // paint grid would waste an ~11-block chunk per pixel). Hand-painting over the import opts back out.
    let biomeOut = biomeBin, heightOut = heightBin, waterOut = waterBin, hi = null;
    if (importedImg && !paintedSinceImport) {
      hi = imageToMaps(IMPORT_RES); biomeOut = hi.biome; heightOut = hi.height;
      waterOut = hi.water; anyWater = hi.water.some(v => v > 0);   // enclosed water in the image -> lakes
    }
    // PNGs kept for human inspection only (not read by the mod).
    const biomePng = await gridToPng((x, y) => water[y * G + x] ? [40, 90, 200] : (ECO_BIOME_COLOR[CN[target[y * G + x]]] || ECO_BIOME_COLOR.Ocean));
    const heightPng = await gridToPng((x, y) => { const b = heightBin[y * G + x]; return [b, b, b]; });
    const files = [
      { name: 'WorldGenerator.eco', data: strBytes(JSON.stringify(cfg, null, 2)) },
      { name: 'biome.bin', data: biomeOut },
      { name: 'height.bin', data: heightOut },
      { name: 'biome.png', data: biomePng },
      { name: 'height.png', data: heightPng },
      { name: 'authored.json', data: strBytes('{ "enabled": true, "source": "eco-map-generator" }') },
    ];
    if (anyWater) files.push({ name: 'water.bin', data: waterOut });   // rivers/lakes (painted) or enclosed lakes (imported)
    // raw editable layers, so the design can be re-imported for tuning (the .bin files are computed output)
    const design = { v: 1, G: G, importMode: importMode, paintRoughness: paintRoughness, elevValue: elevValue, layoutWeight: layoutWeight,
      target: abToB64(target.buffer), elev: abToB64(elev.buffer), elevPainted: abToB64(elevPainted.buffer), rough: abToB64(rough.buffer), water: abToB64(water.buffer) };
    files.push({ name: 'design.json', data: strBytes(JSON.stringify(design)) });
    return { size: (cfg && findWorldWidth(cfg)) || 72, files: files, hiRes: hi ? hi.res : 0 };
  }

  // ---- hosted generation: POST the bundle to eco-worldgen-service, then poll status inline ----
  // The service error strings are plain text (never HTML) — always insert them with textContent.
  function setGenLine(text, isError) {
    const el = $('dsnGenStatus'); if (!el) return null;
    el.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'dsnMini';
    if (isError) line.style.color = '#e5484d';
    line.textContent = text;
    el.appendChild(line);
    return el;
  }
  function addGenLink(el, href, label, block) {
    if (!el) return null;
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = label;
    a.style.cssText = 'font-size:12px;margin-top:6px;' + (block ? 'display:block;' : 'display:inline-block;margin-right:12px;');
    el.appendChild(a);
    return a;
  }
  function setGenLineWithPage(text, statusUrl, isError) {
    const el = setGenLine(text, isError);
    addGenLink(el, statusUrl, '🔗 Your world page (bookmark this)', true);
    return el;
  }
  function submitError(status, msg) {
    if (status === 413) return 'That bundle is too large for the service.';
    if (status === 429) return 'Too many requests — wait a minute and try again.';
    if (status === 503) return 'The service is busy or full right now — try again later.';
    if (status === 400) return msg || 'The bundle was rejected.';
    return msg || ('Upload failed (HTTP ' + status + ').');
  }
  async function generateSave() {
    if (typeof baseCfg === 'undefined' || !baseCfg) { setGenLine('Load a config first.', true); return; }
    const btn = $('dsnGenSave');
    // The service rejects (not clamps) world size, so check it here for a friendlier message.
    const ww = (typeof readForm === 'function') ? (readForm().worldWidth | 0) : 0;
    if (ww && (ww < 12 || ww > WORLDGEN_MAX_SIZE || ww % 4 !== 0)) {
      setGenLine('World size must be a multiple of 4 between 12 and ' + WORLDGEN_MAX_SIZE + ' (currently ' + ww + '). Adjust it in World settings.', true);
      return;
    }
    if (btn) btn.disabled = true;
    clearTimeout(genPollTimer);
    setGenLine('Building bundle…');
    try {
      const b = await buildBundleFiles();
      const blob = new Blob([makeZip(b.files)], { type: 'application/zip' });
      const body = new FormData();
      body.append('file', blob, 'bundle.zip');
      setGenLine('Uploading to the generation service…');
      const res = await fetch(WORLDGEN_API + '/api/submit', { method: 'POST', body });
      let data = {}; try { data = await res.json(); } catch (e) {}
      if (!res.ok) { setGenLine(submitError(res.status, data && data.error), true); if (btn) btn.disabled = false; return; }
      setGenLineWithPage('Submitted — your world is queued.', data.statusUrl);
      pollStatus(data.token, data.statusUrl);
    } catch (e) {
      setGenLine('Could not reach the generation service (' + e.message + '). It may be offline, or this origin is not allowed by CORS.', true);
      if (btn) btn.disabled = false;
    }
  }
  function pollStatus(token, statusUrl) {
    const btn = $('dsnGenSave');
    const tick = async () => {
      let s;
      try {
        const res = await fetch(WORLDGEN_API + '/api/status/' + encodeURIComponent(token));
        if (res.status === 404) { setGenLine('This job is no longer available.', true); if (btn) btn.disabled = false; return; }
        s = await res.json();
      } catch (e) { genPollTimer = setTimeout(tick, 5000); return; }   // transient network error — back off, keep trying
      if (s.state === 'queued') {
        setGenLineWithPage('Queued' + (s.queuePosition ? ' — #' + s.queuePosition + ' in line' : '') + '…', statusUrl);
        genPollTimer = setTimeout(tick, 2500);
      } else if (s.state === 'generating') {
        setGenLineWithPage('Generating your world… (a few minutes)', statusUrl);
        genPollTimer = setTimeout(tick, 2500);
      } else if (s.state === 'finished') {
        const el = setGenLine('✅ Your world is ready!');
        addGenLink(el, statusUrl.replace(/\/$/, '') + '/save', '⬇ Download Eco save', true);
        addGenLink(el, statusUrl, '🔗 World page (re-download any time)', true);
        if (btn) btn.disabled = false;
      } else if (s.state === 'failed') {
        setGenLineWithPage('Generation failed: ' + (s.error || 'unknown error'), statusUrl, true);
        if (btn) btn.disabled = false;
      } else {
        genPollTimer = setTimeout(tick, 2500);
      }
    };
    tick();
  }
  function findWorldWidth(j) { let r = null; (function w(o) { if (!o || typeof o !== 'object' || r) return; if (Object.prototype.hasOwnProperty.call(o, 'WorldWidth')) { r = o.WorldWidth; return; } for (const k in o) w(o[k]); })(j); return r; }

  // Re-import a previously exported design .zip: restore the editable layers (design.json) + the world
  // config (WorldGenerator.eco), so you can keep tuning and re-export/regenerate.
  function importDesignZip(file) {
    const setStatus = m => { const a = $('dsnGenStatus'); if (a) a.innerHTML = m; const b = $('dsnAnalysis'); if (b) b.innerHTML = '<b>' + m + '</b>'; };
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const zf = unzipStore(new Uint8Array(reader.result));
        const dj = zf['design.json'];
        if (!dj) { setStatus('That .zip has no design.json — only designs exported from this version can be re-imported.'); return; }
        const d = JSON.parse(new TextDecoder().decode(dj));
        if (d.G !== G) { setStatus('This design uses a ' + d.G + '² grid but the current one is ' + G + '² — can\'t import it exactly.'); return; }
        pushUndo();
        target = b64ToU8(d.target);
        elev = new Float32Array(b64ToU8(d.elev).buffer);
        elevPainted = b64ToU8(d.elevPainted);
        rough = new Float32Array(b64ToU8(d.rough).buffer);
        water = b64ToU8(d.water);
        hideLegend();                                   // clears any stale image-import state
        importMode = d.importMode || 'colors';
        if (d.paintRoughness != null) { paintRoughness = d.paintRoughness; const rg = $('dsnRough'); if (rg) rg.value = Math.round(paintRoughness / 0.16 * 100); const rv = $('dsnRoughV'); if (rv) rv.textContent = roughLabel(paintRoughness); }
        if (d.elevValue != null) { elevValue = d.elevValue; const el = $('dsnElev'); if (el) el.value = Math.round(elevValue * 100); const ev = $('dsnElevV'); if (ev) ev.textContent = elevLabel(elevValue); }
        if (d.layoutWeight != null) { layoutWeight = d.layoutWeight; const w = $('dsnWeight'); if (w) w.value = Math.round(layoutWeight * 100); }
        // restore the world config (size, biomes, terrain/ore) from the bundle if present
        const eco = zf['WorldGenerator.eco'];
        if (eco && typeof loadConfigText === 'function') {
          loadConfigText(new TextDecoder().decode(eco), true);
          $('cfgPanel').style.display = 'none'; const sb = $('surfaceBar'); if (sb) sb.style.display = 'none';   // stay in the designer overlay
          syncWorldFields();   // the bundle may carry a different world size/water/height

        }
        paintMode = 'biome'; markPaintMode(); renderPaint();
        const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target, true);
        setStatus('Imported design — tune it, then re-generate or preview.');
      } catch (e) { setStatus('Could not read that design .zip: ' + e.message); }
    };
    reader.readAsArrayBuffer(file);
  }

  // test/automation hook: returns the bundle files base64-encoded (no download prompt)
  async function bundleBase64() {
    const b = await buildBundleFiles();
    const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
    const out = { size: b.size }; for (const f of b.files) out[f.name] = b64(f.data); return out;
  }

  // ---- 3D preview of the authored design (reuses the main 3D voxel view + worker) ----
  // Builds the same biome + carved-height maps the export produces and hands them to the voxel worker,
  // which upscales them to world size and meshes real block chunks — so you can fly through the design.
  function build3DPayload() {
    const cfg = readForm();                               // internal cfg (worldWidth, waterLevel, maxGenerationHeight)
    const t = computeTerrain();
    const heightBytes = new Uint8Array(G * G);
    for (let i = 0; i < G * G; i++) heightBytes[i] = Math.max(0, Math.min(255, Math.round(t.height[i] * 255)));
    return { type: '3d-authored', G: G, biome: target.slice(), height: heightBytes, cfg: cfg, terrain: terrain };
  }
  function post3D() {
    const p = build3DPayload();
    $('view3dStatus').textContent = 'building 3D preview…';
    worker.postMessage(p, [p.biome.buffer, p.height.buffer]);
  }
  function preview3D() {
    if (typeof baseCfg === 'undefined' || !baseCfg) { $('dsnGenStatus').textContent = 'Load a config first.'; return; }
    if (typeof terrain === 'undefined' || !terrain) { $('dsnGenStatus').textContent = 'No terrain loaded — load/generate a config first.'; return; }
    $('designWrap').style.display = 'none';
    const cp = $('chartsPanel'); if (cp) cp.style.display = 'none';   // 3D view is a full-screen preview; Underground returns on Back
    $('view3dWrap').style.display = 'block';
    threeDFrom = 'designer';
    const cb = $('view3dClose'); if (cb) cb.textContent = '← Back to design';
    seenBlocks = {}; hiddenBlocks = new Set(); buildBlockToggles();
    Render3D.init($('view3dCanvas'), THREE);
    if (!worker3dBound) { worker.addEventListener('message', worker3dHandler); worker3dBound = true; }
    requestAnimationFrame(() => Render3D.resize());
    post3D();
  }

  async function zipBase64() { const b = await buildBundleFiles(); return abToB64(makeZip(b.files).buffer); }   // test hook
  window.Designer = { open, close, bundleBase64, preview3D, post3D, zipBase64 };
  const btn = document.getElementById('designOpen');
  if (btn) btn.onclick = () => open('design');
  const fbtn = document.getElementById('findOpen');
  if (fbtn) fbtn.onclick = () => open('find');
})();
