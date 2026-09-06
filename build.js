// Build script: inlines src/*.js + vectortable + the default WorldGenerator.eco into a single self-contained index.html.
// Usage: node build.js
const fs = require('fs');

function strip(src) {
  return src.split(/\r?\n/).filter(l => {
    const t = l.trim();
    if (t.startsWith('if (typeof module')) return false;
    if (t.startsWith('if (typeof require')) return false;
    if (t.startsWith('let C, G;')) return false;
    if (t.startsWith('function bind(')) return false;
    return true;
  }).join('\n');
}

const core = strip(fs.readFileSync('src/core.js', 'utf8'));
const geo = strip(fs.readFileSync('src/geo.js', 'utf8'));
const worldgen = strip(fs.readFileSync('src/worldgen.js', 'utf8'));
const raster = strip(fs.readFileSync('src/raster.js', 'utf8'));
const voxel = strip(fs.readFileSync('src/voxel.js', 'utf8'));
const search = strip(fs.readFileSync('src/search.js', 'utf8'));   // inverse-design search core (worker + main thread)
const vt = fs.readFileSync('src/vectortable.txt', 'utf8').trim();
const defaultEco = fs.readFileSync('WorldGenerator.eco', 'utf8').trim();
// three.js (UMD, sets global THREE) and the main-thread 3D renderer are injected via
// placeholders AFTER the template literal is built, so their backticks/${} don't need escaping.
const threeSrc = fs.readFileSync('src/vendor/three.min.js', 'utf8');
const render3dSrc = fs.readFileSync('src/render3d.js', 'utf8');
const designerSrc = fs.readFileSync('src/designer.js', 'utf8');   // "Design a map" (main thread; injected raw)

const LIB = [core, geo, worldgen, raster, voxel, search,
  `const C = { CsRandom, Perlin, Billow, RidgedMulti, ScaleBias, gradientCoherentNoise3D, setVectorTable, NQ };`,
  `const G = { poissonSamples, Voronoi };`,
  `bindVoxel(C);`
].join('\n\n');

