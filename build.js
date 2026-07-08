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
const vt = fs.readFileSync('src/vectortable.txt', 'utf8').trim();
const defaultEco = fs.readFileSync('WorldGenerator.eco', 'utf8').trim();

const LIB = [core, geo, worldgen,
  `const C = { CsRandom, Perlin, RidgedMulti, ScaleBias, gradientCoherentNoise3D, setVectorTable, NQ };`,
  `const G = { poissonSamples, Voronoi };`
].join('\n\n');

const WORKER_GLUE = `
onmessage = function (e) {
  const m = e.data;
  if (m.type === 'init') { setVectorTable(m.vt); postMessage({ type: 'ready' }); return; }
  if (m.type === 'gen') {
    try {
      const res = generate(m.cfg, { progress: s => postMessage({ type: 'progress', phase: s }) });
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
};`;

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
  .wrap{max-width:1360px; margin:0 auto;}
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
  #orePanel{display:none; margin-top:20px;}
  #chartsPanel{display:none; margin-top:20px;}
  #chartTabs button{font-size:13px; padding:6px 13px;}
  #oreTabs button{font-size:13px; padding:6px 13px;}
  #ovBiomes{display:flex; gap:6px; flex-wrap:wrap; margin:6px 0 2px;}
  #ovLane svg{max-width:100%;}
  #oreEditor{display:flex; flex-direction:column; gap:6px; margin:8px 0 12px;}
  #oreEditor details{border:0.5px solid var(--border); border-radius:8px; background:var(--surf); padding:2px 10px;}
  #oreEditor summary{cursor:pointer; font-weight:600; font-size:13px; padding:5px 0; user-select:none;}
  #oreEditor summary .cnt{color:var(--muted); font-weight:400; font-size:12px;}
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
  .oreAdd{display:flex; gap:8px; padding:9px 0 5px;}
  .oreAdd button{font-size:12px; padding:4px 11px;}
  #oreChartWrap{width:100%; overflow-x:auto; position:relative; border:0.5px solid var(--border); border-radius:12px; background:var(--surf); padding:6px 0; margin-top:4px;}
  #oreChart svg{max-width:100%; height:auto;}
  #oreTip{position:absolute; display:none; pointer-events:none; background:var(--surf); border:0.5px solid var(--border2); border-radius:var(--radius); padding:8px 10px; font-size:12px; line-height:1.5; max-width:250px; z-index:5; box-shadow:0 2px 10px rgba(0,0,0,.15);}
  #oreLegend{display:flex; flex-wrap:wrap; gap:12px 18px; margin-top:12px; font-size:12px; color:var(--text2); align-items:center;}
  #blockChartWrap{width:100%; overflow-x:auto; position:relative; border:0.5px solid var(--border); border-radius:12px; background:var(--surf); padding:6px 0; margin-top:4px;}
  #blockChart svg{max-width:100%; height:auto;}
  #blockTip{position:absolute; display:none; pointer-events:none; background:var(--surf); border:0.5px solid var(--border2); border-radius:var(--radius); padding:8px 10px; font-size:12px; line-height:1.5; max-width:290px; z-index:5; box-shadow:0 2px 10px rgba(0,0,0,.15);}
  #blockLegend{display:flex; flex-wrap:wrap; gap:10px 16px; margin-top:12px; font-size:12px; color:var(--text2); align-items:center;}
</style>
</head>
<body>
<div class="wrap">
  <h1>Eco WorldGen map preview</h1>
  <p class="sub">A default Eco world is shown on load — drop, upload, or paste your own <code>WorldGenerator.eco</code> to replace it, or edit any knob below and regenerate. Previews the generated surface (biomes, elevation, climate, rivers &amp; lakes) and block/ore composition, entirely in your browser using a faithful port of the server's generator.</p>

  <div id="drop">
    <strong>Drop a WorldGenerator.eco file here</strong>, or <label style="color:var(--accent); cursor:pointer; text-decoration:underline">browse<input id="file" type="file" accept=".eco,.json,application/json" style="display:none"></label>
    <div style="font-size:13px; margin-top:4px;">— or paste the JSON below —</div>
  </div>
  <textarea id="paste" placeholder="Paste WorldGenerator.eco JSON here, then click Generate"></textarea>
  <div class="row">
    <button class="primary" id="gen">Generate map</button>
    <span class="lbl">Seed override</span><input type="text" id="seed" placeholder="(from config)"><button id="randSeed" title="Random seed &amp; regenerate">🎲 Randomize</button>
    <span class="lbl">Max render px</span><input type="number" id="maxpx" value="900" min="200" max="2000" step="100">
  </div>
  <div id="err"></div>
  <div id="meta"></div>
  <div id="prog">Generating… <span id="progPhase"></span><div class="bar"><div id="progBar"></div></div></div>

  <div id="panel">
    <div class="row">
      <span class="lbl">Layer</span><span class="seg" id="layers"></span>
      <label class="lbl" style="display:inline-flex;align-items:center;gap:5px;margin-left:8px"><input type="checkbox" id="waterToggle" checked> Rivers &amp; lakes</label>
      <button id="expPng" style="margin-left:auto">Export PNG</button>
    </div>
    <div id="canvasWrap"><canvas id="cv"></canvas><div id="tip"></div></div>
    <div id="legend"></div>
    <div id="stats"></div>
  </div>

  <div id="chartsPanel">
    <div class="row" style="margin:6px 0 4px;">
      <strong style="font-size:15px;">Underground</strong>
      <span class="seg" id="chartTabs" style="margin-left:4px">
        <button type="button" data-tab="block" class="on">Block composition</button>
        <button type="button" data-tab="ore">Ore distribution</button>
      </span>
    </div>

    <div id="blockTab">
      <div style="display:flex;align-items:center;gap:10px;margin:2px 0;flex-wrap:wrap;">
        <span class="lbl">what a column is made of, top to bottom, per biome</span>
        <span class="lbl" style="margin-left:8px">Crushed</span><span class="seg" id="blkCrush"></span>
        <span class="lbl" style="margin-left:8px">Ores</span><span class="seg" id="blkEmph"></span>
        <span class="lbl" id="blockMeta" style="margin-left:10px"></span>
      </div>
      <div id="blockChartWrap"><div id="blockChart"></div><div id="blockTip"></div></div>
      <div id="blockLegend"></div>
    </div>

    <div id="oreTab" style="display:none">
      <div style="display:flex;align-items:center;gap:10px;margin:2px 0;flex-wrap:wrap;">
        <span class="lbl">where each material concentrates by biome &amp; depth</span>
        <span class="lbl" style="margin-left:8px">Group by</span><span class="seg" id="oreGrp"></span>
        <span class="lbl" style="margin-left:8px">Style</span><span class="seg" id="oreSty"></span>
        <span class="lbl" style="margin-left:8px">Scale</span><span class="seg" id="oreScl"></span>
        <span class="lbl" style="margin-left:8px">Seed spread</span><span class="seg" id="oreSpr"></span>
        <span class="lbl" id="oreMeta" style="margin-left:10px"></span>
      </div>
      <div id="oreChartWrap"><div id="oreChart"></div><div id="oreTip"></div></div>
      <div id="oreLegend"></div>
    </div>
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
      <button id="dlEco" style="margin-left:auto">Download .eco</button>
    </div>
  </div>

  <div id="orePanel">
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 2px;flex-wrap:wrap;">
      <strong style="font-size:15px;">Block &amp; ore composition</strong>
      <span class="seg" id="oreTabs" style="margin-left:2px">
        <button type="button" data-tab="visual" class="on">Visual editor</button>
        <button type="button" data-tab="manual">Manual knobs</button>
      </span>
      <button id="oreHandoff" style="margin-left:auto">Open in ore visualizer ↗</button>
    </div>
    <div id="oreVisualTab">
      <div class="lbl" style="margin:4px 0 6px">Pick a biome, then drag a vein/scatter to move its depth, or drag its right edge to change abundance. Click one to fine-tune or change its block.</div>
      <div id="ovBiomes"></div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;margin-top:8px">
        <div id="ovLane" style="flex:0 0 auto;border:0.5px solid var(--border);border-radius:12px;background:var(--surf);padding:6px 0;overflow-x:auto;max-width:100%"></div>
        <div style="flex:1 1 240px;min-width:230px">
          <div id="ovDetail"></div>
          <div class="oreAdd" style="margin-top:8px"><button id="ovAddVein">+ vein</button><button id="ovAddScatter">+ scatter</button></div>
        </div>
      </div>
    </div>
    <div id="oreManualTab" style="display:none">
      <div class="lbl" style="margin:4px 0 8px">Edit veins &amp; scatter for every biome, add/remove nodes — the distribution chart updates live.</div>
      <div id="oreEditor"></div>
    </div>
  </div>
