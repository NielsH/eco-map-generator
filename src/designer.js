// src/designer.js — "Design a map": draw a target biome layout, invert it to a starting config,
// then run a parallel best-of-N seed search for a real, playable world that resembles the drawing.
//
// Injected RAW into the page (like render3d.js), AFTER the main script, so it can use template
// literals freely and reference the main-thread globals ($, baseCfg, readForm, populateForm,
// generateMap, makeWorker, VT, sharesToWeights, WEIGHT_KEYS, terrain, cfgUsed) and the inlined
// search core (SCLASS, SC, NUM_CLASSES, scoreGrids, blendScore, histogram).
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
  // How strongly a biome levels itself against the ground around it: 0 leaves the relief alone, 1
  // replaces it with the local mean. Only biomes stock builds on flat ground belong here.
  const BIOME_FLATTEN = { Wetland: 1.00 };
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
  let seededFrom = null;        // the map result this design was seeded from, so a new map can re-seed it
  let designEdited = false;     // set by any paint or import; an edited design is never re-seeded under the user
  let undoStack = [], lastGX = -1, lastGY = -1;
  let lastTerrain = null;                       // last computed {height,waterVal} — for the elevation hover readout
  // image-import color legend: dominant source colors + their (user-overridable) biome assignment
  let legend = [];               // [{ rgb:[r,g,b], count, cls }]
  let imgLegendIdx = null;       // Int16Array(G*G) legend index per image cell (-1 = transparent -> ocean)
  const MAX_LEGEND = 12;         // cap on distinct source colors offered for remapping
  let importMode = 'colors';     // 'colors' (nearest hue) | 'brightness' (luminance ramp — better for photos)
  let lastImgData = null;        // last decoded G*G RGBA, so switching import mode re-maps without re-loading
  let importedImg = null;        // the decoded source Image, kept so export can resample it at high resolution
  // A pure image import EXPORTS at IMPORT_RES, not at the G paint grid, so showing it at G misrepresents
  // it: a coastline only a pixel or two wide in the source is thinner than one paint cell and breaks into
  // dashes on screen, even though the generated world has it intact. Keep a preview at export resolution
  // and show that until the user paints — at which point the coarse grid IS what gets exported, and the
  // display switches back to it.
  let importPreview = null;      // Uint8Array(IMPORT_RES^2) class per cell, generation orientation
  let importLegendIdxHi = null;  // legend index per hi-res cell, so remapping a colour rebuilds instantly
  let paintedSinceImport = false; // once the user hand-edits an import, export falls back to the G² paint grid
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
  function assignLegendIdx(d, size) {
    const N = size || G;
    const idx = new Int16Array(N * N);
    for (let i = 0; i < N * N; i++) {
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
    if (importedImg && importMode === 'colors') {
      if (!importLegendIdxHi) importLegendIdxHi = assignLegendIdx(decodeAt(importedImg, IMPORT_RES), IMPORT_RES);
      const N = IMPORT_RES;
      importPreview = new Uint8Array(N * N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const li = importLegendIdxHi[y * N + x];
        importPreview[(N - 1 - y) * N + x] = li < 0 ? SC.Ocean : legend[li].cls;   // flipped like `target`
      }
    } else importPreview = null;
    renderPaint();
    const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target);
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
  function hideLegend() { legend = []; imgLegendIdx = null; lastImgData = null; importedImg = null; paintedSinceImport = false; importPreview = null; importLegendIdxHi = null; const w = $('dsnLegendWrap'); if (w) { w.style.display = 'none'; w.innerHTML = ''; } }
  // toroidal separable box blur (in place); spreads biome-edge height steps into gentle slopes
  // ---- water surface solver -------------------------------------------------------------------
  //
  // Turns a per-cell first guess at the water surface into one a world can be built from. Every cell
  // starts with a level taken from its own bank, and three things are wrong with that: a bad bank
  // estimate leaves one cell standing metres above the water around it, a course drawn across a slope
  // gets a high level on its uphill side and a low one on its downhill side, and a lake keeps a
  // different level on every shore it touches. The passes below fix them in that order.
  //
  // `land[j] === 2` marks fresh water; `fromShore` is how many cells that water is from its own edge.
  // Written for the image import first and shared with a design seeded from the map, which arrives at
  // the same first guess by a different route and needs the same three things done to it.
  const BLK = 1 / 120;      // one world block, in designer frac (Y = 60 + (2h-1)*60)
  const OPEN_WATER = 4;     // cells from the edge before water counts as open rather than shallow
  // ---- water levels ---------------------------------------------------------------------------
  //
  // Decide how high the water in each body stands, BEFORE anything tries to level or contain it. This
  // is the part that makes water sit down in the landscape rather than on top of it: each cell is
  // bounded by its own ring of bank, by the average ground around it, and by how far it is from the sea
  // (a mouth is pinned to sea level the way vanilla pins one by construction), and then a priority flood
  // from every mouth gives each cell the lowest level any outlet can justify. A basin fills to its rim
  // and comes out dead flat; a channel keeps its own descending profile.
  //
  // Written for the image import and shared with a design seeded from the map, whose water arrives on
  // terrain that has no basin under it at all - without this the seeded lakes stand ON the ground and
  // the shore ring has to be raised to hold them, which is a kerb around every body.
  function settleWaterLevels(res, n, land, hf, distO, BPC, groups, boxBlurTor) {
    const nbr4 = j => { const x = j % res, y = (j / res) | 0; return [((x + 1) % res) + y * res, ((x + res - 1) % res) + y * res, x + ((y + 1) % res) * res, x + ((y + res - 1) % res) * res]; };
    const SEA = SEA_LEVEL;
    const surf = new Float32Array(n).fill(Infinity); const lakeSet = new Set();
    for (const cells of groups) for (const j of cells) lakeSet.add(j);
    // Fresh water near the sea has to arrive AT it. Vanilla routes every river downhill until it hits an
    // ocean cell and then walks the segment back from that mouth with `endElevation = Math.Max(0f, ...)`
    // (VoronoiWorldGenerator, "ensure the elevation changes are valid"), so a mouth is pinned to sea level
    // by construction. A painted channel has no router: it takes its level from whatever banks it happens
    // to have, so a course drawn along a coast carries its inland level right past the sea and ends up
    // perched, with its own bank walling the sea out. Measured on a real authored world, one stretch sat
    // 6 blocks over a sea 20 m away — and 230 m away from its own outlet, so nothing that follows the
    // CHANNEL can see the problem. The bound therefore reads distance to the SEA, which distO already has.
    //
    // Its shape is vanilla's own envelope, measured over four seeds as the highest fresh water at a given
    // distance from the sea: at most +1 to +3 out to 30 m, +5 to +7 by 40, +7 to +11 by 50 and flat after.
    const COAST_FLAT = 22, COAST_GRADE = 0.4;          // blocks of sea-level shelf, then blocks gained per block inland
    const LEVEL_DROP = 0.012;                          // the step taken off `level` when it becomes a surface, below
    const seaCap = j => 0.5 + LEVEL_DROP + (1 + Math.max(0, distO[j] * BPC - COAST_FLAT) * COAST_GRADE) * (1 / 120);
    const mouth = new Uint8Array(n);                   // cells the bound actually bit on — the body's outlets
    // The average is bounded by how much containment it may build. Vanilla can use the average outright
    // because its rims are near flat — cell noise with no local gradient — so `lakeElevation + 0.01` raises
    // a cell or two. On a sloped authored rim the average can sit many blocks over the low side, and holding
    // it there means walling the whole downhill arc. 4 blocks is the knee measured on a real 120-wide map:
    // it roughly doubles how much ground beyond the rim may sit below the water (11.6% -> 21.2% at 20 m,
    // against vanilla's 30-45%) and drops the banks ~0.9 blocks at every distance, while leaving water
    // spilling over its bank where it already was. Past ~6 it starts spilling; past ~8 the lake drowns its
    // own outlet and the banks become a trench.
    const BERM = 4 * (1 / 120);
    // The ring is the immediate bank and nothing else, so a course running along a slope takes a level its
    // uphill side justifies, the restore raises the downhill bank to hold it, and the ground beyond falls
    // away — water standing on an embankment, which reads in game as an aqueduct. Bound the level by the
    // AVERAGE HEIGHT OF THE SURROUNDING GROUND as well, so the water sits down in the landscape it crosses
    // rather than on top of it. The radius is ~19 m, the distance at which the perch is visible.
    const around = Float32Array.from(hf);
    boxBlurTor(around, res, Math.max(1, Math.round(res / 23)), 2);
    // The same average over LAND ONLY. `around` blurs the height field whole, and a water column's height
    // is its bed, so within a radius of any river the average reads several blocks below the ground
    // actually there. Anything that bounds a BANK has to compare it against land, not against the channel.
    const aroundLand = Float32Array.from(hf, (v, j) => land[j] === 1 ? v : 0);
    const landWeight = Float32Array.from(hf, (_, j) => land[j] === 1 ? 1 : 0);
    boxBlurTor(aroundLand, res, Math.max(1, Math.round(res / 23)), 2);
    boxBlurTor(landWeight, res, Math.max(1, Math.round(res / 23)), 2);
    for (let j = 0; j < n; j++) aroundLand[j] = landWeight[j] > 0.05 ? aroundLand[j] / landWeight[j] : around[j];
    const SETTLE_MARGIN = 4 * (1 / 120);
    const settle = (lvl, j) => { const v = Math.min(lvl, around[j] + SETTLE_MARGIN), c = seaCap(j); if (c >= v) return v; mouth[j] = 1; return c; };
    for (const j of lakeSet) {
      let sum = 0, cnt = 0, mn = Infinity;
      for (const nb of nbr4(j)) if (land[nb] === 1) { sum += hf[nb]; cnt++; if (hf[nb] < mn) mn = hf[nb]; }
      surf[j] = cnt ? settle(Math.min(sum / cnt, mn + BERM), j) : Infinity;
    }
    // A cell with no shore of its own (mid-lake) has no constraint; give it the body's ring average, bounded
    // the same way. This is what keeps a lake uniform now that nothing is min-propagated — and dropping that
    // propagation is the actual point: the level is now the local ring, not the lowest thing within ~54 m,
    // so ground beyond the rim is free to sit below the water the way vanilla's does.
    for (const cells of groups) {
      let sum = 0, cnt = 0, mn = Infinity;
      for (const j of cells) for (const nb of nbr4(j)) if (land[nb] === 1) { sum += hf[nb]; cnt++; if (hf[nb] < mn) mn = hf[nb]; }
      if (!cnt) continue;
      const ring = Math.min(sum / cnt, mn + BERM);
      for (const j of cells) if (!isFinite(surf[j])) surf[j] = settle(ring, j);
    }
    // Open water gets ONE surface per patch, however wide the lake, so the flood cannot ramp across a middle
    // it never reaches — in game that reads as a corrugated bed under otherwise flat water. This is what
    // keeps a lake level now that nothing is min-propagated. A drawn river is only a few cells across, so it
    // has no open water at all and is left alone, which is what keeps it descending rather than turning
    // into a level canal.
    const fromShore = new Int16Array(n).fill(-1);
    { const q = [];
      for (let j = 0; j < n; j++) if (!lakeSet.has(j)) { fromShore[j] = 0; q.push(j); }
      for (let h = 0; h < q.length; h++) { const c = q[h]; for (const nb of nbr4(c)) if (fromShore[nb] < 0) { fromShore[nb] = fromShore[c] + 1; q.push(nb); } } }
    const openPatches = [];
    {
      const open = []; for (const j of lakeSet) if (fromShore[j] >= OPEN_WATER) open.push(j);
      const seen = new Set();
      for (const s0 of open) {
        if (seen.has(s0)) continue;
        const stack = [s0], patch = []; seen.add(s0); let sum = 0;
        openPatches.push(patch);
        while (stack.length) {
          const c = stack.pop(); patch.push(c); sum += surf[c];
          for (const nb of nbr4(c)) if (fromShore[nb] >= OPEN_WATER && lakeSet.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
        }
        let pmn = Infinity, pcap = Infinity;
        for (const j of patch) { if (surf[j] < pmn) pmn = surf[j]; const c = seaCap(j); if (c < pcap) pcap = c; }
        // Bounded by the coast the same way a shore cell is, but by the TIGHTEST bound over the patch, so
        // open water keeps the single flat level the rest of the pass exists to give it.
        const lv = Math.min(sum / patch.length, pmn + BERM, pcap);             // the patch's average, bounded like the rest
        if (pcap <= lv) for (const j of patch) mouth[j] = 1;
        for (const j of patch) surf[j] = lv;
        // pull the surrounding shallows to it too, so the rim does not stand above the middle
        for (const j of patch) for (const nb of nbr4(j)) if (lakeSet.has(nb) && fromShore[nb] < OPEN_WATER && surf[nb] > lv) surf[nb] = lv;
      }
    }
    // Water sits in FLAT pools, in a valley it CARVES for itself.
    //
    // Pinning each cell's surface to its nearest bank (surf[] above) makes water follow the mountains it
    // was drawn across: one body then spans tens of blocks and Eco, which fills every column separately,
    // renders it as a jagged cascade. Pooling alone cannot fix that — the range is in the terrain, not in
    // the choice of levels. So relax the surface first, then carve the land to match.
    const MAX_WATER_STEP = 0.5 * BLK;     // biggest rise allowed between neighbouring water cells
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
      const inGroup = new Set(cells), done = new Set();
      const heap = [];                                                        // binary min-heap on assigned level
      const push = (k, v) => { heap.push([k, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
      // A body has as many mouths as it has places where the coast bound bites, not one. Flooding from the
      // single lowest cell makes the level non-decreasing along the CHANNEL from that one point, which is
      // why a course that runs back out to the coast 230 m downstream carries its inland level with it —
      // the bound on `surf` there is simply overwritten by the parent's. Seeding every such cell and always
      // expanding the lowest gives each cell the lowest level any mouth can justify, so the stretch beside
      // the sea descends into it and only the water between two mouths keeps the higher of them.
      const seed = j => { if (done.has(j)) return; done.add(j); level[j] = surfOf(j); push(level[j], j); };
      seed(start);
      for (const j of cells) if (mouth[j]) seed(j);
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
    // `aroundLand` is the blurred height of the LAND only; the bank shaping downstream wants it too,
    // and it is built here because this is where the radius is decided.
    // `aroundLand` (blurred height of the LAND only) and SETTLE_MARGIN belong to the bounds decided
    // here; the bank shaping downstream reuses both, so they come back rather than being recomputed.
    // The distance-to-sea envelope, kept so a caller can re-apply it. Levelling a lake afterwards takes the
    // body's DOMINANT level, which knows nothing about how near the sea it is, and that can lift a coastal
    // body back over the bound this pass put on it.
    //
    // Per CELL is the wrong shape to re-apply it in. The bound tightens toward the sea, so on a body that
    // has since been levelled it cuts a wedge off the seaward side and leaves the lake on two levels —
    // which is the defect the levelling exists to remove. Water that is levelled as one body takes ONE
    // bound: the tightest over that body, so the envelope lowers the lake whole or not at all.
    //
    // The body is a patch of open water and the shallows around it, out to the patch's own half-width —
    // as far from the middle as the middle is from the bank, which is the whole of a lake and only a local
    // disc of a river. A fixed reach instead leaves the far end of a wide lake's shelf on the per-cell
    // bound, and that is a step in the finished water surface just the same.
    const seaCapAt = new Float32Array(n);
    for (let j = 0; j < n; j++) seaCapAt[j] = seaCap(j);
    for (const patch of openPatches) {
      let reach = 0;
      for (const j of patch) if (fromShore[j] > reach) reach = fromShore[j];
      const group = patch.slice(), step = new Map();
      for (const j of patch) step.set(j, 0);
      for (let h = 0; h < group.length; h++) { const c = group[h];
        if (step.get(c) >= reach) continue;
        for (const nb of nbr4(c)) if (lakeSet.has(nb) && !step.has(nb)) { step.set(nb, step.get(c) + 1); group.push(nb); } }
      let cap = Infinity;
      for (const j of group) if (seaCapAt[j] < cap) cap = seaCapAt[j];
      for (const j of group) seaCapAt[j] = cap;
    }
    return { level: level, fromShore: fromShore, aroundLand: aroundLand, SETTLE_MARGIN: SETTLE_MARGIN, seaCapAt: seaCapAt };
  }

  // ---- water bed ------------------------------------------------------------------------------
      // Shelve the fresh water at its edges, the way the sea already is. A flat bed a fixed depth below the
      // surface puts a STEP at the shoreline: the bed is ~3.8 blocks down and the bank ~1.4 up, and Eco's
      // CliffExtruder builds a rock face wherever two columns differ by 5 or more. Measured on a generated
      // world, 52.9% of shoreline column pairs cleared that — a stone retaining wall around every lake and
      // river. Ramping the bed up to one block under the surface at the shore takes the step under the
      // threshold, and reads as a shallows rather than a tank.
      //
      // Away from the edges it DEEPENS, the way vanilla's does. One fixed depth makes every body the same 3.6
      // blocks however wide it is, so a lake reads as a puddle: measured on a real map, water 20 blocks from
      // the nearest shore was 3.6 blocks deep where vanilla's rule gives 18.4.
      //
      // Vanilla floods inward from the bank, adding `depthChange = 2` to the depth each ring
      // (VoronoiWorldGenerator, "floodfill to determine depth of water features"), starting at 1 and never
      // capping. Depth is in heightmap grays and Y = waterLevel + (gray/255*2-1)*(maxGen-waterLevel), so one
      // gray is 2*(maxGen-waterLevel)/255 — 0.47 blocks on a 60/120 world, which is what BLK already assumes.
      // Its rings are one block wide and ours are BPC, and its enclosure test is 8-neighbour, so the distance
      // it deepens by is CHEBYSHEV. Walking 4-neighbour here would run deeper than vanilla, not equal to it.
  function shelveWaterBed(res, n, land, wsurf, bed, BPC) {
    const nbr4 = j => { const x = j % res, y = (j / res) | 0; return [((x + 1) % res) + y * res, ((x + res - 1) % res) + y * res, x + ((y + 1) % res) * res, x + ((y + res - 1) % res) * res]; };
      const SHELF_CELLS = 3;                    // how far in the shallows reach
      const SHORE_DEPTH = 1.2 * BLK;            // depth right at the bank; below ~1.8 a shore cell can round to no water at all
      const GRAY = 0.4706 * BLK;                // one unit of vanilla's depth
      // Vanilla's rule deepens without limit, which is right for vanilla's channels — 6-12 m wide, so it
      // yields 3-6 blocks. Ours are 16-32 m wide by design, and the same rule yields 8-15: measured
      // against a real vanilla world, depth p50 3 / p90 9 / max 15 against its 2 / 4 / 11. Cap it, so a
      // wide river is a wide river rather than a canyon. The cap only ever binds in the middle; the shelf
      // still owns the shore, which is what the bank is measured against.
      //
      // But one cap for everything makes every LAKE 8 blocks too, and a stock world's are not: over seven
      // of them fresh water reaches 10-12 at p99 and 13-17 at worst, and their ~2,500-cell lakes run 11-14
      // deep where ours arrived at 8. A lake is wide in every direction, so vanilla's depth reads as a bed
      // there rather than as the gorge it would cut along a channel. Tell the two apart by SHAPE, the same
      // way Eco/Tools/WorldGenAnalysis/metrics/lakes.js does when it measures a generated world: a body
      // that fills a good part of its own bounding box is a lake, and a winding course never does however
      // long or wide it is drawn. A lake DRAINING into a river shares its body with the whole system and
      // so keeps the channel bed — the safe way to be wrong, and the same way lakes.js reads that case.
      const MAX_DEPTH = 8 * BLK;                // a channel's bed stops here, whatever vanilla's ramp says
      const LAKE_DEEPEN = 0.6;                  // of vanilla's remaining ramp, once a lake is past that
      const LAKE_MAX_DEPTH = 16 * BLK;          // and never past the deepest fresh water a stock world holds
      const LAKE_FILL = 0.35;                   // of the body's bounding box
      const LAKE_MIN_BLOCKS = 60;               // smallest body worth calling a lake, in world blocks of area
      const deepBed = new Uint8Array(n);
      {
        const seenB = new Uint8Array(n);
        // The map wraps, so a body's box is the shortest interval that still holds every cell — what is
        // left once the widest EMPTY run is taken out. Reading x0..x1 straight would hand a body lying
        // over the seam the whole world as its box, and demote it to a channel.
        const span = (cells, key) => {
          const used = new Uint8Array(res);
          for (const c of cells) used[key(c)] = 1;
          let gap = 0, run = 0;
          for (let k = 0; k < 2 * res; k++) { if (used[k % res]) run = 0; else if (++run > gap) gap = run; }
          return res - gap;
        };
        for (let j = 0; j < n; j++) {
          if (land[j] !== 2 || seenB[j]) continue;
          const st = [j], cells = []; seenB[j] = 1;
          while (st.length) { const c = st.pop(); cells.push(c); for (const nb of nbr4(c)) if (land[nb] === 2 && !seenB[nb]) { seenB[nb] = 1; st.push(nb); } }
          if (cells.length * BPC * BPC < LAKE_MIN_BLOCKS) continue;
          const box = span(cells, c => c % res) * span(cells, c => (c / res) | 0);
          if (cells.length / box < LAKE_FILL) continue;
          for (const c of cells) deepBed[c] = 1;
        }
      }
      const dIn = new Int32Array(n).fill(-1), qs = [];
      for (let j = 0; j < n; j++) if (land[j] !== 2) { dIn[j] = 0; qs.push(j); }
      for (let k = 0; k < qs.length; k++) {
        const c = qs[k], cx = c % res, cy = (c / res) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nb = ((cx + dx + res) % res) + ((cy + dy + res) % res) * res;
          if (dIn[nb] < 0 && land[nb] === 2) { dIn[nb] = dIn[c] + 1; qs.push(nb); }
        }
      }
      for (let j = 0; j < n; j++) {
        if (land[j] !== 2) continue;
        // The shelf still owns the first few cells — it is what holds the bed-to-bank step under
        // CliffExtruder's threshold, and vanilla is SHALLOWER than it at the bank (0.5 blocks against 1.8).
        // Past the point where vanilla's ramp overtakes the shelf, it takes over.
        const t = Math.min(1, Math.max(0, (dIn[j] - 1) / SHELF_CELLS));
        const s = t * t * (3 - 2 * t);
        const shelf = SHORE_DEPTH + (3.6 * BLK - SHORE_DEPTH) * s;
        const vanilla = Math.max(1, 2 * (dIn[j] - 0.5) * BPC - 1) * GRAY;
        // A lake carries on deepening past the cap rather than stopping dead at it. Stopping gives it a
        // flat plateau for a bed — on the real map p90 and p99 both landed exactly on the cap — where a
        // stock lake's bed peaks: p90 8-9 blocks under a max of 13-15.
        const want = Math.max(shelf, vanilla);
        const depth = deepBed[j] && want > MAX_DEPTH
          ? Math.min(LAKE_MAX_DEPTH, MAX_DEPTH + (want - MAX_DEPTH) * LAKE_DEEPEN)
          : Math.min(MAX_DEPTH, want);
        bed[j] = Math.max(0.03, wsurf[j] - depth);
      }
  }

  // ---- export columns -------------------------------------------------------------------------
  // Turn the land field, the bed and the water surface into the height byte the mod reads, with the two
  // rules a water column has to obey: never dug deeper than the shelf intended (quantisation is what
  // takes that depth away, not the shelf), and never left so far under its own bank that Eco's
  // CliffExtruder builds a rock face around the body. Shared by the import and the seeded path.
  function writeExportColumns(res, n, land, hf, bed, wsurf, water, height) {
    const nbr4 = j => { const x = j % res, y = (j / res) | 0; return [((x + 1) % res) + y * res, ((x + res - 1) % res) + y * res, x + ((y + 1) % res) * res, x + ((y + res - 1) % res) * res]; };
    const MIN_DEPTH = 2.1;                                     // blocks left in the shallowest column
    const WL = 60, RELIEF = 60, MAXGEN = 120;                  // the 60/120 world BLK already assumes
    // The shelf keeps the bed-to-bank step under CliffExtruder's 5 blocks by holding the shore shallow,
    // but it only ever compares the bed against its own surface. Where a bank is pinned high by a SECOND
    // body beside it — two arms of one course passing within a cell, the higher one holding the divider up
    // — the lower arm's own shelf knows nothing about it and the step clears the threshold anyway. Bound
    // the bed by the bank as well, keeping a block of water whatever happens.
    const BANK_STEP = 4;                                       // blocks of bed-to-bank the shelf may leave
    const bankAbove = new Float32Array(n).fill(-Infinity);
    for (let j = 0; j < n; j++) if (land[j] === 2) for (const nb of nbr4(j)) if (land[nb] !== 2 && hf[nb] > bankAbove[j]) bankAbove[j] = hf[nb];
    for (let j = 0; j < n; j++) {
      let h = land[j] === 2 ? bed[j] : (land[j] ? Math.max(0.505, hf[j]) : Math.min(hf[j], 0.495));
      height[j] = Math.max(0, Math.min(255, Math.round(h * 255)));
      if (land[j] === 2) {
        const wy = WL + Math.trunc(RELIEF * (water[j] / 255));                // what Eco will fill this column to
        // Never deeper than the shelf meant this column to be. The shelf holds the first cells at ~1.8
        // blocks on purpose — that is what keeps the bed-to-bank step under CliffExtruder's threshold —
        // so a flat floor applied everywhere digs exactly the columns that must not be dug. Restoring the
        // intended depth is enough: quantisation is what took it away, not the shelf.
        const want = Math.min(MIN_DEPTH, (wsurf[j] - bed[j]) * MAXGEN);
        height[j] = Math.max(0, Math.min(height[j], Math.floor(255 * (wy - want) / MAXGEN)));
        if (bankAbove[j] > -Infinity) {
          const floorY = Math.min(wy - 1, (2 * bankAbove[j] - 1) * 60 + 60 - BANK_STEP);
          height[j] = Math.max(height[j], Math.min(255, Math.ceil(255 * floorY / MAXGEN)));
        }
      }
    }
  }

  // ---- bank containment -----------------------------------------------------------------------
  // Two passes that keep the ground and the water it holds in a sane relationship, shared by the import and
  // the seeded path. Both take the land height field `hf` and the solved surface `wsurf`.

  // Cap the ring that touches water. Left free it binds into a flat-topped ledge of constant height
  // following the channel, which reads as masonry rather than ground; vanilla's first ring sits 0.3-0.45
  // blocks over its water.
  const BANK_CAP = 0.5 * BLK;
  function capBankLip(res, land, wsurf, hf) {
    const n = res * res;
    const nbr4 = j => { const x = j % res, y = (j / res) | 0; return [((x + 1) % res) + y * res, ((x + res - 1) % res) + y * res, x + ((y + 1) % res) * res, x + ((y + res - 1) % res) * res]; };
    for (let j = 0; j < n; j++) {
      if (land[j] !== 1) continue;
      let s = -Infinity;
      for (const nb of nbr4(j)) if (land[nb] === 2 && wsurf[nb] > s) s = wsurf[nb];
      if (s > -Infinity && hf[j] > s + BANK_CAP) hf[j] = s + BANK_CAP;
    }
  }

  // And the lower bound: any land touching water sits above it. Averaging across a shoreline drags the bank
  // down with the water, far enough in places to leave the bank UNDER what it is holding back, which reads
  // in game as a lake spilling over the terrain.
  const SHORE_LIP = 0.35 * BLK;
  function restoreShoreLip(res, land, wsurf, hf) {
    const n = res * res;
    const nbr4 = j => { const x = j % res, y = (j / res) | 0; return [((x + 1) % res) + y * res, ((x + res - 1) % res) + y * res, x + ((y + 1) % res) * res, x + ((y + res - 1) % res) * res]; };
    for (let j = 0; j < n; j++) {
      if (land[j] !== 1) continue;
      let need = -Infinity;
      for (const nb of nbr4(j)) if (land[nb] === 2 && wsurf[nb] > need) need = wsurf[nb];
      if (need > -Infinity && hf[j] < need + SHORE_LIP) hf[j] = need + SHORE_LIP;
    }
  }

  // ---- bank shaping ---------------------------------------------------------------------------
  // A river corridor is a VALLEY: the ground climbs away from the water and levels off a few blocks up.
  // Measured over five vanilla worlds it reaches 2.2-2.8 blocks and gets its third block within 7-8 m,
  // and on none of them does a bank stand over the ground behind it (0.2-0.5% of shore rays).
  //
  // One profile applied everywhere is still uniformity, and it renders as concentric shelving — every
  // bank climbing at the same steady rate for the same distance draws a contour line at each block.
  // Vanilla's AVERAGE profile is a smooth ramp, but ray by ray it is not: a fifth of its banks gain
  // nothing at all over 14 m, a seventh gain five blocks or more, and the climbing is over by ~8 m.
  // Averaging many such banks smears them into the ramp; imposing the ramp back onto every bank is what
  // built the terraces. So the shoulder height and the distance it takes are low-frequency FIELDS, read
  // at the water and carried inland with the distance transform, which is what keeps a stretch coherent:
  // a flat reach is flat for its whole depth and a steep one is steep for its whole depth. The floor is
  // not zero — a bank still has to clear the ring beside the water, or the ledge comes back.
  const VALLEY_SHOULDER_MIN = 0.6 * BLK, VALLEY_SHOULDER_MAX = 6 * BLK;
  const VALLEY_RISE_MIN = 3, VALLEY_RISE_MAX = 6;   // cells, ~2.7 world blocks each
  // Three blocks, not eight. The bluff allowance sits on TOP of a corridor that already rises, and at
  // eight the near-river ground averaged 5.8 blocks over the water where vanilla runs 2-3, and the extra
  // relief came out as evenly-spaced single-block risers (72% of them, against vanilla's 68-81%).
  const BLUFF_KEEP = 3 * BLK;                                  // how much bank a bluff stretch may keep
  const valleyAt = (d, sh, rs) => sh * Math.min(1, d / rs);
  function bankProfileFields(res, n, wsurf, aroundLand) {
    const vshF = new Float32Array(n), vrsF = new Float32Array(n), bluff = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const x = j % res, y = (j / res) | 0;
      // How far up a bank climbs is set by WHAT IS BEHIND IT, not by a constant. Split vanilla's shores by
      // how high the land 25-45 m back stands over the water, and its 14 m climb tracks it: where that land
      // is at or below the water it gains 0.9-1.4 blocks, at +3..4 it gains 2.5-2.7, at +7 and up 3.6-5.9.
      // A fixed shoulder cannot do that — it terraces the flat stretches to reach a height nothing behind
      // them justifies, and under-builds the steep ones. aroundLand is already the local land average, so
      // aim a fraction of the way up to it, with a low-frequency jitter so neighbouring reaches differ.
      const jit = 0.6 + 0.800 * (0.62 * vnR(x + 1301, y + 907, 17, res) + 0.38 * vnR(x + 613, y + 2207, 41, res));
      const up = (aroundLand[j] - wsurf[j]) * 0.2 * jit;
      vshF[j] = Math.max(VALLEY_SHOULDER_MIN, Math.min(VALLEY_SHOULDER_MAX, up));
      vrsF[j] = VALLEY_RISE_MIN + (VALLEY_RISE_MAX - VALLEY_RISE_MIN) * vnR(x + 4409, y + 1811, 23, res);
    }
    for (let j = 0; j < n; j++) {
      const v = 0.62 * vnR(j % res, (j / res) | 0, 22, res) + 0.38 * vnR(j % res, (j / res) | 0, 57, res);
      const t = Math.max(0, Math.min(1, (v - 0.26) / 0.30));
      bluff[j] = t * t * (3 - 2 * t);
    }
    return { vshF: vshF, vrsF: vrsF, bluff: bluff };
  }

  // Valley the banks — the port of VoronoiWorldGenerator's SMOOTH PASS 2, the block commented "form
  // valleys around rivers and lakes". Vanilla relaxes: several passes, each pulling near-water land a
  // fraction of the way to the water it can see. It never limits a slope; it drags the ground down and
  // lets the profile come out concave.
  //
  // What this replaced was a fixed-slope cone, and a cone is a ceiling rather than a valley — it PERMITTED
  // 3 blocks of rise per cell (18 blocks inside 16 m) and did nothing whatever past its reach, so a river
  // drawn across high ground kept a sheer wall. Measured on an authored 120-wide world, half of all
  // fresh-water shoreline rose 11.5 blocks within 20 m and a tenth rose 26.6; terraced, that is the
  // canyon players were standing in.
  //
  // Runs AFTER the per-cell flattening for the same reason vanilla runs it after per-polygon elevations
  // are set: flattening gives every cell one height, and would otherwise snap the carved bank back up.
  function valleyBanks(res, n, land, wsurf, hf, prof) {
    const nbr4 = j => { const x = j % res, y = (j / res) | 0; return [((x + 1) % res) + y * res, ((x + res - 1) % res) + y * res, x + ((y + 1) % res) * res, x + ((y + res - 1) % res) * res]; };
    const vshF = prof.vshF, vrsF = prof.vrsF, bluff = prof.bluff;
    // Tuned against measured vanilla, not copied from it. Vanilla's own constants (a fifth per pass over
    // ~3 Voronoi cells) put the MEDIAN on vanilla but leave the steep tail well above it — authored
    // rivers get drawn across high ground vanilla's river router would never route through, so the same
    // relaxation has more to undo. Reaching further and pulling slightly harder lands the tail exactly on
    // vanilla instead, which is the end that reads as a cliff. Height above sea within 20 m of a
    // fresh-water shoreline, against vanilla over 4 seeds at this world size:
    //                     median   p75    p90
    //   vanilla              9.2   13.4   18.6
    //   these constants      6.8   13.4   18.6   (at or below vanilla at every percentile)
    //   vanilla's constants  9.2   17.2   22.8
    const VALLEY_REACH = Math.max(3, Math.round(res / 27));   // ~45 world blocks on a 120-wide world
    // 0.45, not 0.25. At 0.25 the ground climbs steadily away from the water — 2.3 blocks up at 6 m and
    // 4.2 at 20 m on a real map — where vanilla's sits at 0.7-1.1 the whole way out to 40 m. A steady
    // climb on both sides is what makes a channel read as a trench cut through a plateau, or an aqueduct
    // where the far side then falls away. At 0.45 the same map reads 0.9 at 6 m and 2.5 at 20 m.
    //
    // It does not cost the drama, which was the worry: the worst rise within 20 m keeps a median of 6.4
    // and a p90 of 13.9, against vanilla's 6.8-7.8 and 11.5-19.5. Pulling harder than this needs a
    // shorter reach to compensate, and the two together overshoot — at 0.65 with reach res/60 the p90
    // goes to 27.
    const VALLEY_PASSES = 4, VALLEY_PULL = 0.45;              // shore keeps (1-pull)^passes of its height
    const dw = new Int32Array(n).fill(-1), near = new Float32Array(n), q = [];
    const nsh = new Float32Array(n), nrs = new Float32Array(n);
    for (let j = 0; j < n; j++) if (land[j] === 2) { dw[j] = 0; near[j] = wsurf[j]; nsh[j] = vshF[j]; nrs[j] = vrsF[j]; q.push(j); }
    for (let k = 0; k < q.length; k++) {
      const c = q[k];
      if (dw[c] >= VALLEY_REACH) continue;
      for (const nb of nbr4(c)) if (dw[nb] < 0 && land[nb] === 1) { dw[nb] = dw[c] + 1; near[nb] = near[c]; nsh[nb] = nsh[c]; nrs[nb] = nrs[c]; q.push(nb); }
    }
    // Vanilla widens its window a step per pass; at import resolution those steps land as visible bands,
    // so the pull falls off smoothly with distance instead — same concave profile, no rings.
    for (let p = 0; p < VALLEY_PASSES; p++) {
      for (let j = 0; j < n; j++) {
        if (land[j] !== 1 || dw[j] < 1) continue;
        const s = 1 - dw[j] / VALLEY_REACH;
        if (s <= 0) continue;
        // The bluff only spares ground from being pulled DOWN. Sparing it from the lift as well would
        // leave the low side of a course at its full depth, which is the embankment the lift removes.
        const ease = s * s * (3 - 2 * s);
        const aim = near[j] + valleyAt(dw[j], nsh[j], nrs[j]); // this stretch's shoulder, not the water line
        if (hf[j] > aim) {
          const t = hf[j] + (aim - hf[j]) * VALLEY_PULL * (1 - 0.9 * bluff[j]) * ease;
          hf[j] = Math.max(t, near[j] + BLK);                  // pull high ground DOWN, never under the water
        }
        // and pull LOW ground up, to the same shoulder. It used to stop a fifth of a block UNDER the
        // water so that the ground beyond a bank could still lie below the water line, and that is what
        // the ledge was made of: the mod holds the ring beside the water at the surface, so a corridor
        // sitting just under it steps up at the bank and never climbs again. Measured on the rays that
        // stood proud, the ground behind the crest averaged 0.34 blocks over the water and stayed there
        // for the whole 16 m — the water was perched and the bank was what held it in.
        else if (hf[j] < aim) {
          const t = hf[j] + (aim - hf[j]) * VALLEY_PULL * ease;
          hf[j] = Math.min(t, aim);
        }
      }
    }
  }

  // The first few metres of LAND have to stay near the water too. Capping only the ring that touches it
  // leaves the ground behind free to climb, and read out of a real save that is what the bank actually is:
  // the highest ground within 3 m of our shores is 2 blocks over the water at p50 where vanilla's is 1.
  // A rim 2 blocks high for the length of a river is what reads as a wall from the water.
  function capShoreBand(res, n, land, wsurf, hf, prof, aroundLand, SETTLE_MARGIN) {
    const nbr4 = j => { const x = j % res, y = (j / res) | 0; return [((x + 1) % res) + y * res, ((x + res - 1) % res) + y * res, x + ((y + 1) % res) * res, x + ((y + res - 1) % res) * res]; };
    const vshF = prof.vshF, vrsF = prof.vrsF, bluff = prof.bluff;
    const SHORE_REACH = Math.max(3, Math.round(res / 40));
    const SHORE_RISE = 0.2 * BLK;
    // A bluff climbs in about a cell and a half, and it starts a cell BACK from the water rather than at
    // it. Rising straight off the waterline puts the whole riser in the first 4 m, where vanilla has
    // almost none (1.5% of columns step 3+ blocks); starting it back moves the riser to 3-7 m, which is
    // where vanilla's is (3.2% and 2.4%). SETBACK is its own low-frequency field so the risers do not all
    // land at one distance from the bank — that would be the uniform kerb again, one step out.
    const BLUFF_REACH = Math.max(2, res / 140), BLUFF_SETBACK = 0.9, SETBACK_VARY = 1.5;
    // The plain bank needs a metre or two of its own: the bluff field is nearly binary, so without this
    // every stretch that is not a cliff comes out the same height and the shoreline reads flat.
    const BANK_VARY = 1 * BLK, BANK_REACH = 2;
    // A cap that stops dead at SHORE_REACH leaves the natural ground to resume, which puts a ring of
    // risers ~30 m out around every course — the causeway. This lets it climb to meet that ground.
    const OUTER_RISE = 8 * BLK, OUTER_POW = 6;
    const setback = new Float32Array(n), bankv = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const x = j % res, y = (j / res) | 0;
      setback[j] = vnR(x, y + 5501, 34, res);
      bankv[j]   = 0.6 * vnR(x + 911, y + 377, 70, res) + 0.4 * vnR(x + 177, y + 733, 161, res);
    }
    const dl = new Int32Array(n).fill(-1), sw = new Float32Array(n), q = [];
    const csh = new Float32Array(n), crs = new Float32Array(n);
    for (let j = 0; j < n; j++) if (land[j] === 2) { dl[j] = 0; sw[j] = wsurf[j]; csh[j] = vshF[j]; crs[j] = vrsF[j]; q.push(j); }
    for (let k = 0; k < q.length; k++) {
      const c = q[k]; if (dl[c] >= SHORE_REACH) continue;
      for (const nb of nbr4(c)) if (dl[nb] < 0 && land[nb] === 1) { dl[nb] = dl[c] + 1; sw[nb] = sw[c]; csh[nb] = csh[c]; crs[nb] = crs[c]; q.push(nb); }
    }
    for (let j = 0; j < n; j++) {
      if (land[j] !== 1 || dl[j] < 1) continue;
      const t = dl[j] / SHORE_REACH;                          // the cap opens out with distance
      const off = BLUFF_SETBACK + SETBACK_VARY * (setback[j] - 0.5);
      const b = Math.max(0, Math.min(1, (dl[j] - off) / BLUFF_REACH));
      // A bluff is ground the water cut into, so it can only stand where the land around it already
      // stands. Bounding by the neighbourhood average keeps it from becoming a levee — a bank higher
      // than everything behind it, which is the aqueduct the berm and the settle exist to prevent.
      const cap = Math.max(sw[j] + SHORE_LIP,
                           Math.min(sw[j] + SHORE_RISE * (0.5 + 1.5 * t * t) + valleyAt(dl[j], csh[j], crs[j]) + OUTER_RISE * Math.pow(t, OUTER_POW)
                                    + BANK_VARY * bankv[j] * Math.min(1, dl[j] / BANK_REACH)
                                    + BLUFF_KEEP * bluff[j] * b * b * (3 - 2 * b), aroundLand[j] + SETTLE_MARGIN));
      if (hf[j] > cap) hf[j] = cap;
    }
  }

  function solveWaterSurface(res, land, wsurf, fromShore) {
    const n = res * res;
    const nbr4 = j => { const x = j % res, y = (j / res) | 0; return [((x + 1) % res) + y * res, ((x + res - 1) % res) + y * res, x + ((y + 1) % res) * res, x + ((y + res - 1) % res) * res]; };
    // Knock isolated spikes out of the water surface. The priority flood lets a cell in open water take its
    // own level outright — which is what stops a lake tilting — but where the bank estimate under one cell
    // spikes, that cell alone ends up metres above the water on every side. In game that is a lump of bed
    // with a puddle on top of it, standing mid-channel, and it is what "blocks poking out with more water
    // above them" turns out to be. A cell higher than ALL of its water neighbours is never a waterfall —
    // those are higher than some and lower than others — so it can be dropped to its highest neighbour
    // without flattening a real descent. Measured on a generated world this cleared all 5 such cells (worst
    // 7.1 blocks proud) while water pairs stepping a block or more only went 0.73% -> 0.59%.
    {
      const SPIKE = 2 * BLK;
      for (let pass = 0; pass < 4; pass++) {
        const next = Float32Array.from(wsurf);
        for (let j = 0; j < n; j++) {
          if (land[j] !== 2) continue;
          let mx = -Infinity;
          for (const nb of nbr4(j)) if (land[nb] === 2 && wsurf[nb] > mx) mx = wsurf[nb];
          if (mx > -Infinity && wsurf[j] - mx >= SPIKE) next[j] = mx;
        }
        wsurf.set(next);
      }
      // Level the surface ACROSS the channel.
      //
      // Every cell takes its level from its own bank, so a course drawn across a hillside gets one from the
      // uphill side and a lower one from the downhill side, and the difference survives everything above:
      // the flood only stops a cell sitting BELOW the water that reached it, and a 4-neighbour average
      // shrinks a cross-channel slope and a descent alike. Measured on a real world, the surface still
      // carried ~0.6 blocks of slope across a 6-cell channel, which rounds to one bank of the river sitting
      // a block over the other for 30 m at a time — 7.6% of all fresh water touched such a split, against
      // vanilla's 0.7-3.0, while steps down the flow were already in band at 0.4% (vanilla 0.2-0.6).
      //
      // Water has no cross-stream slope, so take it out directionally: weight each neighbour by how far it
      // lies ACROSS the flow and average. The axis is the structure tensor of the water mask — its major
      // eigenvector is the across-channel normal — and the weight is (direction . normal)^2, which is 1 for
      // a neighbour straight across and 0 for one straight along. Repeated, that levels every cross-section
      // and leaves the profile down the channel alone. Eight neighbours, not four: a channel drawn at 45
      // degrees has its across direction on a diagonal, and a 4-neighbour stencil can only offer it two
      // axes that are equally across and equally along, so it would smooth the descent as hard as the slope.
      {
        const mask = new Float32Array(n);
        for (let j = 0; j < n; j++) mask[j] = land[j] === 2 ? 1 : 0;
        boxBlurTor(mask, res, 2, 1);
        const gx = new Float32Array(n), gy = new Float32Array(n);
        for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
          const j = y * res + x;
          gx[j] = (mask[((x + 1) % res) + y * res] - mask[((x + res - 1) % res) + y * res]) / 2;
          gy[j] = (mask[x + ((y + 1) % res) * res] - mask[x + ((y + res - 1) % res) * res]) / 2;
        }
        const Jxx = Float32Array.from(gx, v => v * v), Jyy = Float32Array.from(gy, v => v * v);
        const Jxy = Float32Array.from(gx, (v, j) => v * gy[j]);
        boxBlurTor(Jxx, res, 4, 1); boxBlurTor(Jyy, res, 4, 1); boxBlurTor(Jxy, res, 4, 1);
        const DIR = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
        const idx = new Int32Array(n * 8), wt = new Float32Array(n * 8);
        const ACROSS_POW = 6;         // exponent on (direction . normal)^2 — 6 gives a twelfth power of the cosine
        const CLEAN_AXIS = 0.4;       // coherence below this is a junction or open water, and has no axis to use
        for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
          const j = y * res + x;
          for (let k = 0; k < 8; k++) idx[j * 8 + k] = ((x + DIR[k][0] + res) % res) + ((y + DIR[k][1] + res) % res) * res;
          if (land[j] !== 2) continue;
          const a = Jxx[j], b = Jxy[j], c = Jyy[j], tr = a + c;
          const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - (a * c - b * b)));
          let nx = b, ny = l1 - a; const nn = Math.hypot(nx, ny);
          const coh = tr > 1e-12 ? (2 * l1 - tr) / tr : 0;      // 1 = a clean channel, 0 = open water or a junction
          // No axis — a junction, or water wide enough to have no channel direction at all. There is no
          // cross-section to level here, and the isotropic average this used to fall back on is exactly the
          // thing that flattens a descent, so leave the cell alone and let its neighbours pull it.
          if (nn < 1e-12 || coh < CLEAN_AXIS) continue;
          nx /= nn; ny /= nn;
          // The weight has to fall away FAST. A squared cosine still passes half of a neighbour lying at 45
          // degrees to the flow, and half the displacement of that neighbour is along the channel, so over
          // enough passes the profile down the river is smoothed as well as the slope across it. Measured on
          // a real world, the squared form took the descent from 52 blocks of fall over all bodies to 19 and
          // the share of water on a step down the flow from 0.52% to 0.07% — the waterfalls went with the
          // defect. A twelfth power leaves 0.02% of a 45-degree neighbour's weight, and at the SAME
          // cross-channel result it keeps 43 blocks of fall and 0.39%, which is where vanilla sits.
          let s = 0;
          for (let k = 0; k < 8; k++) {
            const L = Math.hypot(DIR[k][0], DIR[k][1]), d = (DIR[k][0] * nx + DIR[k][1] * ny) / L;
            wt[j * 8 + k] = Math.pow(d * d, ACROSS_POW) / L; s += wt[j * 8 + k];
          }
          for (let k = 0; k < 8; k++) wt[j * 8 + k] /= s;       // one block of transport per pass, whatever the axis
        }
        // Diffusion proper, u += TAU * sum_k w_k (u_nb - u), with each pair weighted by the MEAN of the two
        // cells' weights. That makes the operator symmetric, so a cross-section keeps its own mean level
        // instead of drifting toward whichever of its cells has the most water neighbours; TAU 0.5 damps the
        // checkerboard mode the plain replace-by-weighted-mean form leaves untouched.
        //
        // 60 passes takes the cross-channel slope out of a channel up to ~8 cells wide. Measured on a real
        // world, water sitting on a lengthwise split went 7.5% -> 2.1% (vanilla 0.70-3.03 over seven seeds).
        //
        // Levelling lifts the low side of a section as much as it drops the high side, and on ground steep
        // enough for the two banks to differ by several blocks that means walking the water up the hill.
        // Cap the lift: past ~2.5 blocks the section is not a channel across a slope any more, and the
        // levelling has nothing useful to say about it.
        const CROSS_PASSES = 60, TAU = 0.5, RAISE_CAP = 2.5 * BLK;
        const was = Float32Array.from(wsurf);
        for (let pass = 0; pass < CROSS_PASSES; pass++) {
          const next = Float32Array.from(wsurf);
          for (let j = 0; j < n; j++) {
            // Open water is one level per patch already; averaging across its edge would tilt it.
            if (land[j] !== 2 || fromShore[j] >= OPEN_WATER) continue;
            let acc = 0;
            for (let k = 0; k < 8; k++) {
              const nb = idx[j * 8 + k]; if (land[nb] !== 2) continue;
              acc += (wt[j * 8 + k] + wt[nb * 8 + k]) / 2 * (wsurf[nb] - wsurf[j]);
            }
            next[j] = wsurf[j] + TAU * acc;
          }
          wsurf.set(next);
        }
        for (let j = 0; j < n; j++) if (land[j] === 2 && wsurf[j] > was[j] + RAISE_CAP) wsurf[j] = was[j] + RAISE_CAP;
      }
      // Neighbouring water columns that disagree by a FRACTION of a block still render as a step, because
      // Eco fills each column separately and rounds. Taking each cell's level from its own four neighbours
      // leaves exactly that disagreement across a channel, and a channel is only a few cells wide, so the
      // step runs ALONG the bank instead of down the river — a waterfall the length of the shoreline, which
      // is what the level-from-the-ring change introduced. Average the surface along the water to take it
      // out. Measured on a real map, the bank ring went from 6.4% of its pairs stepping a block, to 41.5%
      // with the ring average, to 6.1% here; over the whole surface it is 11.9%, against vanilla's 11-13.5%.
      {
        for (let pass = 0; pass < 3; pass++) {
          const next = Float32Array.from(wsurf);
          for (let j = 0; j < n; j++) {
            // Open water is already one level per patch and must stay exactly that — averaging across its
            // edge tilts the whole surface, which is the ridged bed under flat water all over again. It
            // still feeds the average of the shore cells beside it, as a fixed value.
            if (land[j] !== 2 || fromShore[j] >= OPEN_WATER) continue;
            let sum = wsurf[j], cnt = 1;
            for (const nb of nbr4(j)) if (land[nb] === 2) { sum += wsurf[nb]; cnt++; }
            next[j] = sum / cnt;
          }
          wsurf.set(next);
        }
      }
      // One level per LAKE.
      //
      // A lake has no flow direction, so it has no reason to hold more than one surface level, and
      // vanilla's never does: VoronoiWorldGenerator gives every cell of a lake polygon a single elevation.
      // Everything above works cell by cell instead, so a lake drawn across a slope keeps a low shore on
      // its downhill side — measured on a generated world one 894-column lake arrived over four levels,
      // with the water running over the step between them. The cross-channel levelling cannot reach it:
      // the middle of a lake has no edge in the water mask, so its structure tensor has no coherence and
      // every cell of it is skipped, which leaves the shallow ring taking its level from its own bank.
      //
      // A lake is a piece of water no LONGER than it is wide: the longest way across it, in cells, against
      // its own width. That is a ratio, so it does not care how big the body is or which way it lies, and
      // it is what keeps a wide slow river out — widening a channel raises both terms, lengthening it only
      // the first. The area of a bounding box, the obvious alternative, cannot tell a lake from a straight
      // reach of a wide river at all. Measured on the shipping map its lakes read 1.2-2.8, a drawn stream
      // 5-6 and its two river systems 36.
      {
        const LAKE_SLIM = 4;
        const lake = new Uint8Array(n);
        const slimOf = inS => {                       // longest way across a set of cells / its width
          let wide = 0, seed = -1;
          for (const c of inS) { if (fromShore[c] > wide) wide = fromShore[c]; if (seed < 0) seed = c; }
          const far = s => { const d = new Map([[s, 0]]); const q = [s]; let best = s;
            for (let h = 0; h < q.length; h++) for (const nb of nbr4(q[h])) if (inS.has(nb) && !d.has(nb)) { d.set(nb, d.get(q[h]) + 1); q.push(nb); best = nb; }
            return [best, d.get(best)]; };
          const [a] = far(seed); const [, diam] = far(a);
          return [diam, wide];
        };
        // A whole body first, which is what a lake usually is.
        const seenB = new Uint8Array(n), bodies = [];
        for (let j = 0; j < n; j++) {
          if (land[j] !== 2 || seenB[j]) continue;
          const st = [j]; seenB[j] = 1; const inB = new Set([j]);
          while (st.length) { const c = st.pop(); for (const nb of nbr4(c)) if (land[nb] === 2 && !seenB[nb]) { seenB[nb] = 1; inB.add(nb); st.push(nb); } }
          const [diam, wide] = slimOf(inB);
          if (diam <= LAKE_SLIM * Math.max(1, 2 * wide - 1)) { for (const c of inB) lake[c] = 1; } else bodies.push(inB);
        }
        // A lake drawn ONTO a river system shares its body with the whole system, and both test designs do
        // exactly that, so the body test alone would never see one. In a body that is not itself a lake,
        // look for a compact patch of OPEN water instead and take the shallow ring around it with it — the
        // ring is the part that carries the low shore.
        const core = j => land[j] === 2 && fromShore[j] >= OPEN_WATER;
        for (const inB of bodies) {
          const seenC = new Set();
          for (const j of inB) {
            if (!core(j) || seenC.has(j)) continue;
            const st = [j]; seenC.add(j); const inP = new Set([j]);
            while (st.length) { const c = st.pop(); for (const nb of nbr4(c)) if (core(nb) && !seenC.has(nb)) { seenC.add(nb); inP.add(nb); st.push(nb); } }
            const [diam, wide] = slimOf(inP);
            if (wide <= OPEN_WATER) continue;                        // one cell thick: a pinch in a channel, not a lake
            if (diam > LAKE_SLIM * (2 * (wide - OPEN_WATER) + 1)) continue;    // a reach, and it descends
            for (const c of inP) lake[c] = 1;
          }
        }
        // The ring goes with it. A ring cell is one that lies on the way from the open water out to the
        // bank, so its steps from the core plus its own distance to the shore still come to OPEN_WATER; a
        // channel leaving the lake fails that within a cell of the mouth however shallow it is, and so
        // keeps its own descent. Without the test the ring simply grew four cells down the outflow and
        // turned a five-block taper into a waterfall.
        { const q = [], d = new Int32Array(n).fill(-1);
          for (let j = 0; j < n; j++) if (lake[j]) { d[j] = 0; q.push(j); }
          for (let h = 0; h < q.length; h++) { const c = q[h];
            for (const nb of nbr4(c)) if (land[nb] === 2 && d[nb] < 0 && d[c] + 1 + fromShore[nb] <= OPEN_WATER) { d[nb] = d[c] + 1; lake[nb] = 1; q.push(nb); } } }
        // And the mouth is not the lake. Lifting the last cell before an outflow lifts the bank beside it,
        // while the outflow's bed a cell away is already lower, so the pair clears Eco's 5-block cliff
        // threshold and a rock wall is built across the outlet — measured on verify-water's design, a
        // 9-block one. Stand the ring off from any water the lake has not claimed, by the width of the
        // ring itself. Where a lake is its own body there is no such water and this does nothing.
        for (let p = 0; p < OPEN_WATER - 1; p++) {
          const drop = [];
          for (let j = 0; j < n; j++) if (lake[j] && fromShore[j] < OPEN_WATER)
            for (const nb of nbr4(j)) if (land[nb] === 2 && !lake[nb]) { drop.push(j); break; }
          if (!drop.length) break;
          for (const j of drop) lake[j] = 0;
        }
        const seenL = new Uint8Array(n);
        for (let j = 0; j < n; j++) {
          if (!lake[j] || seenL[j]) continue;
          const st = [j]; seenL[j] = 1; const cells = [];
          while (st.length) { const c = st.pop(); cells.push(c); for (const nb of nbr4(c)) if (lake[nb] && !seenL[nb]) { seenL[nb] = 1; st.push(nb); } }
          // Which level: the lake's DOMINANT one — the mean over the cells of whichever block level already
          // holds most of its area. Raising a lake lifts the bank beside it and lowering it drains the
          // shallow ring, so the level that moves the fewest cells costs least of either. Measured on a
          // generated world against the alternatives: the dominant level took banks standing proud from
          // 1.01% to 0.51% and the water from 23,446 columns to 23,466, the MEAN left the banks where they
          // were (1.02%), and the MINIMUM cost 3,639 columns — 15.5% of the fresh water — for 1.14%.
          let lv = 0, bn = -1;
          const bucket = new Map();
          for (const c of cells) { const k = Math.trunc(120 * wsurf[c] - 60); const b = bucket.get(k) || [0, 0]; b[0]++; b[1] += wsurf[c]; bucket.set(k, b); }
          for (const [, b] of bucket) if (b[0] > bn) { bn = b[0]; lv = b[1] / b[0]; }
          for (const c of cells) wsurf[c] = lv;
        }
      }
    }
    return wsurf;
  }

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
  // Resample the ORIGINAL imported image at `res` (well above the G² paint grid) and produce aligned biome
  // + height maps, so a photo/portrait exports with far sharper features. Uses the current legend + mode;
  // height follows the picture (dark/low = deep water, light/high = land) so the land/water outline stays
  // crisp and matched to the biome tint.
  function imageToMaps(res, blocksPerCell) {
    const BPC = blocksPerCell || 1200 / res;      // a 120-wide world unless told otherwise
    const c = document.createElement('canvas'); c.width = res; c.height = res;
    // Nearest-neighbour upscale for colour (biome) maps so discrete biome colours stay pure — interpolation
    // would blend e.g. blue+white into a false "Grassland/Coast" ring around lakes. Photos use smoothing.
    const cx = c.getContext('2d'); cx.imageSmoothingEnabled = (importMode === 'brightness'); cx.drawImage(importedImg, 0, 0, res, res);
    const d = cx.getImageData(0, 0, res, res).data, n = res * res;
    const biome = new Uint8Array(n), height = new Uint8Array(n);
    const hf = new Float32Array(n), land = new Uint8Array(n);   // base height + land mask, in FINAL orientation
    const fresh = new Uint8Array(n);                            // 1 where the source used the fresh-water colour
    // Only the SEA keeps a height from the decode — the shelf below ramps up from this bed. Every land
    // cell is redrawn by the ridged/coast-distance field further down, so all the colour decode owes a
    // land cell is which side of the waterline it is on. (Brightness needs its own value regardless: for
    // a photo the tone IS the land/water test.) There used to be a per-biome base height here, compressed
    // toward a common mean so biome edges were not cliffs; the biome nudge in the elevation field does
    // that job now, off a spatially blurred target, and this one never survived to be read.
    const SEA_BED = 0.30, SEA = 0.5;
    const put = (x, y, cls, h01, isLand) => { const j = (res - 1 - y) * res + x; biome[j] = cls; hf[j] = h01; land[j] = isLand ? 1 : 0; };   // flip Y like the paint-grid path
    if (importMode === 'brightness') {
      const lum = new Float32Array(n), trans = new Uint8Array(n), op = [];
      for (let i = 0; i < n; i++) { const o = i * 4; if (d[o + 3] < 128) { trans[i] = 1; continue; } const L = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; lum[i] = L; op.push(L); }
      op.sort((a, b) => a - b); const N = op.length || 1, nB = legend.length;
      const rank = L => { let lo = 0, hi = op.length; while (lo < hi) { const m = (lo + hi) >> 1; if (op[m] < L) lo = m + 1; else hi = m; } return lo; };
      for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
        const i = y * res + x;
        if (trans[i]) { put(x, y, SC.Ocean, SEA_BED, 0); continue; }
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
        put(x, y, cls, SEA_BED, isOcean ? 0 : 1);
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
    // Distance to the sea, EUCLIDEAN. A 4-neighbour flood measures Manhattan distance, whose contours are
    // diamonds — long straight 45-degree lines. Since this field multiplies the relief, those diamonds get
    // printed onto every slope as ruled terrace edges, which is not something vanilla does. Chamfer sweeps
    // (1 orthogonal, sqrt2 diagonal) approximate the true distance closely enough that the contours curve.
    const distO = new Float32Array(n).fill(Infinity);
    { const D = Math.SQRT2, wrap = v => ((v % res) + res) % res;
      for (let i = 0; i < n; i++) if (isSea[i]) distO[i] = 0;
      const at = (x, y) => distO[wrap(y) * res + wrap(x)];
      for (let pass = 0; pass < 4; pass++) {                                     // repeated, so it wraps toroidally
        for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
          const i = y * res + x;
          let d = distO[i];
          const c = Math.min(at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + D, at(x + 1, y - 1) + D);
          if (c < d) distO[i] = c;
        }
        for (let y = res - 1; y >= 0; y--) for (let x = res - 1; x >= 0; x--) {
          const i = y * res + x;
          let d = distO[i];
          const c = Math.min(at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + D, at(x - 1, y + 1) + D);
          if (c < d) distO[i] = c;
        }
      }
      for (let i = 0; i < n; i++) if (!isFinite(distO[i])) distO[i] = res;        // land with no sea at all
    }
    const OCEAN_DIST = 0.13 * res, EPOW = 1.8;                                    // reach full height ~13% inland -> steeper coasts
    const aboveMid = cls => { const b = ECO_BIOME_ELEV[CN[cls]] || [0.52, 0.62]; return Math.max(0, ((b[0] + b[1]) / 2 - 0.5) * 2); };   // biome target elevation above sea, [0,1]
    const tgt = new Float32Array(n); for (let j = 0; j < n; j++) tgt[j] = land[j] === 1 ? aboveMid(biome[j]) : 0;
    boxBlurTor(tgt, res, Math.max(3, Math.round(res / 27)), 2);                   // smooth the biome nudge so borders ramp, not step
    // Ridged multifractal in [0,1]. Vanilla's elevation is drawn once per Voronoi cell — chunky patches
    // tens of blocks across — so its terraces come out wide. Piling on high octaves here gives detail finer
    // than a terrace band, which just makes the height cross a band every block or two: a dense corduroy
    // instead of broad benches. RIDGE_FREQ/RIDGE_OCTAVES set how coarse those patches are.
    const RIDGE_FREQ = 6;   // coarser than it was (9): finer than a terrace band just makes corduroy
    const RIDGE_OCTAVES = 5;
    const RIDGE_FALLOFF = 0.55;
    const FINE_AMP = 0.06;
    // Domain warp before sampling. vnR is value noise on an axis-aligned lattice, so its contours like to
    // line up with the grid and come out as long ruled edges once terraced — vanilla's gradient noise does
    // not do that. Displacing the sample point by a slow noise field bends those contours off the lattice.
    const WARP_AMP = 18;
    const WARP_FREQ = 3;
    const warpX = (x, y) => x + (vnR(x, y, WARP_FREQ, res) - 0.5) * 2 * WARP_AMP;
    const warpY = (x, y) => y + (vnR(x + 137.5, y + 91.3, WARP_FREQ, res) - 0.5) * 2 * WARP_AMP;
    const ridged = (x0, y0) => { const x = warpX(x0, y0), y = warpY(x0, y0); let s = 0, amp = 1, fr = RIDGE_FREQ, norm = 0; for (let o = 0; o < RIDGE_OCTAVES; o++) { const nz = vnR(x, y, fr, res); s += amp * (1 - Math.abs(2 * nz - 1)); norm += amp; amp *= RIDGE_FALLOFF; fr *= 2; } return s / norm; };
    const DIST_WOBBLE = 12;     // cells the coast-distance ramp wanders, so its contours are not clean offsets
    const MAXH = 1.35;
    const ceil = new Float32Array(n);                                            // coastal ceiling, reused by the peak pass                                                           // interior peaks reach near the world's max height
    for (let j = 0; j < n; j++) {
      if (land[j] !== 1) continue;
      const x = j % res, y = (j / res) | 0;
      // Wobble the coast distance by a fixed number of CELLS before using it. Straight terrace lines all
      // live inside this ramp (measured: 100% of the long ones) and mostly run parallel to the shore,
      // because a clean distance field's contours are exact parallel offsets of the coastline. Vanilla
      // avoids it by counting distance in hops across irregular Voronoi cells. The offset has to be
      // ADDITIVE: scaling the distance instead leaves almost no wobble close inshore, which is exactly
      // where the lines bunch up and where it needs to bite most.
      const wob = ((vnR(x, y, 7, res) * 0.6 + vnR(x, y, 17, res) * 0.4) - 0.5) * 2 * DIST_WOBBLE;
      const nd = Math.min(1, Math.max(0, distO[j] + wob) / OCEAN_DIST);
      const maxE = Math.pow(nd, EPOW); ceil[j] = maxE;                                            // ocean-distance ceiling: coasts stay low (beaches), interiors rise
      const relief = (0.10 + 0.90 * Math.pow(ridged(x, y), 1.3)) * MAXH;          // sharper, taller ridged mountain ranges (deep valleys -> high peaks)
      // Sample the biome-height target along the WARPED position, not this cell's own. A drawn biome edge
      // is usually a clean line — often dead straight — and reading the target straight off it lays that
      // same line into the terrain, where terracing turns it into ruled edges running parallel to the
      // border. Vanilla never shows this because its biome edges follow Voronoi cells. The biome map itself
      // is untouched; only where the height TRANSITION happens gets bent.
      const wj = (((Math.round(warpY(x, y)) % res) + res) % res) * res + (((Math.round(warpX(x, y)) % res) + res) % res);
      const nudge = (tgt[wj] - 0.25) * 0.40;                                      // high-elevation biomes trend higher
      // SHAPE the relief by the coastal ceiling rather than clipping to it. Clipping (min) threw away the
      // noise wherever the ceiling was the lower of the two — on this design that was 78% of all land — and
      // left height as a pure function of distance-to-sea, whose contours are evenly spaced bands marching
      // up the slope. That is the machine-made staircase. Multiplying keeps the ridged detail everywhere
      // and still holds the coast down, because the ceiling is 1 inland and only bites near the shore.
      const above = Math.max(0.02, (relief + nudge + (vnR(x, y, 24, res) - 0.5) * FINE_AMP) * maxE);
      hf[j] = 0.5 + above * 0.5;                                                  // designer frac (0.5 = sea)
    }
    // Vanilla's relief stops growing with distance past about 64 blocks: measured inland on seven stock
    // worlds, the mean rise over 64 and over 128 blocks are the same to within a block. This field kept
    // growing (6.1 then 10.2), because the coast-distance ramp and the coarsest ridged octave both add a
    // slow rise from every shore towards the interior. Terracing draws that as rings around the middle of
    // the landmass, and it puts the typical land 22 blocks over the sea where vanilla's sits at 13.
    //
    // Only the part ABOVE the landmass's own level is taken out. Subtracting the trend symmetrically would
    // lift the coasts by exactly as much as it lowers the interior, and low coasts are what the beaches and
    // the river mouths are built on.
    {
      const TREND_BLOCKS = 60, TREND_CUT = 1.00;
      const PEAK_GAIN = 2.60, PEAK_KNEE = 0.97;                  // how far the tail is stretched, and from where
      const cells = Math.max(4, Math.round(TREND_BLOCKS / (1200 / res)));
      //Blur over LAND ONLY: letting the ocean vote drags every coast down and the correction then lifts it.
      const before = Float32Array.from(hf);                                    // what the trend removal is about to take
      const num = new Float32Array(n), den = new Float32Array(n);
      for (let j = 0; j < n; j++) { const m = land[j] === 1 ? 1 : 0; num[j] = m * hf[j]; den[j] = m; }
      boxBlurTor(num, res, cells, 2);
      boxBlurTor(den, res, cells, 2);
      const low = new Float32Array(n);
      for (let j = 0; j < n; j++) low[j] = den[j] > 1e-4 ? num[j] / den[j] : 0.5;
      const vals = [];
      for (let j = 0; j < n; j++) if (land[j] === 1) vals.push(low[j]);
      vals.sort((a, b) => a - b);
      const level = vals[Math.floor(vals.length * 0.35)];                        // the landmass's own low ground
      for (let j = 0; j < n; j++) if (land[j] === 1)
        hf[j] = Math.max(0.505, hf[j] - TREND_CUT * Math.max(0, low[j] - level));

      // Taking the trend out compresses the TOP of the height distribution along with the dome: peaks fell
      // from 102 blocks to 90, where a stock world reaches 100-115. Sparing the trend over a noise mask
      // does not help — the mask does not know where the ridges are, and it moved the peak by a block.
      // This stretches the tail back out instead: nothing below the 97th percentile moves at all, and the
      // gain grows with height, so it lifts the ridge crests the trend flattened without putting a slow
      // rise back under the plains. Peaks come back to 103 blocks with the 50th and 90th percentiles
      // unmoved.
      {
        const tops = [];
        for (let j = 0; j < n; j++) if (land[j] === 1) tops.push(hf[j]);
        tops.sort((a, b) => a - b);
        const knee = tops[Math.floor(tops.length * PEAK_KNEE)], top = tops[tops.length - 1];
        if (top > knee) for (let j = 0; j < n; j++) {
          if (land[j] !== 1 || hf[j] <= knee) continue;
          const t = (hf[j] - knee) / (top - knee);
          //Never past where the column started: this restores the tail the trend took, it does not invent
          //height. Without the bound it lifts the ground around a lake and the rim stops being a rim.
          hf[j] = Math.min(before[j], knee + (hf[j] - knee) * (1 + PEAK_GAIN * t));
        }
      }
    }

    // Load-bearing beyond the peaks: removing this pass takes the ground beyond a lake's rim that may sit
    // below the water from 11.9% to 2.5%, against vanilla's 30-45%, because the water follows the land
    // down further than the land around it does. verify-water catches that.
    //
    // Vanilla's peaks reach 100-115 blocks while its 90th percentile sits at 75: mountains are RARE and
    // tall, not a general elevation. Taking the trend out flattens them along with everything else (peaks
    // fell to 89), and weakening the correction to save them brings the dome straight back. So they are put
    // back separately, over a small share of the land.
    {
      const PEAK_FREQ = 5, PEAK_THRESH = 0.74, PEAK_AMP = 0.55;
      for (let j = 0; j < n; j++) {
        if (land[j] !== 1) continue;
        const x = j % res, y = (j / res) | 0;
        const m = Math.max(0, (vnR(warpX(x, y), warpY(x, y), PEAK_FREQ, res) - PEAK_THRESH) / (1 - PEAK_THRESH));
        if (m <= 0) continue;
        hf[j] += PEAK_AMP * m * m * Math.pow(ridged(x, y), 1.3) * ceil[j] * 0.5;
      }
    }

    // A drawn highland decides WHERE the mountains are. It cannot do that through the elevation nudge in
    // the field above: the trend removal is a 60-block high-pass over land, and a biome-wide offset is
    // exactly the shape it deletes. Quadrupling that nudge moved the median land cell 0.00 blocks and the
    // middle of a drawn highland 0.5-2.4; the only thing left of it was the filter's other lobe, a ring
    // from 10 cells inside the highland to 20 outside pushed DOWN by up to 2.5 blocks. Fresh water takes
    // its level from its immediate bank, so that ring dropped the water standing in it, and the ground
    // beyond a rim that may sit below the water fell from 11.9% to 2.5% — the land had hardly moved, the
    // WATER had sunk. (Swapping only the water surfaces between the two runs reproduces the whole fall.)
    //
    // So the drawing is applied AFTER the trend removal, and as a stretch of the relief already there
    // rather than as a lift. The gain follows the same ridged field the peaks do, which is near zero in
    // the valleys, so crests gain and the basin a lake sits in does not: fresh water comes out at the same
    // 22,958 columns at the same levels, and the rim check is unmoved at 11.1%.
    //
    // Only the highland gains. Scaling the low biomes DOWN by the same rule takes the crests the water
    // reads its level from with them, and the rim check falls again — 9.8% at a third of this gain, 5.8%
    // at two thirds.
    {
      const HL_SPAN = 0.33;      // how far a biome's band must sit over the middle to count as fully highland
      const HL_RELIEF = 0.9;     // relief a fully-highland biome gains, in the peak pass's own units
      for (let j = 0; j < n; j++) {
        if (land[j] !== 1) continue;
        const x = j % res, y = (j / res) | 0;
        // Read the band at the WARPED position, as the nudge does, so a drawn biome edge is not printed
        // into the terrain as a ruled line.
        const wj = (((Math.round(warpY(x, y)) % res) + res) % res) * res + (((Math.round(warpX(x, y)) % res) + res) % res);
        const hl = Math.min(1, (tgt[wj] - 0.25) / HL_SPAN);
        if (hl <= 0) continue;
        hf[j] += HL_RELIEF * hl * Math.pow(ridged(x, y), 1.3) * ceil[j] * 0.5;
      }
    }

    // Some biomes are FLAT ground, not just ground at a particular height. A stock wetland sits inside a
    // 3-4 block band and is the flattest biome in the world, because stock derives the biome FROM the
    // terrain and can only ever put one on low flat ground. Here the biome is drawn independently, so a
    // wetland lands on whatever relief happens to be there - measured, ours spanned 12 blocks and rose
    // three times as fast over 8 blocks as a stock one.
    //
    // Flattening toward the LOCAL land mean rather than toward a fixed height is what keeps this off the
    // biome borders: the pass removes the wrinkles inside the region and leaves the region sitting where
    // it already sat, so there is no step to walk down at the edge. The mask is blurred over the same
    // radius as the biome elevation nudge for the same reason - a drawn border is usually a clean line,
    // and anything read straight off it gets printed into the terrain.
    {
      const FLAT_BLOCKS = 40;                                    // window the ground is levelled over
      const cells = Math.max(3, Math.round(FLAT_BLOCKS / (1200 / res)));
      // Tighter than the biome nudge blurs. At res/27 the blur ate the mask inside a region as small as
      // a wetland - the middle of one kept less than half its value and barely flattened. This still
      // ramps the effect out over ~19 blocks, which is a walk, not a step.
      const maskR = Math.max(3, Math.round(res / 60));
      const num = new Float32Array(n), den = new Float32Array(n);
      for (let j = 0; j < n; j++) { const m = land[j] === 1 ? 1 : 0; num[j] = m * hf[j]; den[j] = m; }
      boxBlurTor(num, res, cells, 2);
      boxBlurTor(den, res, cells, 2);
      const mask = new Float32Array(n);
      for (let j = 0; j < n; j++) mask[j] = land[j] === 1 ? (BIOME_FLATTEN[CN[biome[j]]] || 0) : 0;
      boxBlurTor(mask, res, maskR, 2);
      for (let j = 0; j < n; j++) {
        if (land[j] !== 1 || mask[j] <= 0.001 || den[j] <= 1e-4) continue;
        const localMean = num[j] / den[j];
        hf[j] = Math.max(0.505, hf[j] + (localMean - hf[j]) * mask[j]);
      }
    }

    // The sea bed is a single flat plane. Every ocean cell is exported at one constant, so 100% of deep
    // water sits at exactly 24 blocks down with four identical neighbours, where a stock world's modal
    // depth holds under 15% of its sea and its floor reaches 48-53 blocks. Give it a profile — dropping
    // away from the shelf, with enough roughness that it is a sea bed rather than a swimming pool.
    {
      const DEEP_CELLS = 45;        // how far out the floor keeps dropping
      const SHALLOW = 0.45;         // where the sea leaves the shelf, ~12 blocks down
      const DEEP_FLOOR = 0.25;      // ~30 blocks down: a stock world's MEDIAN is 24-27, not its floor
      const BED_RELIEF = 0.095;     // roughness, growing with depth so the shallows stay calm
      const dist = new Int16Array(n).fill(-1), q = [];
      for (let j = 0; j < n; j++) if (land[j] === 1) { dist[j] = 0; q.push(j); }
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        if (dist[c] >= DEEP_CELLS) continue;
        for (const nb of nbr4(c)) if (dist[nb] < 0 && land[nb] === 0) { dist[nb] = dist[c] + 1; q.push(nb); }
      }
      for (let j = 0; j < n; j++) {
        if (land[j] !== 0) continue;
        const x = j % res, y = (j / res) | 0;
        const d = dist[j] < 0 ? DEEP_CELLS : dist[j];
        const t = Math.min(1, d / DEEP_CELLS), sm = t * t * (3 - 2 * t);
        const bed = SHALLOW + (DEEP_FLOOR - SHALLOW) * sm;
        const rough = (vnR(x, y, 14, res) - 0.5) * 2 * BED_RELIEF * sm
                    + (vnR(x + 61.7, y + 23.1, 30, res) - 0.5) * BED_RELIEF * sm;
        hf[j] = Math.max(0.03, Math.min(0.495, bed + rough));
      }
    }

    // Shelve the sea bed near the shore. Left at full depth the sea floor sits ~14 blocks below the land
    // it touches, and Eco carves a rock face wherever neighbouring columns differ by 5 or more — so EVERY
    // coastal cell qualified and the whole coastline came out lined with extruded sandstone. Real coasts
    // shelve: shallow at the beach, dropping away offshore. Ramping the depth over SHELF_CELLS keeps the
    // step at the waterline under that threshold, so no cliff is cut and the beach stays a beach.
    {
      const SHELF_CELLS = 14;       // how far out the shallows reach
      const SHELF_TOP = 0.492;      // just under sea level (~1 block down) right at the shore
      const dist = new Int16Array(n).fill(-1), q = [];
      for (let j = 0; j < n; j++) if (land[j] === 1) { dist[j] = 0; q.push(j); }
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        if (dist[c] >= SHELF_CELLS) continue;
        for (const nb of nbr4(c)) if (dist[nb] < 0 && land[nb] === 0) { dist[nb] = dist[c] + 1; q.push(nb); }
      }
      for (let j = 0; j < n; j++) {
        if (land[j] !== 0 || dist[j] < 0) continue;
        const t = Math.min(1, dist[j] / SHELF_CELLS), sm = t * t * (3 - 2 * t);   // smooth, so there is no rim
        const shelf = SHELF_TOP + (hf[j] - SHELF_TOP) * sm;
        if (shelf > hf[j]) hf[j] = shelf;
      }
    }
    // Per-cell water surface, from the land it touches — the AVERAGE of it, which is what vanilla's lake
    // pass uses ("use average height as the lake elevation", VoronoiWorldGenerator).
    //
    // This used to take the MINIMUM bank and then min-propagate it 20 cells, so a body sat level with the
    // lowest shore within ~54 m. That one rule is what put authored water in a bowl: if the level IS the
    // lowest thing within 54 m then by construction nothing within 54 m can be lower, and the ground can
    // only rise away from it. Measured across four vanilla worlds, 30-45% of the ground 20 m from vanilla's
    // fresh water is BELOW the water line — its water threads through terrain that is as often lower as
    // higher — against 11.6% here. Containment is not what the level is for: vanilla holds a lake with its
    // immediate ring alone (raising just that ring), and lets the ground beyond do as it likes.
    // How high the water stands, and how far each cell is from its own edge - see settleWaterLevels.
    const settled = settleWaterLevels(res, n, land, hf, distO, BPC, groups, boxBlurTor);
    const level = settled.level, fromShore = settled.fromShore, aroundLand = settled.aroundLand;
    const SETTLE_MARGIN = settled.SETTLE_MARGIN;
    for (const cells of groups) {
      const tally = {}; for (const j of cells) for (const nb of nbr4(j)) if (land[nb] === 1) tally[biome[nb]] = (tally[biome[nb]] || 0) + 1;
      let lb = SC.Grassland, bc = -1; for (const k in tally) if (tally[k] > bc) { bc = tally[k]; lb = +k; }   // majority shore biome
      // Only the mask and the surface are settled here. hf/water/bed are written once, at the end, out of
      // the surface the passes below leave behind — anything put in them now is overwritten unread.
      for (const j of cells) {
        biome[j] = lb; land[j] = 2; wsurf[j] = Math.max(SEA + 0.01, level[j] - 0.012);   // just under the surrounding bank
      }
    }
    // Settle the water surface: spikes, cross-channel levelling, then one level per lake. Shared with
    // the seeded path, which needs exactly the same treatment - see solveWaterSurface.
    solveWaterSurface(res, land, wsurf, fromShore);
    {
      // the surface as it will be exported
      for (let j = 0; j < n; j++) {
        if (land[j] !== 2) continue;
        const surface = Math.max(SEA + 0.01, wsurf[j]);
        wsurf[j] = surface; hf[j] = surface;
        water[j] = Math.max(1, Math.min(255, Math.round((2 * surface - 1) * 255)));
      }
    }
    shelveWaterBed(res, n, land, wsurf, bed, BPC);
    // minimal smoothing — keep the ridged relief steep (just knock off single-pixel noise + shoreline step)
    boxBlurTor(hf, res, Math.max(1, Math.round(res / 140)), 1);
    // Break the land into cells and give each ONE height, the way the real generator does.
    //
    // Up to here the field is smooth, and a smooth field is locally a PLANE — whose contours are straight
    // parallel lines. Terracing then draws them, which is the "elevation runs in a line" look: measured
    // against a real vanilla world, 69% of windows here fitted a plane at R^2>0.9 versus vanilla's 4.5%.
    // Vanilla is not smooth: it draws elevation once per Voronoi cell, so every cell boundary breaks the
    // plane. Doing the same drops that to 2%.
    //
    // Cells come from a jittered grid (one site per grid square, so the nearest site is always within the
    // 5x5 block around a pixel — no full Voronoi build needed). Cells whose site is not land are left
    // alone, which keeps coastlines smooth instead of stepping them.
    const CELL_SPACING = 6.5;       // cells across, in import cells (~17 world blocks, close to vanilla's)
    // Reads hf as it stands and hands back the hard per-cell field plus a once-blurred copy of it, for the
    // caller to mix. `siteOk(si)` says which sites may be sampled, `cellOk(j)` which pixels may move; the
    // corridor pass below runs it a second time with a narrower pair of those.
    const cellFlatten = (siteOk, cellOk) => {
      const cells = Math.max(1, Math.round(res / CELL_SPACING)), cw = res / cells;
      const wrapC = v => ((v % cells) + cells) % cells;
      const wrapD = (a, b) => { const d = Math.abs(a - b); return d > res / 2 ? res - d : d; };
      const siteX = new Float32Array(cells * cells), siteY = new Float32Array(cells * cells);
      const siteV = new Float32Array(cells * cells), siteUse = new Uint8Array(cells * cells);
      for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
        const c = cy * cells + cx;
        const px = (cx + h2(cx, cy)) * cw, py = (cy + h2(cx + 7777, cy + 3333)) * cw;
        siteX[c] = px; siteY[c] = py;
        const ix = Math.min(res - 1, px | 0), iy = Math.min(res - 1, py | 0), si = iy * res + ix;
        if (siteOk(si)) { siteV[c] = hf[si]; siteUse[c] = 1; }
      }
      const flat = new Float32Array(hf);
      for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
        const j = y * res + x;
        if (!cellOk(j)) continue;
        const gx = Math.floor(x / cw), gy = Math.floor(y / cw);
        let best = -1, bd = Infinity;
        for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
          const c = wrapC(gy + oy) * cells + wrapC(gx + ox);
          if (!siteUse[c]) continue;
          const dx = wrapD(x, siteX[c]), dy = wrapD(y, siteY[c]), d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = c; }
        }
        if (best >= 0) flat[j] = siteV[best];
      }
      const soft = new Float32Array(flat);
      boxBlurTor(soft, res, 1, 1);
      return { flat, soft };
    };
    {
      const CELL_SHARP = 0.90;      // how much of the hard cell edge survives the smoothing
      const isLand = j => land[j] === 1;
      const { flat, soft } = cellFlatten(isLand, isLand);
      for (let j = 0; j < n; j++) if (land[j] === 1) hf[j] = soft[j] * (1 - CELL_SHARP) + flat[j] * CELL_SHARP;
    }
    // A real river is not the same on both banks or along its length: the inside of a bend silts up into
    // a flat point bar, the outside is cut back into a bluff. Everything below relaxes and caps the shore
    // by the same rule everywhere, so every bank column ends the same height over the water and the
    // result reads as masonry. This field decides, at low frequency, which stretches keep their bank —
    // 0 on a beach, 1 on a bluff — and the relax and both caps read it.
    // The corridor's own profile — see bankProfileFields. Ours had none of its own: the relax below aimed
    // at the WATER and the cap held the first 30 m within half a block of it, so the corridor was only a
    // valley where the bluff field happened to spare it, and flat everywhere else. On the flat stretches
    // the ring beside the water is held at the surface while the ground behind sits at 0.34 blocks over
    // it, and that step is the ledge: 18% of shore rays. So the relax, the lift and the cap all read it.
    const prof = bankProfileFields(res, n, wsurf, aroundLand);
    const vshF = prof.vshF, vrsF = prof.vrsF, bluff = prof.bluff;
    valleyBanks(res, n, land, wsurf, hf, prof);
    // Flatten the very first ring of land into a bank rather than a lip. The valley pass above shapes the
    // slope but leaves this ring wherever the relaxation put it — up to 4.9 blocks over the water at p90 —
    // and CliffExtruder measures the ring against the BED, not the surface, so those blocks clear its
    // 5-block threshold and become a wall. Together with the shelf this holds the whole shoreline step to
    // about 3.5 blocks. Runs before the restore below, which still owns the lower bound.
    {
      // One block, not two. At two, the cap BINDS along most of the shoreline and every cell it touches
      // ends up the same height over the water, so the ring becomes a flat-topped ledge of constant height
      // following the channel — masonry rather than ground. At one it mostly stops binding and the height
      // comes from the restore below instead, which is a lip rather than a terrace. Vanilla's first ring
      // sits 0.3-0.45 blocks over its water; this takes 1.37 to 0.93.
      capBankLip(res, land, wsurf, hf);
    }
    // The blur averages across the shoreline, and water cells sit low, so it drags the banks down with them
    // — far enough, in places, to leave the bank UNDER the water it is holding back, which reads in game as
    // a lake spilling over the terrain. Put the shore back: any land touching water sits a block above it.
    // Runs again after the corridor is snapped back onto its cells, since that move can drop the ring below
    // the water a second time; it is the lower bound on the shore, so nothing may leave it unenforced.
    const restoreShore = () => restoreShoreLip(res, land, wsurf, hf);
    restoreShore();
    capShoreBand(res, n, land, wsurf, hf, prof, aroundLand, SETTLE_MARGIN);
    // Snap the shaped corridor back onto the same cells the rest of the land uses.
    //
    // Vanilla relaxes its river valleys on POLYGONS — one height per Voronoi cell — so its corridor is
    // made of cell-sized plateaus and the rise is concentrated on cell boundaries, which are irregular and
    // in a different place on every stretch. Ours relaxes per import cell (2.7 world blocks), which leaves
    // the corridor a smooth function of distance-to-water: every block of height then draws its own contour
    // line parallel to the river, and the bank reads as rice terraces. Measured, a 14 m walk inland crossed
    // 3.0 separate risers against vanilla's 1.8-2.1, at the same total height gained.
    //
    // The ring of land next to the water keeps whatever the passes above gave it — that shape is what stops
    // the bank being a kerb — and cells sited inside that ring are left alone rather than dragging it up.
    {
      const CELL2_SHARP = 0.6, CELL2_KEEP = 1;
      const CELL2_FLOOR = 0.35 * BLK, CELL2_REACH = 8;
      const dwc = new Int32Array(n).fill(-1), cws = new Float32Array(n), q2 = [];
      for (let j = 0; j < n; j++) if (land[j] === 2) { dwc[j] = 0; cws[j] = wsurf[j]; q2.push(j); }
      for (let k = 0; k < q2.length; k++) { const c = q2[k]; if (dwc[c] >= CELL2_REACH) continue;
        for (const nb of nbr4(c)) if (dwc[nb] < 0) { dwc[nb] = dwc[c] + 1; cws[nb] = cws[c]; q2.push(nb); } }
      // Same cells as the land pass, minus the ring beside the water at either end: a site sited in it
      // would drag it up, and a pixel in it would lose the shape the passes above gave it.
      const outsideRing = j => land[j] === 1 && (dwc[j] < 0 || dwc[j] > CELL2_KEEP);
      const { flat, soft } = cellFlatten(outsideRing, outsideRing);
      // Only the FINE structure is snapped. A cell is 17 blocks across, so on a valley wall one site can
      // stand ten blocks above the ground beside the water, and taking it whole would put the trench and
      // the rim straight back. Holding the move to about one terrace band keeps the macro shape the passes
      // above worked out and still gathers the metre-scale wobble into flat treads with the rise on the
      // cell boundary.
      const CELL2_MOVE = 2.5 * BLK;
      for (let j = 0; j < n; j++) {
        if (land[j] !== 1 || (dwc[j] >= 0 && dwc[j] <= CELL2_KEEP)) continue;
        const want = soft[j] * (1 - CELL2_SHARP) + flat[j] * CELL2_SHARP;
        let v = Math.max(hf[j] - CELL2_MOVE, Math.min(hf[j] + CELL2_MOVE, want));
        // and it may not push the corridor under the river it runs beside — the passes above lift low
        // ground to the shoulder for a reason, and a cell dropped below the water line is the perched
        // channel with a bank holding it in.
        if (dwc[j] >= 1 && v < cws[j] + CELL2_FLOOR) v = Math.min(hf[j], cws[j] + CELL2_FLOOR);
        hf[j] = v;
      }
      restoreShore();   // the shoreline is still owed its freeboard after any move
    }
    // finalize: lakes hold water above their (fixed) bed; other land keeps its relief above sea; sea stays deep
    //
    // Both maps leave here as BYTES, and Eco truncates the water one — `waterLevel + trunc(relief * b/255)`
    // — while the bed byte rounds on its own. A column the shelf gave 1.8 blocks of water can therefore
    // arrive holding 0.7, and where it lands under a block Eco fills the column to nothing and the channel
    // is dry there. On a mirrored map it is worse than cosmetic: the terrain noise under the two isles is
    // not mirrored, so they round differently and the water goes missing on ONE side, which is what a
    // mirrored world shows up as a river that runs on one isle and not on its twin. Measured before this,
    // 307 cells held under a block and 241 of them were wet on one isle and dry on the other.
    //
    // So set the bed from the QUANTISED surface, in the same arithmetic Eco will use, rather than trusting
    // the sub-block value to survive the trip.
    writeExportColumns(res, n, land, hf, bed, wsurf, water, height);
    return { res, biome, height, water };
  }
  // Decode the source image onto the G x G paint grid. Colour maps must NOT be smoothed, for the same
  // reason imageToMaps doesn't smooth them: an averaging downscale turns every biome boundary into blend
  // colours, and those blends compete for the MAX_LEGEND slots. A small biome loses — an ice cap at ~1% of
  // land never survives a 448 -> 128 downscale, and gets silently remapped to whatever colour is nearest.
  // Brightness mode does want the averaging, since it is reading tone off a photo.
  function decodeAt(img, N) {
    const c = document.createElement('canvas'); c.width = N; c.height = N;
    const cx = c.getContext('2d'); cx.imageSmoothingEnabled = (importMode === 'brightness');
    cx.drawImage(img, 0, 0, N, N);
    return cx.getImageData(0, 0, N, N).data;
  }
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
      importLegendIdxHi = null; importPreview = null;
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
  function drawGrid(canvas, grid, size) {
    const G2 = size || G;
    const ctx = canvas.getContext('2d');
    if (canvas.width !== G2) { canvas.width = G2; canvas.height = G2; }   // backing store; CSS scales it up
    const W = canvas.width;
    const img = ctx.createImageData(W, W);
    const d = img.data;
    for (let y = 0; y < W; y++) {
      const gy = G2 - 1 - y;
      for (let x = 0; x < W; x++) {
        const c = grid[gy * G2 + x], rgb = COL[CN[c]] || [128, 128, 128];
        const o = (y * W + x) * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  function renderPaint() {
    if (paintMode === 'elevation') drawHeight($('dsnCanvas'));
    else if (paintMode === 'water') drawWaterView($('dsnCanvas'));
    else if (importPreview && !paintedSinceImport) drawGrid($('dsnCanvas'), importPreview, IMPORT_RES);
    else drawGrid($('dsnCanvas'), target);
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
    drawGrid(canvas, target);
    const ctx = canvas.getContext('2d'), W = canvas.width, img = ctx.getImageData(0, 0, W, W), d = img.data;
    for (let y = 0; y < W; y++) { const gy = G - 1 - y; for (let x = 0; x < W; x++) { if (water[gy * G + x]) { const o = (y * W + x) * 4; d[o] = 30; d[o + 1] = 110; d[o + 2] = 230; } } }
    ctx.putImageData(img, 0, 0);
  }
  // Every mutation goes through here, so it is also where the design stops being a straight copy of the map.
  function pushUndo() { designEdited = true; undoStack.push({ t: target.slice(), e: elev.slice(), p: elevPainted.slice(), w: water.slice(), r: rough.slice() }); if (undoStack.length > 40) undoStack.shift(); }
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
  // level and land stays above it. Painted values override. Blurred so biome edges are slopes, not cliffs.
  const OCEAN_FALLOFF = G / 4, RELIEF_AMP = 0.10;   // coast→interior ramp, kept proportional to grid size
  function computeHeightField() {
    const dist = oceanDistField();
    let a = new Float32Array(G * G);
    const dryLand = new Uint8Array(G * G);   // cells the sea-level floor owns; re-applied once the blur is done
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const i = y * G + x;
      if (elevPainted[i]) {                                             // painted: add the per-cell micro-relief baked at paint time
        const v = elev[i] + (fbm(x, y) - 0.5) * rough[i];
        // a value painted BELOW sea is a deliberate hollow, so only land-side paint claims the floor
        if (elev[i] >= 0.505) { a[i] = Math.max(0.505, v); dryLand[i] = 1; } else a[i] = v;
        continue;
      }
      const band = ECO_BIOME_ELEV[CN[target[i]]] || [0.52, 0.62], lo = band[0], hi = band[1];
      if (target[i] === SC.Ocean) { a[i] = lo + (hi - lo) * fbm(x, y); continue; }           // below sea level -> water
      const fall = Math.min(1, dist[i] / OCEAN_FALLOFF), s = fall * fall * (3 - 2 * fall);    // smoothstep coast->inland
      const base = lo + (hi - lo) * s;                                                        // rise from shore to interior
      a[i] = Math.max(0.505, base + (fbm(x, y) - 0.5) * RELIEF_AMP * (0.4 + 0.6 * s));         // rolling hills, gentler near shore
      dryLand[i] = 1;
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
    // The floor has to hold AFTER the blur. Averaging a coastal cell with its ocean neighbours drags it
    // back under sea level — up to 10 blocks under, two cells inland — while biome.bin still calls that
    // cell Grassland, so the two exported layers contradict each other and the waterline lands inland of
    // where it was drawn. imageToMaps applies the same floor at its finalize step, after all of ITS
    // smoothing, for the same reason; this keeps the painted path's promise identical to the imported one.
    for (let i = 0; i < G * G; i++) if (dryLand[i] && a[i] < 0.505) a[i] = 0.505;
    // A water surface has to hold after the blur too, and for a sharper reason than the floor: a lake is
    // one level by definition, and averaging its cells against the banks around it tilts that level cell by
    // cell. Measured on a design seeded from a map, leaving the blur to it put 42% of the lake water off
    // its own lake's level, where a stock world has none.
    for (let i = 0; i < G * G; i++) if (water[i] && elevPainted[i]) a[i] = elev[i];
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
    const ctx = canvas.getContext('2d');
    // The biome view leaves the canvas at IMPORT_RES for an untouched image import, but the terrain here is
    // always G-resolution. Reading a G grid with a wider loop tiles the map res/G times across the canvas,
    // so put the canvas back to G first — drawGrid does the same for the views that own their own size.
    if (canvas.width !== G) { canvas.width = G; canvas.height = G; }
    const W = canvas.width, img = ctx.createImageData(W, W), d = img.data;
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
  /** A design that is still blank ocean everywhere - it has not been seeded, or it was just cleared. */
  function designIsEmpty(t) {
    for (let i = 0; i < t.length; i++) if (t[i] !== SC.Ocean) return false;
    return true;
  }

  // Re-seed for a map the design has not seen. Without this, rolling a new map and reopening the designer
  // silently regenerates the PREVIOUS design with only the config seed changed - two worlds generated that
  // way from different seeds came out 97.6% identical. An edited design is never replaced under the user.
  function shouldReseed(empty, edited, mapChanged) { return empty || (!edited && mapChanged); }

  function seedFromMap() {
    if (typeof result === 'undefined' || !result) { $('dsnAnalysis').textContent = 'Generate a map first, then seed from it.'; return; }
    pushUndo();
    if (!classgridBound) {
      worker.addEventListener('message', ev => {
        if (!(ev.data && ev.data.type === 'classgrid' && ev.data.grid)) return;
        target = new Uint8Array(ev.data.grid);
        // The map's lakes and rivers come across too. Without them the design exports no water at all and
        // the generated world has none - no rivers, no lakes, and no river sand along either. Only WHERE
        // the water is: how high it stands is settled at export time against the design's own terrain, by
        // the same passes the image import uses. The map's own heights belong to the map's landscape, not
        // to this one, and carrying them over put water 17 blocks above the sea within sight of the coast.
        if (ev.data.water) water = new Uint8Array(ev.data.water);
        seededFrom = result; designEdited = false;
        hideLegend(); renderPaint(); flashAnalysis('Seeded from the current map. Edit it, then analyze.');
      });
      classgridBound = true;
    }
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
  // The blend itself is search.js's, so the gallery cannot drift from the score the worker returned.
  function combine(c, w) {
    const b = blendScore(c, w);
    return { score: b.score, layout: b.layout, prop: c.prop, soft: c.soft, iou: c.iou, exact: c.exact };
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
    const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target);   // keep the "your drawing" thumbnail in sync
    const bestRef = $('dsnBestRef'), bestLbl = $('dsnBestLbl');
    if (bestRef) { if (pool.length) { drawGrid(bestRef, pool[0].grid); if (bestLbl) bestLbl.textContent = 'best match · ' + (pool[0].s.score * 100).toFixed(1) + '%'; } else { bestRef.getContext('2d').clearRect(0, 0, G, G); if (bestLbl) bestLbl.textContent = 'best match'; } }
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
    gal.querySelectorAll('canvas[data-i]').forEach(c => drawGrid(c, show[+c.dataset.i].grid));
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
    const haveMap = typeof result !== 'undefined' && result;
    if (haveMap && shouldReseed(designIsEmpty(target), designEdited, seededFrom !== result)) seedFromMap();
    else if (haveMap && designEdited && seededFrom !== result) flashAnalysis('The map changed. This design is still the one you edited — "Seed from current map" replaces it.');
    updateSpeedHint();
    const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target);
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
  // ---- export detail -------------------------------------------------------------------------------
  // The paint grid is 128 cells whatever the world size, so a designed 720-block world is upscaled from
  // 5.6 world blocks per cell and the export simply contains nothing finer than that. Two things have to
  // change together, and measuring them apart is what shows why: a finer export lattice alone buys almost
  // nothing (there is no detail to carry) and finer octaves alone buy almost nothing (there is no lattice
  // to put them on) - together they roughly double the relief the finished world has over 4 and 8 blocks.
  // Frequencies are cycles across the whole map, so they are derived from world size; left fixed, a big
  // world is always smoother than a small one.
  const EXPORT_BLOCKS_PER_CELL = 2;         // the image-import path exports at ~2.7 and lands in stock's band
  const EXPORT_RES_MAX = 512;               // keeps the bundle inside the service's size limit
  const FINE_WAVE1 = 32, FINE_WAVE2 = 14;   // world blocks per cycle of the two added octaves
  const FINE_A1 = 0.12, FINE_A2 = 0.07;     // weights, against the three shipped octaves which sum to 1
  const FINE_RELIEF = 0.45;                 // height range the added detail spans, as RELIEF_AMP does
  // Smooth noise spreads its relief evenly, which is the wrong shape: stock is mostly FLAT with the height
  // gathered into a few sharp risers, and adding a smooth field instead ruffles every tread - measured, it
  // buys the missing relief at the cost of two thirds of the flat building land. Snapping the added detail
  // to whole 3-block levels first keeps the treads flat and puts the height into steps you can see.
  // 4 blocks, in the [0,1] the height byte encodes (0 = off). Bigger than the mod's own terrace level on
  // purpose: what stock has and smooth detail does not is relief GATHERED - mostly flat ground with the
  // height in a few sharp risers. Snapping to a coarser level leaves wider flat treads and puts the
  // height into fewer, larger steps. Measured at the export's real pitch, going 3 -> 4 blocks took flat
  // 5x5 building pads from 33-35% to 35-38% against stock's 37-40%, and the one-block share of the step
  // mix from 77-81% to 75-78% against stock's 73-75%.
  const FINE_STEP = 4 / 120;

  /** Export lattice for a world this many blocks across: a whole multiple of G, so the upsample is exact. */
  function exportRes(worldBlocks) {
    if (!worldBlocks) return G;
    const n = Math.round(worldBlocks / EXPORT_BLOCKS_PER_CELL / G) * G;
    return Math.max(G, Math.min(EXPORT_RES_MAX, n));
  }

  /** Nearest-cell lookup from a paint-grid layer, for the categorical ones. */
  function sampleG(layer, N, x, y) {
    const gx = Math.min(G - 1, Math.floor(x * G / N)), gy = Math.min(G - 1, Math.floor(y * G / N));
    return layer[gy * G + gx];
  }

  /**
   * The carved height field on the export lattice: bilinear from the paint grid, plus the fine octaves it
   * could never carry. Detail is held off the waterline and off the channels - the coastline and the rivers
   * are the design's, and nothing here may move them.
   */
  function exportHeight(base, N, worldBlocks, wetNear) {
    const out = new Float32Array(N * N);
    const p1 = Math.max(2, Math.round(worldBlocks / FINE_WAVE1));
    const p2 = Math.max(2, Math.round(worldBlocks / FINE_WAVE2));
    const s = G / N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = x * s, fy = y * s;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const x1 = (x0 + 1) % G, y1 = (y0 + 1) % G;
        const v = (base[y0 * G + x0] * (1 - tx) + base[y0 * G + x1] * tx) * (1 - ty)
                + (base[y1 * G + x0] * (1 - tx) + base[y1 * G + x1] * tx) * ty;
        const u = x / N, w = y / N;
        const d = FINE_A1 * (vnW(u * p1 + 13, w * p1 + 29, p1) - 0.5)
                + FINE_A2 * (vnW(u * p2 + 7,  w * p2 + 3,  p2) - 0.5);
        const above = Math.min(1, Math.max(0, (v - 0.505) / 0.03));    // fade in just above sea level
        const dry = sampleG(wetNear, N, x, y) ? 0 : 1;
        let off = d * FINE_RELIEF;
        if (FINE_STEP > 0) off = Math.round(off / FINE_STEP) * FINE_STEP;
        out[y * N + x] = v + off * above * dry;
      }
    }
    return out;
  }

  /**
   * The sea and the water bodies on the export lattice, the way settleWaterLevels wants them: a chamfer
   * distance from the OCEAN (the largest salt-water component, so an inland dip does not count as sea) and
   * the connected components of fresh water.
   */
  function waterTopologyAt(N, land) {
    const n = N * N;
    const nbr4 = j => { const x = j % N, y = (j / N) | 0; return [((x + 1) % N) + y * N, ((x + N - 1) % N) + y * N, x + ((y + 1) % N) * N, x + ((y + N - 1) % N) * N]; };
    const sc = new Int32Array(n).fill(-1), size = [];
    let id = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (land[s0] !== 0 || sc[s0] >= 0) continue;
      const st = [s0]; sc[s0] = id; let sz = 0;
      while (st.length) { const c = st.pop(); sz++; for (const q of nbr4(c)) if (land[q] === 0 && sc[q] < 0) { sc[q] = id; st.push(q); } }
      size.push(sz); id++;
    }
    let seaId = -1, seaSz = -1;
    for (let i = 0; i < size.length; i++) if (size[i] > seaSz) { seaSz = size[i]; seaId = i; }
    const distO = new Float32Array(n).fill(Infinity);
    const D = Math.SQRT2, wrap = v => ((v % N) + N) % N;
    for (let i = 0; i < n; i++) if (sc[i] === seaId) distO[i] = 0;
    const at = (x, y) => distO[wrap(y) * N + wrap(x)];
    for (let pass = 0; pass < 4; pass++) {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const m = Math.min(distO[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + D, at(x + 1, y - 1) + D);
        if (m < distO[i]) distO[i] = m;
      }
      for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) {
        const i = y * N + x;
        const m = Math.min(distO[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + D, at(x - 1, y + 1) + D);
        if (m < distO[i]) distO[i] = m;
      }
    }
    const seen = new Uint8Array(n), groups = [];
    for (let j = 0; j < n; j++) {
      if (land[j] !== 2 || seen[j]) continue;
      const st = [j]; seen[j] = 1; const cells = [];
      while (st.length) { const c = st.pop(); cells.push(c); for (const q of nbr4(c)) if (land[q] === 2 && !seen[q]) { seen[q] = 1; st.push(q); } }
      groups.push(cells);
    }
    return { distO: distO, groups: groups };
  }

  /**
   * The three things solveWaterSurface reads, built on the export lattice: which cells are fresh water,
   * a first guess at each one's surface, and how far that water is from its own edge. The guess is simply
   * the ground the cell sits on - the same starting point the import path has, and the same one the solver
   * is written to correct.
   */
  function waterFieldsAt(N, fine) {
    const n = N * N;
    const land = new Uint8Array(n), wsurf = new Float32Array(n), fromShore = new Int16Array(n).fill(-1);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      wsurf[i] = fine[i];
      land[i] = sampleG(water, N, x, y) ? 2 : (fine[i] >= SEA_LEVEL + 0.005 ? 1 : 0);
    }
    const q = [];
    for (let i = 0; i < n; i++) if (land[i] !== 2) { fromShore[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) {
      const c = q[h], x = c % N, y = (c / N) | 0;
      for (const nb of [y * N + (x + 1) % N, y * N + (x + N - 1) % N, ((y + 1) % N) * N + x, ((y + N - 1) % N) * N + x])
        if (fromShore[nb] < 0) { fromShore[nb] = fromShore[c] + 1; q.push(nb); }
    }
    return { land: land, wsurf: wsurf, fromShore: fromShore };
  }

  /** Water cells and their immediate neighbours, so added detail never breaks a channel or a bank. */
  function nearWater() {
    const out = new Uint8Array(G * G);
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      if (!water[y * G + x]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
        out[(((y + dy) % G + G) % G) * G + (((x + dx) % G + G) % G)] = 1;
    }
    return out;
  }

  /**
   * The three maps the service is handed: biome class, height byte and water surface, on the export
   * lattice. Split out of buildBundleFiles because the 3D preview has to show THESE - it used to build
   * its own from the paint grid, which meant it previewed a different world from the one you get.
   */
  function buildExportMaps() {
    // Raw maps (what the mod actually reads — unambiguous, no PNG decode). Generation orientation, row-major.
    const worldBlocks = ((typeof readForm === 'function' ? (readForm().worldWidth | 0) : 0) || 72) * 10;
    const N = exportRes(worldBlocks);
    // The water surface is SOLVED on the export lattice, by the same passes the image import uses. Every
    // cell starts with the level of the ground it sits on, which is wrong in the three ways
    // solveWaterSurface exists to fix - a spike stands proud, a course drawn across a slope keeps a
    // different level on each bank, and a lake holds one level per shore. Doing it here rather than on the
    // paint grid also settles it at the export's own pitch instead of 5.6 world blocks at a time.
    const base = computeHeightField();          // uncarved: the water passes decide what the channel does
    const fine = exportHeight(base, N, worldBlocks, nearWater());
    const wf = waterFieldsAt(N, fine);
    const topo = waterTopologyAt(N, wf.land);
    const settled = settleWaterLevels(N, N * N, wf.land, fine, topo.distO, worldBlocks / N, topo.groups, boxBlurTor);
    for (let i = 0; i < N * N; i++)
      if (wf.land[i] === 2) wf.wsurf[i] = Math.max(SEA_LEVEL + 0.01, settled.level[i] - 0.012);   // just under the bank
    solveWaterSurface(N, wf.land, wf.wsurf, settled.fromShore);
    // Levelling a lake takes its dominant level, which does not know how near the sea it is - so put the
    // coast envelope back on afterwards, or a body beside the shore keeps an inland level.
    for (let i = 0; i < N * N; i++)
      if (wf.land[i] === 2) wf.wsurf[i] = Math.min(wf.wsurf[i], settled.seaCapAt[i] - 0.012);
    const biomeBin = new Uint8Array(N * N);     // per-cell score-class index (matches the mod's BIOME_BY_INDEX)
    const heightBin = new Uint8Array(N * N);    // per-cell height byte 0..255 (mod maps to [-1,1], then bilinear-upscales)
    const waterBin = new Uint8Array(N * N);     // per-cell water surface as waterValue*255 (0 = sea level; mod fills to it)
    for (let i = 0; i < N * N; i++) {
      if (wf.land[i] !== 2) continue;
      const surface = Math.max(SEA_LEVEL + 0.01, wf.wsurf[i]);
      wf.wsurf[i] = surface;
      waterBin[i] = Math.max(1, Math.min(255, Math.round((2 * surface - 1) * 255)));
    }
    // Shape the corridor the water runs in, the way the import does: relax the banks into a valley, then
    // cap the first 30 m of land. Without it the seeded ground climbs straight out of the water on one
    // side and lies below its surface on the other, and either way the bank ends up the high point of its
    // own surroundings - a kerb following the water.
    const prof = bankProfileFields(N, N * N, wf.wsurf, settled.aroundLand);
    valleyBanks(N, N * N, wf.land, wf.wsurf, fine, prof);
    // The ground either side: cap the ring so it is not a ledge, then put the shore back above the water.
    capBankLip(N, wf.land, wf.wsurf, fine);
    restoreShoreLip(N, wf.land, wf.wsurf, fine);
    capShoreBand(N, N * N, wf.land, wf.wsurf, fine, prof, settled.aroundLand, settled.SETTLE_MARGIN);
    restoreShoreLip(N, wf.land, wf.wsurf, fine);
    // The bed shelves up at the edges and deepens away from them. A flat bed a fixed depth down puts a step
    // at every shoreline that Eco's CliffExtruder turns into a rock face - measured on a seeded world
    // without this, 41-44% of shoreline pairs cleared that threshold where a stock world has none.
    const bedN = new Float32Array(N * N);
    shelveWaterBed(N, N * N, wf.land, wf.wsurf, bedN, worldBlocks / N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) biomeBin[y * N + x] = sampleG(target, N, x, y);
    writeExportColumns(N, N * N, wf.land, fine, bedN, wf.wsurf, waterBin, heightBin);
    let anyWater = false;
    for (let i = 0; i < G * G; i++) if (water[i]) { anyWater = true; break; }
    // A pure image import exports hi-res biome + height straight from the source image (the G² paint
    // grid would spread several world blocks over every pixel). Hand-painting over the import opts back out.
    let biomeOut = biomeBin, heightOut = heightBin, waterOut = waterBin, hi = null;
    if (importedImg && !paintedSinceImport) {
      // Water depth follows vanilla's rule, which is defined per world BLOCK, so the import needs to know
      // how many blocks a cell of its grid covers.
      const wwCells = ((typeof readForm === 'function' ? (readForm().worldWidth | 0) : 0) || 120) * 10;
      hi = imageToMaps(IMPORT_RES, wwCells / IMPORT_RES); biomeOut = hi.biome; heightOut = hi.height;
      waterOut = hi.water; anyWater = hi.water.some(v => v > 0);   // enclosed water in the image -> lakes
    }
    // `hiRes` is 0 unless this came from a pure image import - the bundle reports it, and it is the only
    // thing left in buildBundleFiles that depended on `hi`, which lives here now.
    return { res: hi ? hi.res : N, hiRes: hi ? hi.res : 0, biome: biomeOut, height: heightOut,
             water: waterOut, anyWater: anyWater, paintHeight: heightBin };
  }

  async function buildBundleFiles() {
    const cfg = buildExportJson();              // the WorldGenerator.eco (main-thread), current form values
    const m = buildExportMaps();
    const biomeOut = m.biome, heightOut = m.height, waterOut = m.water, anyWater = m.anyWater;
    const heightBin = m.paintHeight;
    // PNGs kept for human inspection only (not read by the mod), so they stay at paint resolution.
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
    return { size: (cfg && findWorldWidth(cfg)) || 72, files: files, hiRes: m.hiRes };
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
    // Seeding from the map is asynchronous, so the design can still be blank ocean a moment after the
    // designer opens. Generating that produces a world with no land anywhere, and it takes minutes to find
    // out. Check before spending them.
    if (designIsEmpty(target)) {
      setGenLine('This design is all ocean — wait a moment for it to seed from the map, or paint some land first.', true);
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
        const ref = $('dsnTargetRef'); if (ref) drawGrid(ref, target);
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
    // The SAME maps the service is handed. This used to be computeTerrain() on the 128-cell paint grid with
    // no water map at all, which is why the preview stopped resembling the finished world: measured against
    // a generated world it was 24 blocks RMS out, 77% of columns off by 5 or more, agreeing on land-vs-sea
    // for only 30% of them, and showing none of the 25,646 columns of fresh water the world has. The export
    // itself predicts that world to 2.2 blocks RMS, so previewing the export is worth 10x.
    const m = buildExportMaps();
    return { type: '3d-authored', G: m.res, biome: m.biome, height: m.height,
             water: m.anyWater ? m.water : null, cfg: cfg, terrain: terrain };
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