const WORKER_GLUE = `
let lastRes = null;   // keep the last generate() result so the 3D view can request raster grids lazily
let vGrid = null, vCtx = null, vChunks = null, vSource = null;   // 3D voxel view: raster grid, terrain ctx, per-chunk column cache, and which view built it ('map'|'authored')
onmessage = function (e) {
  const m = e.data;
  if (m.type === 'init') { setVectorTable(m.vt); postMessage({ type: 'ready' }); return; }
  if (m.type === 'gen') {
    try {
      const res = generate(m.cfg, { progress: s => postMessage({ type: 'progress', phase: s }) });
      lastRes = res; vGrid = null; vCtx = null; vChunks = null; vSource = null;   // stale 3D caches
      const polys = res.polys.map(p => {
        const pts = new Float32Array(p.points.length * 2);
        for (let i = 0; i < p.points.length; i++) { pts[i*2] = p.points[i].x; pts[i*2+1] = p.points[i].y; }
        return { cx: p.center.x, cy: p.center.y, pts, c: p.biome.color, lake: p.hasLake, river: p.hasRiver, e: p.elevation, t: p.temperature, mo: p.moisture, name: p.biome.name };
      });
      const rivers = res.rivers.map(r => r.map(c => ({ x: c.center.x, y: c.center.y, e: c.elevation })));
      const counts = {}; for (const p of res.polys) counts[p.biome.name] = (counts[p.biome.name] || 0) + 1;
      postMessage({ type: 'done', worldSize: res.worldSize, polys, rivers,
        stats: { continents: res.numContinents, islands: res.numSmallIslands, lakes: res.numLakes, rivers: res.numRivers, landPercent: res.landPercent, counts } });
    } catch (err) { postMessage({ type: 'error', message: String(err && err.stack || err) }); }
  }
  // ---- 3D voxel view (its own message types so it never clashes with generation) ----
  if (m.type === '3d-init') {
    try {
      if (!lastRes) { postMessage({ type: 'v3d-error', message: 'No world generated yet' }); return; }
      if (vCtx && vCtx._deposits && vGrid && vSource === 'map') {   // reuse the precomputed layer on reopen (invalidated on regenerate / authored preview)
        postMessage({ type: 'v3d-ready', W: vGrid.W, waterLevel: m.cfg.waterLevel, maxGenerationHeight: m.cfg.maxGenerationHeight,
          gray: vGrid.gray.slice(), biome: vGrid.biome.slice(), biomeNames: vGrid.biomeNames });
        return;
      }
      if (!vGrid) vGrid = rasterize(lastRes.polys, lastRes.worldSize, { progress: (ph, f) => postMessage({ type: 'v3d-progress', phase: ph, frac: f }) });
      const cfg = m.cfg;
      vCtx = initTerrain(m.terrain, cfg);
      const W = vGrid.W, names = vGrid.biomeNames, biome = vGrid.biome, gray = vGrid.gray;
      vCtx.grayAt = (x, z) => gray[z * W + x];
      vCtx.biomeAt = (x, z) => names[biome[z * W + x]];
      computeDeposits(vCtx, vGrid, (ph, f) => postMessage({ type: 'v3d-progress', phase: ph, frac: f }));   // precompute the ore-vein overlay
      vChunks = new Map(); vSource = 'map';
      const grayCopy = gray.slice(), biomeCopy = biome.slice();   // copies so the worker keeps its grids
      postMessage({ type: 'v3d-ready', W: W, waterLevel: cfg.waterLevel, maxGenerationHeight: cfg.maxGenerationHeight,
        gray: grayCopy, biome: biomeCopy, biomeNames: names },
        [grayCopy.buffer, biomeCopy.buffer]);
    } catch (err) { postMessage({ type: 'v3d-error', message: String(err && err.stack || err) }); }
  }
  // Authored design -> 3D: build the voxel grids straight from the painted biome + height maps
  // (upscaled to world size, painter classes mapped to real biomes), then reuse the same chunk mesher.
  if (m.type === '3d-authored') {
    try {
      const cfg = m.cfg, Gg = m.G, W = cfg.worldWidth * 10;
      const src = m.biome, hsrc = m.height, wsrc = m.water || null;
      const CLS2RB = [RB_ID.DeepOcean, RB_ID.WarmCoast, RB_ID.Grassland, RB_ID.WarmForest, RB_ID.ColdForest, RB_ID.RainForest, RB_ID.Desert, RB_ID.Taiga, RB_ID.Tundra, RB_ID.Ice, RB_ID.Wetland];
      const biome = new Uint8Array(W * W), gray = new Uint8Array(W * W);
      const wrap = (v, n) => ((v % n) + n) % n;
      for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) {
        const xc = (x * Gg / W) | 0, zc = (z * Gg / W) | 0, cls = src[zc * Gg + xc];        // biome: nearest upscale
        biome[z * W + x] = cls < CLS2RB.length ? CLS2RB[cls] : RB_ID.DeepOcean;
        const fx = (x + 0.5) * Gg / W - 0.5, fz = (z + 0.5) * Gg / W - 0.5;                  // height: bilinear + toroidal (matches the mod)
        const x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0;
        const x0w = wrap(x0, Gg), x1w = wrap(x0 + 1, Gg), z0w = wrap(z0, Gg), z1w = wrap(z0 + 1, Gg);
        const v00 = hsrc[z0w * Gg + x0w], v10 = hsrc[z0w * Gg + x1w], v01 = hsrc[z1w * Gg + x0w], v11 = hsrc[z1w * Gg + x1w];
        const top = v00 + (v10 - v00) * tx, bot = v01 + (v11 - v01) * tx;
        gray[z * W + x] = Math.round(top + (bot - top) * tz);
      }
      // Fresh water is a per-column surface, not a plane: the export carries it as waterValue*255 and the
      // server fills each column up to WaterLevel + (MaxGen - WaterLevel) * value. Without this the preview
      // can only ever show the sea, so every river and lake in the design is missing from it.
      let wy = null;
      if (wsrc) {
        wy = new Int16Array(W * W);
        const WLv = cfg.waterLevel, MHv = cfg.maxGenerationHeight;
        for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) {
          const xc = (x * Gg / W) | 0, zc = (z * Gg / W) | 0, b = wsrc[zc * Gg + xc];
          wy[z * W + x] = b > 0 ? WLv + Math.trunc((MHv - WLv) * (b / 255)) : 0;
        }
      }
      vGrid = { W: W, biome: biome, gray: gray, biomeNames: RASTER_BIOMES };
      vCtx = initTerrain(m.terrain, cfg);
      vCtx.grayAt = (x, z) => gray[z * W + x];
      vCtx.biomeAt = (x, z) => RASTER_BIOMES[biome[z * W + x]];
      vCtx.waterYAt = wy ? (x, z) => wy[z * W + x] : null;
      computeDeposits(vCtx, vGrid, (ph, f) => postMessage({ type: 'v3d-progress', phase: ph, frac: f }));
      vChunks = new Map(); vSource = 'authored';
      const grayCopy = gray.slice(), biomeCopy = biome.slice();
      postMessage({ type: 'v3d-ready', W: W, waterLevel: cfg.waterLevel, maxGenerationHeight: cfg.maxGenerationHeight,
        gray: grayCopy, biome: biomeCopy, biomeNames: RASTER_BIOMES }, [grayCopy.buffer, biomeCopy.buffer]);
    } catch (err) { postMessage({ type: 'v3d-error', message: String(err && err.stack || err) }); }
  }
  if (m.type === 'chunk') {
    try {
      if (!vCtx) { postMessage({ type: 'v3d-error', message: '3D not initialized' }); return; }
      const key = m.cx + ',' + m.cz;
      let ch = vChunks.get(key);
      if (!ch) { ch = genChunkColumns(vCtx, m.cx, m.cz, m.CHUNK); vChunks.set(key, ch); }
      const g = meshChunkFromCols(ch, m.hidden, m.sliceTop);
      postMessage({ type: 'v3d-chunkmesh', cx: m.cx, cz: m.cz, pos: g.pos, nor: g.nor, pal: g.pal, palette: g.palette },
        [g.pos.buffer, g.nor.buffer, g.pal.buffer]);
    } catch (err) { postMessage({ type: 'v3d-error', message: String(err && err.stack || err) }); }
  }
  if (m.type === 'chunkdrop') { if (vChunks) vChunks.delete(m.cx + ',' + m.cz); }
  // ---- inverse-design search (own message types) ----
  if (m.type === 'classgrid') {   // coarse class-grid signature of the current map (for "seed from current map")
    try {
      if (!lastRes) { postMessage({ type: 'classgrid', grid: null }); return; }
      const grid = classGridAt(lastRes.polys, lastRes.worldSize, m.G, { lakesAsLand: true });
      const w = waterGridAt(lastRes.polys, lastRes.rivers, lastRes.worldSize, m.G);
      postMessage({ type: 'classgrid', G: m.G, grid, water: w.mask, waterElev: w.elev },
                  [grid.buffer, w.mask.buffer, w.elev.buffer]);
    } catch (err) { postMessage({ type: 'search-error', message: String(err && err.stack || err) }); }
  }
  if (m.type === 'search-init') { sTarget = m.target; sG = m.G; sW = m.layoutWeight; postMessage({ type: 'search-ready' }); }
  if (m.type === 'search-eval') {   // generate one candidate (biomes only), rasterize + score vs the target
    try {
      const res = generate(m.cfg, { biomesOnly: true });
      const grid = classGridAt(res.polys, res.worldSize, sG);
      const s = scoreGrids(sTarget, grid, sG, { layoutWeight: sW });
      postMessage({ type: 'search-result', seed: m.cfg.seed, jobId: m.jobId, grid,
        score: s.score, prop: s.prop, soft: s.soft, exact: s.exact, iou: s.iou, layout: s.layout, shift: s.shift,
        landPercent: res.landPercent }, [grid.buffer]);
    } catch (err) { postMessage({ type: 'search-error', jobId: m.jobId, message: String(err && err.stack || err) }); }
  }
};
let sTarget = null, sG = 64, sW = 0.6;`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eco WorldGen map preview</title>
<style>
  :root{
    --bg:#f7f6f2; --surf:#ffffff; --surf1:#f1efe8; --text:#1a1a18; --text2:#56554f; --muted:#8a887f;
    --border:rgba(0,0,0,.12); --border2:rgba(0,0,0,.28); --accent:#185fa5; --water:#3987e5;
    --radius:8px; --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#161614; --surf:#1f1e1c; --surf1:#26251f; --text:#f3f1ea; --text2:#c3c2b7; --muted:#8a887f;
      --border:rgba(255,255,255,.14); --border2:rgba(255,255,255,.32); --accent:#5a9bdf; --water:#5a9bdf; }
  }
  *{box-sizing:border-box}
  body{margin:0; background:var(--bg); color:var(--text); font-family:var(--font); font-size:15px; line-height:1.5; padding:24px;}
  .wrap{max-width:1440px; margin:0 auto;}
  #mainCols{display:flex; gap:22px; align-items:flex-start; margin-top:16px;}
  #leftCol{flex:1 1 auto; min-width:0; display:flex; flex-direction:column;}
  #leftCol > #panel{margin-top:0; order:0;}
  #leftCol > #chartsPanel{order:-1;}   /* Underground sits above the map/designer, collapsed by default */
  #mainCols > #cfgPanel{flex:0 0 344px; margin-top:0; position:sticky; top:10px; max-height:calc(100vh - 20px); overflow:auto;}
  @media(max-width:1080px){ #mainCols{flex-direction:column;} #mainCols > #cfgPanel{flex:1 1 auto; width:100%; position:static; max-height:none;} }
  h1{font-size:21px; font-weight:600; margin:0 0 4px;}
  p.sub{color:var(--text2); margin:0 0 20px; font-size:14px;}
  #drop{border:1.5px dashed var(--border2); border-radius:12px; padding:22px; text-align:center; color:var(--text2);
    background:var(--surf); transition:.15s; cursor:pointer;}
  #drop.over{border-color:var(--accent); color:var(--text); background:var(--surf1);}
  #drop strong{color:var(--text);}
  .row{display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin:14px 0;}
  textarea{width:100%; min-height:80px; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px;
    border:0.5px solid var(--border); border-radius:var(--radius); padding:10px; background:var(--surf); color:var(--text); resize:vertical;}
  button{border:0.5px solid var(--border2); background:var(--surf); color:var(--text); padding:7px 14px;
    border-radius:var(--radius); font-size:13px; cursor:pointer; font-family:inherit;}
  button:hover{background:var(--surf1);}
  button.primary{background:var(--accent); color:#fff; border-color:var(--accent);}
  button:disabled{opacity:.5; cursor:default;}
  .seg{display:inline-flex; border:0.5px solid var(--border2); border-radius:var(--radius); overflow:hidden;}
  .seg button{border:none; border-radius:0; background:transparent;}
  .seg button.on{background:var(--accent); color:#fff; font-weight:600;}
  .lbl{font-size:12px; color:var(--text2);}
  input[type=number],input[type=text]{border:0.5px solid var(--border); border-radius:var(--radius); padding:6px 8px; background:var(--surf); color:var(--text); font-family:inherit; font-size:13px; width:130px;}
  #meta{font-size:13px; color:var(--text2); margin:6px 0 0; min-height:18px;}
  #err{color:#c0392b; font-size:13px; margin:8px 0; white-space:pre-wrap;}
  #panel{display:none; margin-top:18px;}
  #canvasWrap{display:inline-block; position:relative; border:0.5px solid var(--border); border-radius:12px; background:var(--surf); padding:8px; line-height:0;}
  canvas{border-radius:6px; max-width:100%; height:auto; image-rendering:auto; cursor:crosshair;}
  #cv{width:100%;}   /* fill the left column so the map sits snug against the config sidebar */
  #srcBox{border:0.5px solid var(--border); border-radius:10px; background:var(--surf); padding:6px 12px; margin-bottom:6px;}
  #srcBox summary{cursor:pointer; font-weight:600; font-size:13px; user-select:none; padding:2px 0;}
  #srcBox[open] summary{margin-bottom:6px;}
  #legend{display:flex; flex-wrap:wrap; gap:8px 16px; margin-top:12px; font-size:12px; color:var(--text2); align-items:center;}
  .sw{width:12px; height:12px; border-radius:2px; display:inline-block; vertical-align:-1px; margin-right:6px; border:0.5px solid var(--border);}
  #stats{font-size:13px; color:var(--text2); margin-top:10px;}
  #stats b{color:var(--text); font-weight:600;}
  #prog{display:none; margin-top:14px; font-size:13px; color:var(--text2);}
  .bar{height:6px; background:var(--surf1); border-radius:3px; overflow:hidden; margin-top:6px; max-width:420px;}
  .bar>div{height:100%; width:0; background:var(--accent); transition:width .2s;}
  #tip{position:absolute; display:none; pointer-events:none; background:var(--surf); border:0.5px solid var(--border2); border-radius:var(--radius); padding:6px 9px; font-size:12px; line-height:1.5; z-index:5; box-shadow:0 2px 10px rgba(0,0,0,.15); white-space:nowrap;}
  a{color:var(--accent);}
  .foot{margin-top:22px; font-size:12px; color:var(--muted);}
  code{background:var(--surf1); padding:1px 5px; border-radius:4px; font-size:12px;}
  #cfgPanel{display:none; margin-top:16px; border:0.5px solid var(--border); border-radius:12px; background:var(--surf); padding:6px 14px 12px;}
  #cfgPanel details{border-top:0.5px solid var(--border); padding:6px 0;}
  #cfgPanel details:first-of-type{border-top:none;}
  #cfgPanel summary{cursor:pointer; font-weight:600; font-size:13px; color:var(--text); padding:4px 0; user-select:none;}
  .cfgGrid{display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px 14px; margin:8px 0 4px;}
  .cfgF{display:flex; flex-direction:column; gap:3px; font-size:12px; color:var(--text2);}
  .cfgF>span{white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
  .cfgF input[type=number]{width:100%;}
  .cfgRange{display:flex; align-items:center; gap:5px;}
  .cfgRange input{width:100%; min-width:0;}
  .cfgRange em{color:var(--muted); font-style:normal;}
  .cfgBool{flex-direction:row; align-items:center; gap:6px;}
  .cfgActions{display:flex; gap:10px; margin-top:12px; align-items:center; flex-wrap:wrap;}
  #mixBar{display:flex; height:20px; border-radius:5px; overflow:hidden; border:0.5px solid var(--border); margin:8px 0 4px; background:var(--surf1);}
  #mixBar>span{display:block;}
  #mixSum{font-size:12px; margin-bottom:8px;}
  #mixSum b{color:var(--text);}
  #mixSum .over{color:#c0392b; font-weight:600;}
  .mixRow{display:flex; align-items:center; gap:8px; padding:3px 0; font-size:12.5px;}
  .mixRow .msw{width:13px; height:13px; border-radius:3px; border:0.5px solid var(--border2); flex:none;}
  .mixRow .mnm{flex:1; color:var(--text); min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
  .mixRow input{width:64px; text-align:right;}
  .mixRow .pct{color:var(--muted); width:14px;}
  .mixRow .mact{color:var(--accent); width:70px; text-align:right; font-size:11.5px;}
  .mixRow.mixGrass input{background:var(--surf1); color:var(--text2);}
  #chartsPanel{display:none; margin:0 0 14px; border:0.5px solid var(--border); border-radius:12px; background:var(--surf); padding:6px 14px 12px;}
  #chartsPanel > summary{cursor:pointer; user-select:none; padding:4px 0; list-style-position:inside;}
  #chartTabs button{font-size:13px; padding:6px 13px;}
  #ovBiomes{display:flex; gap:6px; flex-wrap:wrap; margin:6px 0 2px;}
  #ovLane svg{max-width:100%;}
  .oreNode{display:flex; align-items:center; gap:7px 10px; flex-wrap:wrap; padding:6px 0; border-top:0.5px solid var(--border); font-size:12px; color:var(--text2);}
  .oreNode:first-of-type{border-top:none;}
  .oreNode .ndot{width:11px; height:11px; border-radius:50%; border:0.5px solid var(--border2); flex:none;}
  .oreNode select{border:0.5px solid var(--border); border-radius:6px; padding:4px 6px; background:var(--surf); color:var(--text); font-size:12px; font-family:inherit; max-width:190px;}
  .oreNode .tag{font-size:10px; padding:1px 6px; border-radius:10px; background:var(--surf1); color:var(--muted); flex:none;}
  .oreNode .kk{display:inline-flex; align-items:center; gap:5px; color:var(--muted);}
  .oreNode .kk label{color:var(--muted); font-size:11px;}
  .oreNode input[type=range]{width:76px; vertical-align:middle; accent-color:var(--accent);}
  .oreNode input.kv{width:56px; border:0.5px solid var(--border); border-radius:5px; padding:2px 5px; background:var(--surf); color:var(--text); font-size:11px; text-align:right; font-variant-numeric:tabular-nums;}
  .oreNode .dash{color:var(--muted);}
  .oreNode .ndel{margin-left:auto; border:none; background:transparent; color:var(--muted); font-size:13px; padding:2px 7px; cursor:pointer; border-radius:5px;}
  .oreNode .ndel:hover{color:#c0392b; background:var(--surf1);}
  .ovRow{display:flex; align-items:center; gap:6px; padding:3px 6px; border-radius:6px; cursor:pointer; font-size:12px; line-height:1.5;}
  .ovRow:hover{background:var(--surf1);}
  .ovRow.sel{outline:1.5px solid var(--accent); background:var(--surf1);}
  .ovRow .ltag{color:var(--muted); font-size:9.5px; text-transform:uppercase; letter-spacing:.03em; flex:0 0 auto; width:44px;}
  .ovRow .lnm{flex:1 1 auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
  /* the row markup has always emitted a colour dot, but only .oreNode .ndot was ever given a size,
     so in this list it collapsed to nothing. Give it one - the colour is the fastest way to read the list. */
  .ovRow .ndot{width:9px; height:9px; border-radius:50%; border:0.5px solid var(--border2); flex:0 0 auto;}
  .ovRow .lmeta{display:flex; align-items:center; gap:5px;}
  .ovRow .lends{opacity:.6;}
  .ovRow .lis.mixed{font-style:italic; opacity:.75;}
  /* how much of the world this layer is actually the rock in - a measured share, not a verdict */
  .ovRow .lpct{min-width:32px; text-align:right; font-weight:600;}
  .ovRow .lpct.lv-hi{color:#5fa463;} .ovRow .lpct.lv-mid{color:#c99a3f;} .ovRow .lpct.lv-lo{color:#c0705a;}
  .ovRow .lmeta{color:var(--muted); font-size:10.5px; flex:0 0 auto; font-variant-numeric:tabular-nums; white-space:nowrap;}
  /* a scatter/vein lives INSIDE a stratum - indent it under its parent and run a guide line down the group */
  .ovRow.sub{margin-left:9px; padding-left:13px; border-left:1px solid var(--border);}
  .ovRow.sub .ltag{width:32px;}
  .ovRow .ndel{border:none; background:transparent; color:var(--muted); font-size:12px; padding:0 5px; cursor:pointer; border-radius:5px; opacity:0; flex:0 0 auto;}
  .ovRow:hover .ndel, .ovRow.sel .ndel{opacity:1;}
  .ovRow .ndel:hover{color:#c0392b; background:var(--surf);}
  #ovLane{position:relative;}
  #ovProbe{position:absolute; z-index:5; pointer-events:none; display:none; max-width:260px; padding:6px 8px;
    border:0.5px solid var(--border2); border-radius:7px; background:var(--surf); color:var(--text);
    font-size:11.5px; line-height:1.5; box-shadow:0 4px 14px rgba(0,0,0,.35);}
  #ovProbe .pd{color:var(--muted); margin-bottom:3px;}
  #ovProbe .pr{display:flex; gap:6px; align-items:center;}
  #ovProbe .pr b{margin-left:auto; font-variant-numeric:tabular-nums;}
  #ovProbe .pdot{width:8px; height:8px; border-radius:50%; flex:0 0 auto; border:0.5px solid var(--border2);}
  #ovProbe .psub{color:var(--muted); margin-top:4px; border-top:0.5px solid var(--border); padding-top:3px;}
  .ovRow[draggable]{cursor:grab;}
  .ovRow.dragging{opacity:.4;}
  .ovRow.dropInto{outline:1.5px dashed var(--accent); outline-offset:-1px;}
  .ovRow.dropAt{box-shadow:inset 0 2px 0 var(--accent);}
  .oreNode .nmv{border:none; background:transparent; color:var(--muted); font-size:10px; padding:2px 4px; cursor:pointer; border-radius:5px; line-height:1;}
  .oreNode .nmv:hover:not(:disabled){color:var(--text); background:var(--surf1);}
  .oreNode .nmv:disabled{opacity:.25; cursor:default;}
  .oreAdd{display:flex; gap:8px; padding:9px 0 5px;}
  .oreAdd button{font-size:12px; padding:4px 11px;}
  #blockChartWrap{width:100%; overflow-x:auto; position:relative; border:0.5px solid var(--border); border-radius:12px; background:var(--surf); padding:6px 0; margin-top:4px;}
  #blockChart svg{max-width:100%; height:auto;}
  #blockTip{position:absolute; display:none; pointer-events:none; background:var(--surf); border:0.5px solid var(--border2); border-radius:var(--radius); padding:8px 10px; font-size:12px; line-height:1.5; max-width:290px; z-index:5; box-shadow:0 2px 10px rgba(0,0,0,.15);}
  #blockLegend{display:flex; flex-wrap:wrap; gap:10px 16px; margin-top:12px; font-size:12px; color:var(--text2); align-items:center;}
</style>
</head>
<body>
<div class="wrap">

  <details id="srcBox" open>
    <summary id="srcSummary">📁 Config source <span class="lbl">— using the default world · drop or paste your own below</span></summary>
    <div id="drop" style="margin-top:8px">
      <strong>Drop a WorldGenerator.eco file here</strong>, or <label style="color:var(--accent); cursor:pointer; text-decoration:underline">browse<input id="file" type="file" accept=".eco,.json,application/json" style="display:none"></label>
      <div style="font-size:13px; margin-top:4px;">— or paste the JSON below —</div>
    </div>
    <textarea id="paste" placeholder="Paste WorldGenerator.eco JSON here, then click Load"></textarea>
    <div class="row"><button class="primary" id="loadCfg">Load pasted config</button></div>
  </details>
  <div class="row" style="margin-top:8px">
    <span class="lbl">Seed override</span><input type="text" id="seed" placeholder="(from config)"><button id="randSeed" title="Random seed &amp; regenerate">🎲 Randomize</button>
  </div>
  <div id="err"></div>
  <div id="meta"></div>
  <div id="prog">Generating… <span id="progPhase"></span><div class="bar"><div id="progBar"></div></div></div>

  <div id="mainCols">
  <div id="leftCol">
  <div id="panel">
    <div class="row" id="surfaceBar">
      <span class="lbl">Layer</span><span class="seg" id="layers"></span>
      <label class="lbl" style="display:inline-flex;align-items:center;gap:5px;margin-left:8px"><input type="checkbox" id="waterToggle" checked> Rivers &amp; lakes</label>
      <button id="designOpen" style="margin-left:auto">🎨 Design a map</button>
      <button id="findOpen">🔍 Find a map</button>
      <button id="view3d">🧊 3D view</button>
      <button id="expPng">Export PNG</button>
    </div>
    <div id="canvasWrap"><canvas id="cv"></canvas><div id="tip"></div></div>
    <div id="legend"></div>
    <div id="stats"></div>

    <div id="view3dWrap" style="display:none">
      <div class="row" style="margin:4px 0 8px">
        <strong style="font-size:15px">🧊 3D voxel world</strong>
        <span class="lbl" id="view3dStatus" style="margin-left:6px"></span>
        <button id="view3dRefresh" style="margin-left:auto" title="Rebuild the 3D view from the current design/map">⟳ Refresh</button>
        <button id="view3dClose" style="margin-left:8px">← Back to map</button>
      </div>
      <div id="view3dCanvas" style="width:100%;height:70vh;min-height:420px;border-radius:var(--radius);overflow:hidden;background:#8fbcd4;position:relative"></div>
      <div class="lbl" style="margin-top:6px"><b>Drag</b> to look around · <b>W A S D</b> move · <b>Space / Q</b> up · <b>Shift / E</b> down · scroll to change speed</div>
      <div class="row" style="margin:8px 0 2px;align-items:baseline">
        <strong style="font-size:13px">Blocks</strong>
        <span class="lbl">— untick to hide a block type and see through it</span>
        <button id="view3dHideSoil" style="margin-left:auto;font-size:12px;padding:4px 9px">Hide surface soils</button>
        <button id="view3dHideAll" style="font-size:12px;padding:4px 9px">Hide all</button>
        <button id="view3dShowAll" style="font-size:12px;padding:4px 9px">Show all</button>
      </div>
      <div id="view3dBlocks" style="display:flex;flex-wrap:wrap;gap:5px 14px;font-size:12.5px"></div>
    </div>

    <div id="designWrap" style="display:none"></div>
  </div>

  <details id="chartsPanel">
    <summary><strong style="font-size:15px;">🧱 Underground</strong> <span class="lbl">block composition &amp; ore editor — applies to the generated / authored world</span></summary>
    <div class="row" style="margin:8px 0 4px;">
      <span class="seg" id="chartTabs">
        <button type="button" data-tab="block" class="on">Block composition</button>
        <button type="button" data-tab="edit">Editor</button>
      </span>
    </div>

    <div id="blockTab">
      <div style="display:flex;align-items:center;gap:10px;margin:2px 0;flex-wrap:wrap;">
        <span class="lbl">what a column is made of, top to bottom, per biome</span>
        <span class="lbl" id="blockMeta" style="margin-left:10px"></span>
      </div>
      <div id="blockChartWrap"><div id="blockChart"></div><div id="blockTip"></div></div>
      <div id="blockLegend"></div>
    </div>

    <div id="editTab" style="display:none">
      <div id="oreVisualTab">
        <div class="lbl" style="margin:4px 0 6px">Pick a biome — the column is drawn in depth below the surface, the engine's own coordinate. The stack shows how often each block is the rock at each depth; every layer's end is a fuzzy band, densest where its per-column draw usually lands. Drag a band's core to move where a layer ends, its edges to change the spread. The bars beside the stack are each vein's and fill's depth setting (hatched where its own layer is not the rock, so it cannot act): drag one to move it, its ends to resize; drag a ribbon's inner edge to change abundance. Select a vein and one deposit is drawn beside its bar at the same scale, in the dashed box it is allowed to grow in — that is the size you actually dig into, which the bar alone cannot tell you. The right edge reads depth back as world Y under this biome's mean surface.</div>
        <div id="ovBiomes"></div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;justify-content:center;margin-top:8px">
          <div id="ovLane" style="flex:0 0 auto;border:0.5px solid var(--border);border-radius:12px;background:var(--surf);padding:6px 10px;overflow-x:auto;max-width:100%"></div>
          <div style="flex:1 1 240px;min-width:230px;max-width:340px">
            <div class="lbl" style="margin:0 0 4px">All blocks — click to select, ✕ to remove, ▲▼ or drag to reorder and to move between layers. Layers are walked in order; within a layer the first match wins.</div>
            <div id="ovList" style="max-height:260px;overflow-y:auto;margin-bottom:10px;border:0.5px solid var(--border);border-radius:8px;padding:4px"></div>
            <div id="ovDetail"></div>
            <div class="oreAdd" style="margin-top:8px"><button id="ovAddVein">+ vein</button><button id="ovAddScatter">+ fill</button></div>
          </div>
        </div>
      </div>
    </div>
  </details>
  </div>

  <div id="cfgPanel">
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 2px;">
      <strong style="font-size:15px;">Config</strong>
      <span class="lbl">edit any value, then Regenerate</span>
    </div>
    <div id="cfgForm"></div>
    <div class="cfgActions">
      <button class="primary" id="regen">Regenerate map</button>
      <button id="resetCfg">Reset to loaded</button>
      <label class="lbl" style="display:inline-flex;align-items:center;gap:5px;margin-left:auto" title="Max canvas resolution for the 2D map render">Max render px <input type="number" id="maxpx" value="1200" min="200" max="2000" step="100" style="width:74px"></label>
      <button id="dlEco">Download .eco</button>
    </div>
  </div>
  </div>

</div>

<script type="text/plain" id="libsrc">
${LIB}
${WORKER_GLUE}
</script>
<script type="text/plain" id="vtsrc">${vt}</script>
<script type="application/json" id="defaultcfg">${defaultEco}</script>

<script>/*__THREE__*/</script>
<script>/*__RENDER3D__*/</script>
<script>/*__SEARCH__*/</script>
<script>
"use strict";
const $ = id => document.getElementById(id);
const VT = $('vtsrc').textContent.trim().split(',').map(Number);

// biome color legend (name -> [r,g,b]); mirrors server Biome colors
const BIOME_COLORS = {
  DeepOcean:[70,130,180], Ocean:[135,206,250], Coast:[250,250,210], Grassland:[144,238,144],
  WarmForest:[184,134,11], ColdForest:[34,139,34], RainForest:[32,178,170], Desert:[244,164,96],
  Taiga:[107,142,35], Tundra:[189,183,107], Ice:[255,255,255], Wetland:[0,100,0],
  ColdCoast:[224,255,255], WarmCoast:[250,250,210], Steppe:[144,238,144], HighDesert:[244,164,96]
};
const BIOME_ORDER = ['DeepOcean','Ocean','ColdCoast','WarmCoast','Grassland','Steppe','WarmForest','ColdForest','RainForest','Wetland','Desert','HighDesert','Taiga','Tundra','Ice'];

// ---- worker ----
let worker = null, workerReady = false;
function makeWorker() {
  const src = $('libsrc').textContent;
  const blob = new Blob([src], { type: 'application/javascript' });
  const w = new Worker(URL.createObjectURL(blob));
  return w;
}

// ---- config parsing ----
function findByKey(obj, key, seen) {
  seen = seen || new Set();
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj;
  for (const k in obj) { const r = findByKey(obj[k], key, seen); if (r) return r; }
  return null;
}
const rng = (o, d) => o ? { min: +o.min, max: +o.max } : d;
function parseConfig(text, seedOverride) {
  const j = JSON.parse(text);
  const vc = findByKey(j, 'PointRadius');
  if (!vc) throw new Error('Could not find the Voronoi world config (no "PointRadius" field). Is this a WorldGenerator.eco file?');
  const dim = findByKey(j, 'WorldWidth') || {};
  const ww = +(dim.WorldWidth) || 72;
  const cfg = {
    worldWidth: ww, worldLength: +(dim.WorldLength) || ww,
    waterLevel: j.WaterLevel ?? 60, maxGenerationHeight: j.MaxGenerationHeight ?? 120,
    seed: (seedOverride !== null && seedOverride !== undefined && seedOverride !== '') ? (seedOverride|0) : ((vc.Seed|0) || (Math.trunc(Math.random()*4294967296)|0)), // Eco treats seed 0 as "random"
    pointRadius: +vc.PointRadius,
    landPercentRange: rng(vc.LandPercentRange, {min:.65,max:.75}),
    coastlineSize: vc.CoastlineSize ?? 1, shallowOceanSize: vc.ShallowOceanSize ?? 2,
    desertWeight:+vc.DesertWeight||0, warmForestWeight:+vc.WarmForestWeight||0, coolForestWeight:+vc.CoolForestWeight||0,
    taigaWeight:+vc.TaigaWeight||0, tundraWeight:+vc.TundraWeight||0, iceWeight:+vc.IceWeight||0,
    rainforestWeight:+vc.RainforestWeight||0, wetlandWeight:+vc.WetlandWeight||0, steppeWeight:+vc.SteppeWeight||0, highDesertWeight:+vc.HighDesertWeight||0,
    numContinentsRange: rng(vc.NumContinentsRange, {min:1,max:1}), continentAvoidRange: rng(vc.ContinentAvoidRange, {min:8,max:16}),
    numSmallIslandsRange: rng(vc.NumSmallIslandsRange, {min:1,max:3}), islandAvoidRange: rng(vc.IslandAvoidRange, {min:4,max:8}),
    islandWeight:+vc.IslandWeight||0,
    numRainforests:vc.NumRainforests||0, numWarmForests:vc.NumWarmForests||0, numCoolForests:vc.NumCoolForests||0,
    numTaigas:vc.NumTaigas||0, numTundras:vc.NumTundras||0, numIces:vc.NumIces||0, numDeserts:vc.NumDeserts||0,
    numWetlands:vc.NumWetlands||0, numHighDeserts:vc.NumHighDeserts||0, numSteppes:vc.NumSteppes||0,
    lakeSizeRange: rng(vc.LakeSizeRange, {min:.0018,max:.003}), numLakesRange: rng(vc.NumLakesRange, {min:2,max:4}),
    numRiversRange: rng(vc.NumRiversRange, {min:1,max:3}), riverCellAvoidance: vc.RiverCellAvoidance ?? 2, riverCellWidth: +vc.RiverCellWidth||10,
    maxElevationOceanDistance: +vc.MaxElevationOceanDistance||12, elevationPower: +vc.ElevationPower||2,
    autoScale: vc.AutoScale ?? false, autoScaleExponent: +vc.AutoScaleExponent||.25,
  };
  return cfg;
}

// ---- state ----
let result = null, cfgUsed = null, layer = 'biomes', showWater = true, flipY = true, scale = 1, renderPx = 900;
let rawJson = null, baseCfg = null;

// ---- editable config form ----
// [key, label, type, step]  types: int, float, range-int, range-float, bool
const CFG_GROUPS = [
  ['World', [
    ['worldWidth', 'World size (chunks · ×10 m)', 'int', 4],
    ['waterLevel', 'Water level', 'int', 1],
    ['maxGenerationHeight', 'Max generation height', 'int', 1],
    ['pointRadius', 'Point radius (cell size)', 'float', 0.5],
  ]],
  ['Land & continents', [
    ['landPercentRange', 'Land percent', 'range-float', 0.01],
    ['coastlineSize', 'Coastline size', 'int', 1],
    ['shallowOceanSize', 'Shallow ocean size', 'int', 1],
    ['numContinentsRange', 'Continents', 'range-int', 1],
    ['continentAvoidRange', 'Continent avoidance', 'range-float', 1],
    ['numSmallIslandsRange', 'Small islands', 'range-int', 1],
    ['islandAvoidRange', 'Island avoidance', 'range-float', 1],
    ['islandWeight', 'Island weight', 'float', 0.01],
  ]],
  ['Biome mix', [
    ['desertWeight', 'Desert', 'float', 0.01], ['warmForestWeight', 'Warm forest', 'float', 0.01],
    ['coolForestWeight', 'Cool forest', 'float', 0.01], ['taigaWeight', 'Taiga', 'float', 0.01],
    ['tundraWeight', 'Tundra', 'float', 0.01], ['iceWeight', 'Ice', 'float', 0.01],
    ['rainforestWeight', 'Rainforest', 'float', 0.01], ['wetlandWeight', 'Wetland', 'float', 0.01],
    ['steppeWeight', 'Steppe', 'float', 0.01], ['highDesertWeight', 'High desert', 'float', 0.01],
  ]],
  ['Biome counts (min blobs)', [
    ['numDeserts', 'Deserts', 'int', 1], ['numWarmForests', 'Warm forests', 'int', 1],
    ['numCoolForests', 'Cool forests', 'int', 1], ['numTaigas', 'Taigas', 'int', 1],
    ['numTundras', 'Tundras', 'int', 1], ['numIces', 'Ices', 'int', 1],
    ['numRainforests', 'Rainforests', 'int', 1], ['numWetlands', 'Wetlands', 'int', 1],
    ['numHighDeserts', 'High deserts', 'int', 1], ['numSteppes', 'Steppes', 'int', 1],
  ]],
  ['Lakes & rivers', [
    ['lakeSizeRange', 'Lake size', 'range-float', 0.0001],
    ['numLakesRange', 'Lakes', 'range-int', 1],
    ['numRiversRange', 'Rivers', 'range-int', 1],
    ['riverCellAvoidance', 'River avoidance', 'int', 1],
    ['riverCellWidth', 'River width', 'float', 0.5],
  ]],
  ['Elevation & scale', [
    ['maxElevationOceanDistance', 'Max elevation ocean dist', 'float', 1],
    ['elevationPower', 'Elevation power', 'float', 0.1],
    ['autoScale', 'Auto-scale features', 'bool'],
    ['autoScaleExponent', 'Auto-scale exponent', 'float', 0.05],
  ]],
];
const CFG_FIELDS = CFG_GROUPS.flatMap(g => g[1]);
const isRange = t => t === 'range-int' || t === 'range-float';

function fieldHtml([key, label, type, step]) {
  if (type === 'bool') return \`<label class="cfgF cfgBool"><input type="checkbox" id="cf_\${key}"><span>\${label}</span></label>\`;
  const st = step != null ? \` step="\${step}"\` : '';
  if (isRange(type)) return \`<label class="cfgF"><span>\${label}</span><span class="cfgRange"><input type="number" id="cf_\${key}_min"\${st}><em>–</em><input type="number" id="cf_\${key}_max"\${st}></span></label>\`;
  return \`<label class="cfgF"><span>\${label}</span><input type="number" id="cf_\${key}"\${st}></label>\`;
}
function buildForm() {
  const host = $('cfgForm'); host.innerHTML = '';
  CFG_GROUPS.forEach(([title, fields], gi) => {
    const d = document.createElement('details');   // all groups collapsed by default — expand what you need
    if (title === 'Biome mix') { d.innerHTML = \`<summary>\${title}</summary>\` + biomeMixHtml(fields); host.appendChild(d); return; }
    d.innerHTML = \`<summary>\${title}</summary><div class="cfgGrid">\${fields.map(fieldHtml).join('')}</div>\`;
    host.appendChild(d);
  });
  initBiomeMix();
}

// ---- Biome mix: Simple (land shares) <-> Advanced (raw weights) ----
// [shareKey, label, color, depth, weightKey]  weightKey null = Grassland (leftover, no weight)
const MIX = [
  ['grassland', 'Grassland (leftover)', '#90EE90', 0, null],
  ['coldforest', 'Cold forest', '#228B22', 1, 'coolForestWeight'],
  ['taiga', 'Taiga', '#6B8E23', 2, 'taigaWeight'],
  ['tundra', 'Tundra', '#BDB76B', 3, 'tundraWeight'],
  ['ice', 'Ice', '#FFFFFF', 4, 'iceWeight'],
  ['warmforest', 'Warm forest', '#B8860B', 1, 'warmForestWeight'],
  ['wetland', 'Wetland', '#006400', 2, 'wetlandWeight'],
  ['rainforest', 'Rainforest', '#20B2AA', 1, 'rainforestWeight'],
  ['desert', 'Desert', '#F4A460', 1, 'desertWeight'],
  ['highdesert', 'High desert', '#C99A5B', 2, 'highDesertWeight'],
  ['steppe', 'Steppe', '#9ACD6A', 1, 'steppeWeight'],
];
const MIX_BIOME = { grassland:'Grassland', coldforest:'ColdForest', taiga:'Taiga', tundra:'Tundra', ice:'Ice', warmforest:'WarmForest', wetland:'Wetland', rainforest:'RainForest', desert:'Desert', highdesert:'HighDesert', steppe:'Steppe' };
const WEIGHT_KEYS = ['coolForestWeight','taigaWeight','tundraWeight','iceWeight','warmForestWeight','wetlandWeight','rainforestWeight','desertWeight','highDesertWeight','steppeWeight'];
const DIRECT_WEIGHTS = ['coolForestWeight','warmForestWeight','rainforestWeight','desertWeight','steppeWeight']; // carved straight from Grassland
const MIX_COUNT = { coldforest:'numCoolForests', taiga:'numTaigas', tundra:'numTundras', ice:'numIces', warmforest:'numWarmForests', wetland:'numWetlands', rainforest:'numRainforests', desert:'numDeserts', highdesert:'numHighDeserts', steppe:'numSteppes' };

function biomeMixHtml(fields) {
  const rows = MIX.map(([k, label, color, depth]) => {
    const inp = k === 'grassland'
      ? \`<input type="number" id="sh_grassland" readonly><span class="pct">%</span><span class="mact" id="act_grassland"></span>\`
      : \`<input type="number" id="sh_\${k}" step="1" min="0"><span class="pct">%</span><span class="mact" id="act_\${k}"></span>\`;
    return \`<div class="mixRow\${k==='grassland'?' mixGrass':''}" style="padding-left:\${depth*18}px"><span class="msw" style="background:\${color}"></span><span class="mnm">\${label}</span>\${inp}</div>\`;
  }).join('');
  return \`
    <div class="row" style="margin:6px 0"><span class="lbl">Edit as</span><span class="seg" id="mixMode">
      <button type="button" data-m="simple" class="on">Land shares</button><button type="button" data-m="advanced">Raw weights</button></span>
      <span class="lbl" style="margin-left:auto">shares are % of land · Grassland fills the remainder</span></div>
    <div id="biomeSimple">
      <div id="mixBar"></div><div id="mixSum"></div>
      \${rows}
    </div>
    <div id="biomeAdvanced" style="display:none"><div class="cfgGrid">\${fields.map(fieldHtml).join('')}</div></div>\`;
}
const readShares = () => { const s = {}; for (const [k] of MIX) s[k] = k === 'grassland' ? 0 : (parseFloat($('sh_' + k).value) || 0) / 100; return s; };
function sharesToWeights(s) {
  return {
    coolForestWeight: s.coldforest + s.taiga + s.tundra + s.ice, taigaWeight: s.taiga + s.tundra + s.ice,
    tundraWeight: s.tundra + s.ice, iceWeight: s.ice,
    warmForestWeight: s.warmforest + s.wetland, wetlandWeight: s.wetland,
    rainforestWeight: s.rainforest, desertWeight: s.desert + s.highdesert, highDesertWeight: s.highdesert, steppeWeight: s.steppe,
  };
}
function weightsToShares() {
  const c = k => Math.max(0, parseFloat($('cf_' + k).value) || 0);
  const s = {
    ice: c('iceWeight'), tundra: c('tundraWeight') - c('iceWeight'), taiga: c('taigaWeight') - c('tundraWeight'),
    coldforest: c('coolForestWeight') - c('taigaWeight'), wetland: c('wetlandWeight'), warmforest: c('warmForestWeight') - c('wetlandWeight'),
    rainforest: c('rainforestWeight'), highdesert: c('highDesertWeight'), desert: c('desertWeight') - c('highDesertWeight'), steppe: c('steppeWeight'),
  };
  for (const k in s) if (s[k] < 0) s[k] = 0;
  return s;
}
// write current weight inputs -> Simple share inputs
function syncSimpleFromWeights() {
  const s = weightsToShares();
  for (const [k] of MIX) if (k !== 'grassland') $('sh_' + k).value = +(s[k] * 100).toFixed(1);
  updateMixBar();
}
// write current Simple share inputs -> weight inputs (and ensure a biome with share > 0 has count >= 1, else it never spawns)
function syncWeightsFromSimple() {
  const s = readShares();
  const w = sharesToWeights(s);
  for (const k of WEIGHT_KEYS) $('cf_' + k).value = +w[k].toFixed(4);
  for (const [k] of MIX) { if (k === 'grassland') continue; const ck = MIX_COUNT[k]; if (s[k] > 0 && (parseInt($('cf_' + ck).value, 10) || 0) < 1) $('cf_' + ck).value = 1; }
  updateMixBar();
}
function updateMixBar() {
  const s = readShares();
  let nonGrass = 0; for (const [k] of MIX) if (k !== 'grassland') nonGrass += s[k];
  const grass = 1 - nonGrass;
  $('sh_grassland').value = +(Math.max(0, grass) * 100).toFixed(1);
  const seg = ([k, , color]) => { const v = k === 'grassland' ? Math.max(0, grass) : s[k]; return v > 0 ? \`<span title="\${MIX_BIOME[k]} \${(v*100).toFixed(1)}%" style="flex:0 0 \${(v*100).toFixed(2)}%;background:\${color}"></span>\` : ''; };
  $('mixBar').innerHTML = MIX.map(seg).join('');
  if (grass < -0.0005) $('mixSum').innerHTML = \`<span class="over">Over-allocated by \${((-grass)*100).toFixed(1)}% — biomes late in the order (Desert→Steppe→Wetland) will be starved.</span>\`;
  else $('mixSum').innerHTML = \`Land used: <b>\${(nonGrass*100).toFixed(1)}%</b> · Grassland: <b>\${(grass*100).toFixed(1)}%</b>\`;
}
function setMixMode(m) {
  const simple = m === 'simple';
  if (simple) syncSimpleFromWeights();            // refresh shares from possibly-edited weights
  $('biomeSimple').style.display = simple ? '' : 'none';
  $('biomeAdvanced').style.display = simple ? 'none' : '';
  for (const b of $('mixMode').children) b.classList.toggle('on', b.dataset.m === m);
}
function initBiomeMix() {
  for (const [k] of MIX) if (k !== 'grassland') $('sh_' + k).addEventListener('input', syncWeightsFromSimple);
  for (const b of $('mixMode').children) b.onclick = () => setMixMode(b.dataset.m);
  updateMixBar();
}
// after a generate, show actual land-share next to each biome
function updateMixActuals(m) {
  const counts = m.stats.counts, tot = k => counts[k] || 0;
  const landCells = totalPolys() - (tot('DeepOcean') + tot('Ocean') + tot('Coast') + tot('ColdCoast') + tot('WarmCoast'));
  for (const [k] of MIX) { const el = $('act_' + k); if (!el) continue;
    el.textContent = landCells > 0 ? '→ ' + (100 * tot(MIX_BIOME[k]) / landCells).toFixed(0) + '%' : ''; }
}
function populateForm(cfg) {
  for (const [key, , type] of CFG_FIELDS) {
    if (type === 'bool') { $('cf_' + key).checked = !!cfg[key]; }
    else if (isRange(type)) { $('cf_' + key + '_min').value = cfg[key].min; $('cf_' + key + '_max').value = cfg[key].max; }
    else { $('cf_' + key).value = cfg[key]; }
  }
  $('seed').value = String(cfg.seed);
  syncSimpleFromWeights();
}
function readForm() {
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  const numOr = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  for (const [key, , type] of CFG_FIELDS) {
    if (type === 'bool') cfg[key] = $('cf_' + key).checked;
    else if (isRange(type)) cfg[key] = { min: numOr($('cf_' + key + '_min').value, baseCfg[key].min), max: numOr($('cf_' + key + '_max').value, baseCfg[key].max) };
    else cfg[key] = numOr($('cf_' + key).value, baseCfg[key]);
  }
  cfg.worldLength = cfg.worldWidth;
  cfg.seed = (parseInt($('seed').value.trim(), 10) || baseCfg.seed) | 0;
  return cfg;
}

// ---- generation ----
function generateMap(cfg) {
  $('err').textContent = '';
  renderPx = Math.max(200, Math.min(2000, ($('maxpx') && +$('maxpx').value) || 900));
  cfgUsed = cfg;
  $('meta').innerHTML = \`World <b>\${cfg.worldWidth*10}×\${cfg.worldLength*10} m</b> · seed <b>\${cfg.seed}</b> · point radius \${cfg.pointRadius}\`;
  $('loadCfg').disabled = true; $('regen').disabled = true;
  $('prog').style.display = 'block'; $('progBar').style.width = '8%'; $('progPhase').textContent = 'sampling…';

  if (!worker) worker = makeWorker();
  const start = performance.now();
  const phases = { voronoi:25, biomes:45, elevation:65, rivers:85 };
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') { worker.postMessage({ type: 'gen', cfg }); return; }
    if (m.type === 'progress') { $('progPhase').textContent = m.phase + '…'; $('progBar').style.width = (phases[m.phase]||10) + '%'; return; }
    if (m.type === 'error') { $('err').textContent = 'Generation failed: ' + m.message; $('loadCfg').disabled = false; $('regen').disabled = false; $('prog').style.display='none'; return; }
    if (m.type === 'done') {
      $('progBar').style.width = '100%';
      result = m;   // 3D voxel caches (grid/terrain/chunks) are invalidated worker-side on each 'gen'
      updateMixActuals(m);
      if (terrain) { const ej = buildExportJson(); BlockChart.render(ej); }   // keep charts' biome present/absent + water line in sync
      $('loadCfg').disabled = false; $('regen').disabled = false;
      setTimeout(() => { $('prog').style.display = 'none'; }, 300);
      $('panel').style.display = 'block';
      scale = renderPx / m.worldSize;
      showStats(m, (performance.now()-start));
      buildLayerButtons();
      render();
    }
  };
  if (workerReady) worker.postMessage({ type: 'gen', cfg });
  else { worker.postMessage({ type: 'init', vt: VT }); workerReady = true; }
}
// parse a pasted/loaded config, fill the form, then generate
function loadConfigText(text, userInitiated) {
  text = (text || '').trim();
  $('err').textContent = '';
  if (!text) { $('err').textContent = 'Paste or drop a WorldGenerator.eco config first.'; return; }
  let cfg;
  try { rawJson = JSON.parse(text); cfg = parseConfig(text, ''); }
  catch (e) { $('err').textContent = 'Config error: ' + e.message; return; }
  baseCfg = cfg;
  populateForm(cfg);
  $('cfgPanel').style.display = 'block';
  terrain = derefTerrain(rawJson);
  OreVisual.build();
  $('chartsPanel').style.display = terrain ? 'block' : 'none';
  if (terrain) { const ej = buildExportJson(); BlockChart.render(ej); }
  if (userInitiated) {   // collapse the source area only after the user loads their own config (not the initial default)
    const sb = $('srcBox'); if (sb) sb.open = false;
    const ss = $('srcSummary'); if (ss) ss.innerHTML = '📁 Config source <span class="lbl">— loaded · click to load another</span>';
  }
  generateMap(cfg);
}
function generateFromForm() {
  if (!baseCfg) { $('err').textContent = 'Load a WorldGenerator.eco config first.'; return; }
  generateMap(readForm());
}
// current form values + edited TerrainModule merged back into the loaded JSON structure
function buildExportJson() {
  const cfg = readForm();
  const j = JSON.parse(JSON.stringify(rawJson));
  const vc = findByKey(j, 'PointRadius'), dim = findByKey(j, 'WorldWidth');
  const topLevel = { worldWidth:1, worldLength:1, waterLevel:1, maxGenerationHeight:1, seed:1 };
  const cap = k => k[0].toUpperCase() + k.slice(1);
  if (vc) {
    for (const [key, , type] of CFG_FIELDS) {
      if (topLevel[key]) continue;
      const P = cap(key), cur = vc[P];
      if (isRange(type) && cur && typeof cur === 'object') { cur.min = cfg[key].min; cur.max = cfg[key].max; }
      else vc[P] = cfg[key];
    }
    vc.Seed = cfg.seed;
  }
  if (dim) { dim.WorldWidth = cfg.worldWidth; dim.WorldLength = cfg.worldLength; }
  if (j && 'WaterLevel' in j) j.WaterLevel = cfg.waterLevel;
  if (j && 'MaxGenerationHeight' in j) j.MaxGenerationHeight = cfg.maxGenerationHeight;
  if (terrain) j.TerrainModule = terrain;   // dereferenced + edited block/ore composition
  return j;
}
function downloadEco() {
  if (!rawJson || !baseCfg) { $('err').textContent = 'Load a config first.'; return; }
  const blob = new Blob([JSON.stringify(buildExportJson(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.download = 'WorldGenerator.eco'; a.href = URL.createObjectURL(blob); a.click();
}

// ---- TerrainModule: dereference $id/$ref into a plain editable tree (keeps $type, drops $id/$ref) ----
let terrain = null;
function derefTerrain(json) {
  const idMap = {};
  (function idx(o) { if (o && typeof o === 'object') { if (!Array.isArray(o) && o['$id'] != null) idMap[o['$id']] = o; for (const k in o) idx(o[k]); } })(json);
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') {
      if (v['$ref'] != null) return clone(idMap[v['$ref']]);
      const o = {}; for (const k in v) { if (k === '$id' || k === '$ref') continue; o[k] = clone(v[k]); }
      return o;
    }
    return v;
  }
  return json && json.TerrainModule ? clone(json.TerrainModule) : null;
}

// ---- shared ore constants (used by editor + chart) ----
const ORE_MATS = [['CrushedIronOreBlock','iron'],['IronOreBlock','iron'],['CrushedCopperOreBlock','copper'],['CopperOreBlock','copper'],['CrushedGoldOreBlock','gold'],['GoldOreBlock','gold'],['CrushedCoalBlock','coal'],['CoalBlock','coal'],['CrushedSulfurBlock','sulfur'],['SulfurBlock','sulfur'],['PeatBlock','peat'],['CrushedLimestoneBlock','limestone'],['LimestoneBlock','limestone'],['ClayBlock','clay']];
const ORE_COL = { iron:'#b0342f', copper:'#cf6a2c', gold:'#d7a521', coal:'#4b4b48', sulfur:'#c9cf3a', peat:'#5a4327', limestone:'#b7ae97', clay:'#8a5a30' };
const ORE_NAME = { iron:'Iron', copper:'Copper', gold:'Gold', coal:'Coal', sulfur:'Sulfur', peat:'Peat', limestone:'Limestone', clay:'Clay' };
const ORE_DISP = { Grassland:'Grassland', RainForest:'Rainforest', WarmForest:'Warm forest', ColdForest:'Cold forest', Taiga:'Taiga', Tundra:'Tundra', Ice:'Ice', Desert:'Desert', ColdCoast:'Cold coast', WarmCoast:'Warm coast', Wetland:'Wetland' };
function oreMaterial(t) { if (!t) return null; for (let i = 0; i < ORE_MATS.length; i++) if (t.indexOf(ORE_MATS[i][0]) >= 0) return ORE_MATS[i][1]; return null; }
const shortBlock = t => (t || '').split(',')[0].split('.').pop().replace(/Block$/, '');
const btOf = bt => (bt && bt.Type) ? bt.Type : '';

// ---- full block palette (base strata + every non-ore block the ore chart ignores) ----
// Ores reuse ORE_COL/ORE_NAME via oreMaterial(); everything else (soils, sediments, rock) lives here.
const ORE_ORDER = ['iron','copper','gold','coal','sulfur','peat','limestone','clay'];
const BLOCK_COL = {
  Water:'#3d7fd6', WaterBlock:'#3d7fd6',      // fresh water, same blue the sea plane uses
  Dirt:'#7c5a38', RockySoil:'#8f7b52', Grass:'#6bbf59', GrassBlock:'#6bbf59',
  WetlandsSoil:'#5d6b46', FrozenSoil:'#93a7ad', Sand:'#e4d59b', DesertSand:'#e9cb8d',
  Sandstone:'#d8b573', Shale:'#69737b', Slate:'#5c666e', Gravel:'#9c958b',
  Granite:'#b98f89', Gneiss:'#9a97a2', Basalt:'#4b4753',
  Snow:'#eef4fa', Ice:'#cfe8f5', ImpenetrableStone:'#2b2b30', Bedrock:'#2b2b30',
  Empty:'#5a6b7a', Air:'#5a6b7a',
};
// shallow soils/sediment first, hard rock deeper, ores last so their thin bands read on top of the stack
const BLOCK_STACK_ORDER = ['Grass','GrassBlock','Dirt','RockySoil','WetlandsSoil','FrozenSoil','Snow','Ice','Sand','DesertSand','Gravel','Sandstone','Shale','Slate','Gneiss','Granite','Basalt','ImpenetrableStone','Bedrock'];
const blockBaseName = t => { const s = shortBlock(t); return s.indexOf('Crushed') === 0 ? s.slice(7) : s; };
function hashColor(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return 'hsl(' + (((h % 360) + 360) % 360) + ',30%,58%)'; }
function blockColorRaw(t) { const m = oreMaterial(t); if (m) return ORE_COL[m]; const b = blockBaseName(t); return BLOCK_COL[b] || hashColor(b); }
const isCrushed = t => shortBlock(t).indexOf('Crushed') === 0;
// crushed variants share their base block's colour; in "Separate" mode we lighten them so a crushed band reads as a paler shade next to the solid one
function lightenColor(c) {
  const amt = 0.42;
  if (c[0] === '#') { let h = c.slice(1); if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    const mix = i => Math.round(parseInt(h.slice(i,i+2),16) + (255 - parseInt(h.slice(i,i+2),16)) * amt);
    return 'rgb(' + mix(0) + ',' + mix(2) + ',' + mix(4) + ')'; }
  const m = c.match(/hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)/);
  return m ? 'hsl(' + m[1] + ',' + m[2] + '%,' + Math.min(96, +m[3] + 22) + '%)' : c;
}
const prettyName = s => s.replace(/([a-z])([A-Z])/g, '$1 $2');
function blockRank(t) { const m = oreMaterial(t); if (m) return 200 + ORE_ORDER.indexOf(m); const i = BLOCK_STACK_ORDER.indexOf(blockBaseName(t)); return i < 0 ? 120 : i; }
// display grouping: merge folds crushed+ore variants together (CrushedIronOre+IronOre -> Iron, CrushedSandstone+Sandstone -> Sandstone)
function blockKeyInfo(t, merge) {
  const m = oreMaterial(t);
  if (!merge) return { key: t, label: prettyName(shortBlock(t)), color: isCrushed(t) ? lightenColor(blockColorRaw(t)) : blockColorRaw(t), rank: blockRank(t), ore: !!m };
  if (m) return { key: 'ore:' + m, label: ORE_NAME[m], color: ORE_COL[m], rank: 200 + ORE_ORDER.indexOf(m), ore: true };
  const b = blockBaseName(t);
  return { key: 'rock:' + b, label: prettyName(b), color: BLOCK_COL[b] || hashColor(b), rank: blockRank(t), ore: false };
}

// ---- ore/scatter knobs + node templates, shared by the visual editor below ----
// "vein" = DepositTerrainModule (concentrated ore vein); "scatter" = StandardTerrainModule (chance-based blocks/bands).
const ORE_SLIDER = {
  SpawnPercentChance: { min:0, max:0.05, step:0.0005 },
  PercentChance:      { min:0, max:1,    step:0.01 },
  NoiseFrequency:     { min:0, max:100,  step:1 },
  DepthRange:         { min:0, max:120,  step:1 },
  DepositDepthRange:  { min:0, max:120,  step:1 },
  BlocksCountRange:   { min:0, max:300,  step:1 },
};
// A fill's PercentChance is a calibrated VOLUME FRACTION (StandardTerrainModule.Initialize sorts ~9k noise
// samples and takes a band that wide), not a per-block dice roll - "coverage" says that, "chance" does not.
// A vein's SpawnPercentChance is a seed rate, and reads far better as the engine's own "1 per N blocks".
// DepositDepthRange is a penalty, not a bound, so it may not be called a range it stays in.
// NoiseFrequency is cycles across the WHOLE map, so raising it makes each patch smaller. Calling it
// "patch size" read as the opposite of what it does; stock fills sit at 3 (a handful of big patches)
// while strata run 15-40.
const KNOB_TITLE = { NoiseFrequency:'how many patches fit across the map - higher means MORE and SMALLER patches',
  PercentChance:'the share of this layer the fill takes, as a volume fraction',
  SpawnPercentChance:'how often a vein seed is planted',
  BlocksCountRange:'how many blocks one vein grows to' };
const KNOB_LABEL = { SpawnPercentChance:'seed rate', PercentChance:'coverage', NoiseFrequency:'patches across map', DepthRange:'seeds at depth', DepositDepthRange:'stays within (soft)', BlocksCountRange:'vein size (blocks)' };
const sMax = (f, v) => { const c = ORE_SLIDER[f]; v = v || 0; return c.step < 1 ? Math.max(c.max, +(v * 1.25).toFixed(4)) : Math.max(c.max, Math.ceil(v)); };
function collectBlockTypes() {
  const set = new Set();
  (function walk(o){ if (o && typeof o === 'object'){ if (!Array.isArray(o) && typeof o.Type === 'string') set.add(o.Type); for (const k in o) walk(o[k]); } })(terrain);
  return [...set].sort((a, b) => shortBlock(a).localeCompare(shortBlock(b)));
}
function blockSelect(cur, opts) {
  if (cur && opts.indexOf(cur) < 0) opts = [cur, ...opts];
  return '<select data-f="block">' + opts.map(t => '<option value="' + t + '"' + (t === cur ? ' selected' : '') + '>' + shortBlock(t) + '</option>').join('') + '</select>';
}
// a slider paired with an editable number (number can exceed the slider's range, which auto-expands)
function slPair(f, c, mx, v) { return '<input type="range" data-f="' + f + '" min="' + c.min + '" max="' + mx + '" step="' + c.step + '" value="' + v + '"><input type="number" class="kv" data-f="' + f + '" step="' + c.step + '" min="0" value="' + v + '">'; }
// DepthRange is the same field with two meanings: on a fill it is the depths it FILLS, on a vein only the
// depths its seed may LAND in. One label for both is how that got confusing, so pass the kind.
const knobLabel = (field, dep) => (dep && field === 'DepthRange') ? 'seeds at depth'
  : (!dep && field === 'DepthRange') ? 'fills depth' : KNOB_LABEL[field];
const knobTitle = field => KNOB_TITLE[field] ? ' title="' + KNOB_TITLE[field] + '"' : '';
function knob1(field, v, dep) { const c = ORE_SLIDER[field]; v = (v != null ? v : 0);
  return '<span class="kk"><label' + knobTitle(field) + '>' + knobLabel(field, dep) + '</label>' + slPair(field, c, sMax(field, v), v) + '</span>'; }
function knobR(field, r, dep) { r = r || {}; const c = ORE_SLIDER[field], mx = sMax(field, Math.max(r.min || 0, r.max || 0));
  return '<span class="kk"><label' + knobTitle(field) + '>' + knobLabel(field, dep) + '</label>' + slPair(field + '_min', c, mx, r.min != null ? r.min : 0) + '<span class="dash">–</span>' + slPair(field + '_max', c, mx, r.max != null ? r.max : 0) + '</span>'; }
function tmplVein() { return { '$type':'Eco.WorldGenerator.DepositTerrainModule, Eco.WorldGenerator', SpawnAtLeastOne:false, SpawnPercentChance:0.005, DepthRange:{min:10,max:30}, DepositDepthRange:{min:0,max:40}, BlocksCountRange:{min:10,max:40}, BlockType:{Type:'Eco.Mods.TechTree.IronOreBlock, Eco.Mods'}, DirectionWeights:[{X:1,Y:1,Z:1}], WeightVariance:{X:1,Y:1,Z:1} }; }
function tmplScatter() { return { '$type':'Eco.WorldGenerator.StandardTerrainModule, Eco.WorldGenerator', BlockType:{Type:'Eco.Mods.TechTree.CoalBlock, Eco.Mods'}, HeightRange:{min:-1,max:1}, DepthRange:{min:0,max:6}, PercentChance:0.3, NoiseFrequency:20, NoiseType:'Perlin', NoiseDistributionType:'Bands' }; }
let oreRenderTimer = null;
function scheduleOreRender() { clearTimeout(oreRenderTimer); oreRenderTimer = setTimeout(() => { if (terrain) { const ej = buildExportJson(); BlockChart.render(ej); } }, 150); }

// ---- visual ore editor: per-biome depth lane where each vein/scatter is a draggable object ----
// Drag an object's body to move its DepthRange, drag its right edge to change abundance (SpawnPercentChance /
// PercentChance). Click to select and fine-tune with the same knobs as the manual editor. Edits the real
// TerrainModule node objects in place and shares scheduleOreRender so the charts + export stay in sync.
const OreVisual = (function () {
  const TOPY = 18, X0 = 46, Wc = 300, BW = 9, BGAP = 2, MINBAND = 8, GRIP = 7;
  let biomeIdx = 0, sel = null, objs = [], strata = [], maxD = 120, H = 0, lastBands = [];
  let lastAlive = [], lastProb = [];   // per-stratum: share of columns it is the rock in at all, and at each depth
  // world-Y reference state (set each render): this biome's surface band and its mean, for the edge ruler
  let surfLo = 60, surfHi = 60, surfMid = 60, SCd = 8;
  const ELEV = { Grassland:[.02,.4], WarmForest:[.1,.5], ColdForest:[.1,.7], RainForest:[.1,.5], Desert:[.02,.2], Taiga:[.3,1], Tundra:[.4,1], Ice:[.6,1], Wetland:[.02,.3], ColdCoast:[.05,.1], WarmCoast:[.05,.1] };
  const waterLvl = () => { const el = $('cf_waterLevel'); const v = el ? parseInt(el.value, 10) : 60; return isFinite(v) ? v : 60; };
  let laneEl = null, detailEl = null, listEl = null, svgEl = null;
  let drag = null, startDepth = 0, snapMin = 0, snapMax = 0;
  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const biomes = () => (terrain && terrain.Modules) ? terrain.Modules : [];
  // the depth axis spans the world's max generation height (blocks can't go below Y0), same for every biome
  const worldMaxD = () => { const el = $('cf_maxGenerationHeight'); const v = el ? parseInt(el.value, 10) : 120; return (isFinite(v) && v > 0) ? v : 120; };
  // an object's bar width represents its share of blocks at its depth (same as the composition chart):
  // scatter = PercentChance directly; vein = saturating cover 1-(1-spawn)^veinSize. Dragging width sets the share
  // and back-solves the underlying config value.
  const veinN = o => { const bc = o.node.BlocksCountRange || {}; return Math.max(1, ((bc.min != null ? bc.min : 1) + (bc.max != null ? bc.max : 1)) / 2); };
  const shareOf = o => o.kind === 'dep' ? (1 - Math.pow(1 - Math.max(0, Math.min(1, o.node.SpawnPercentChance || 0)), veinN(o))) : Math.max(0, Math.min(1, o.node.PercentChance || 0));
  const setShare = (o, frac) => { frac = Math.max(0, Math.min(1, frac));
    if (o.kind === 'dep') o.node.SpawnPercentChance = +(1 - Math.pow(1 - frac, 1 / veinN(o))).toFixed(4);
    else o.node.PercentChance = +frac.toFixed(3); };
  // a vein doesn't fill a flat box: it seeds within its DepthRange and grows blocks across its (usually larger)
  // DepositDepthRange, densest at the seed and tapering out. Mirror the composition chart's depShape so the views agree.
  const meanW = node => { const dw = node.DirectionWeights || []; if (!dw.length) return [1, 1, 1]; let x = 0, yy = 0, z = 0; for (let i = 0; i < dw.length; i++) { x += dw[i].X || 0; yy += dw[i].Y || 0; z += dw[i].Z || 0; } return [x / dw.length, yy / dw.length, z / dw.length]; };
  const vBoost = (wx, wy, wz) => { wx = Math.max(wx, 1e-6); wy = Math.max(wy, 1e-6); wz = Math.max(wz, 1e-6); return Math.pow(wy, 2 / 3) / Math.pow(wx * wz, 1 / 3); };
  function veinShape(node, sa, sb, ba, bb, md) {
    const bc = node.BlocksCountRange || {}, N = Math.max(1, ((bc.min != null ? bc.min : 1) + (bc.max != null ? bc.max : 1)) / 2);
    const mw = meanW(node), h = Math.max(1, Math.round(0.62 * Math.cbrt(N) * vBoost(mw[0], mw[1], mw[2])));
    const base = new Float64Array(md + 1); for (let d = Math.max(0, sa); d <= Math.min(md, sb); d++) base[d] = 1;
    const sm = new Float64Array(md + 1);
    for (let d = 0; d <= md; d++) { let acc = 0, ws = 0; for (let k = -h; k <= h; k++) { const wk = h + 1 - Math.abs(k), dd = d - k; if (dd >= 0 && dd <= md) acc += base[dd] * wk; ws += wk; } sm[d] = acc / ws; }
    for (let d = 0; d <= md; d++) if (d < ba || d > bb) sm[d] = 0;
    let peak = 0; for (let d = 0; d <= md; d++) if (sm[d] > peak) peak = sm[d];
    const arr = new Float64Array(md + 1); if (peak > 0) for (let d = 0; d <= md; d++) arr[d] = sm[d] / peak;
    return arr;
  }
  // The lane is drawn in DEPTH, the engine's own coordinate (TerrainModules.cs L266 tests depth, never Y),
  // with depth 0 at the top and one row per block. It used to be projected onto world Y through the biome's
  // surface band, which smeared every depth across the band's width - 11 blocks in Desert, 42 in Taiga -
  // when the engine's own per-column spread of a boundary is a few blocks. A 5-block "55-60" boundary drew
  // as a 40-block wash, and the wash hid exactly the thing this panel exists to show. World Y survives as a
  // reference ruler on the right edge, read through the biome's mean surface.
  const yAtDepth = d => TOPY + d * SCd;                       // top of block row d -> svg pixel-y
  const depthAtSvgY = sy => (sy - TOPY) / SCd;                // svg pixel-y -> depth below surface (continuous)
  // every vein/scatter, including non-ore blocks (Empty caves, soil, crushed rock) the composition chart shows, so the two agree
  function collect(bm) { const out = []; const rs = (bm.Module && bm.Module.BlockDepthRanges) || [];
    rs.forEach(l => (l.SubModules || []).forEach(sm => { const ty = sm['$type'] || ''; const bt = btOf(sm.BlockType); if (!bt) return; const mat = oreMaterial(bt);
      if (ty.indexOf('DepositTerrainModule') >= 0) out.push({ node: sm, kind: 'dep', sub: l.SubModules, mat, parent: l });
      else if (ty.indexOf('StandardTerrainModule') >= 0) out.push({ node: sm, kind: 'std', sub: l.SubModules, mat, parent: l }); }));
    return out; }
  // display name for a node: ore label if it's an ore, otherwise the block's own pretty name
  const oreLabel = o => ORE_NAME[o.mat] || prettyName(shortBlock(btOf(o.node.BlockType)));
  const oreDot = o => ORE_COL[o.mat] || blockColorRaw(btOf(o.node.BlockType));
  // base rock strata: the BlockDepthRanges that carry a base block (the bulk fill the composition chart shows)
  function collectStrata(bm) { const rs = (bm.Module && bm.Module.BlockDepthRanges) || [], list = [];
    rs.forEach(l => { const b = btOf(l.BlockType); if (b) list.push({ node: l, block: b, min: Math.max(0, l.Min | 0), max: Math.max(l.Min | 0, l.Max | 0) }); }); return list; }
  const mulb = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  function selBase(T, N, d) { let last = N - 1; for (let i = N - 2; i >= 0; i--) { let sk = false; for (let j = i + 1; j < N; j++) { if (T[j] <= T[i]) { sk = true; break; } } if (sk) continue; if (d <= T[i]) last = i; else break; } return last; }
  // which base stratum dominates each depth (same threshold model the composition chart uses), grouped into contiguous bands
  // A stratum's threshold is NOT uniform in [Min,Max]. The engine draws it from clamp(0.5*Perlin+0.5),
  // which is a bell: sd 0.209 of the range, so "55-60" ends at 57 or 58 in 65% of columns and at 55 or
  // 60 in 3% each. Sampling it uniformly - which this did - pushed every probability the panel shows
  // toward the range edges. These are the 32 quantiles of that distribution, measured over 200k samples
  // of this repo's own bit-exact Perlin across five frequencies and seeds (it is frequency-independent).
  const BELL = [0.0000, 0.1031, 0.1719, 0.2189, 0.2554, 0.2859, 0.3130, 0.3368, 0.3587, 0.3796, 0.3989,
    0.4178, 0.4358, 0.4532, 0.4705, 0.4876, 0.5000, 0.5121, 0.5287, 0.5463, 0.5637, 0.5825, 0.6013,
    0.6214, 0.6425, 0.6654, 0.6900, 0.7177, 0.7488, 0.7845, 0.8301, 0.8967, 1.0000];
  /** Inverse-CDF sample of that bell from a uniform u, linear between quantiles. */
  function bell(u) { const q = u * (BELL.length - 1), i = Math.min(BELL.length - 2, Math.floor(q));
    return BELL[i] + (BELL[i + 1] - BELL[i]) * (q - i); }
  /** Gradient stops that paint a boundary band with the bell's own density: each quantile carries 1/32 of
   *  the mass, so density at a quantile is the inverse of the gap to its neighbours. Square-rooted so the
   *  edges (8x thinner than the core) stay visible instead of vanishing; the core is 1. Pure. */
  function bellStops() {
    const n = BELL.length, dens = new Array(n);
    for (let k = 0; k < n; k++) { const lo = k > 0 ? 1 / (BELL[k] - BELL[k - 1]) : 0, hi = k < n - 1 ? 1 / (BELL[k + 1] - BELL[k]) : 0;
      dens[k] = (k > 0 && k < n - 1) ? (lo + hi) / 2 : lo + hi; }
    let mx = 0; for (let k = 0; k < n; k++) if (dens[k] > mx) mx = dens[k];
    return BELL.map((q, k) => ({ off: q, a: Math.sqrt(dens[k] / mx) }));
  }
  // prob[i][d] is how often stratum i is the rock at depth d; alive[i] is how often it is the rock at
  // ANY depth. The two answer different questions and the panel used to have only the first: a stratum can
  // be the plurality nowhere and still be the rock in a large minority of columns, which reads as "dead"
  // if you look at bands alone. Stock Desert's second Sand layer is exactly that - it wins nowhere and is
  // alive in 43% of columns.
  function baseBands(list, md) { const N = list.length; if (!N) return { bands: [], prob: [], alive: [] };
    const cnt = list.map(() => new Float64Array(md + 1)), S = 240, rnd = mulb(0x51ed3c), T = new Float64Array(N);
    const alive = new Float64Array(N), seen = new Uint8Array(N);
    for (let s = 0; s < S; s++) {
      // round, as the engine does - the skip test compares thresholds with <=, so rounding decides ties
      for (let i = 0; i < N; i++) T[i] = Math.round(list[i].min + bell(rnd()) * (list[i].max - list[i].min));
      seen.fill(0);
      for (let d = 0; d <= md; d++) { const w = selBase(T, N, d); cnt[w][d]++; seen[w] = 1; }
      for (let i = 0; i < N; i++) if (seen[i]) alive[i]++;
    }
    for (let i = 0; i < N; i++) alive[i] /= S;
    const bands = []; let cur = -1, start = 0;
    for (let d = 0; d <= md; d++) { let bi = 0, bv = -1; for (let i = 0; i < N; i++) if (cnt[i][d] > bv) { bv = cnt[i][d]; bi = i; }
      if (bi !== cur) { if (cur >= 0) bands.push({ st: list[cur], si: cur, top: start, bot: d - 1 }); cur = bi; start = d; } }
    if (cur >= 0) bands.push({ st: list[cur], si: cur, top: start, bot: md });
    for (let i = 0; i < N; i++) for (let d = 0; d <= md; d++) cnt[i][d] /= S;
    return { bands: bands, prob: cnt, alive: alive }; }
  /** Where each stratum's boundary band sits, in row-edge depths: a threshold T ends the layer at the
   *  bottom of row T, so Min..Max spans the row edges Min+1..Max+1. A band is hollow when the layer is the
   *  rock in fewer than half the columns - a deeper layer usually ends above it and the engine then skips
   *  it (TerrainModules.cs L254-264) - and it is drawn dashed behind the band that wins. The last stratum
   *  is never tested against depth: its range is only the ceiling that suppresses the others. Pure. */
  function bandLayout(list, alive, md) {
    return list.map((st, i) => { const last = i === list.length - 1, mn = Math.max(0, Math.min(md, st.min)), mx = Math.max(mn, Math.min(md, st.max));
      const live = (alive && alive.length > i) ? alive[i] : 1;
      return { si: i, min: mn, max: mx, top: mn + 1, bot: mx + 1, core: (mn + mx) / 2 + 1, live: live, hollow: !last && live < 0.5, ceiling: last }; });
  }
  /** Push label y's apart top-down by at least gap, keeping input order. Desert's "1-20" and "0-20" bands
   *  share a core and would otherwise print on top of each other. Pure. */
  function spreadLabels(ys, gap) { const idx = ys.map((y, i) => i).sort((a, b) => ys[a] - ys[b]); const out = ys.slice(); let prev = -1e9;
    idx.forEach(i => { let y = ys[i]; if (y < prev + gap) y = prev + gap; out[i] = y; prev = y; }); return out; }
  /** Split a fill's mn..mx into runs where its parent stratum usually is the rock (on) and where it is
   *  not (off, drawn hatched): a fill only applies inside its own stratum, so the off part is a setting
   *  with no effect. No parent probability at all (an orphan) is off everywhere. Pure. */
  function clipRuns(prob, mn, mx, md) { const runs = []; let cur = null;
    for (let d = Math.max(0, mn); d <= Math.min(md, mx); d++) { const on = prob ? prob[d] >= 0.5 : false;
      if (cur && cur.on === on) cur.b = d; else { cur = { a: d, b: d, on: on }; runs.push(cur); } }
    return runs; }
  const labelColor = c => { if (c && c[0] === '#') { let h = c.slice(1); if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16); return (0.299*r + 0.587*g + 0.114*b) > 150 ? '#1a1a18' : '#f5f5f0'; } return '#1a1a18'; };
  const f1 = v => v.toFixed(1);
  const rect = (x, y, w, h, attrs) => '<rect x="' + f1(x) + '" y="' + f1(y) + '" width="' + f1(Math.max(0, w)) + '" height="' + f1(Math.max(0, h)) + '" ' + attrs + '/>';
  function render() {
    const bms = biomes();
    let chips = ''; bms.forEach((bm, i) => { const on = i === biomeIdx;
      chips += '<button type="button" data-bi="' + i + '" style="font:inherit;font-size:13px;padding:5px 11px;border-radius:8px;border:0.5px solid ' + (on ? 'var(--accent)' : 'var(--border)') + ';background:' + (on ? 'var(--accent)' : 'var(--surf)') + ';color:' + (on ? '#fff' : 'var(--text)') + ';cursor:pointer">' + (ORE_DISP[bm.BiomeName] || bm.BiomeName) + '</button>'; });
    $('ovBiomes').innerHTML = chips;
    $('ovBiomes').querySelectorAll('button').forEach(b => b.onclick = () => { biomeIdx = +b.dataset.bi; sel = null; render(); renderDetail(); renderList(); });
    const bm = bms[biomeIdx]; objs = bm ? collect(bm) : []; strata = bm ? collectStrata(bm) : [];
    if (sel) { if (sel.kind === 'strat') { const f = strata.find(st => st.node === sel.node); sel = f ? { kind: 'strat', node: f.node, block: f.block } : null; } else { const f = objs.find(o => o.node === sel.node); sel = f || null; } }
    maxD = Math.max(20, worldMaxD());
    const hasBase = strata.length > 0; let baseProb = [];
    if (hasBase) { const bb = baseBands(strata, maxD); lastBands = bb.bands; baseProb = bb.prob; lastAlive = bb.alive; lastProb = bb.prob; }
    else { lastBands = []; lastAlive = []; lastProb = []; }
    const stratIdxOf = new Map(); strata.forEach((st, i) => stratIdxOf.set(st.node, i));
    // crushed variants share their solid twin's raw colour (and often the base rock's), so lighten them to read as a distinct paler shade
    const oreCol = bt => isCrushed(bt) ? lightenColor(blockColorRaw(bt)) : blockColorRaw(bt);
    const oi = objs.map(o => { const bt = btOf(o.node.BlockType);
      if (o.kind === 'dep') { const dr = o.node.DepthRange || {}, dd = o.node.DepositDepthRange || {};
        const sa = Math.max(0, dr.min | 0), sb = Math.max(sa, Math.min(maxD, dr.max | 0));
        const ba = Math.max(0, Math.min(sa, dd.min != null ? dd.min | 0 : sa)), bb = Math.min(maxD, Math.max(sb, dd.max != null ? dd.max | 0 : sb));
        return { o, mn: ba, mx: Math.max(ba + 1, bb), sa, sb, shape: veinShape(o.node, sa, sb, ba, bb, maxD), sh: Math.max(0, Math.min(1, shareOf(o))), col: oreCol(bt) }; }
      const r = o.node.DepthRange || { min: 0, max: 10 }; const mn = Math.max(0, r.min | 0), mx = Math.max(mn, Math.min(maxD, r.max | 0));
      return { o, mn, mx, sh: Math.max(0, Math.min(1, shareOf(o))), col: oreCol(bt) }; });
    // ---- world-Y reference: this biome's surface band, and the mean surface the edge ruler reads through ----
    const WL = waterLvl();
    const elv = ELEV[bm ? bm.BiomeName : ''] || [.1, .5];
    surfLo = Math.round(WL + elv[0] * (maxD - WL)); surfHi = Math.round(WL + elv[1] * (maxD - WL));
    surfMid = (surfLo + surfHi) / 2;
    const surfY = Math.round(surfMid);   // the mean surface as a row: the floor, the edge ruler and the real columns all read through it
    SCd = 1000 / Math.max(60, maxD);
    const colTop = yAtDepth(0), colBot = yAtDepth(maxD + 1); H = colBot + 24;
    const rows = surfY + 1;
    // columns left to right: depth ruler | probability stack | one bar per vein/fill (its settings) | real columns | world-Y edge
    const CX = X0, GX = CX + Wc + 10, GW = objs.length * (BW + BGAP), EX = GX + GW + 14, W = EX + 60;
    const cB = cssv('--border'), cM = cssv('--muted'), cT = cssv('--text'), cS = cssv('--text2'), cWl = cssv('--water') || '#3987e5', cSurf = cssv('--surf') || '#ffffff', cAcc = cssv('--accent') || '#185fa5';
    // A vein's SEED can only land where its own stratum is the rock, so a vein seeded in a layer that
    // exists in 43% of columns starts 43% as often as one in a layer that always exists. The blocks it then
    // grows overwrite whatever they reach, so the scaling is by the parent's share over the seed depths
    // only - not per grow depth. (The previous commit described this fix but returned before reaching it.)
    const seedOk = oi.map(info => { if (!info.shape || !hasBase) return 1; const pi = stratIdxOf.get(info.o.parent); if (pi == null) return 1;
      let acc = 0, n = 0; for (let d = info.sa; d <= info.sb; d++) { if (d < 0 || d > maxD) continue; acc += baseProb[pi][d]; n++; } return n ? acc / n : 1; });
    const veinCov = (i, d) => { const info = oi[i]; if (d < info.mn || d > info.mx || info.sh <= 0) return 0; return info.sh * info.shape[d] * seedOk[i]; };
    // one 100% column at each DEPTH: veins overwrite first (first-wins), then each stratum's rock is carved by its scatters
    const N = strata.length;
    const veinIdx = [], scatBy = strata.map(() => []), orphan = [];
    oi.forEach((info, i) => { if (info.o.kind === 'dep') veinIdx.push(i); else { const pi = stratIdxOf.get(info.o.parent); if (pi != null) scatBy[pi].push(i); else orphan.push(i); } });
    const cells = [];
    strata.forEach((st, i) => { cells.push({ t: 'rock', si: i, node: st.node, col: blockColorRaw(st.block), label: prettyName(shortBlock(st.block)) });
      scatBy[i].forEach(oiIdx => cells.push({ t: 'ore', oiIdx: oiIdx, node: oi[oiIdx].o.node, col: oi[oiIdx].col, label: oreLabel(oi[oiIdx].o) })); });
    orphan.concat(veinIdx).forEach(oiIdx => cells.push({ t: 'ore', oiIdx: oiIdx, node: oi[oiIdx].o.node, col: oi[oiIdx].col, label: oreLabel(oi[oiIdx].o) }));
    const C = cells.length, oiCell = {}, rockCell = {};
    cells.forEach((c, ci) => { if (c.t === 'ore') oiCell[c.oiIdx] = ci; else rockCell[c.si] = ci; });
    const frac = cells.map(() => new Float64Array(maxD + 1));
    for (let d = 0; d <= maxD; d++) { let rem = 1;
      veinIdx.forEach(oiIdx => { const cov = Math.min(1, veinCov(oiIdx, d)); if (cov <= 0) return; const take = rem * cov; frac[oiCell[oiIdx]][d] = take; rem -= take; });
      const nonDep = rem;
      strata.forEach((st, i) => { const p = baseProb[i] ? baseProb[i][d] : 0; if (p <= 0) return; const foot = nonDep * p; let sRem = 1;
        scatBy[i].forEach(oiIdx => { const info = oi[oiIdx]; if (d < info.mn || d > info.mx) return; const pc = Math.max(0, Math.min(1, info.sh)); const take = sRem * pc; frac[oiCell[oiIdx]][d] += foot * take; sRem -= take; });
        frac[rockCell[i]][d] += foot * sRem; }); }
    const cum = []; for (let c = 0; c <= C; c++) cum.push(new Float64Array(maxD + 1));
    for (let d = 0; d <= maxD; d++) { let acc = 0; for (let c = 0; c < C; c++) { cum[c][d] = acc; acc += frac[c][d]; } cum[C][d] = acc; }
    const xOf = (c, d) => CX + Wc * cum[c][d];
    const maxFrac = cells.map((c, ci) => { let m = 0; for (let d = 0; d <= maxD; d++) if (frac[ci][d] > m) m = frac[ci][d]; return m; });
    const peakD = cells.map((c, ci) => { let pk = 0, pv = -1; for (let d = 0; d <= maxD; d++) if (frac[ci][d] > pv) { pv = frac[ci][d]; pk = d; } return pk; });
    // a cell's outline as stepped block rows, emitting a point only where its x changes (long runs are the norm)
    const edge = (c, down) => { let p = '', px = null;
      if (down) { for (let d = 0; d <= maxD; d++) { const x = f1(xOf(c, d)); if (x !== px) { if (px != null) p += ' L' + px + ' ' + f1(yAtDepth(d)); p += ' L' + x + ' ' + f1(yAtDepth(d)); px = x; } } p += ' L' + px + ' ' + f1(yAtDepth(maxD + 1)); }
      else { for (let d = maxD; d >= 0; d--) { const x = f1(xOf(c, d)); if (x !== px) { if (px != null) p += ' L' + px + ' ' + f1(yAtDepth(d + 1)); p += ' L' + x + ' ' + f1(yAtDepth(d + 1)); px = x; } } p += ' L' + px + ' ' + f1(yAtDepth(0)); }
      return p; };
    const axMid = (colTop + colBot) / 2;
    let s = '<svg id="ovSvg" xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:block;touch-action:none;user-select:none;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif">';
    s += '<defs><linearGradient id="ovBell" x1="0" y1="0" x2="0" y2="1">' + bellStops().map(st => '<stop offset="' + st.off.toFixed(4) + '" stop-color="' + cT + '" stop-opacity="' + (0.62 * st.a).toFixed(3) + '"/>').join('') + '</linearGradient>';
    s += '<pattern id="ovHatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="' + cT + '" stroke-opacity="0.5" stroke-width="1.2"/></pattern></defs>';
    s += '<text x="12" y="' + f1(axMid) + '" fill="' + cS + '" font-size="12" transform="rotate(-90 12 ' + f1(axMid) + ')">Depth below the surface</text>';
    for (let d = 0; d <= maxD; d += 10) { const yy = yAtDepth(d); s += '<line x1="' + CX + '" y1="' + f1(yy) + '" x2="' + EX + '" y2="' + f1(yy) + '" stroke="' + cB + '"/><text x="' + (CX - 8) + '" y="' + f1(yy + 4) + '" text-anchor="end" font-size="11" fill="' + cM + '">' + d + '</text>'; }
    if (objs.length) s += '<text x="' + GX + '" y="' + (TOPY - 6) + '" font-size="9" fill="' + cM + '">depth ranges</text>';
    // ---- the stack: how often each block is what you dig through at each depth ----
    cells.forEach((c, ci) => { if (maxFrac[ci] < 1e-4) return;
      const seld = c.t === 'rock' ? (sel && sel.kind === 'strat' && sel.node === c.node) : (sel && sel.kind !== 'strat' && sel.node === c.node);
      const path = 'M' + f1(xOf(ci, 0)) + ' ' + f1(yAtDepth(0)) + edge(ci, true) + edge(ci + 1, false) + 'Z';
      s += '<path d="' + path + '" fill="' + c.col + '"' + (c.t === 'rock' ? ' data-strat="' + c.si + '" style="cursor:pointer"' : '') + '/>';
      if (seld) s += '<path d="' + path + '" fill="none" stroke="' + cT + '" stroke-width="2"/>';
      const pk = peakD[ci], wpx = xOf(ci + 1, pk) - xOf(ci, pk);
      if (wpx > 30) s += '<text x="' + f1((xOf(ci, pk) + xOf(ci + 1, pk)) / 2) + '" y="' + f1(yAtDepth(pk + 0.5) + 3) + '" text-anchor="middle" font-size="' + (c.t === 'rock' ? 10 : 9) + '" fill="' + labelColor(c.col) + '" pointer-events="none">' + c.label + '</text>';
      if (c.t === 'ore') {
        // the ribbon moves the object; its inner (left) edge is the abundance handle - drag it into the rock for more
        let tD = -1, bD = -1; for (let d = 0; d <= maxD; d++) if (frac[ci][d] > 1e-3) { if (tD < 0) tD = d; bD = d; }
        if (tD < 0) { tD = oi[c.oiIdx].mn; bD = oi[c.oiIdx].mx; }
        const lc = xOf(ci, pk), y1 = yAtDepth(tD), y2 = yAtDepth(bD + 1);
        s += '<path d="' + path + '" fill="transparent" pointer-events="all" data-drag="' + c.oiIdx + '|move" style="cursor:move"/>';
        if (seld) s += '<line x1="' + f1(lc) + '" y1="' + f1(y1 + 1) + '" x2="' + f1(lc) + '" y2="' + f1(y2 - 1) + '" stroke="' + cT + '" stroke-width="3" stroke-linecap="round"/>';
        s += rect(lc - 7, y1, 14, Math.max(6, y2 - y1), 'fill="transparent" pointer-events="all" data-drag="' + c.oiIdx + '|w" style="cursor:ew-resize"'); } });
    // ---- boundary bands: where each layer ENDS, shaded by how often the per-column draw lands there ----
    if (hasBase) {
      const bands = bandLayout(strata, lastAlive, maxD);
      const selI = (sel && sel.kind === 'strat') ? strata.findIndex(st => st.node === sel.node) : -1;
      // hollow bands behind solid ones, the selected band on top so its handles win in an overlap
      const order = bands.filter(b => b.hollow && b.si !== selI).concat(bands.filter(b => !b.hollow && b.si !== selI));
      if (selI >= 0) order.push(bands[selI]);
      const labY = spreadLabels(bands.map(b => yAtDepth(b.core)), 11);
      let handles = '', labels = '';
      order.forEach(b => { const st = strata[b.si]; let y1 = yAtDepth(b.top), y2 = yAtDepth(b.bot);
        if (y2 - y1 < MINBAND) { const mid = (y1 + y2) / 2; y1 = mid - MINBAND / 2; y2 = mid + MINBAND / 2; }
        const seld = b.si === selI;
        if (b.hollow) s += rect(CX, y1, Wc, y2 - y1, 'fill="url(#ovBell)" fill-opacity="0.35" stroke="' + cT + '" stroke-opacity="0.55" stroke-dasharray="4 3"');
        else if (b.ceiling) s += rect(CX, y1, Wc, y2 - y1, 'fill="url(#ovBell)" fill-opacity="0.5" stroke="' + cM + '" stroke-dasharray="2 3"');
        else s += rect(CX, y1, Wc, y2 - y1, 'fill="url(#ovBell)"');
        if (seld) s += rect(CX, y1, Wc, y2 - y1, 'fill="none" stroke="' + cAcc + '" stroke-width="2"');
        const txt = prettyName(shortBlock(st.block)) + ' ends ' + (st.node.Min | 0) + '–' + (st.node.Max | 0) + (b.live < 0.995 ? ' · ' + livePct(b.live) : '') + (b.ceiling ? ' · ceiling' : '');
        labels += '<text x="' + (CX + Wc - 4) + '" y="' + f1(labY[b.si] + 3.5) + '" text-anchor="end" font-size="9.5" fill="' + (seld ? cAcc : cT) + '" stroke="' + cSurf + '" stroke-width="3" paint-order="stroke" data-strat="' + b.si + '" style="cursor:pointer">' + txt + '</text>';
        // handles: the dense core (the middle half of the bell, quantiles 8..24) moves Min and Max together;
        // a grip on each edge moves that edge alone. The rest of the band stays transparent so the stack and
        // the ribbons under a wide band remain reachable.
        const hgt = y2 - y1; let c1 = y1 + hgt * BELL[8], c2 = y1 + hgt * BELL[24];
        if (c2 - c1 < MINBAND) { const mid = (c1 + c2) / 2; c1 = mid - MINBAND / 2; c2 = mid + MINBAND / 2; }
        const out = hgt < 24;   // a thin band puts its grips outside itself so they do not cover the core
        handles += rect(CX, c1, Wc, c2 - c1, 'fill="transparent" pointer-events="all" data-sdrag="' + b.si + '" style="cursor:move"');
        handles += rect(CX, out ? y1 - GRIP : y1 - GRIP / 2, Wc, GRIP, 'fill="transparent" pointer-events="all" data-sedge="' + b.si + '|min" style="cursor:ns-resize"');
        handles += rect(CX, out ? y2 : y2 - GRIP / 2, Wc, GRIP, 'fill="transparent" pointer-events="all" data-sedge="' + b.si + '|max" style="cursor:ns-resize"'); });
      s += handles + labels;
    }
    // ---- one bar per vein/fill: the depth setting itself, clipped to where it can act ----
    let k = 0, selBarX = null, selBarInfo = null;
    cells.forEach(c => { if (c.t !== 'ore') return; const info = oi[c.oiIdx], x = GX + (k++) * (BW + BGAP), seld = sel && sel.kind !== 'strat' && sel.node === c.node;
      if (seld) { selBarX = x; selBarInfo = info; }
      const pi = stratIdxOf.get(info.o.parent), pp = (hasBase && pi != null) ? baseProb[pi] : null;
      const hTop = info.sa != null ? info.sa : info.mn, hBot = info.sb != null ? info.sb : info.mx;
      s += '<g><title>' + oreLabel(info.o) + ' · ' + metaOf(info.o) + '</title>';
      // a vein: the whole grow window light, then its seed range on top; a fill: just its range
      if (info.shape) s += rect(x, yAtDepth(info.mn), BW, yAtDepth(info.mx + 1) - yAtDepth(info.mn), 'fill="' + info.col + '" fill-opacity="0.3"');
      clipRuns(pp, hTop, hBot, maxD).forEach(r => { const y1 = yAtDepth(r.a), y2 = yAtDepth(r.b + 1);
        if (r.on) s += rect(x, y1, BW, y2 - y1, 'fill="' + info.col + '"');
        else s += rect(x, y1, BW, y2 - y1, 'fill="' + info.col + '" fill-opacity="0.3"') + rect(x, y1, BW, y2 - y1, 'fill="url(#ovHatch)"'); });
      if (seld) s += rect(x - 1, yAtDepth(info.mn) - 1, BW + 2, yAtDepth(info.mx + 1) - yAtDepth(info.mn) + 2, 'fill="none" stroke="' + cT + '" stroke-width="1.5"');
      s += rect(x, yAtDepth(info.mn), BW, yAtDepth(info.mx + 1) - yAtDepth(info.mn), 'fill="transparent" pointer-events="all" data-drag="' + c.oiIdx + '|move" style="cursor:move"');
      if (info.shape) { // grow-window grips first, so a seed grip that sits on the same edge wins
        s += rect(x, yAtDepth(info.mn) - GRIP / 2, BW, GRIP, 'fill="transparent" pointer-events="all" data-drag="' + c.oiIdx + '|gt" style="cursor:ns-resize"');
        s += rect(x, yAtDepth(info.mx + 1) - GRIP / 2, BW, GRIP, 'fill="transparent" pointer-events="all" data-drag="' + c.oiIdx + '|gb" style="cursor:ns-resize"'); }
      s += rect(x, yAtDepth(hTop) - GRIP / 2, BW, GRIP, 'fill="transparent" pointer-events="all" data-drag="' + c.oiIdx + '|t" style="cursor:ns-resize"');
      s += rect(x, yAtDepth(hBot + 1) - GRIP / 2, BW, GRIP, 'fill="transparent" pointer-events="all" data-drag="' + c.oiIdx + '|b" style="cursor:ns-resize"');
      s += '</g>'; });
    // ---- the selected vein, drawn as one deposit at true scale ------------------------------------
    // The bar beside it is the SETTING - the depths a seed may land in. It says nothing about how big the
    // thing that grows from it is, and that is the question you ask when a prospect comes back 17 blocks
    // deep. So draw one, same scale as the depth axis, against the soft window it is allowed to grow in.
    if (selBarInfo && selBarInfo.shape) {
      const node = selBarInfo.o.node, e = veinExtent(node);
      const dd = node.DepositDepthRange || node.DepthRange || { min: 0, max: 10 };
      const px = SCd;                                  // one block, both ways, so the shape is not distorted
      let cx = (selBarX != null ? selBarX + BW / 2 : GX + GW / 2);
      const halfW = (e.projWide * px) / 2 + 4;
      cx = Math.max(CX + halfW, Math.min(EX - halfW, cx));
      const wLo = yAtDepth(dd.min | 0), wHi = yAtDepth((dd.max | 0) + 1);
      s += '<g pointer-events="none">';
      // the crisp box is ONE deposit's window; the faint one behind it is where the ore actually reaches,
      // because every deposit hangs under its own seed's surface and the ground rolls over a range
      const relief = Math.max(0, (surfHi | 0) - (surfLo | 0));
      if (relief > 0) { const bLo = yAtDepth((dd.min | 0)), bHi = yAtDepth((dd.max | 0) + 1 + relief);
        s += rect(cx - halfW - 3, bLo, halfW * 2 + 6, bHi - bLo, 'fill="' + selBarInfo.col + '" fill-opacity="0.10"');
        s += '<text x="' + f1(cx) + '" y="' + f1(bHi - 3) + '" text-anchor="middle" font-size="9" fill="' + cM + '" paint-order="stroke" stroke="' + cssv('--surf') + '" stroke-width="3">'
          + 'a column digs ~' + (e.tall + relief) + ' blocks of it</text>'; }
      s += rect(cx - halfW, wLo, halfW * 2, wHi - wLo, 'fill="none" stroke="' + cT + '" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="3 3"');
      e.proj.forEach(pr => { const bx = cx + pr[0] * px - px / 2, by = yAtDepth(pr[1]);
        s += rect(bx, by, px + 0.4, px + 0.4, 'fill="' + selBarInfo.col + '"'); });
      const capY = Math.min(yAtDepth(maxD), wHi + 13);
      s += '<text x="' + f1(cx) + '" y="' + f1(capY) + '" text-anchor="middle" font-size="9.5" fill="' + cM + '" paint-order="stroke" stroke="' + cssv('--surf') + '" stroke-width="3">'
        + 'one deposit Â· ' + e.tall + ' tall Ã— ' + e.wide + ' wide' + (e.shapes > 1 ? ' (1 of ' + e.shapes + ' shapes)' : '') + '</text>';
      s += '<text x="' + f1(cx) + '" y="' + f1(wLo - 5) + '" text-anchor="middle" font-size="9" fill="' + cM + '" paint-order="stroke" stroke="' + cssv('--surf') + '" stroke-width="3">grows within</text>';
      s += '</g>';
    }
    // ---- world-Y edge: depth read back through this biome's mean surface, plus the water line and the floor ----
    const floorD = surfY;   // Y0 sits this deep under the mean surface; higher ground digs deeper
    const edgeBot = yAtDepth(Math.min(maxD, floorD) + 1);
    s += '<line x1="' + EX + '" y1="' + f1(colTop) + '" x2="' + EX + '" y2="' + f1(edgeBot) + '" stroke="' + cS + '"/>';
    for (let Y = 0; Y <= surfY; Y += 10) { const d = surfY - Y; if (d > maxD) continue; const yy = yAtDepth(d + 0.5), big = Y % 20 === 0;
      s += '<line x1="' + EX + '" y1="' + f1(yy) + '" x2="' + (EX + (big ? 6 : 3)) + '" y2="' + f1(yy) + '" stroke="' + cS + '"/>';
      if (big) s += '<text x="' + (EX + 9) + '" y="' + f1(yy + 3.5) + '" font-size="9.5" fill="' + cM + '">Y' + Y + '</text>'; }
    s += '<text x="' + (EX + 50) + '" y="' + f1(axMid) + '" fill="' + cS + '" font-size="10" text-anchor="middle" transform="rotate(-90 ' + (EX + 50) + ' ' + f1(axMid) + ')">world Y under the mean surface (Y' + surfY + ')</text>';
    s += '<text x="' + (W - 2) + '" y="' + (TOPY - 6) + '" text-anchor="end" font-size="9" fill="' + cM + '">surface Y' + surfLo + '–' + surfHi + '</text>';
    const wD = surfY - WL;
    if (wD >= 0 && wD <= maxD) { const wy = yAtDepth(wD + 0.5);
      s += '<line x1="' + CX + '" y1="' + f1(wy) + '" x2="' + EX + '" y2="' + f1(wy) + '" stroke="' + cWl + '" stroke-width="1.2" stroke-dasharray="5 4"/><text x="' + (EX - 4) + '" y="' + f1(wy - 4) + '" text-anchor="end" font-size="10" fill="' + cWl + '">water Y' + WL + '</text>'; }
    if (floorD <= maxD) { const fy = yAtDepth(floorD + 1);
      s += rect(CX, fy, EX - CX, colBot - fy, 'fill="' + cSurf + '" fill-opacity="0.55" pointer-events="none"');
      s += '<line x1="' + CX + '" y1="' + f1(fy) + '" x2="' + EX + '" y2="' + f1(fy) + '" stroke="' + cS + '" stroke-width="1"/><text x="' + (CX + 4) + '" y="' + f1(fy + 11) + '" font-size="9.5" fill="' + cM + '" pointer-events="none">Y0 under the mean surface · higher ground digs deeper</text>'; }
    if (!cells.length) s += '<text x="' + (CX + 20) + '" y="' + (TOPY + 44) + '" fill="' + cM + '" font-size="12">nothing here yet — add a vein or scatter below</text>';
    s += rect(CX, colTop, Wc, colBot - colTop, 'fill="none" stroke="' + cB + '" stroke-width="1"');
    s += '</svg>';
    laneEl.innerHTML = s; svgEl = document.getElementById('ovSvg'); probeEl = null;
    svgEl.addEventListener('pointermove', showProbe);
    svgEl.addEventListener('pointerleave', hideProbe);
    svgEl.addEventListener('pointerdown', hideProbe);
    svgEl.addEventListener('pointerdown', onDown);
  }
  const pointerDepth = e => { const r = svgEl.getBoundingClientRect(); return depthAtSvgY((e.clientY - r.top) * (H / r.height)); };
  // Read the column at one depth. Everything needed was already computed for the drawing - lastProb per
  // stratum per depth, and every object's own depth range - but you could only get at it by reading the
  // picture, and the picture is a stack of probabilities that no eye reads to 1%.
  let probeEl = null;
  function hideProbe() { if (probeEl) probeEl.style.display = 'none'; }
  function showProbe(e) {
    if (drag || !svgEl || !laneEl) return;                      // never fight a drag
    const d = Math.round(pointerDepth(e));
    if (!(d >= 0 && d <= maxD) || !lastProb.length) { hideProbe(); return; }
    if (!probeEl) { probeEl = document.createElement('div'); probeEl.id = 'ovProbe'; laneEl.appendChild(probeEl); }
    const rows = strata.map((st, i) => ({ st: st, p: (lastProb[i] && lastProb[i][d]) || 0 }))
      .filter(r => r.p >= 0.005).sort((a, b) => b.p - a.p);
    let h = '<div class="pd">depth ' + d + '</div>';
    h += rows.length ? rows.map(r => '<div class="pr"><span class="pdot" style="background:' + blockColorRaw(r.st.block) + '"></span>'
      + prettyName(shortBlock(r.st.block)) + '<b>' + Math.round(r.p * 100) + '%</b></div>').join('')
      : '<div class="pr">nothing generates here</div>';
    const here = objs.filter(o => { const r = o.node.DepthRange; return r && d >= (r.min | 0) && d <= (r.max | 0); });
    if (here.length) h += '<div class="psub">' + here.map(o => (o.kind === 'dep' ? 'vein ' : 'fill ') + oreLabel(o)
      + ' in ' + prettyName(shortBlock(btOf(o.parent.BlockType) || '')) ).join('<br>') + '</div>';
    probeEl.innerHTML = h; probeEl.style.display = 'block';
    const lr = laneEl.getBoundingClientRect(), pw = probeEl.offsetWidth, ph = probeEl.offsetHeight;
    let x = e.clientX - lr.left + laneEl.scrollLeft + 14, y = e.clientY - lr.top + laneEl.scrollTop + 14;
    if (x + pw > laneEl.scrollLeft + lr.width) x = Math.max(0, x - pw - 28);
    if (y + ph > laneEl.scrollTop + lr.height) y = Math.max(0, y - ph - 28);
    probeEl.style.left = x + 'px'; probeEl.style.top = y + 'px';
  }
  function onDown(e) { const t = e.target; if (!t || !t.dataset) return;
    if (t.dataset.sdrag != null || t.dataset.sedge != null) { const p = (t.dataset.sedge != null ? t.dataset.sedge : t.dataset.sdrag).split('|'); const st = strata[+p[0]];
      // every drag is a delta from where the pointer went down, so grabbing a handle never jumps the value
      if (st) { sel = { kind: 'strat', node: st.node, block: st.block }; drag = { strat: st.node, edge: p[1] || 'both', d0: pointerDepth(e), min: st.node.Min | 0, max: st.node.Max | 0 }; }
      e.preventDefault(); render(); renderDetail(); renderList(); return; }
    if (t.dataset.strat != null) { const st = strata[+t.dataset.strat]; sel = st ? { kind: 'strat', node: st.node, block: st.block } : null; drag = null; render(); renderDetail(); renderList(); return; }
    if (!t.dataset.drag) return; const p = t.dataset.drag.split('|');
    sel = objs[+p[0]]; drag = { i: +p[0], o: objs[+p[0]], k: p[1] };
    startDepth = pointerDepth(e); const grow = p[1] === 'gt' || p[1] === 'gb';
    const rg = (grow ? drag.o.node.DepositDepthRange : drag.o.node.DepthRange) || {}; snapMin = rg.min || 0; snapMax = rg.max || 0;
    if (p[1] === 'w') { const r = svgEl.getBoundingClientRect(), vbW = svgEl.viewBox.baseVal.width; drag.wx = (e.clientX - r.left) * (vbW / r.width); drag.wshare = shareOf(drag.o); }
    e.preventDefault(); render(); renderDetail(); renderList(); }
  function onMove(e) { if (!drag) return;
    if (drag.strat) { const dl = Math.round(pointerDepth(e) - drag.d0), node = drag.strat;
      if (drag.edge === 'min') node.Min = Math.max(0, Math.min(drag.max, drag.min + dl));
      else if (drag.edge === 'max') node.Max = Math.max(drag.min, drag.max + dl);
      else { node.Min = Math.max(0, drag.min + dl); node.Max = node.Min + (drag.max - drag.min); }
      render(); renderDetail(); scheduleOreRender(); return; }
    const o = drag.o, dl = Math.round(pointerDepth(e) - startDepth);
    if (drag.k === 'move') { const span = snapMax - snapMin; const nmin = Math.max(0, Math.min(maxD - span, snapMin + dl)); o.node.DepthRange = o.node.DepthRange || {}; o.node.DepthRange.min = nmin; o.node.DepthRange.max = nmin + span; }
    else if (drag.k === 't') { const r = o.node.DepthRange = o.node.DepthRange || {}; r.min = Math.max(0, Math.min(r.max || 0, snapMin + dl)); }
    else if (drag.k === 'b') { const r = o.node.DepthRange = o.node.DepthRange || {}; r.max = Math.max(r.min || 0, Math.min(maxD, snapMax + dl)); }
    // the grow window may start above the surface (stock Desert has a vein growing from -2), so only its order is enforced
    else if (drag.k === 'gt') { const r = o.node.DepositDepthRange = o.node.DepositDepthRange || {}; r.min = Math.min(r.max != null ? r.max : snapMax, snapMin + dl); }
    else if (drag.k === 'gb') { const r = o.node.DepositDepthRange = o.node.DepositDepthRange || {}; r.max = Math.max(r.min != null ? r.min : snapMin, Math.min(maxD, snapMax + dl)); }
    else if (drag.k === 'w') { const r = svgEl.getBoundingClientRect(), vbW = svgEl.viewBox.baseVal.width, xx = (e.clientX - r.left) * (vbW / r.width);
      if (drag.wx != null) setShare(o, Math.max(0.005, Math.min(1, drag.wshare - (xx - drag.wx) / Wc))); }
    render(); renderDetail(); scheduleOreRender(); }
  /** A percentage with no trailing noise: 1 -> 100%, .075 -> 7.5%, .0025 -> 0.25%. */
  function pct(v) { if (v == null) return ''; const n = v * 100;
    let s = n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2);
    // trim only a FRACTIONAL tail (100 must not become 1). No regex: a backslash here would be eaten
    // by the template literal this file is emitted from.
    if (s.indexOf('.') >= 0) { while (s.slice(-1) === '0') s = s.slice(0, -1); if (s.slice(-1) === '.') s = s.slice(0, -1); }
    return s + '%'; }
  // An en dash between a negative bound and its max reads as one number ("-2-1"), and depths really do
  // go negative: a vein whose grow range starts at -2 may climb two blocks ABOVE the surface. Spell
  // those out instead.
  const rangeOf = r => { if (!r) return ''; const a = r.min | 0, b = r.max | 0;
    return (a < 0 || b < 0) ? a + ' to ' + b : a + '–' + b; };
  // A scatter's DepthRange IS the depths it fills. A vein's is only where its SEED may land - it then
  // grows through DepositDepthRange, which the engine widens to include the seed range and treats as a
  // soft bound (leaving it costs 5x a normal vertical step). Naming the seed range as the extent was
  // simply wrong, so say both - and only when they differ, since after the widening they often do not.
  function metaOf(o) {
    const seed = rangeOf(o.node.DepthRange);
    if (o.kind !== 'dep') return seed;
    const grow = rangeOf(o.node.DepositDepthRange);
    return (grow && grow !== seed) ? 'seed ' + seed + ' · grows ' + grow : seed;
  }
  /** The depths where this layer is the commonest rock, from the bands render() already solved. */
  function occupiedBand(node) { let top = null, bot = null;
    lastBands.forEach(b => { if (b.st.node === node) { top = top == null ? b.top : Math.min(top, b.top); bot = bot == null ? b.bot : Math.max(bot, b.bot); } });
    return top == null ? null : { top: top, bot: bot }; }
  const livePct = v => v >= 0.995 ? '100%' : v < 0.005 ? '<1%' : Math.round(v * 100) + '%';
  const liveClass = v => v >= 0.9 ? 'lv-hi' : v >= 0.25 ? 'lv-mid' : 'lv-lo';
  // A row carries BOTH numbers on purpose. "ends" is the one you edit and the only one in the file; "is" is
  // where the layer actually sits, which "ends" cannot tell you because the top comes from the layer above.
  // Showing only one of the two has confused a reader every time it has been tried.
  const stratMetaDesc = (st, occ, live) =>
    'ends: the depth this layer stops at, drawn per column between Min and Max — this is the editable number'
    + (occ ? ' · is: the depths where it is the commonest rock' : ' · it is never the commonest rock at any depth')
    + (live == null ? '' : ' · it is the rock somewhere in ' + livePct(live) + ' of columns');
  // The weights are a LIST - the engine picks one at random per deposit - so editing them as raw vectors is
  // a poor fit for a panel. These three cover what the stock configs actually do: shallow desert iron is
  // Y-dominant and grows as pipes, the deep sheets are X/Z-dominant. "mixed" is shown, not offered, when the
  // config carries a list this cannot express - changing it away is one-way, so it says so.
  const GROWTH = {
    pipes:  { label: 'vertical pipes',  w: [{ X: 1, Y: 4, Z: 1 }], v: { X: 2, Y: 1, Z: 1 } },
    blobs:  { label: 'even blobs',      w: [{ X: 1, Y: 1, Z: 1 }], v: { X: 1, Y: 1, Z: 1 } },
    sheets: { label: 'flat sheets',     w: [{ X: 4, Y: 1, Z: 4 }], v: { X: 3, Y: 1, Z: 3 } },
  };
  function growthKindOf(node) {
    const ws = node.DirectionWeights || [];
    if (ws.length !== 1) return ws.length > 1 ? 'mixed' : 'blobs';
    const w = ws[0], y = w.Y || 1, xz = Math.max(w.X || 1, w.Z || 1);
    return y > xz ? 'pipes' : xz > y ? 'sheets' : 'blobs'; }
  function growthSelect(node) {
    const cur = growthKindOf(node);
    const opts = Object.keys(GROWTH).map(k => '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + GROWTH[k].label + '</option>').join('')
      + (cur === 'mixed' ? '<option value="mixed" selected>mixed (' + (node.DirectionWeights || []).length + ' shapes)</option>' : '');
    return '<span class="kk"><label title="which way a deposit prefers to grow - the single biggest lever on what it looks like underground">growth</label>'
      + '<select class="kv" data-f="growth">' + opts + '</select></span>'; }
  // One deposit is not what you dig through, and the difference is not small. Two things stack on top of it:
  //
  //   * every deposit's soft window is anchored to ITS OWN seed column's surface
  //     (DepositTerrainModule.ConvertDepthRangeToHeightRange: depth + height - range), so across a biome's
  //     surface relief the windows slide past each other in absolute Y. Desert's surface runs Y61-Y72, so a
  //     5-deep window seeded anywhere in it unions to a 16-block band - and one column passes through all
  //     of it. Measured against the game: settings of 20-24 with 11 blocks of relief prospect as 16 blocks
  //     of solid iron, where the panel used to promise 5.
  //   * seed rate times deposit size is ore per column, and it is easy to set that far above what the band
  //     can hold. The engine warns about the same ratio at load (Initialize, "spawn rate is too high").
  function veinNoteHtml(node) {
    const e = veinExtent(node), dd = node.DepositDepthRange || node.DepthRange || { min: 0, max: 10 };
    const dr = node.DepthRange || dd, bc = node.BlocksCountRange || { min: 1, max: 1 };
    const relief = Math.max(0, (surfHi | 0) - (surfLo | 0));
    const band = e.tall + relief;
    const seedsPerCol = Math.max(0, ((dr.max | 0) - (dr.min | 0) + 1)) * (node.SpawnPercentChance || 0);
    const perCol = seedsPerCol * (((bc.min | 0) + (bc.max | 0)) / 2);
    const perSeed = node.SpawnPercentChance ? Math.round(1 / node.SpawnPercentChance) : Infinity;
    const tooDense = (bc.max | 0) > perSeed;
    // Lead with the number a drill returns. "5 blocks tall" is the deposit's own height somewhere in it;
    // a flat sheet 5 tall spreads 3000 blocks over 971 columns and the MEDIAN one holds 3, while the same
    // 3000 as blobs holds 5. Thickness is what you dig, and it is set by growth far more than by size.
    let h = '<b>a drill through one passes about ' + e.thick + ' block' + (e.thick === 1 ? '' : 's') + '</b>'
      + ' — it is ' + e.tall + ' tall and ' + e.wide + ' wide overall'
      + ', ' + e.n + ' blocks' + (e.capped ? ' (shape sampled at ' + GROW_CAP + ')' : '')
      + (e.shapes > 1 ? ', averaged over its ' + e.shapes + ' growth shapes' : '') + '.';
    if (relief > 0) h += ' Each one hangs under the surface of <b>its own</b> seed, and the ground here rolls over '
      + relief + ' blocks, so across the biome the ore can sit anywhere in a band about <b>' + band + ' blocks</b> deep — that is its reach, not its thickness.';
    if (perCol > 0) { const pc = perCol < 1 ? perCol.toFixed(2) : Math.round(perCol);
      h += ' At this seed rate that is roughly <b>' + pc + ' block' + (String(pc) === '1' ? '' : 's') + ' of ore per column</b>'
        + (perCol >= band ? ', more than the band can hold — expect it solid.' : '.'); }
    if (tooDense) h += ' <b style="color:#c0705a">The engine will warn at load</b>: one seed per ' + perSeed
      + ' blocks with deposits up to ' + (bc.max | 0) + ' is too dense; it wants about 1 per ' + Math.round((bc.max | 0) * 1.2) + '.';
    return h; }

  // ---- how big a vein actually gets ------------------------------------------------------------------
  // A vein is not a depth range with a density; it is a seed that GROWS. DepositSpawner keeps a priority
  // queue of candidate blocks and always takes the cheapest, where a step costs 1/weight for its axis minus
  // a random share of that axis's variance, and any vertical step leaving the soft window costs 5x. So the
  // direction weights decide the SHAPE and the block count decides the size, and neither was visible: the
  // panel drew a vein as an abundance over its depth range, which answers a different question. Stock
  // Desert's shallow iron carries Y-dominant weights and reads as 13-block vertical pipes underground while
  // the panel showed a thin ribbon. This is a port of that loop, run once per (size, weights, window).
  function heapPush(h, e) { h.push(e); let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (h[p].pr <= h[i].pr) break; const t = h[p]; h[p] = h[i]; h[i] = t; i = p; } }
  function heapPop(h) { const top = h[0], last = h.pop();
    if (h.length) { h[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < h.length && h[l].pr < h[m].pr) m = l;
        if (r < h.length && h[r].pr < h[m].pr) m = r;
        if (m === i) break; const t = h[m]; h[m] = h[i]; h[i] = t; i = m; } }
    return top; }
  // Growing fewer blocks than configured does NOT give the same shape smaller - measured on a 20-24
  // window at (4,1,4): 1200 blocks is 5 tall x 30 wide, 3000 is 5 tall x 42, 5000 is 5 tall x 51. The
  // height saturates against the window, the width does not, so a cap below the real count understates
  // reach. 5000 covers the stock configs; past that it is stated rather than guessed at.
  const GROW_CAP = 5000;
  const extentMemo = new Map();
  /** Grow one deposit and report its bounding box. Deterministic: same settings, same answer. */
  function growExtent(n, w, wv, winLo, winHi) {
    n = Math.max(1, Math.min(GROW_CAP, n | 0));
    const inv = { x: 1 / w.X, y: 1 / w.Y, z: 1 / w.Z };
    const iv = { x: wv.X / ((wv.X + w.X) * w.X), y: wv.Y / ((wv.Y + w.Y) * w.Y), z: wv.Z / ((wv.Z + w.Z) * w.Z) };
    let a = 0x51ed3c; const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const seedY = Math.round((winLo + winHi) / 2), taken = new Set(), queued = new Set(), q = [];
    const pri = (pr, i, v) => pr + i - rnd() * v;
    let xlo = 0, xhi = 0, zlo = 0, zhi = 0, ylo = seedY, yhi = seedY;
    const proj = new Set();   // (x, depth) - the deposit as a cut face would show it
    const col = new Map();    // blocks per (x, z) - what a drill straight down actually passes through
    // EnqueueUnique, as the engine has it: a point already taken or already queued is not queued again.
    const offer = (x, y, z, pr) => { const k = x + ',' + y + ',' + z;
      if (taken.has(k) || queued.has(k)) return; queued.add(k); heapPush(q, { x: x, y: y, z: z, pr: pr }); };
    const spawn = (x, y, z, pr) => { const k = x + ',' + y + ',' + z;
      if (taken.has(k)) return false; taken.add(k); queued.delete(k); proj.add(x + ',' + y);
      const ck = x + ',' + z; col.set(ck, (col.get(ck) || 0) + 1);
      if (x < xlo) xlo = x; if (x > xhi) xhi = x; if (z < zlo) zlo = z; if (z > zhi) zhi = z;
      if (y < ylo) ylo = y; if (y > yhi) yhi = y;
      offer(x + 1, y, z, pri(pr, inv.x, iv.x));
      offer(x - 1, y, z, pri(pr, inv.x, iv.x));
      offer(x, y, z + 1, pri(pr, inv.z, iv.z));
      offer(x, y, z - 1, pri(pr, inv.z, iv.z));
      offer(x, y - 1, z, y - 1 >= winLo ? pri(pr, inv.y, iv.y) : pr + inv.y * 5);
      offer(x, y + 1, z, y + 1 <= winHi ? pri(pr, inv.y, iv.y) : pr + inv.y * 5);
      return true; };
    spawn(0, seedY, 0, 0);
    while (taken.size < n && q.length) { const e = heapPop(q); spawn(e.x, e.y, e.z, e.pr); }
    const hs = [...col.values()].sort((a, b) => a - b);
    return { tall: yhi - ylo + 1, wide: Math.max(xhi - xlo, zhi - zlo) + 1, blocks: taken.size,
             thick: hs.length ? hs[hs.length >> 1] : 0,   // the MEDIAN column, not the deepest one
             proj: [...proj].map(k => k.split(',').map(Number)) };
  }
  /** The typical extent of the selected vein, at its mean size and each of its weight vectors. */
  function veinExtent(node) {
    const bc = node.BlocksCountRange || { min: 1, max: 1 };
    const dd = node.DepositDepthRange || node.DepthRange || { min: 0, max: 10 };
    const ws = (node.DirectionWeights && node.DirectionWeights.length) ? node.DirectionWeights : [{ X: 1, Y: 1, Z: 1 }];
    const wv = node.WeightVariance || { X: 0, Y: 0, Z: 0 };
    const n = Math.round((((bc.min | 0) + (bc.max | 0)) / 2));
    const key = n + '|' + (dd.min | 0) + '|' + (dd.max | 0) + '|' + JSON.stringify(ws) + '|' + JSON.stringify(wv);
    const hit = extentMemo.get(key); if (hit) return hit;
    let tall = 0, wide = 0, thick = 0; const runs = [];
    ws.forEach(w => { const r = growExtent(n, { X: w.X || 1, Y: w.Y || 1, Z: w.Z || 1 },
      { X: wv.X || 0, Y: wv.Y || 0, Z: wv.Z || 0 }, dd.min | 0, dd.max | 0);
      tall += r.tall; wide += r.wide; thick += r.thick; runs.push(r); });
    const mt = tall / ws.length, mw = wide / ws.length;
    // one shape has to stand for the list, so take the one nearest the average rather than the first
    let best = runs[0], bd = Infinity;
    runs.forEach(r => { const d = Math.abs(r.tall - mt) + Math.abs(r.wide - mw); if (d < bd) { bd = d; best = r; } });
    const out = { tall: Math.round(mt), wide: Math.round(mw), thick: Math.round(thick / ws.length), capped: n > GROW_CAP, n: n, shapes: ws.length,
                  proj: best.proj, projTall: best.tall, projWide: best.wide };
    extentMemo.set(key, out); return out; }

  /** A vein's spawn chance as the engine itself phrases it: one seed per N blocks. */
  const seedRate = v => !v ? '' : '1 per ' + (1 / v >= 1000 ? Math.round(1 / v / 100) * 100 : Math.round(1 / v));
  const METdesc = o => o.kind === 'dep'
    ? 'where its seed block may land, the depths it then grows through (a soft bound), and how often one starts'
    : 'the depths it fills, and the share of that rock it takes — a calibrated volume fraction, not a dice roll';
  // list of every block in the biome, NESTED: each base rock, then the veins and scatters that live inside
  // it. They were listed flat - every rock, then every ore - which hid the one thing that decides what a
  // scatter does: which stratum contains it, since it only applies within that stratum's own depth band.
  function renderList() {
    if (!listEl) return;
    let h = '';
    const stratRow = (st, i, occ, live) => { const seld = sel && sel.kind === 'strat' && sel.node === st.node;
      const isAt = occ ? '<span class="lis">is ' + occ.top + '–' + occ.bot + '</span>' : '<span class="lis mixed">mixed in</span>';
      const chip = live == null ? '' : '<span class="lpct ' + liveClass(live) + '">' + livePct(live) + '</span>';
      return '<div class="ovRow' + (seld ? ' sel' : '') + '" data-lk="s" data-li="' + i + '"><span class="ndot" style="background:' + blockColorRaw(st.block) + '"></span><span class="ltag">layer</span><span class="lnm">' + prettyName(shortBlock(st.block)) + '</span><span class="lmeta" title="' + stratMetaDesc(st, occ, live) + '"><span class="lends">ends ' + (st.node.Min | 0) + '–' + (st.node.Max | 0) + '</span>' + isAt + chip + '</span><button class="ndel" data-delstrat="' + i + '" title="Remove this layer and everything in it">✕</button></div>'; };
    const objRow = (o, i, nested) => { const seld = sel && sel.kind !== 'strat' && sel.node === o.node;
      const chance = o.kind === 'dep' ? seedRate(o.node.SpawnPercentChance) : pct(o.node.PercentChance);
      const meta = [metaOf(o), chance].filter(Boolean).join(' · ');
      return '<div class="ovRow' + (seld ? ' sel' : '') + (nested ? ' sub' : '') + '" draggable="true" data-lk="o" data-li="' + i + '"><span class="ndot" style="background:' + oreDot(o) + '"></span><span class="ltag">' + (o.kind === 'dep' ? 'vein' : 'fill') + '</span><span class="lnm">' + oreLabel(o) + '</span><span class="lmeta" title="' + METdesc(o) + '">' + meta + '</span><button class="ndel" data-del="' + i + '" title="Remove this block">✕</button></div>'; };
    const placed = new Set();
    strata.forEach((st, i) => {
      h += stratRow(st, i, occupiedBand(st.node), lastAlive.length ? lastAlive[i] : null);
      objs.forEach((o, j) => { if (o.parent !== st.node) return; placed.add(j); h += objRow(o, j, true); });
    });
    // anything whose parent is not a listed stratum (a depth range with no base block of its own) still
    // has to be reachable, so it goes at the end rather than silently disappearing from the list.
    objs.forEach((o, j) => { if (!placed.has(j)) h += objRow(o, j, false); });
    listEl.innerHTML = h || '<div class="lbl" style="padding:6px">No blocks in this biome.</div>';
    listEl.querySelectorAll('.ovRow').forEach(row => row.onclick = e => { if (e.target.closest('.ndel')) return;
      if (row.dataset.lk === 's') { const st = strata[+row.dataset.li]; sel = st ? { kind: 'strat', node: st.node, block: st.block } : null; }
      else sel = objs[+row.dataset.li] || null;
      render(); renderDetail(); renderList(); });
    listEl.querySelectorAll('.ndel[data-del]').forEach(btn => btn.onclick = e => { e.stopPropagation();
      const o = objs[+btn.dataset.del]; if (!o) return; const idx = o.sub.indexOf(o.node); if (idx >= 0) o.sub.splice(idx, 1); if (sel && sel.node === o.node) sel = null; render(); renderDetail(); renderList(); scheduleOreRender(); });
    listEl.querySelectorAll('.ndel[data-delstrat]').forEach(btn => btn.onclick = e => { e.stopPropagation(); removeStratum(strata[+btn.dataset.delstrat]); });
    wireDrag();
  }
  // Drag a fill or vein onto a layer to move it there, or onto another fill/vein to drop it in at that
  // spot. Both matter: which layer decides whether it can act at all, and the position decides who wins
  // when two of them cover the same depths, since the first match takes it.
  let dragI = null;
  function clearDrop() { if (!listEl) return;
    listEl.querySelectorAll('.ovRow').forEach(r => { r.classList.remove('dropInto'); r.classList.remove('dropAt'); }); }
  function wireDrag() {
    listEl.querySelectorAll('.ovRow[draggable]').forEach(row => {
      row.addEventListener('dragstart', e => { dragI = +row.dataset.li;
        e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'ore');
        row.classList.add('dragging'); });
      row.addEventListener('dragend', () => { dragI = null; row.classList.remove('dragging'); clearDrop(); });
    });
    listEl.querySelectorAll('.ovRow').forEach(row => {
      row.addEventListener('dragover', e => { if (dragI == null) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        clearDrop(); row.classList.add(row.dataset.lk === 's' ? 'dropInto' : 'dropAt'); });
      row.addEventListener('dragleave', () => row.classList.remove('dropInto', 'dropAt'));
      row.addEventListener('drop', e => { e.preventDefault(); clearDrop();
        if (dragI == null) return; const o = objs[dragI]; dragI = null; if (!o) return;
        let destStrat = null, at = -1;
        if (row.dataset.lk === 's') { const st = strata[+row.dataset.li]; destStrat = st && st.node; }
        else { const t = objs[+row.dataset.li]; if (!t || t.node === o.node) return;
               destStrat = t.parent; at = (t.sub || []).indexOf(t.node); }
        if (!moveToLayer(o, destStrat, at)) return;
        const node = o.node; render(); sel = objs.find(x => x.node === node) || null;
        renderDetail(); renderList(); scheduleOreRender(); });
    });
  }
  // remove a base-rock layer (its BlockDepthRange, along with any veins/scatters nested in it)
  function removeStratum(st) { if (!st) return; const bm = biomes()[biomeIdx]; const arr = bm && bm.Module && bm.Module.BlockDepthRanges; if (!arr) return;
    const idx = arr.indexOf(st.node); if (idx < 0) return; arr.splice(idx, 1); if (sel && sel.node === st.node) sel = null;
    render(); renderDetail(); renderList(); scheduleOreRender(); }
  /** Move a node one place within the array that holds it. Order is semantics here, in two ways: the
   *  layer chain is walked in order, and within a layer the FIRST sub-module that matches a depth wins,
   *  so two fills over the same depths are not commutative. Nothing in the panel could reorder either. */
  /**
   * Move a fill or vein into another layer. This is the one edit the panel could not make, and it is the
   * one that matters: a sub-module is only consulted while its OWN layer owns the depth, so a vein seeded
   * at 20-24 inside a layer that ends at 20 can never spawn - the engine never asks it. Nothing said so
   * and nothing could fix it; adding always appended to the first layer, and the arrows only moved within
   * one. The "at" argument is an index in the destination, or -1 to append.
   */
  function moveToLayer(o, destStrat, at) {
    if (!o || !destStrat) return false;
    destStrat.SubModules = destStrat.SubModules || [];
    const from = o.sub, i = from.indexOf(o.node);
    if (i < 0) return false;
    from.splice(i, 1);
    const dest = destStrat.SubModules;
    let j = at == null || at < 0 ? dest.length : at;
    if (from === dest && at != null && at > i) j--;      // the splice above shifted everything after i
    dest.splice(Math.max(0, Math.min(dest.length, j)), 0, o.node);
    return true; }
  function moveIn(arr, node, dir) { const i = arr.indexOf(node), j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return false;
    arr.splice(j, 0, arr.splice(i, 1)[0]); return true; }
  const moveBtns = (canUp, canDown) => '<button class="nmv" data-mv="-1"' + (canUp ? '' : ' disabled') + ' title="Move earlier — layers are walked in order, and within a layer the first match wins">▲</button>'
    + '<button class="nmv" data-mv="1"' + (canDown ? '' : ' disabled') + ' title="Move later">▼</button>';
  function wireMove(arr, node) { detailEl.querySelectorAll('.nmv').forEach(b => b.onclick = () => {
    if (!moveIn(arr, node, +b.dataset.mv)) return; render(); renderDetail(); renderList(); scheduleOreRender(); }); }
  /** Arrows on a fill/vein: past the end of its own layer, step into the neighbouring one. */
  function wireMoveObj(o) { detailEl.querySelectorAll('.nmv').forEach(b => b.onclick = () => {
    const dir = +b.dataset.mv, i = o.sub.indexOf(o.node);
    let ok = moveIn(o.sub, o.node, dir);
    if (!ok) {                                            // at an edge - hop to the next layer along
      const si = strata.findIndex(st => st.node === o.parent), ds = strata[si + dir];
      if (!ds) return;
      ok = moveToLayer(o, ds.node, dir < 0 ? -1 : 0);      // up: append to the end of the one above
    }
    if (!ok) return;
    const node = o.node; render(); sel = objs.find(x => x.node === node) || null;
    renderDetail(); renderList(); scheduleOreRender(); }); }
  function renderDetail() {
    if (!detailEl) return;
    if (!sel) { detailEl.innerHTML = '<div class="lbl" style="padding:6px 0">Click a layer, fill, or vein to edit it — or add one below.</div>'; return; }
    if (sel.kind === 'strat') { const opts = collectBlockTypes(), col = blockColorRaw(sel.block);
      detailEl.innerHTML = '<div class="oreNode" style="border-top:none"><span class="ndot" style="background:' + col + '"></span><span class="tag">layer</span>' + blockSelect(sel.block, opts)
        + '<span class="kk"><label title="the depth this layer stops at - every column draws its own end between these two">ends at depth</label><input type="number" class="kv" data-sf="Min" value="' + (sel.node.Min | 0) + '"><span class="dash">–</span><input type="number" class="kv" data-sf="Max" value="' + (sel.node.Max | 0) + '"></span>'
        + moveBtns(true, true)
        + '<button class="ndel" title="Remove this layer and everything in it">✕</button></div>'
        + '<div id="ovStratNote" style="font-size:11.5px;color:var(--muted);margin-top:5px">' + stratNoteHtml(sel.node) + '</div>';
      wireStrat(sel);
      { const bm = biomes()[biomeIdx], arr = bm && bm.Module && bm.Module.BlockDepthRanges; if (arr) wireMove(arr, sel.node); }
      return; }
    const o = sel, opts = collectBlockTypes(), dep = o.kind === 'dep';
    const dot = '<span class="ndot" style="background:' + oreDot(o) + '"></span>', del = '<button class="ndel" title="Remove this node">✕</button>';
    let h = '<div class="oreNode" style="border-top:none">' + dot + '<span class="tag">' + (dep ? 'vein' : 'fill') + '</span>' + blockSelect(btOf(o.node.BlockType), opts);
    h += dep ? (knob1('SpawnPercentChance', o.node.SpawnPercentChance, dep) + knobR('DepthRange', o.node.DepthRange, dep) + knobR('DepositDepthRange', o.node.DepositDepthRange, dep) + knobR('BlocksCountRange', o.node.BlocksCountRange, dep))
             : (knob1('PercentChance', o.node.PercentChance, dep) + knobR('DepthRange', o.node.DepthRange, dep) + knob1('NoiseFrequency', o.node.NoiseFrequency, dep));
    if (dep) h += growthSelect(o.node); else h += noiseSelects(o.node);
    h += moveBtns(true, true) + del + '</div>';
    if (dep) h += '<div id="ovVeinNote" style="font-size:11.5px;color:var(--muted);margin-top:5px">' + veinNoteHtml(o.node) + '</div>';
    detailEl.innerHTML = h; wireDetail(o); wireMoveObj(o);
  }
  // StandardTerrainModule.Initialize sorts its noise samples and takes a band of the requested width:
  // Bands takes it around the MEDIAN (contiguous sheets following an isosurface), Blobs takes the low
  // TAIL (compact pockets). Same coverage, completely different-looking rock - and neither was editable,
  // though stock configs use both. NoiseType picks the field the band is cut from.
  const SEL_OPT = (v, cur) => '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + '</option>';
  function noiseSelects(n) {
    const shape = n.NoiseDistributionType || 'Bands', type = n.NoiseType || 'Perlin';
    return '<span class="kk"><label title="Bands follow a surface through the rock; Blobs are compact pockets">shape</label>'
      + '<select class="kv" data-f="NoiseDistributionType">' + ['Bands', 'Blobs'].map(v => SEL_OPT(v, shape)).join('') + '</select></span>'
      + '<span class="kk"><label title="the noise field the band is cut from: Perlin swells smoothly, Billow folds its troughs up into puffy clumps, RidgedMulti has sharp crests over broad flat valleys">noise</label>'
      + '<select class="kv" data-f="NoiseType">' + ['Perlin', 'Billow', 'RidgedMulti'].map(v => SEL_OPT(v, type)).join('') + '</select></span>'; }
  function wireDetail(o) { const node = o.node;
    detailEl.querySelectorAll('input,select').forEach(inp => inp.addEventListener('input', () => {
      const f = inp.dataset.f; if (!f) return;
      if (f === 'growth') { const g = GROWTH[inp.value]; if (!g) return;
        node.DirectionWeights = g.w.map(v => ({ X: v.X, Y: v.Y, Z: v.Z })); node.WeightVariance = { X: g.v.X, Y: g.v.Y, Z: g.v.Z };
        render(); renderDetail(); renderList(); scheduleOreRender(); return; }
      if (f === 'NoiseDistributionType' || f === 'NoiseType') { node[f] = inp.value; render(); scheduleOreRender(); return; }
      if (f === 'block') { node.BlockType = node.BlockType || {}; node.BlockType.Type = inp.value; o.mat = oreMaterial(inp.value) || o.mat; render(); renderList(); scheduleOreRender(); return; }
      const val = parseFloat(inp.value); if (!isFinite(val)) return;
      if (f.endsWith('_min') || f.endsWith('_max')) { const key = f.slice(0, -4), mm = f.slice(-3); node[key] = node[key] || {}; node[key][mm] = val; } else node[f] = val;
      detailEl.querySelectorAll('input[data-f="' + f + '"]').forEach(sib => { if (sib === inp) return; if (sib.type === 'range' && val > +sib.max) sib.max = val; sib.value = val; });
      const vn = document.getElementById('ovVeinNote'); if (vn) vn.innerHTML = veinNoteHtml(node);
      render(); scheduleOreRender();
    }));
    const d = detailEl.querySelector('.ndel'); if (d) d.onclick = () => { const idx = o.sub.indexOf(o.node); if (idx >= 0) o.sub.splice(idx, 1); sel = null; render(); renderDetail(); renderList(); scheduleOreRender(); };
  }
  // No verdict, a measurement. "Overridden" was a plurality artefact: a layer that is the rock in a large
  // minority of columns wins nowhere and was reported as skipped entirely.
  function stratNoteHtml(node) {
    const i = strata.findIndex(st => st.node === node);
    const live = i >= 0 && lastAlive.length ? lastAlive[i] : null;
    const occ = occupiedBand(node);
    const where = occ ? 'usually the rock at depth <b>' + occ.top + '–' + occ.bot + '</b>'
      : 'never the commonest rock at any depth — it only ever appears mixed in with the layers around it';
    const how = live == null ? '' : ' · it is the rock somewhere in <b>' + livePct(live) + '</b> of columns'
      + (live < 0.5 ? ', because a deeper layer often ends above it' : '');
    return where + how + ' · Min–Max is where this layer <b>ends</b> — its top comes from the layer above,'
      + ' and every column draws its own end between them. Drag the bottom edge to move the boundary.'; }
  function wireStrat(o) { const node = o.node;
    detailEl.querySelectorAll('input,select').forEach(inp => inp.addEventListener('input', () => {
      if (inp.dataset.f === 'block') { node.BlockType = node.BlockType || {}; node.BlockType.Type = inp.value; sel.block = inp.value; render(); renderList(); scheduleOreRender(); return; }
      const sf = inp.dataset.sf; if (!sf) return; const val = parseInt(inp.value, 10); if (!isFinite(val)) return; node[sf] = val; render();
      const n = document.getElementById('ovStratNote'); if (n) n.innerHTML = stratNoteHtml(node); scheduleOreRender(); }));
    const d = detailEl.querySelector('.ndel'); if (d) d.onclick = () => removeStratum(strata.find(st => st.node === node) || o);
  }
  function add(type) { const bm = biomes()[biomeIdx]; if (!bm) return; bm.Module = bm.Module || {};
    if (!bm.Module.BlockDepthRanges || !bm.Module.BlockDepthRanges.length) bm.Module.BlockDepthRanges = [{ NoiseFrequency: 40, Min: 0, Max: 0, BlockType: { Type: 'Eco.World.Blocks.DirtBlock, Eco.World' }, SubModules: [] }];
    // Into the layer you are looking at. Appending to the first layer regardless is how a vein ends up in a
    // layer that does not own its depths, which is silent and fatal.
    const arr = bm.Module.BlockDepthRanges;
    const target = sel ? (sel.kind === 'strat' ? sel.node : sel.parent) : null;
    const layer = (target && arr.indexOf(target) >= 0) ? target : arr[0];
    layer.SubModules = layer.SubModules || []; const n = type === 'vein' ? tmplVein() : tmplScatter();
    layer.SubModules.push(n); render(); sel = objs.find(x => x.node === n) || null; renderDetail(); renderList(); scheduleOreRender(); }
  function build() { laneEl = $('ovLane'); detailEl = $('ovDetail'); listEl = $('ovList');
    if (!terrain || !terrain.Modules) { if (laneEl) laneEl.innerHTML = '<div class="lbl" style="padding:10px">No TerrainModule to edit.</div>'; if (detailEl) detailEl.innerHTML = ''; return; }
    if (biomeIdx >= terrain.Modules.length) biomeIdx = 0; render(); renderDetail(); renderList(); }
  function init() { document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', () => { drag = null; });
    $('ovAddVein').onclick = () => add('vein'); $('ovAddScatter').onclick = () => add('scatter'); }
  return { build, init };
})();

// ---- block-composition chart: per-biome vertical "what you dig through" stack over world height ----
// Shows the 100%-stacked composition of ALL blocks (base strata + scatter + veins) at each Y, per biome, so
// you can read how the mix shifts with depth. Model is a faithful aggregate of the server's TerrainDepthModule:
// each stratum's bottom is a per-column noise threshold ~U[Min,Max]; the shallowest in-order stratum whose
// threshold >= depth wins, then that stratum's scatters apply first-wins by PercentChance, and veins carve a
// small deposit fraction out on top. We Monte-Carlo the strata thresholds (fixed seed -> stable chart).
const BlockChart = (function () {
  const ELEV = { Grassland:[.02,.4], WarmForest:[.1,.5], ColdForest:[.1,.7], RainForest:[.1,.5], Desert:[.02,.2], Taiga:[.3,1], Tundra:[.4,1], Ice:[.6,1], Wetland:[.02,.3], ColdCoast:[.05,.1], WarmCoast:[.05,.1] };
  const WEIGHTF = { RainForest:'RainforestWeight', WarmForest:'WarmForestWeight', ColdForest:'CoolForestWeight', Taiga:'TaigaWeight', Tundra:'TundraWeight', Ice:'IceWeight', Desert:'DesertWeight', Wetland:'WetlandWeight' };
  const ALWAYS = { Grassland:1, ColdCoast:1, WarmCoast:1 };
  const biomeOrder = ['Desert','Grassland','Wetland','WarmForest','RainForest','WarmCoast','ColdCoast','ColdForest','Taiga','Tundra','Ice'];
  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const state = { merge:'separate', emph:'off' };   // fixed: separate crushed blocks, ores at true abundance
  let Ymax = 125, DMAX = 210;
  const padTop = 44, sc = 2.4, x0 = 54, colW = 50, gap = 16, maxHW = colW/2 - 3;
  const py = Y => padTop + (Ymax - Y) * sc;
  function mulberry32(a){ return function(){ a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // pull every block (not just ores) + the full strata/submodule structure out of the config
  function extract(cfg) {
    const idmap = {};
    (function idx(o){ if (o && typeof o === 'object'){ if (!Array.isArray(o) && o['$id']) idmap[o['$id']] = o; for (const k in o) idx(o[k]); } })(cfg);
    const deref = o => (o && o['$ref'] != null) ? idmap[o['$ref']] : o;
    const btype = bt => { bt = deref(bt); return (bt && bt.Type) ? bt.Type : ''; };
    const rng = (o, k, d) => { const r = o[k]; if (!r) return d; return [r.min != null ? r.min : d[0], r.max != null ? r.max : d[1]]; };
    const meanW = o => { const dw = o.DirectionWeights || []; if (!dw.length) return [1,1,1]; let x=0,y=0,z=0; for (let i=0;i<dw.length;i++){x+=dw[i].X||0;y+=dw[i].Y||0;z+=dw[i].Z||0;} return [x/dw.length,y/dw.length,z/dw.length]; };
    const boost = (wx,wy,wz) => { wx=Math.max(wx,1e-6);wy=Math.max(wy,1e-6);wz=Math.max(wz,1e-6); return Math.pow(wy,2/3)/Math.pow(wx*wz,1/3); };
    let weights = null;
    (function find(o){ if (weights||!o||typeof o!=='object') return; if (!Array.isArray(o)&&(o.CoolForestWeight!=null||o.DesertWeight!=null)){weights=o;return;} for (const k in o) find(o[k]); })(cfg);
    const WL = cfg.WaterLevel != null ? cfg.WaterLevel : 60, MG = cfg.MaxGenerationHeight != null ? cfg.MaxGenerationHeight : 120;
    const surfOf = name => { const e = ELEV[name] || [.1,.5]; return [Math.round(WL + e[0]*(MG-WL)), Math.round(WL + e[1]*(MG-WL))]; };
    const presentOf = name => { if (ALWAYS[name]) return true; if (!weights) return true; const f = WEIGHTF[name]; if (!f) return true; return (weights[f]||0) > 0; };
    const terr = deref(cfg.TerrainModule); if (!terr || !terr.Modules) throw new Error('No TerrainModule.Modules');
    const biomes = [];
    terr.Modules.forEach(bm => { bm = deref(bm); const name = bm.BiomeName; if (!ELEV[name]) return;
      const dm = deref(bm.Module); const ranges = (dm && dm.BlockDepthRanges) || [];
      const strata = ranges.map(bdr => { bdr = deref(bdr);
        const scatters = [], deposits = [];
        (bdr.SubModules||[]).forEach(sm => { sm = deref(sm); const ty = sm['$type']||''; const bt = btype(sm.BlockType); if (!bt) return;
          if (ty.indexOf('StandardTerrainModule') >= 0) { const r = rng(sm,'DepthRange',[0,200]); scatters.push({ block:bt, a:Math.max(0,r[0]|0), b:Math.max(r[0]|0,r[1]|0), pc:Math.max(0,Math.min(1, sm.PercentChance!=null?sm.PercentChance:0.05)) }); }
          else if (ty.indexOf('DepositTerrainModule') >= 0) { const sr = rng(sm,'DepthRange',[0,200]), br = rng(sm,'DepositDepthRange',[0,200]); const bc = rng(sm,'BlocksCountRange',[1,1]); const N = Math.max(1,(bc[0]+bc[1])/2); const mw = meanW(sm);
            deposits.push({ block:bt, sa:sr[0]|0, sb:Math.max(sr[0]|0,sr[1]|0), ba:Math.min(sr[0],br[0])|0, bb:Math.max(sr[1],br[1])|0, spc:Math.max(0, sm.SpawnPercentChance!=null?sm.SpawnPercentChance:0.01), bo:boost(mw[0],mw[1],mw[2]), N:N }); }
        });
        return { block: btype(bdr.BlockType), min: Math.max(0,bdr.Min|0), max: Math.max(bdr.Min|0,bdr.Max|0), scatters, deposits };
      }).filter(st => st.block);
      biomes.push({ bi:name, surf:surfOf(name), on:presentOf(name), strata });
    });
    return { biomes, WL, MG };
  }

  // which stratum wins at depth d for one sampled set of thresholds (port of TerrainDepthModule.TrySpawnBlock)
  function selectBase(T, N, d) { let last = N - 1;
    for (let i = N - 2; i >= 0; i--) { let skip = false;
      for (let j = i + 1; j < N; j++) { if (T[j] <= T[i]) { skip = true; break; } }
      if (skip) continue;
      if (d <= T[i]) last = i; else break;
    } return last; }

  // peak-normalised vertical shape of a vein: 1 at its densest depth, tapering to its bounds
  function depShape(m) {
    const arr = new Float64Array(DMAX + 1);
    const ey = 0.62 * Math.cbrt(m.N) * m.bo, h = Math.max(1, Math.round(ey));
    const base = new Float64Array(DMAX + 1); for (let d = Math.max(0,m.sa); d <= m.sb && d <= DMAX; d++) base[d] = 1;
    const sm = new Float64Array(DMAX + 1);
    for (let d = 0; d <= DMAX; d++) { let acc = 0, ws = 0; for (let k = -h; k <= h; k++) { const wk = h + 1 - Math.abs(k), dd = d - k; if (dd >= 0 && dd <= DMAX) acc += base[dd]*wk; ws += wk; } sm[d] = acc/ws; }
    for (let d2 = 0; d2 <= DMAX; d2++) if (d2 < m.ba || d2 > m.bb) sm[d2] = 0;
    let peak = 0; for (let d3 = 0; d3 <= DMAX; d3++) if (sm[d3] > peak) peak = sm[d3];
    if (peak > 0) for (let d4 = 0; d4 <= DMAX; d4++) arr[d4] = sm[d4]/peak;
    return arr;
  }
  // fraction of a vein's zone that fills with its block — saturates toward 1 as spawn chance / vein size grow
  // (deposits seed at SpawnPercentChance and grow ~N blocks, so their zone fills far denser than the raw chance)
  const depCover = m => 1 - Math.pow(1 - Math.max(0, Math.min(1, m.spc)), Math.max(1, m.N));

  // composition (raw block type -> fraction, sums to 1) at every depth 0..DMAX for one biome
  function computeComp(entry) {
    const strata = entry.strata, N = strata.length, comp = [], raws = new Set();
    if (!N) { for (let d = 0; d <= DMAX; d++) comp.push({}); return { comp, raws }; }
    const baseP = []; for (let i = 0; i < N; i++) baseP.push(new Float64Array(DMAX + 1));
    const S = 160, rnd = mulberry32(0x1234567), T = new Float64Array(N);
    for (let s = 0; s < S; s++) {
      for (let i = 0; i < N; i++) { const st = strata[i]; T[i] = st.min + rnd() * (st.max - st.min); }
      for (let d = 0; d <= DMAX; d++) baseP[selectBase(T, N, d)][d]++;
    }
    for (let i = 0; i < N; i++) for (let d = 0; d <= DMAX; d++) baseP[i][d] /= S;
    // veins claim their share first (they overwrite as a post-pass in the game), first-wins by order; base + scatter fill the rest
    const deps = []; strata.forEach(st => st.deposits.forEach(dep => deps.push({ block: dep.block, cov: depCover(dep), shape: depShape(dep) })));
    const addTo = (o, k, v) => { if (v > 0) o[k] = (o[k] || 0) + v; };
    for (let d = 0; d <= DMAX; d++) {
      const c = {}; let rem = 1;
      for (const dp of deps) { const cs = dp.cov * dp.shape[d]; if (cs <= 0) continue; const take = rem * Math.min(1, cs); addTo(c, dp.block, take); rem -= take; }
      const nonDep = rem; // fraction left for base rock + scatter, split by which stratum is selected
      for (let i = 0; i < N; i++) { const p = baseP[i][d]; if (p <= 0) continue; const st = strata[i]; let sRem = 1;
        for (const scb of st.scatters) { if (d >= scb.a && d <= scb.b) { const take = sRem * scb.pc; addTo(c, scb.block, nonDep * p * take); sRem -= take; } }
        addTo(c, st.block, nonDep * p * sRem); }
      for (const k in c) raws.add(k);
      comp.push(c);
    }
    return { comp, raws };
  }

  let D = null, cols = [], curW = 0, plotR = 0, H = 0, svgEl = null, hvLine = null, hvRect = null, tipEl = null, wrapEl = null;

  // map a biome's depth-composition onto world-height Y, averaged over its (soft) surface band; air above surface
  function projectToY(entry) {
    const merge = state.merge === 'merge', lo = entry.surf[0], hi = entry.surf[1], cnt = hi - lo + 1;
    const yKeys = [], ySolid = new Float64Array(Ymax + 1), used = {};
    for (let Y = 0; Y <= Ymax; Y++) {
      const agg = {}; let solid = 0;
      for (let sft = lo; sft <= hi; sft++) { const d = sft - Y; if (d < 0) continue; solid++; const c = entry.comp[Math.min(d, DMAX)];
        for (const raw in c) { const info = blockKeyInfo(raw, merge); const k = info.key; agg[k] = (agg[k] || 0) + c[raw]; if (!used[k]) used[k] = info; } }
      ySolid[Y] = cnt > 0 ? solid / cnt : 0;
      if (solid > 0) for (const k in agg) agg[k] /= solid;
      yKeys.push(agg);
    }
    return { yKeys, ySolid, used };
  }

  function render() {
    if (!D) return;
    const cT = cssv('--text'), cS = cssv('--text2'), cM = cssv('--muted'), cB = cssv('--border'), water = cssv('--water') || '#3987e5';
    const shown = biomeOrder.map(b => D.biomes.find(e => e.bi === b)).filter(Boolean);
    const n = shown.length;
    curW = x0 + n * colW + Math.max(0, n - 1) * gap + 16; plotR = curW - 12;
    const emph = state.emph === 'on', legendKeys = {}; cols = [];
    let s = '<svg id="blkSvg" xmlns="http://www.w3.org/2000/svg" width="' + curW + '" height="' + H + '" viewBox="0 0 ' + curW + ' ' + H + '" style="display:block;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">';
    const step = Ymax > 140 ? 40 : 20;
    for (let t = 0; t <= Ymax; t += step) { const ty = py(t); s += '<line x1="' + x0 + '" y1="' + ty + '" x2="' + plotR + '" y2="' + ty + '" stroke="' + cB + '" stroke-width="1"/><text x="' + (x0 - 8) + '" y="' + (ty + 4) + '" text-anchor="end" fill="' + cM + '" font-size="11">' + t + '</text>'; }
    s += '<text x="12" y="' + py(Ymax*0.82) + '" fill="' + cS + '" font-size="12" transform="rotate(-90 12 ' + py(Ymax*0.82) + ')">World height (Y)</text>';
    const wy = py(D.WL); s += '<line x1="' + x0 + '" y1="' + wy + '" x2="' + plotR + '" y2="' + wy + '" stroke="' + water + '" stroke-width="1.4" stroke-dasharray="5 4"/><text x="' + plotR + '" y="' + (wy - 5) + '" text-anchor="end" fill="' + water + '" font-size="10.5">water Y' + D.WL + '</text>';
    s += '<rect id="blkHvr" x="0" y="0" width="0" height="0" fill="' + cM + '" fill-opacity="0.10" style="display:none"/>';
    shown.forEach((entry, ci) => {
      const cx = x0 + ci * (colW + gap) + colW / 2, dim = entry.on ? 1 : 0.45;
      const proj = projectToY(entry); for (const k in proj.used) legendKeys[k] = proj.used[k];
      const keys = Object.keys(proj.used).sort((a, b) => (proj.used[a].rank - proj.used[b].rank) || a.localeCompare(b));
      // header
      s += '<text x="' + cx + '" y="20" text-anchor="middle" fill="' + (entry.on ? cT : cM) + '" font-size="12" font-weight="600">' + (ORE_DISP[entry.bi] || entry.bi) + (entry.on ? '' : '*') + '</text>';
      // cumulative left/right edge per key per Y (centred stack, width tracks the solid fraction so the top tapers in)
      const leftE = {}, rightE = {}; keys.forEach(k => { leftE[k] = new Float64Array(Ymax + 1); rightE[k] = new Float64Array(Ymax + 1); });
      for (let Y = 0; Y <= Ymax; Y++) { const comp = proj.yKeys[Y], hw = proj.ySolid[Y] * maxHW; let x = cx - hw;
        for (const k of keys) { const w = (comp[k] || 0) * 2 * hw; leftE[k][Y] = x; rightE[k][Y] = x + w; x += w; } }
      // one filled ribbon per block; adjacent edges are shared so the stack is seamless
      keys.forEach(k => { const info = proj.used[k]; let op = dim; if (emph && !info.ore) op *= 0.28;
        let path = 'M'; for (let Y = 0; Y <= Ymax; Y++) path += (leftE[k][Y]).toFixed(1) + ' ' + py(Y).toFixed(1) + ' ';
        for (let Y = Ymax; Y >= 0; Y--) path += (rightE[k][Y]).toFixed(1) + ' ' + py(Y).toFixed(1) + ' ';
        s += '<path d="' + path + 'Z" fill="' + info.color + '" fill-opacity="' + op.toFixed(2) + '"/>'; });
      // faint silhouette so near-empty columns still read (only over the solid range, no stalk above the surface)
      const topY = Math.min(Ymax, entry.surf[1]);
      let sil = 'M'; for (let Y = 0; Y <= topY; Y++) sil += (cx - proj.ySolid[Y]*maxHW).toFixed(1) + ' ' + py(Y).toFixed(1) + ' ';
      for (let Y = topY; Y >= 0; Y--) sil += (cx + proj.ySolid[Y]*maxHW).toFixed(1) + ' ' + py(Y).toFixed(1) + ' ';
      s += '<path d="' + sil + 'Z" fill="none" stroke="' + cB + '" stroke-width="0.75"/>';
      cols.push({ x0: cx - maxHW - gap/2, x1: cx + maxHW + gap/2, cx: cx, e: entry, proj: proj, keys: keys });
    });
    s += '<line id="blkHvl" x1="0" y1="0" x2="0" y2="0" stroke="' + cT + '" stroke-width="1" stroke-opacity="0.5" stroke-dasharray="3 3" style="display:none"/></svg>';
    $('blockChart').innerHTML = s; svgEl = $('blkSvg'); hvLine = $('blkHvl'); hvRect = $('blkHvr');
    svgEl.addEventListener('mousemove', onMove);
    svgEl.addEventListener('mouseleave', () => { tipEl.style.display='none'; hvLine.style.display='none'; hvRect.style.display='none'; });
    // legend
    const lk = Object.keys(legendKeys).sort((a, b) => (legendKeys[a].rank - legendKeys[b].rank) || a.localeCompare(b));
    let lg = ''; lk.forEach(k => { const info = legendKeys[k]; lg += '<span><span class="sw" style="background:' + info.color + '"></span>' + info.label + '</span>'; });
    lg += '<span style="color:var(--muted)">* biome not on this map · each column is a 100%-stacked mix at that depth (soft top = varying surface) · hover for the exact breakdown</span>';
    $('blockLegend').innerHTML = lg;
  }

  function onMove(e) {
    const cM = cssv('--muted'), cS = cssv('--text2'); const r = svgEl.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (curW / r.width), sy = (e.clientY - r.top) * (H / r.height), Y = Math.round(Ymax - (sy - padTop) / sc);
    let col = null; for (let i = 0; i < cols.length; i++) { if (sx >= cols[i].x0 && sx < cols[i].x1) { col = cols[i]; break; } }
    if (!col || Y < 0 || Y > Ymax) { tipEl.style.display='none'; hvLine.style.display='none'; hvRect.style.display='none'; return; }
    hvLine.setAttribute('x1', x0); hvLine.setAttribute('x2', plotR); hvLine.setAttribute('y1', py(Y)); hvLine.setAttribute('y2', py(Y)); hvLine.style.display = 'block';
    hvRect.setAttribute('x', col.cx - maxHW - 1); hvRect.setAttribute('y', padTop); hvRect.setAttribute('width', maxHW*2 + 2); hvRect.setAttribute('height', Ymax*sc); hvRect.style.display = 'block';
    const en = col.e, comp = col.proj.yKeys[Y], solid = col.proj.ySolid[Y];
    const sm = (en.surf[0] + en.surf[1]) / 2, dep = Math.round(sm - Y), depL = dep >= 0 ? ('~ ' + dep + ' blocks deep') : ('~ ' + (-dep) + ' above surface');
    let body;
    if (solid < 0.02) body = '<div style="color:' + cM + '">above the surface here (air)</div>';
    else { const rows = Object.keys(comp).map(k => ({ k, v: comp[k], info: col.proj.used[k] })).filter(x => x.v >= 0.005).sort((a, b) => b.v - a.v);
      if (!rows.length) body = '<div style="color:' + cM + '">—</div>';
      else body = rows.map(x => '<div style="display:flex;gap:7px;align-items:center"><span class="sw" style="background:' + x.info.color + '"></span><span style="flex:1">' + x.info.label + '</span><span style="color:' + cS + ';font-variant-numeric:tabular-nums">' + (x.v * 100 >= 1 ? Math.round(x.v * 100) : (x.v * 100).toFixed(1)) + '%</span></div>').join(''); }
    const absent = en.on ? '' : '<div style="color:' + cM + '">* not generated on this map</div>';
    tipEl.innerHTML = '<div style="font-weight:600">' + (ORE_DISP[en.bi] || en.bi) + '</div><div style="color:' + cS + ';margin-bottom:3px">Y ' + Y + ' · ' + depL + '</div>' + body + absent;
    tipEl.style.display = 'block';
    // keep the tooltip inside the (scrollable) chart box: flip above/left of the cursor near an edge so a tall
    // breakdown never spills out and forces a scrollbar
    const wr = wrapEl.getBoundingClientRect();
    const relX = e.clientX - wr.left + wrapEl.scrollLeft, relY = e.clientY - wr.top + wrapEl.scrollTop;
    const vL = wrapEl.scrollLeft, vT = wrapEl.scrollTop, vR = vL + wrapEl.clientWidth, vB = vT + wrapEl.clientHeight;
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let left = relX + 14; if (left + tw > vR) left = relX - tw - 14; if (left < vL + 2) left = vL + 2;
    let top = relY + 12; if (top + th > vB) top = relY - th - 12; if (top < vT + 2) top = vT + 2; if (top + th > vB) top = Math.max(vT + 2, vB - th - 2);
    tipEl.style.left = left + 'px'; tipEl.style.top = top + 'px';
  }

  function renderFromCfg(cfg) {
    try { D = extract(cfg); } catch (ex) { $('blockChart').innerHTML = '<div class="lbl" style="padding:12px">Block composition unavailable: ' + ex.message + '</div>'; return; }
    Ymax = Math.max(120, Math.ceil(D.MG / 20) * 20); DMAX = Ymax + 90; H = padTop + Ymax * sc + 20;
    let nBlocks = 0; const seen = {};
    D.biomes.forEach(e => { const cc = computeComp(e); e.comp = cc.comp; cc.raws.forEach(r => { const k = blockKeyInfo(r, state.merge === 'merge').key; if (!seen[k]) { seen[k] = 1; nBlocks++; } }); });
    $('blockMeta').textContent = D.biomes.length + ' biomes · ' + nBlocks + ' block types · water Y' + D.WL + ' · gen height ' + D.MG;
    render();
  }

  function seg(id, opts, key) { const c = $(id); c.innerHTML = ''; opts.forEach(o => { const b = document.createElement('button'); b.textContent = o.label; b.onclick = () => { state[key] = o.val; [].forEach.call(c.children, x => x.classList.toggle('on', x === b)); if (key === 'merge' && D) renderFromCfg(lastCfg); else render(); }; if (o.val === state[key]) b.className = 'on'; c.appendChild(b); }); }
  let lastCfg = null;
  function init() {
    tipEl = $('blockTip'); wrapEl = $('blockChartWrap');
  }
  return { render: function (cfg) { lastCfg = cfg; renderFromCfg(cfg); }, init };
})();

// ---- rendering ----
function fillPolyPath(ctx, pts, s, ox, oy) {
  ctx.moveTo((pts[0]+ox)*s, (pts[1]+oy)*s);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo((pts[i]+ox)*s, (pts[i+1]+oy)*s);
}
function drawWrapped(ctx, pts, ws, s) {
  let L=false,Rt=false,T=false,Bt=false;
  for (let i=0;i<pts.length;i+=2){ const x=pts[i],y=pts[i+1]; if(x<0)L=true; if(x>=ws)Rt=true; if(y<0)T=true; if(y>=ws)Bt=true; }
  ctx.beginPath(); fillPolyPath(ctx,pts,s,0,0); ctx.closePath(); ctx.fill();
  const copy=(dx,dy)=>{ ctx.beginPath(); fillPolyPath(ctx,pts,s,dx,dy); ctx.closePath(); ctx.fill(); };
  if(L)copy(ws,0); if(Rt)copy(-ws,0); if(T)copy(0,ws); if(Bt)copy(0,-ws);
  if(L&&T)copy(ws,ws); if(Rt&&T)copy(-ws,ws); if(L&&Bt)copy(ws,-ws); if(Rt&&Bt)copy(-ws,-ws);
}
function colorFor(p) {
  if (layer === 'biomes') return p.lake ? [70,130,180] : p.c;
  if (layer === 'elevation') {
    if (p.e < 0) { const t = Math.min(1, -p.e); return [30+ (1-t)*40, 60+(1-t)*80, 120+(1-t)*90]; }
    const h = Math.round(255*(p.e*0.85+0.15)); return [h, h, h];
  }
  if (layer === 'temperature') { const t = Math.max(0,Math.min(1,p.t)); return ramp(t, [40,90,200],[240,230,120],[200,50,40]); }
  if (layer === 'moisture') { const t = Math.max(0,Math.min(1,p.mo)); return ramp(t, [200,170,110],[120,200,120],[40,110,190]); }
  return p.c;
}
function ramp(t, a, b, c) {
  if (t < 0.5) { const u=t/0.5; return [a[0]+(b[0]-a[0])*u, a[1]+(b[1]-a[1])*u, a[2]+(b[2]-a[2])*u]; }
  const u=(t-0.5)/0.5; return [b[0]+(c[0]-b[0])*u, b[1]+(c[1]-b[1])*u, b[2]+(c[2]-b[2])*u];
}
function closestWrapped(vx, vy, x, y, ws) {
  const h = ws*0.5; let nx=x, ny=y;
  if (x-vx < -h) nx += ws; else if (x-vx > h) nx -= ws;
  if (y-vy < -h) ny += ws; else if (y-vy > h) ny -= ws;
  return [nx, ny];
}
function render() {
  if (!result) return;
  const ws = result.worldSize, s = scale;
  const cv = $('cv'); cv.width = Math.round(ws*s); cv.height = Math.round(ws*s);
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0b1a2b'; ctx.fillRect(0,0,cv.width,cv.height);
  if (flipY) ctx.setTransform(1, 0, 0, -1, 0, cv.height); // match TerrainEditorPanel's RotateNoneFlipY
  for (const p of result.polys) { const c = colorFor(p); ctx.fillStyle = \`rgb(\${c[0]|0},\${c[1]|0},\${c[2]|0})\`; drawWrapped(ctx, p.pts, ws, s); }

  if (showWater && (layer === 'biomes' || layer === 'elevation')) {
    ctx.strokeStyle = 'rgba(70,130,180,0.95)'; ctx.lineJoin='round'; ctx.lineCap='round';
    ctx.lineWidth = Math.max(1.2, (cfgUsed.pointRadius*0.6)*s);
    for (const river of result.rivers) {
      if (river.length < 2) continue;
      for (let ox=-ws; ox<=ws; ox+=ws) for (let oy=-ws; oy<=ws; oy+=ws) {
        const pts = river.map(r=>[r.x+ox, r.y+oy]);
        for (let i=0;i<pts.length-1;i++) pts[i+1] = closestWrapped(pts[i][0],pts[i][1],pts[i+1][0],pts[i+1][1],ws);
        ctx.beginPath(); ctx.moveTo(pts[0][0]*s, pts[0][1]*s);
        for (let i=1;i<pts.length-1;i++){ const mx=(pts[i][0]+pts[i+1][0])/2, my=(pts[i][1]+pts[i+1][1])/2; ctx.quadraticCurveTo(pts[i][0]*s, pts[i][1]*s, mx*s, my*s); }
        ctx.lineTo(pts[pts.length-1][0]*s, pts[pts.length-1][1]*s); ctx.stroke();
      }
    }
  }
}

function buildLayerButtons() {
  const defs = [['biomes','Biomes'],['elevation','Elevation'],['temperature','Temperature'],['moisture','Moisture']];
  const seg = $('layers'); seg.innerHTML='';
  for (const [k,label] of defs){ const b=document.createElement('button'); b.textContent=label; if(k===layer)b.className='on';
    b.onclick=()=>{ layer=k; [...seg.children].forEach(x=>x.classList.remove('on')); b.classList.add('on'); render(); buildLegend(); }; seg.appendChild(b); }
  buildLegend();
}
function buildLegend() {
  const el = $('legend'); el.innerHTML='';
  if (layer === 'biomes') {
    const present = result.stats.counts;
    for (const name of BIOME_ORDER) { if (!present[name]) continue; const c = BIOME_COLORS[name];
      const span=document.createElement('span'); span.innerHTML=\`<span class="sw" style="background:rgb(\${c[0]},\${c[1]},\${c[2]})"></span>\${name} <span style="color:var(--muted)">\${(100*present[name]/totalPolys()).toFixed(1)}%</span>\`; el.appendChild(span); }
  } else {
    const grads = { elevation:'deep water → sea level → peaks', temperature:'cold → temperate → hot', moisture:'dry → moderate → wet' };
    el.innerHTML = \`<span style="color:var(--muted)">\${grads[layer]||''}</span>\`;
  }
}
function totalPolys(){ let t=0; for(const k in result.stats.counts) t+=result.stats.counts[k]; return t; }
function showStats(m, ms) {
  const s = m.stats;
  $('stats').innerHTML = \`<b>\${totalPolys().toLocaleString()}</b> cells · <b>\${s.continents}</b> continent(s) · <b>\${s.islands}</b> island group(s) · <b>\${s.lakes}</b> lake(s) requested · <b>\${m.rivers.length}</b> river(s) placed · land <b>\${(s.landPercent*100).toFixed(1)}%</b> · generated in <b>\${(ms/1000).toFixed(1)}s</b>\`;
}

// ---- hover tooltip ----
$('cv').addEventListener('mousemove', (ev) => {
  if (!result) return;
  const cv=$('cv'), r=cv.getBoundingClientRect();
  const wx = (ev.clientX-r.left)/r.width*result.worldSize;
  let wy = (ev.clientY-r.top)/r.height*result.worldSize;
  if (flipY) wy = result.worldSize - wy;
  let best=null,bd=1e18; for(const p of result.polys){const dx=p.cx-wx,dy=p.cy-wy,d=dx*dx+dy*dy; if(d<bd){bd=d;best=p;}}
  const tip=$('tip');
  if(best){ tip.style.display='block'; tip.style.left=(ev.clientX-r.left+12)+'px'; tip.style.top=(ev.clientY-r.top+12)+'px';
    tip.innerHTML=\`<b>\${best.name}</b>\${best.lake?' (lake)':''}\${best.river?' · river':''}<br>elev \${best.e.toFixed(2)} · temp \${best.t.toFixed(2)} · moist \${best.mo.toFixed(2)}\`; }
});
$('cv').addEventListener('mouseleave', ()=>{ $('tip').style.display='none'; });

// ---- wiring ----
buildForm();
BlockChart.init();
OreVisual.init();
// underground: Block composition + Editor tabs in one panel (Block composition default)
(function initChartTabs(){
  const tabs = $('chartTabs');
  const show = t => { $('blockTab').style.display = t === 'block' ? '' : 'none'; $('editTab').style.display = t === 'edit' ? '' : 'none';
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.tab === t);
    if (t === 'edit' && terrain) OreVisual.build(); };
  for (const b of tabs.children) b.onclick = () => show(b.dataset.tab);
  // re-render the shown tab when Underground is expanded (it renders correctly once it has real size)
  $('chartsPanel').addEventListener('toggle', e => {
    if (!e.target.open || !terrain) return;
    if ($('editTab').style.display !== 'none') OreVisual.build();
    else { const ej = buildExportJson(); BlockChart.render(ej); }
  });
})();
$('regen').onclick = generateFromForm;
$('loadCfg').onclick = () => loadConfigText($('paste').value, true);
$('resetCfg').onclick = () => { if (baseCfg) populateForm(baseCfg); };
$('dlEco').onclick = downloadEco;
$('randSeed').onclick = () => {
  if (!baseCfg) { $('err').textContent = 'Load or paste a WorldGenerator.eco config first.'; return; }
  $('seed').value = String(Math.trunc(Math.random() * 4294967296) | 0); // full int32 range, incl. negatives
  generateFromForm();
};
$('waterToggle').onchange = e => { showWater = e.target.checked; render(); };
$('expPng').onclick = () => { const a=document.createElement('a'); a.download='eco-worldgen-'+layer+'.png'; a.href=$('cv').toDataURL('image/png'); a.click(); };

// ---- 3D voxel view ----
// The worker generates + meshes real per-voxel block chunks on demand; we stream them into
// Render3D and colour them by block type (reusing the ore chart's palette). Untick a block
// type to hide it and see through to the strata/ore veins beneath.
let seenBlocks = {}, hiddenBlocks = new Set(), worker3dBound = false, threeDFrom = 'map';
const block3dColor = t => blockColorRaw(t);   // CSS colour string; THREE.Color parses it
const SOIL_HIDE = ['Dirt','RockySoil','Grass','WetlandsSoil','FrozenSoil','Sand','DesertSand','Snow','Grass Block'];

// Persistent listener for 3D messages only (own types, so generation is never affected).
function worker3dHandler(e) {
  const m = e.data;
  if (m.type === 'v3d-progress') {
    const pct = m.frac != null ? ' ' + Math.round(m.frac * 100) + '%' : '';
    $('view3dStatus').textContent = m.phase === 'blur' ? 'smoothing height…' : m.phase === 'raster' ? 'rasterizing…' :
      m.phase === 'veins-seed' ? 'finding ore veins…' + pct : m.phase === 'veins-grow' ? 'growing ore veins…' + pct : 'building…';
    return;
  }
  if (m.type === 'v3d-error') { $('view3dStatus').textContent = 'Error: ' + m.message; return; }
  if (m.type === 'v3d-ready') {
    $('view3dStatus').textContent = m.W + '×' + m.W + ' · drag to look, W A S D to fly';
    Render3D.setWorld(m, block3dColor,
      (cx, cz, CH, hid, slice) => worker.postMessage({ type: 'chunk', cx, cz, CHUNK: CH, hidden: hid, sliceTop: slice }),
      (cx, cz) => worker.postMessage({ type: 'chunkdrop', cx, cz }));
    Render3D.start();
    return;
  }
  if (m.type === 'v3d-chunkmesh') {
    let added = false;
    for (const t of m.palette) if (!seenBlocks[t]) { seenBlocks[t] = true; added = true; }
    if (added) buildBlockToggles();
    Render3D.onChunkMesh(m.cx, m.cz, { pos: m.pos, nor: m.nor, pal: m.pal, palette: m.palette });
    return;
  }
}
function buildBlockToggles() {
  const types = Object.keys(seenBlocks).sort((a, b) => (blockRank(a) - blockRank(b)) || shortBlock(a).localeCompare(shortBlock(b)));
  $('view3dBlocks').innerHTML = types.map(t => {
    const on = !hiddenBlocks.has(t);
    return '<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer">' +
      '<input type="checkbox" data-blk="' + t.replace(/"/g, '&quot;') + '"' + (on ? ' checked' : '') + '>' +
      '<span class="sw" style="display:inline-block;width:11px;height:11px;border-radius:2px;background:' + blockColorRaw(t) + '"></span>' +
      prettyName(shortBlock(t)) + '</label>';
  }).join('');
  $('view3dBlocks').querySelectorAll('input[data-blk]').forEach(cb => {
    cb.onchange = () => { const t = cb.getAttribute('data-blk'); if (cb.checked) hiddenBlocks.delete(t); else hiddenBlocks.add(t); Render3D.setHidden(Array.from(hiddenBlocks)); };
  });
}
function open3D() {
  if (!result || !terrain || !cfgUsed) { $('err').textContent = 'Wait for the world to finish generating first.'; return; }
  threeDFrom = 'map'; $('view3dClose').textContent = '← Back to map';
  $('canvasWrap').style.display = 'none'; $('legend').style.display = 'none'; $('stats').style.display = 'none';
  $('surfaceBar').style.display = 'none'; $('cfgPanel').style.display = 'none'; $('chartsPanel').style.display = 'none';   // hidden cfg sidebar → left column goes full width (flex)
  $('view3dWrap').style.display = 'block';
  $('view3dStatus').textContent = 'initializing…';
  seenBlocks = {}; hiddenBlocks = new Set(); buildBlockToggles();
  Render3D.init($('view3dCanvas'), THREE);
  if (!worker3dBound) { worker.addEventListener('message', worker3dHandler); worker3dBound = true; }
  requestAnimationFrame(() => Render3D.resize());   // size after the container is visible
  worker.postMessage({ type: '3d-init', terrain: terrain, cfg: cfgUsed });
}
function close3D() {
  Render3D.stop();
  $('view3dWrap').style.display = 'none';
  if (threeDFrom === 'designer') { threeDFrom = 'map'; $('chartsPanel').style.display = 'block'; $('designWrap').style.display = ''; return; }   // back to the designer (Underground returns below it)
  $('canvasWrap').style.display = ''; $('legend').style.display = ''; $('stats').style.display = '';
  $('surfaceBar').style.display = ''; $('cfgPanel').style.display = 'block'; $('chartsPanel').style.display = 'block';
}
function refresh3D() {
  $('view3dStatus').textContent = 'rebuilding…';
  if (threeDFrom === 'designer') { if (window.Designer && Designer.post3D) Designer.post3D(); }
  else worker.postMessage({ type: '3d-init', terrain, cfg: cfgUsed });
}
$('view3d').onclick = open3D;
$('view3dClose').onclick = close3D;
$('view3dRefresh').onclick = refresh3D;
$('view3dHideSoil').onclick = () => { SOIL_HIDE.forEach(s => { for (const t in seenBlocks) if (shortBlock(t) === s || prettyName(shortBlock(t)) === s) hiddenBlocks.add(t); }); buildBlockToggles(); Render3D.setHidden(Array.from(hiddenBlocks)); };
$('view3dHideAll').onclick = () => { hiddenBlocks = new Set(Object.keys(seenBlocks)); buildBlockToggles(); Render3D.setHidden(Array.from(hiddenBlocks)); };
$('view3dShowAll').onclick = () => { hiddenBlocks = new Set(); buildBlockToggles(); Render3D.setHidden([]); };
const drop = $('drop');
['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop', e => { const f=e.dataTransfer.files[0]; if(f) readFile(f); });
drop.addEventListener('click', ()=>$('file').click());
$('file').addEventListener('change', e => { const f=e.target.files[0]; if(f) readFile(f); });
function readFile(f){ const r=new FileReader(); r.onload=()=>{ $('paste').value=r.result; loadConfigText(r.result, true); }; r.readAsText(f); }

// load the bundled default world on startup (embedded, so it works from file:// too)
const DEFAULT_ECO = ($('defaultcfg').textContent || '').trim();
if (DEFAULT_ECO) loadConfigText(DEFAULT_ECO);
</script>
<script>/*__DESIGNER__*/</script>
</body>
</html>`;

// inject the vendored three.js and the 3D renderer via replacer functions (not template
// interpolation) so their backticks and `$` sequences pass through verbatim.
const finalHtml = html
  .replace('/*__THREE__*/', () => threeSrc)
  .replace('/*__RENDER3D__*/', () => render3dSrc)
  .replace('/*__SEARCH__*/', () => search)   // same search core on the main thread (rescoring, previews, inversion)
  .replace('/*__DESIGNER__*/', () => designerSrc);

fs.writeFileSync('index.html', finalHtml);
console.log('wrote index.html', finalHtml.length, 'bytes');