</div>

<script type="text/plain" id="libsrc">
${LIB}
${WORKER_GLUE}
</script>
<script type="text/plain" id="vtsrc">${vt}</script>
<script type="application/json" id="defaultcfg">${defaultEco}</script>

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
    const d = document.createElement('details'); if (gi < 3) d.open = true;
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
  renderPx = Math.max(200, Math.min(2000, +$('maxpx').value || 900));
  cfgUsed = cfg;
  $('meta').innerHTML = \`World <b>\${cfg.worldWidth*10}×\${cfg.worldLength*10} m</b> · seed <b>\${cfg.seed}</b> · point radius \${cfg.pointRadius}\`;
  $('gen').disabled = true; $('regen').disabled = true;
  $('prog').style.display = 'block'; $('progBar').style.width = '8%'; $('progPhase').textContent = 'sampling…';

  if (!worker) worker = makeWorker();
  const start = performance.now();
  const phases = { voronoi:25, biomes:45, elevation:65, rivers:85 };
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') { worker.postMessage({ type: 'gen', cfg }); return; }
    if (m.type === 'progress') { $('progPhase').textContent = m.phase + '…'; $('progBar').style.width = (phases[m.phase]||10) + '%'; return; }
    if (m.type === 'error') { $('err').textContent = 'Generation failed: ' + m.message; $('gen').disabled = false; $('regen').disabled = false; $('prog').style.display='none'; return; }
    if (m.type === 'done') {
      $('progBar').style.width = '100%';
      result = m;
      updateMixActuals(m);
      if (terrain) { const ej = buildExportJson(); OreChart.render(ej); BlockChart.render(ej); }   // keep charts' biome present/absent + water line in sync
      $('gen').disabled = false; $('regen').disabled = false;
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
function loadConfigText(text) {
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
  buildOreEditor();
  OreVisual.build();
  $('orePanel').style.display = terrain ? 'block' : 'none';
  $('chartsPanel').style.display = terrain ? 'block' : 'none';
  if (terrain) { const ej = buildExportJson(); OreChart.render(ej); BlockChart.render(ej); }
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

// ---- focused ore/scatter editor (edits the dereferenced terrain tree in place) ----
// "vein" = DepositTerrainModule (concentrated ore vein); "scatter" = StandardTerrainModule (chance-based blocks/bands).
let oreNodes = [];
const oreOpen = new Set(); // biome names whose <details> are expanded (preserved across rebuilds)
const ORE_SLIDER = {
  SpawnPercentChance: { min:0, max:0.05, step:0.0005 },
  PercentChance:      { min:0, max:1,    step:0.01 },
  NoiseFrequency:     { min:0, max:100,  step:1 },
  DepthRange:         { min:0, max:120,  step:1 },
  BlocksCountRange:   { min:0, max:300,  step:1 },
};
const KNOB_LABEL = { SpawnPercentChance:'chance', PercentChance:'chance', NoiseFrequency:'freq', DepthRange:'depth', BlocksCountRange:'blocks (vein size)' };
const sMax = (f, v) => { const c = ORE_SLIDER[f]; v = v || 0; return c.step < 1 ? Math.max(c.max, +(v * 1.25).toFixed(4)) : Math.max(c.max, Math.ceil(v)); };
const sFmt = (f, v) => (ORE_SLIDER[f].step < 1 ? String(+(+v).toFixed(4)) : String(Math.round(v)));
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
function knob1(field, v) { const c = ORE_SLIDER[field]; v = (v != null ? v : 0);
  return '<span class="kk"><label>' + KNOB_LABEL[field] + '</label>' + slPair(field, c, sMax(field, v), v) + '</span>'; }
function knobR(field, r) { r = r || {}; const c = ORE_SLIDER[field], mx = sMax(field, Math.max(r.min || 0, r.max || 0));
  return '<span class="kk"><label>' + KNOB_LABEL[field] + '</label>' + slPair(field + '_min', c, mx, r.min != null ? r.min : 0) + '<span class="dash">–</span>' + slPair(field + '_max', c, mx, r.max != null ? r.max : 0) + '</span>'; }
function tmplVein() { return { '$type':'Eco.WorldGenerator.DepositTerrainModule, Eco.WorldGenerator', SpawnAtLeastOne:false, SpawnPercentChance:0.005, DepthRange:{min:10,max:30}, DepositDepthRange:{min:0,max:40}, BlocksCountRange:{min:10,max:40}, BlockType:{Type:'Eco.Mods.TechTree.IronOreBlock, Eco.Mods'}, DirectionWeights:[{X:1,Y:1,Z:1}], WeightVariance:{X:1,Y:1,Z:1} }; }
function tmplScatter() { return { '$type':'Eco.WorldGenerator.StandardTerrainModule, Eco.WorldGenerator', BlockType:{Type:'Eco.Mods.TechTree.CoalBlock, Eco.Mods'}, HeightRange:{min:-1,max:1}, DepthRange:{min:0,max:6}, PercentChance:0.3, NoiseFrequency:20, NoiseType:'Perlin', NoiseDistributionType:'Bands' }; }
function oreAdd(bi, type) {
  const bm = terrain.Modules[bi]; if (!bm) return;
  bm.Module = bm.Module || {};
  if (!bm.Module.BlockDepthRanges || !bm.Module.BlockDepthRanges.length) { bm.Module.BlockDepthRanges = [{ NoiseFrequency:40, Min:0, Max:0, BlockType:{ Type:'Eco.World.Blocks.DirtBlock, Eco.World' }, SubModules:[] }]; }
  const layer = bm.Module.BlockDepthRanges[0]; layer.SubModules = layer.SubModules || [];
  layer.SubModules.push(type === 'vein' ? tmplVein() : tmplScatter());
  oreOpen.add(bm.BiomeName); buildOreEditor(); OreVisual.build(); scheduleOreRender();
}
function oreRemove(idx) { const e = oreNodes[idx]; if (!e) return; const i = e.sub.indexOf(e.node); if (i >= 0) e.sub.splice(i, 1); buildOreEditor(); OreVisual.build(); scheduleOreRender(); }
function buildOreEditor() {
  const host = $('oreEditor'); host.innerHTML = ''; oreNodes = [];
  if (!terrain || !terrain.Modules) { host.innerHTML = '<div class="lbl">This config has no TerrainModule to edit.</div>'; return; }
  const opts = collectBlockTypes();
  terrain.Modules.forEach((bm, bi) => {
    const biome = bm.BiomeName; const ranges = (bm.Module && bm.Module.BlockDepthRanges) || [];
    const rows = [];
    for (const layer of ranges) for (const sm of (layer.SubModules || [])) {
      const ty = sm['$type'] || ''; const mat = oreMaterial(btOf(sm.BlockType)); if (!mat) continue;
      const idx = oreNodes.length; const dot = '<span class="ndot" style="background:' + ORE_COL[mat] + '"></span>';
      const del = '<button class="ndel" title="Remove this node">✕</button>';
      if (ty.indexOf('DepositTerrainModule') >= 0) {
        oreNodes.push({ node: sm, kind: 'dep', sub: layer.SubModules });
        rows.push('<div class="oreNode" data-idx="' + idx + '">' + dot + '<span class="tag" title="A concentrated vein of ore blocks">vein</span>' + blockSelect(btOf(sm.BlockType), opts) + knob1('SpawnPercentChance', sm.SpawnPercentChance) + knobR('DepthRange', sm.DepthRange) + knobR('BlocksCountRange', sm.BlocksCountRange) + del + '</div>');
      } else if (ty.indexOf('StandardTerrainModule') >= 0) {
        oreNodes.push({ node: sm, kind: 'std', sub: layer.SubModules });
        rows.push('<div class="oreNode" data-idx="' + idx + '">' + dot + '<span class="tag" title="Blocks scattered or banded through a depth range by chance">scatter</span>' + blockSelect(btOf(sm.BlockType), opts) + knob1('PercentChance', sm.PercentChance) + knobR('DepthRange', sm.DepthRange) + knob1('NoiseFrequency', sm.NoiseFrequency) + del + '</div>');
      }
    }
    const d = document.createElement('details'); if (oreOpen.has(biome)) d.open = true;
    d.innerHTML = '<summary>' + (ORE_DISP[biome] || biome) + ' <span class="cnt">· ' + rows.length + ' node' + (rows.length === 1 ? '' : 's') + '</span></summary>' + rows.join('') +
      '<div class="oreAdd"><button data-add="vein" data-b="' + bi + '">+ vein</button><button data-add="scatter" data-b="' + bi + '">+ scatter</button></div>';
    d.addEventListener('toggle', () => { if (d.open) oreOpen.add(biome); else oreOpen.delete(biome); });
    host.appendChild(d);
  });
  wireOreEditor();
}
function wireOreEditor() {
  const host = $('oreEditor');
  host.querySelectorAll('.oreNode').forEach(row => {
    const idx = +row.dataset.idx, node = oreNodes[idx].node;
    row.querySelectorAll('input,select').forEach(inp => inp.addEventListener('input', () => {
      const f = inp.dataset.f; if (!f) return;
      if (f === 'block') { node.BlockType = node.BlockType || {}; node.BlockType.Type = inp.value; scheduleOreRender(); return; }
      const val = parseFloat(inp.value); if (!isFinite(val)) return;
      if (f.endsWith('_min') || f.endsWith('_max')) { const key = f.slice(0, -4), mm = f.slice(-3); node[key] = node[key] || {}; node[key][mm] = val; }
      else node[f] = val;
      // keep the slider and its editable number in sync; a number beyond the slider's max grows the slider
      row.querySelectorAll('input[data-f="' + f + '"]').forEach(sib => { if (sib === inp) return; if (sib.type === 'range' && val > +sib.max) sib.max = val; sib.value = val; });
      scheduleOreRender();
    }));
    const del = row.querySelector('.ndel'); if (del) del.addEventListener('click', () => oreRemove(idx));
  });
  host.querySelectorAll('button[data-add]').forEach(b => b.addEventListener('click', () => oreAdd(+b.dataset.b, b.dataset.add)));
}
let oreRenderTimer = null;
function scheduleOreRender() { clearTimeout(oreRenderTimer); oreRenderTimer = setTimeout(() => { if (terrain) { const ej = buildExportJson(); OreChart.render(ej); BlockChart.render(ej); } }, 150); }

// ---- visual ore editor: per-biome depth lane where each vein/scatter is a draggable object ----
// Drag an object's body to move its DepthRange, drag its right edge to change abundance (SpawnPercentChance /
// PercentChance). Click to select and fine-tune with the same knobs as the manual editor. Edits the real
// TerrainModule node objects in place and shares scheduleOreRender so the charts + export stay in sync.
const OreVisual = (function () {
  const TOP = 16, SC = 2.2, X0 = 46, COLW = 58;
  let biomeIdx = 0, sel = null, objs = [], maxD = 120, H = 0;
  let laneEl = null, detailEl = null, svgEl = null;
  let drag = null, startDepth = 0, snapMin = 0, snapMax = 0;
  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const biomes = () => (terrain && terrain.Modules) ? terrain.Modules : [];
  const chanceOf = o => o.kind === 'dep' ? (o.node.SpawnPercentChance || 0) : (o.node.PercentChance || 0);
  const setChance = (o, v) => { if (o.kind === 'dep') o.node.SpawnPercentChance = v; else o.node.PercentChance = v; };
  const chMax = o => o.kind === 'dep' ? 0.03 : 1;
  const chStep = o => o.kind === 'dep' ? 0.0005 : 0.01;
  const y = d => TOP + d * SC, d2y = yy => (yy - TOP) / SC;
  function collect(bm) { const out = []; const rs = (bm.Module && bm.Module.BlockDepthRanges) || [];
    rs.forEach(l => (l.SubModules || []).forEach(sm => { const ty = sm['$type'] || ''; const mat = oreMaterial(btOf(sm.BlockType)); if (!mat) return;
      if (ty.indexOf('DepositTerrainModule') >= 0) out.push({ node: sm, kind: 'dep', sub: l.SubModules, mat });
      else if (ty.indexOf('StandardTerrainModule') >= 0) out.push({ node: sm, kind: 'std', sub: l.SubModules, mat }); }));
    return out; }
  function render() {
    const bms = biomes();
    let chips = ''; bms.forEach((bm, i) => { const on = i === biomeIdx;
      chips += '<button type="button" data-bi="' + i + '" style="font:inherit;font-size:13px;padding:5px 11px;border-radius:8px;border:0.5px solid ' + (on ? 'var(--accent)' : 'var(--border)') + ';background:' + (on ? 'var(--accent)' : 'var(--surf)') + ';color:' + (on ? '#fff' : 'var(--text)') + ';cursor:pointer">' + (ORE_DISP[bm.BiomeName] || bm.BiomeName) + '</button>'; });
    $('ovBiomes').innerHTML = chips;
    $('ovBiomes').querySelectorAll('button').forEach(b => b.onclick = () => { biomeIdx = +b.dataset.bi; sel = null; render(); renderDetail(); });
    const bm = bms[biomeIdx]; objs = bm ? collect(bm) : [];
    if (sel) { const f = objs.find(o => o.node === sel.node); sel = f || null; }
    maxD = 60; objs.forEach(o => { const r = o.node.DepthRange || {}; maxD = Math.max(maxD, r.max || 0); if (o.kind === 'dep') { const dd = o.node.DepositDepthRange || {}; maxD = Math.max(maxD, dd.max || 0); } });
    maxD = Math.min(220, Math.ceil((maxD + 10) / 20) * 20); H = TOP + maxD * SC + 34;
    const W = Math.max(X0 + 130, X0 + objs.length * COLW + 30);
    const cB = cssv('--border'), cM = cssv('--muted'), cT = cssv('--text'), cS = cssv('--text2');
    const midY = TOP + maxD * SC * 0.5;
    let s = '<svg id="ovSvg" xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:block;touch-action:none;user-select:none;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif">';
    s += '<text x="12" y="' + midY + '" fill="' + cS + '" font-size="12" transform="rotate(-90 12 ' + midY + ')">Depth (blocks below surface)</text>';
    for (let d = 0; d <= maxD; d += 20) { const yy = y(d); s += '<line x1="' + X0 + '" y1="' + yy + '" x2="' + W + '" y2="' + yy + '" stroke="' + cB + '"/><text x="' + (X0 - 8) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="11" fill="' + cM + '">' + d + '</text>'; }
    if (!objs.length) s += '<text x="' + (X0 + 30) + '" y="' + (TOP + 44) + '" fill="' + cM + '" font-size="12.5">No veins or scatter here yet — add one below.</text>';
    objs.forEach((o, i) => { const x = X0 + i * COLW, cx = x + COLW / 2; const r = o.node.DepthRange || { min: 0, max: 10 };
      const mn = Math.max(0, r.min || 0), mx = Math.max(mn + 1, r.max || 0); const yT = y(mn), yB = y(Math.min(maxD, mx));
      const frac = Math.min(1, Math.max(0.12, chanceOf(o) / chMax(o))), wH = frac * (COLW / 2 - 7);
      const col = blockColorRaw(btOf(o.node.BlockType)), seld = sel && o.node === sel.node;
      s += '<rect x="' + (cx - wH).toFixed(1) + '" y="' + yT.toFixed(1) + '" width="' + (wH * 2).toFixed(1) + '" height="' + (yB - yT).toFixed(1) + '" rx="4" fill="' + col + '" fill-opacity="' + (o.kind === 'std' ? 0.72 : 0.92) + '"' + (seld ? ' stroke="' + cT + '" stroke-width="2"' : '') + '/>';
      s += '<text x="' + cx + '" y="' + (H - 20) + '" text-anchor="middle" font-size="10.5" fill="' + (seld ? cT : cS) + '">' + ORE_NAME[o.mat] + '</text>';
      s += '<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle" font-size="9.5" fill="' + cM + '">' + (o.kind === 'dep' ? 'vein' : 'scatter') + '</text>';
      s += '<rect x="' + (cx - wH).toFixed(1) + '" y="' + yT.toFixed(1) + '" width="' + (wH * 2).toFixed(1) + '" height="' + (yB - yT).toFixed(1) + '" fill="transparent" pointer-events="all" data-drag="' + i + '|move" style="cursor:move"/>';
      s += '<rect x="' + (cx + wH - 7).toFixed(1) + '" y="' + yT.toFixed(1) + '" width="14" height="' + (yB - yT).toFixed(1) + '" fill="transparent" pointer-events="all" data-drag="' + i + '|w" style="cursor:ew-resize"/>';
    });
    s += '</svg>';
    laneEl.innerHTML = s; svgEl = document.getElementById('ovSvg');
    svgEl.addEventListener('pointerdown', onDown);
  }
  function onDown(e) { const t = e.target; if (!t || !t.dataset || !t.dataset.drag) return; const p = t.dataset.drag.split('|');
    sel = objs[+p[0]]; drag = { i: +p[0], o: objs[+p[0]], k: p[1] }; const r = svgEl.getBoundingClientRect();
    startDepth = d2y((e.clientY - r.top) * (H / r.height)); const rg = drag.o.node.DepthRange || {}; snapMin = rg.min || 0; snapMax = rg.max || 0;
    e.preventDefault(); render(); renderDetail(); }
  function onMove(e) { if (!drag) return; const r = svgEl.getBoundingClientRect(); const o = drag.o;
    if (drag.k === 'move') { const d = d2y((e.clientY - r.top) * (H / r.height)); const span = snapMax - snapMin;
      let nmin = Math.max(0, Math.min(maxD - span, Math.round(snapMin + (d - startDepth)))); o.node.DepthRange = o.node.DepthRange || {}; o.node.DepthRange.min = nmin; o.node.DepthRange.max = nmin + span; }
    else if (drag.k === 'w') { const W = svgEl.viewBox.baseVal.width, cx = X0 + drag.i * COLW + COLW / 2; const xx = (e.clientX - r.left) * (W / r.width);
      let frac = Math.max(0.12, Math.min(1, (xx - cx) / (COLW / 2 - 7))), v = frac * chMax(o), st = chStep(o); setChance(o, +(Math.round(v / st) * st).toFixed(4)); }
    render(); renderDetail(); scheduleOreRender(); }
  function renderDetail() {
    if (!detailEl) return;
    if (!sel) { detailEl.innerHTML = '<div class="lbl" style="padding:6px 0">Click a vein or scatter to fine-tune it or change its block — or add one below.</div>'; return; }
    const o = sel, opts = collectBlockTypes(), dep = o.kind === 'dep';
    const dot = '<span class="ndot" style="background:' + ORE_COL[o.mat] + '"></span>', del = '<button class="ndel" title="Remove this node">✕</button>';
    let h = '<div class="oreNode" style="border-top:none">' + dot + '<span class="tag">' + (dep ? 'vein' : 'scatter') + '</span>' + blockSelect(btOf(o.node.BlockType), opts);
    h += dep ? (knob1('SpawnPercentChance', o.node.SpawnPercentChance) + knobR('DepthRange', o.node.DepthRange) + knobR('BlocksCountRange', o.node.BlocksCountRange))
             : (knob1('PercentChance', o.node.PercentChance) + knobR('DepthRange', o.node.DepthRange) + knob1('NoiseFrequency', o.node.NoiseFrequency));
    h += del + '</div>'; detailEl.innerHTML = h; wireDetail(o);
  }
  function wireDetail(o) { const node = o.node;
    detailEl.querySelectorAll('input,select').forEach(inp => inp.addEventListener('input', () => {
      const f = inp.dataset.f; if (!f) return;
      if (f === 'block') { node.BlockType = node.BlockType || {}; node.BlockType.Type = inp.value; o.mat = oreMaterial(inp.value) || o.mat; render(); scheduleOreRender(); return; }
      const val = parseFloat(inp.value); if (!isFinite(val)) return;
      if (f.endsWith('_min') || f.endsWith('_max')) { const key = f.slice(0, -4), mm = f.slice(-3); node[key] = node[key] || {}; node[key][mm] = val; } else node[f] = val;
      detailEl.querySelectorAll('input[data-f="' + f + '"]').forEach(sib => { if (sib === inp) return; if (sib.type === 'range' && val > +sib.max) sib.max = val; sib.value = val; });
      render(); scheduleOreRender();
    }));
    const d = detailEl.querySelector('.ndel'); if (d) d.onclick = () => { const idx = o.sub.indexOf(o.node); if (idx >= 0) o.sub.splice(idx, 1); sel = null; buildOreEditor(); render(); renderDetail(); scheduleOreRender(); };
  }
  function add(type) { const bm = biomes()[biomeIdx]; if (!bm) return; bm.Module = bm.Module || {};
    if (!bm.Module.BlockDepthRanges || !bm.Module.BlockDepthRanges.length) bm.Module.BlockDepthRanges = [{ NoiseFrequency: 40, Min: 0, Max: 0, BlockType: { Type: 'Eco.World.Blocks.DirtBlock, Eco.World' }, SubModules: [] }];
    const layer = bm.Module.BlockDepthRanges[0]; layer.SubModules = layer.SubModules || []; const n = type === 'vein' ? tmplVein() : tmplScatter();
    layer.SubModules.push(n); buildOreEditor(); render(); sel = objs.find(x => x.node === n) || null; renderDetail(); scheduleOreRender(); }
  function build() { laneEl = $('ovLane'); detailEl = $('ovDetail');
    if (!terrain || !terrain.Modules) { if (laneEl) laneEl.innerHTML = '<div class="lbl" style="padding:10px">No TerrainModule to edit.</div>'; if (detailEl) detailEl.innerHTML = ''; return; }
    if (biomeIdx >= terrain.Modules.length) biomeIdx = 0; render(); renderDetail(); }
  function init() { document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', () => { drag = null; });
    $('ovAddVein').onclick = () => add('vein'); $('ovAddScatter').onclick = () => add('scatter'); }
  return { build, init };
})();

// ---- ore-distribution chart (port of WorldGenOreVisualizer) ----
const OreChart = (function () {
  const ELEV = { Grassland:[.02,.4], WarmForest:[.1,.5], ColdForest:[.1,.7], RainForest:[.1,.5], Desert:[.02,.2], Taiga:[.3,1], Tundra:[.4,1], Ice:[.6,1], Wetland:[.02,.3], ColdCoast:[.05,.1], WarmCoast:[.05,.1] };
  const WEIGHTF = { RainForest:'RainforestWeight', WarmForest:'WarmForestWeight', ColdForest:'CoolForestWeight', Taiga:'TaigaWeight', Tundra:'TundraWeight', Ice:'IceWeight', Desert:'DesertWeight', Wetland:'WetlandWeight' };
  const ALWAYS = { Grassland:1, ColdCoast:1, WarmCoast:1 };
  const biomeOrder = ['Desert','Grassland','Wetland','WarmForest','RainForest','WarmCoast','ColdCoast','ColdForest','Taiga','Tundra','Ice'];
  const oreOrder = ['iron','copper','gold','coal','sulfur','peat','limestone','clay'];
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
    const out = {}; const add = (b,o,m) => { const k = b+'|'+o; (out[k]=out[k]||[]).push(m); };
    terr.Modules.forEach(bm => { bm = deref(bm); const name = bm.BiomeName; if (!ELEV[name]) return;
      const dm = deref(bm.Module); const ranges = (dm && dm.BlockDepthRanges) || [];
      ranges.forEach(bdr => { bdr = deref(bdr); const pm = oreMaterial(btype(bdr.BlockType));
        if (pm) add(name, pm, { t:'strat', a:Math.max(0,bdr.Min|0), b:Math.max(bdr.Min|0,bdr.Max|0), w:0.6 });
        (bdr.SubModules||[]).forEach(sm => { sm = deref(sm); const ty = sm['$type']||''; const mat = oreMaterial(btype(sm.BlockType)); if (!mat) return;
          if (ty.indexOf('StandardTerrainModule') >= 0) { const r = rng(sm,'DepthRange',[0,200]); add(name, mat, { t:'std', a:r[0]|0, b:r[1]|0, w:sm.PercentChance!=null?sm.PercentChance:0.05 }); }
          else if (ty.indexOf('DepositTerrainModule') >= 0) { const sr = rng(sm,'DepthRange',[0,200]), br = rng(sm,'DepositDepthRange',[0,200]); const bc = rng(sm,'BlocksCountRange',[1,1]); const N = (bc[0]+bc[1])/2; const mw = meanW(sm);
            const spc = sm.SpawnPercentChance!=null?sm.SpawnPercentChance:0.01;
            add(name, mat, { t:'dep', sa:sr[0]|0, sb:sr[1]|0, ba:Math.min(sr[0],br[0])|0, bb:Math.max(sr[1],br[1])|0, w:spc*N, spc:spc, bo:boost(mw[0],mw[1],mw[2]), N:N }); }
        });
      });
    });
    const entries = []; for (const k in out) { const p = k.split('|'); entries.push({ bi:p[0], ore:p[1], surf:surfOf(p[0]), on:presentOf(p[0]), mods:out[k] }); }
    // Seed-to-seed spread: each deposit is an independent per-block Bernoulli roll, so the count of deposit
    // seed-points on one map is ~Poisson. Relative spread of a module is 1/sqrt(expected count); scatter has a
    // huge count (~zero spread), rare deposits in rare biomes have few (visible spread). Combine per cell by
    // error propagation over each module's integrated contribution. Areas are in blocks² (chance is per block).
    // Prefer the actually-generated map for world area and biome coverage; fall back to config + constants when
    // no map has been generated yet. Ocean is its own biome key, so per-biome coverage already excludes it.
    let wsum = 0; if (weights) for (const bn in WEIGHTF) wsum += (weights[WEIGHTF[bn]]||0);
    const fallbackFrac = name => { const f = WEIGHTF[name]; if (f) return Math.max(0, (weights && weights[f])||0);
      if (name === 'Grassland') return Math.max(0.03, 1 - wsum); return 0.04; }; // coasts are thin strips
    const dims = deref(cfg.Dimensions) || {};
    const cfgArea = (((dims.WorldWidth|0)||72)*10) * (((dims.WorldLength|0)||72)*10);
    const LANDSHARE = 0.6; // rough land fraction, used only in the no-map fallback
    const map = (result && result.stats && result.worldSize) ? result : null;
    let cellArea; // land area (blocks²) of a given ore-chart biome
    if (map) { const worldArea = map.worldSize * map.worldSize, counts = map.stats.counts;
      let tot = 0; for (const k in counts) tot += counts[k]; tot = tot || 1;
      cellArea = name => { const c = counts[name]||0; return c > 0 ? worldArea*(c/tot) : cfgArea*LANDSHARE*fallbackFrac(name); }; }
    else cellArea = name => cfgArea * LANDSHARE * fallbackFrac(name);
    entries.forEach(e => { const area = cellArea(e.bi); let vSum = 0, iSum = 0, depI = 0, lam = 0;
      e.mods.forEach(m => {
        if (m.t === 'dep') { const band = Math.max(1, m.sb - m.sa + 1);
          const lambda = Math.max(1e-6, m.spc * area * band); lam += lambda;
          const I = m.w, cv = 1 / Math.sqrt(lambda); vSum += (I*cv)*(I*cv); iSum += I; depI += I; }
        else iSum += m.w * Math.max(1, (m.b - m.a + 1)); }); // scatter: effectively zero variance
      e.cv = iSum > 0 ? Math.min(1.5, Math.sqrt(vSum) / iSum) : 0; e.lambda = lam;
      e.depShare = iSum > 0 ? depI / iSum : 0; }); // how much of this ore comes from sparse deposits vs steady scatter
    return { entries, WL, MG, spreadFromMap: !!map };
  }
  let Ymax = 125, DMAX = 210;
  function depthProfile(e) {
    const arr = new Array(DMAX+1).fill(0);
    e.mods.forEach(m => {
      if (m.t === 'std' || m.t === 'strat') { for (let d = Math.max(0,m.a); d <= m.b && d <= DMAX; d++) arr[d] += m.w; return; }
      const ey = 0.62*Math.cbrt(m.N)*m.bo, h = Math.max(1, Math.round(ey));
      const base = new Array(DMAX+1).fill(0); for (let d = Math.max(0,m.sa); d <= m.sb && d <= DMAX; d++) base[d] = 1;
      const sm = new Array(DMAX+1).fill(0);
      for (let d = 0; d <= DMAX; d++) { let acc=0,ws=0; for (let k=-h;k<=h;k++){ const wk=h+1-Math.abs(k), dd=d-k; if (dd>=0&&dd<=DMAX) acc+=base[dd]*wk; ws+=wk; } sm[d]=acc/ws; }
      for (let d2 = 0; d2 <= DMAX; d2++) if (d2 < m.ba || d2 > m.bb) sm[d2] = 0;
      let tot = 0; for (let d3 = 0; d3 <= DMAX; d3++) tot += sm[d3];
      if (tot > 0) for (let d4 = 0; d4 <= DMAX; d4++) arr[d4] += sm[d4]/tot*m.w;
    });
    return arr;
  }
  function smearY(dp, surf) { const lo=surf[0],hi=surf[1],cnt=hi-lo+1,arr=[];
    for (let Y=0;Y<=Ymax;Y++){ let sum=0; for (let sft=lo;sft<=hi;sft++){ const d=sft-Y; sum+=(d>=0&&d<=DMAX)?dp[d]:0; } arr.push(sum/cnt); }
    const sm=[]; for (let Y2=0;Y2<=Ymax;Y2++){ const a=arr[Math.max(0,Y2-1)],b=arr[Y2],c=arr[Math.min(Ymax,Y2+1)]; sm.push((a+2*b+c)/4); } return sm; }
  let D=null, gMax=0, oreMax={}, layout=[], curW=0, plotR=0, svgEl=null, hvLine=null, hvRect=null, H=0, tipEl=null, wrapEl=null;
  const padTop=48, sc=2.4, x0=64, subW=34, gap=10;
  const state = { mode:'ore', style:'violin', scale:'global', spread:'off' };
  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const py = Y => padTop + (Ymax-Y)*sc;
  function buildGroups(mode) { const E=D.entries, groups=[];
    if (mode === 'ore') oreOrder.forEach(o => { const cells=E.filter(e=>e.ore===o).sort((a,b)=>biomeOrder.indexOf(a.bi)-biomeOrder.indexOf(b.bi)); if (cells.length) groups.push({label:ORE_NAME[o],color:ORE_COL[o],on:true,cells,sub:e=>ORE_DISP[e.bi]+(e.on?'':'*')}); });
    else biomeOrder.forEach(b => { const cells=E.filter(e=>e.bi===b).sort((a,b2)=>oreOrder.indexOf(a.ore)-oreOrder.indexOf(b2.ore)); if (cells.length) groups.push({label:ORE_DISP[b]+(cells[0].on?'':'*'),color:null,on:cells[0].on,cells,sub:e=>ORE_NAME[e.ore]}); });
    return groups; }
  function render() {
    if (!D) return;
    const cT=cssv('--text'),cS=cssv('--text2'),cM=cssv('--muted'),cB=cssv('--border'),water=cssv('--water')||'#3987e5';
    const groups=buildGroups(state.mode), MINGW=82; let totalSlots=0; groups.forEach(g=>{ g.slot=Math.max(g.cells.length*subW,MINGW); totalSlots+=g.slot; });
    curW=x0+totalSlots+(groups.length-1)*gap+14; plotR=curW-14; layout=[]; const maxHW=subW/2-2, barHW=10;
    let s='<svg id="oreSvg" xmlns="http://www.w3.org/2000/svg" width="'+curW+'" height="'+H+'" viewBox="0 0 '+curW+' '+H+'" style="display:block;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">';
    const step=Ymax>140?40:20, ticks=[]; for (let t=0;t<=Ymax;t+=step) ticks.push(t);
    for (let i=0;i<ticks.length;i++){ const ty=py(ticks[i]); s+='<line x1="'+x0+'" y1="'+ty+'" x2="'+plotR+'" y2="'+ty+'" stroke="'+cB+'" stroke-width="1"/><text x="'+(x0-8)+'" y="'+(ty+4)+'" text-anchor="end" fill="'+cM+'" font-size="11">'+ticks[i]+'</text>'; }
    s+='<text x="12" y="'+py(Ymax*0.86)+'" fill="'+cS+'" font-size="12" transform="rotate(-90 12 '+py(Ymax*0.86)+')">World height (Y)</text>';
    const wy=py(D.WL); s+='<line x1="'+x0+'" y1="'+wy+'" x2="'+plotR+'" y2="'+wy+'" stroke="'+water+'" stroke-width="1.4" stroke-dasharray="5 4"/><text x="'+plotR+'" y="'+(wy-5)+'" text-anchor="end" fill="'+water+'" font-size="10.5">water Y'+D.WL+'</text>';
    s+='<rect id="oreHvr" x="0" y="0" width="0" height="0" fill="'+cM+'" fill-opacity="0.10" style="display:none"/>';
    let cx=x0;
    groups.forEach(g => { const gStart=cx, slot=g.slot, cellsW=g.cells.length*subW; let cellx=gStart+(slot-cellsW)/2; const hcol=g.color?cT:(g.on?cT:cM);
      s+='<text x="'+(gStart+slot/2)+'" y="20" text-anchor="middle" fill="'+hcol+'" font-size="12.5" font-weight="600">'+g.label+'</text>';
      if (g.color) s+='<rect x="'+(cellx+4)+'" y="26" width="'+(cellsW-8)+'" height="3" rx="1.5" fill="'+g.color+'"/>'; else s+='<line x1="'+(cellx+4)+'" y1="27" x2="'+(cellx+cellsW-4)+'" y2="27" stroke="'+cB+'" stroke-width="1"/>';
      g.cells.forEach(e => { const bx=cellx, scx=bx+subW/2, col=ORE_COL[e.ore], dim=e.on?1:0.5; const norm=(state.scale==='global'?gMax:(oreMax[e.ore]||1))||1; const syT=py(Math.min(e.surf[1],Ymax)),syB=py(e.surf[0]);
        s+='<rect x="'+(bx+2)+'" y="'+syT+'" width="'+(subW-4)+'" height="'+(syB-syT)+'" fill="'+cM+'" fill-opacity="0.08"/><line x1="'+(bx+2)+'" y1="'+syT+'" x2="'+(bx+subW-2)+'" y2="'+syT+'" stroke="'+cM+'" stroke-width="1" stroke-opacity="0.35" stroke-dasharray="2 2"/>';
        if (state.style === 'violin') { const halo=state.spread==='on'&&e.cv>0.02, hwCap=subW/2-0.5;
          for (let Y=0;Y<=Ymax;Y++){ const nv=e.prof[Y]/norm; if (nv<=0.004) continue; const rt=Math.sqrt(nv), hw=Math.max(1.1,rt*maxHW), op=(0.26+0.6*rt)*dim, yy=py(Y)-sc/2, hgt=(sc+0.5).toFixed(1);
            if (halo){ const hw2=Math.min(hwCap,hw*(1+e.cv)); s+='<rect x="'+(scx-hw2).toFixed(1)+'" y="'+yy.toFixed(1)+'" width="'+(hw2*2).toFixed(1)+'" height="'+hgt+'" fill="'+col+'" fill-opacity="'+(0.13*dim).toFixed(2)+'"/>'; }
            s+='<rect x="'+(scx-hw).toFixed(1)+'" y="'+yy.toFixed(1)+'" width="'+(hw*2).toFixed(1)+'" height="'+hgt+'" fill="'+col+'" fill-opacity="'+op.toFixed(2)+'"/>'; } }
        else { let ylo=1e9,yhi=-1; for (let Y2=0;Y2<=Ymax;Y2++){ if (e.prof[Y2]/norm>0.03){ if (Y2<ylo)ylo=Y2; if (Y2>yhi)yhi=Y2; } } if (yhi>0){ const bt=py(yhi); s+='<rect x="'+(scx-barHW)+'" y="'+bt+'" width="'+(barHW*2)+'" height="'+(py(ylo)-bt)+'" rx="2" fill="'+col+'" fill-opacity="'+(0.82*dim).toFixed(2)+'"/>'; } }
        s+='<text transform="rotate(-42 '+scx+' '+(H-48)+')" x="'+scx+'" y="'+(H-48)+'" text-anchor="end" fill="'+(e.on?cS:cM)+'" font-size="10">'+g.sub(e)+'</text>';
        layout.push({x0:bx,x1:bx+subW,e}); cellx+=subW;
      });
      cx=gStart+slot+gap;
    });
    s+='<line id="oreHvl" x1="0" y1="0" x2="0" y2="0" stroke="'+cT+'" stroke-width="1" stroke-opacity="0.5" stroke-dasharray="3 3" style="display:none"/></svg>';
    $('oreChart').innerHTML=s; svgEl=$('oreSvg'); hvLine=$('oreHvl'); hvRect=$('oreHvr');
    svgEl.addEventListener('mousemove', onMove);
    svgEl.addEventListener('mouseleave', () => { tipEl.style.display='none'; hvLine.style.display='none'; hvRect.style.display='none'; });
  }
  function onMove(e) {
    const cM=cssv('--muted'),cS=cssv('--text2'); const r=svgEl.getBoundingClientRect();
    const sx=(e.clientX-r.left)*(curW/r.width), sy=(e.clientY-r.top)*(H/r.height); const Y=Math.round(Ymax-(sy-padTop)/sc); let col=null;
    for (let i=0;i<layout.length;i++){ if (sx>=layout[i].x0&&sx<layout[i].x1){ col=layout[i]; break; } }
    if (!col||Y<0||Y>Ymax){ tipEl.style.display='none'; hvLine.style.display='none'; hvRect.style.display='none'; return; }
    const en=col.e, val=en.prof[Y], gi=val/gMax*100, po=val/(oreMax[en.ore]||1)*100;
    hvLine.setAttribute('x1',x0); hvLine.setAttribute('x2',plotR); hvLine.setAttribute('y1',py(Y)); hvLine.setAttribute('y2',py(Y)); hvLine.style.display='block';
    hvRect.setAttribute('x',col.x0); hvRect.setAttribute('y',padTop); hvRect.setAttribute('width',subW); hvRect.setAttribute('height',Ymax*sc); hvRect.style.display='block';
    const sm=(en.surf[0]+en.surf[1])/2, dep=Math.round(sm-Y); const depL=dep>=0?('≈ '+dep+' blocks deep'):('~ '+(-dep)+' above surface');
    const giTxt=gi>=1?Math.round(gi):(gi>0.05?'<1':'0'); let bodyH;
    if (gi<0.4 && po<2) bodyH='<div style="color:'+cM+'">negligible '+ORE_NAME[en.ore].toLowerCase()+' here</div>';
    else bodyH='<div>Density index <span style="font-weight:600;color:'+ORE_COL[en.ore]+'">'+giTxt+'</span> / 100 <span style="color:'+cM+'">global</span></div><div style="color:'+cS+'">'+Math.round(po)+'% of peak '+ORE_NAME[en.ore].toLowerCase()+'</div>';
    const absent=en.on?'':'<div style="color:'+cM+'">* not generated on this map</div>';
    let spreadH='';
    if (en.lambda>0){ const pct=Math.round(en.cv*100), depN='≈'+Math.round(Math.max(1,en.lambda))+' deposits/map';
      if (en.cv<0.05 && en.depShare<0.5) spreadH='<div style="color:'+cS+'">steady across seeds <span style="color:'+cM+'">(scatter-dominated · '+depN+')</span></div>';
      else { const lbl=en.cv<0.05?'barely varies':(en.cv<0.2?'mild seed variance':'high seed variance');
        spreadH='<div style="color:'+cS+'">seed spread ±'+pct+'% · '+depN+' <span style="color:'+cM+'">('+lbl+')</span></div>'; } }
    tipEl.innerHTML='<div style="font-weight:600">'+ORE_DISP[en.bi]+' · '+ORE_NAME[en.ore]+'</div><div style="color:'+cS+'">Y '+Y+' · '+depL+'</div>'+bodyH+spreadH+absent; tipEl.style.display='block';
    const wr=wrapEl.getBoundingClientRect(); tipEl.style.left=(e.clientX-wr.left+wrapEl.scrollLeft+14)+'px'; tipEl.style.top=(e.clientY-wr.top+12)+'px';
  }
  function renderFromCfg(cfg) {
    try { D = extract(cfg); } catch (ex) { $('oreChart').innerHTML='<div class="lbl" style="padding:12px">Ore chart unavailable: ' + ex.message + '</div>'; return; }
    Ymax = Math.max(120, Math.ceil(D.MG/20)*20); DMAX = Ymax+90; H = padTop+Ymax*sc+70; gMax = 0; oreMax = {};
    D.entries.forEach(e => { e.prof = smearY(depthProfile(e), e.surf); e.pk = 0; e.prof.forEach(v => { if (v>gMax) gMax=v; if (v>e.pk) e.pk=v; }); if (e.pk>(oreMax[e.ore]||0)) oreMax[e.ore]=e.pk; }); if (gMax<=0) gMax=1;
    $('oreMeta').textContent = D.entries.length + ' biome×material bands · water Y' + D.WL + ' · gen height ' + D.MG
      + ' · seed spread ' + (D.spreadFromMap ? 'from generated map' : 'estimated (generate for real coverage)');
    render();
  }
  function seg(id, opts, key) { const c=$(id); c.innerHTML=''; opts.forEach(o => { const b=document.createElement('button'); b.textContent=o.label; b.onclick=()=>{ state[key]=o.val; [...c.children].forEach(x=>x.classList.toggle('on', x===b)); render(); }; if (o.val===state[key]) b.className='on'; c.appendChild(b); }); }
  function init() {
    tipEl=$('oreTip'); wrapEl=$('oreChartWrap');
    seg('oreGrp', [{label:'Ore',val:'ore'},{label:'Biome',val:'biome'}], 'mode');
    seg('oreSty', [{label:'Violins',val:'violin'},{label:'Bars',val:'bars'}], 'style');
    seg('oreScl', [{label:'Global',val:'global'},{label:'Per-ore',val:'perore'}], 'scale');
    seg('oreSpr', [{label:'Off',val:'off'},{label:'On',val:'on'}], 'spread');
    let lg=''; oreOrder.forEach(o => { lg+='<span><span class="sw" style="background:'+ORE_COL[o]+'"></span>'+ORE_NAME[o]+'</span>'; });
    lg+='<span style="color:var(--muted)">* biome not on this map · widths √-scaled · <b>Global</b>: full width = densest ore anywhere · <b>Per-ore</b>: full width = peak of that ore · <b>Seed spread</b>: faint halo = seed-to-seed variance (wide on rare deposits) · hover for density</span>'; $('oreLegend').innerHTML=lg;
  }
  return { render: renderFromCfg, init };
})();

// ---- block-composition chart: per-biome vertical "what you dig through" stack over world height ----
// Complements the ore chart. Where the ore chart normalises each ore's density on its own axis, this shows
// the 100%-stacked composition of ALL blocks (base strata + scatter + veins) at each Y, per biome, so you can
// read how the mix shifts with depth. Model is a faithful aggregate of the server's TerrainDepthModule:
// each stratum's bottom is a per-column noise threshold ~U[Min,Max]; the shallowest in-order stratum whose
// threshold >= depth wins, then that stratum's scatters apply first-wins by PercentChance, and veins carve a
// small deposit fraction out on top. We Monte-Carlo the strata thresholds (fixed seed -> stable chart).
const BlockChart = (function () {
  const ELEV = { Grassland:[.02,.4], WarmForest:[.1,.5], ColdForest:[.1,.7], RainForest:[.1,.5], Desert:[.02,.2], Taiga:[.3,1], Tundra:[.4,1], Ice:[.6,1], Wetland:[.02,.3], ColdCoast:[.05,.1], WarmCoast:[.05,.1] };
  const WEIGHTF = { RainForest:'RainforestWeight', WarmForest:'WarmForestWeight', ColdForest:'CoolForestWeight', Taiga:'TaigaWeight', Tundra:'TundraWeight', Ice:'IceWeight', Desert:'DesertWeight', Wetland:'WetlandWeight' };
  const ALWAYS = { Grassland:1, ColdCoast:1, WarmCoast:1 };
  const biomeOrder = ['Desert','Grassland','Wetland','WarmForest','RainForest','WarmCoast','ColdCoast','ColdForest','Taiga','Tundra','Ice'];
  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const state = { merge:'merge', emph:'off' };
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

  // expected per-depth occupancy fraction of one vein (same smear the ore chart uses)
  function depositFrac(m) {
    const arr = new Float64Array(DMAX + 1);
    const ey = 0.62 * Math.cbrt(m.N) * m.bo, h = Math.max(1, Math.round(ey));
    const base = new Float64Array(DMAX + 1); for (let d = Math.max(0,m.sa); d <= m.sb && d <= DMAX; d++) base[d] = 1;
    const sm = new Float64Array(DMAX + 1);
    for (let d = 0; d <= DMAX; d++) { let acc = 0, ws = 0; for (let k = -h; k <= h; k++) { const wk = h + 1 - Math.abs(k), dd = d - k; if (dd >= 0 && dd <= DMAX) acc += base[dd]*wk; ws += wk; } sm[d] = acc/ws; }
    for (let d2 = 0; d2 <= DMAX; d2++) if (d2 < m.ba || d2 > m.bb) sm[d2] = 0;
    let tot = 0; for (let d3 = 0; d3 <= DMAX; d3++) tot += sm[d3];
    const w = m.spc * m.N;
    if (tot > 0) for (let d4 = 0; d4 <= DMAX; d4++) arr[d4] = sm[d4]/tot*w;
    return arr;
  }

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
    const depFrac = {};
    strata.forEach(st => st.deposits.forEach(dep => { const a = depositFrac(dep); const cur = depFrac[dep.block] || (depFrac[dep.block] = new Float64Array(DMAX + 1)); for (let d = 0; d <= DMAX; d++) cur[d] += a[d]; }));
    const addTo = (o, k, v) => { if (v > 0) o[k] = (o[k] || 0) + v; };
    for (let d = 0; d <= DMAX; d++) {
      const c = {};
      for (let i = 0; i < N; i++) { const p = baseP[i][d]; if (p <= 0) continue; const st = strata[i]; let remaining = 1;
        for (const scb of st.scatters) { if (d >= scb.a && d <= scb.b) { const take = remaining * scb.pc; addTo(c, scb.block, p * take); remaining -= take; } }
        addTo(c, st.block, p * remaining); }
      let depTot = 0; for (const k in depFrac) depTot += depFrac[k][d];
      if (depTot > 0) { const cap = Math.min(0.95, depTot), scale = 1 - cap, f = cap / depTot;
        for (const k in c) c[k] *= scale;
        for (const k in depFrac) addTo(c, k, depFrac[k][d] * f); }
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
    seg('blkCrush', [{ label:'Merge', val:'merge' }, { label:'Separate', val:'separate' }], 'merge');
    seg('blkEmph', [{ label:'Normal', val:'off' }, { label:'Emphasize', val:'on' }], 'emph');
  }
  return { render: function (cfg) { lastCfg = cfg; renderFromCfg(cfg); }, init };
})();

// hand-off the current (edited) config to the standalone ore visualizer via postMessage handshake
let pendingHandoff = null;
function oreHandoff() {
  if (!terrain) { $('err').textContent = 'Load a config first.'; return; }
  pendingHandoff = buildExportJson();
  window.open('WorldGenOreVisualizer.html', '_blank');
}
window.addEventListener('message', e => { if (e.data && e.data.type === 'eco-oreviz-ready' && pendingHandoff && e.source) e.source.postMessage({ type: 'eco-config', cfg: pendingHandoff }, '*'); });

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
OreChart.init();
BlockChart.init();
OreVisual.init();
// underground charts: two tabs in one panel, Block composition default
(function initChartTabs(){
  const tabs = $('chartTabs');
  const show = t => { $('blockTab').style.display = t === 'block' ? '' : 'none'; $('oreTab').style.display = t === 'ore' ? '' : 'none';
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.tab === t); };
  for (const b of tabs.children) b.onclick = () => show(b.dataset.tab);
})();
// block & ore editor: Visual editor / Manual knobs tabs (rebuild the shown tab so edits in the other stay in sync)
(function initOreTabs(){
  const tabs = $('oreTabs');
  const show = t => { $('oreVisualTab').style.display = t === 'visual' ? '' : 'none'; $('oreManualTab').style.display = t === 'manual' ? '' : 'none';
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.tab === t);
    if (terrain) { if (t === 'visual') OreVisual.build(); else buildOreEditor(); } };
  for (const b of tabs.children) b.onclick = () => show(b.dataset.tab);
})();
$('oreHandoff').onclick = oreHandoff;
$('gen').onclick = () => loadConfigText($('paste').value);
$('regen').onclick = generateFromForm;
$('resetCfg').onclick = () => { if (baseCfg) populateForm(baseCfg); };
$('dlEco').onclick = downloadEco;
$('randSeed').onclick = () => {
  if (!baseCfg) { $('err').textContent = 'Load or paste a WorldGenerator.eco config first.'; return; }
  $('seed').value = String(Math.trunc(Math.random() * 4294967296) | 0); // full int32 range, incl. negatives
  generateFromForm();
};
$('waterToggle').onchange = e => { showWater = e.target.checked; render(); };
$('expPng').onclick = () => { const a=document.createElement('a'); a.download='eco-worldgen-'+layer+'.png'; a.href=$('cv').toDataURL('image/png'); a.click(); };
const drop = $('drop');
['dragover','dragenter'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop', e => { const f=e.dataTransfer.files[0]; if(f) readFile(f); });
drop.addEventListener('click', ()=>$('file').click());
$('file').addEventListener('change', e => { const f=e.target.files[0]; if(f) readFile(f); });
function readFile(f){ const r=new FileReader(); r.onload=()=>{ $('paste').value=r.result; loadConfigText(r.result); }; r.readAsText(f); }

// load the bundled default world on startup (embedded, so it works from file:// too)
const DEFAULT_ECO = ($('defaultcfg').textContent || '').trim();
if (DEFAULT_ECO) loadConfigText(DEFAULT_ECO);
</script>
</body>
</html>`;

fs.writeFileSync('index.html', html);
console.log('wrote index.html', html.length, 'bytes');
