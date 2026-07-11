// Per-voxel underground block generation — faithful port of Eco.WorldGenerator's
// TerrainGenerator + TerrainModules. Runs in the worker. Depends on core.js (Perlin, CsRandom).
//
// Base rock strata (TerrainDepthModule) + scatter (StandardTerrainModule) are seed-faithful and
// generated per column on demand. Ore veins (DepositTerrainModule) are a GLOBAL post-pass in the
// game (spawn points collected worldwide, then grown via a shared random + overlap dedup), so we
// precompute the whole sparse vein layer once (computeDeposits) and overlay it during meshing.
//
// Seed model (verified against the server):
// - Terrain-module noise seeds come from `new Random(seed)` consumed by InitModules, which inits
//   every module TWICE (a quirk we reproduce). Submodule seeds are drawn in authored order
//   (scatter/deposit interleaved). The same Random continues as the deposit GROWTH random.
// - Deposit SPAWN points use a per-10x10-chunk `new Random(chunkX*seed + chunkZ)`, consumed in
//   x,z,y-down scan order (interleaved with a surface "extrude" draw on Minable tops).
// - FrequencyScale = WorldWidth / 72 (same as the surface).

let VC;
if (typeof require !== 'undefined') VC = require('./core.js');
function bindVoxel(core) { VC = core; }

const IMPENETRABLE = 'Eco.World.Blocks.ImpenetrableStoneBlock';   // server floor fallback
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const inRangeInc = (v, lo, hi) => v >= lo && v <= hi;
const fr = Math.fround;

// SharpNoise/Eco SeamlessNoise.GetValue with extent = FrequencyScale (tiles across x-z).
function seamless(src, fs, x, y, z) {
  const ext = fs; x *= fs; z *= fs;
  const sw = src.getValue(x, y, z), se = src.getValue(x + ext, y, z);
  const nw = src.getValue(x, y, z + ext), ne = src.getValue(x + ext, y, z + ext);
  const xB = 1 - x / ext, zB = 1 - z / ext;
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(sw, se, xB), l(nw, ne, xB), zB);
}

// blocks mined with a pick (drive the surface "extrude" random draw). Best-effort classification;
// soils/sand/gravel/snow/ice are dug, not mined. A mismatch only perturbs one 10x10 chunk locally.
const MINABLE = new Set(['Granite', 'Sandstone', 'Limestone', 'Shale', 'Slate', 'Basalt', 'Gneiss',
  'Coal', 'IronOre', 'CopperOre', 'GoldOre', 'Sulfur', 'ImpenetrableStone', 'Bedrock']);
const baseName = t => { const s = (t || '').split(',')[0].split('.').pop().replace(/Block$/, ''); return s.indexOf('Crushed') === 0 ? s.slice(7) : s; };
const isMinable = t => MINABLE.has(baseName(t));

// ---- parse the (dereferenced) TerrainModule tree; keep submodules in authored order ----
function parseTerrain(terr) {
  const btype = bt => (bt && bt.Type) ? bt.Type : '';
  const rng = (o, d) => o ? [o.min != null ? o.min : d[0], o.max != null ? o.max : d[1]] : d;
  const biomes = {};
  (terr.Modules || []).forEach(bm => {
    const name = bm.BiomeName; if (!name) return;
    const dm = bm.Module || {};
    const ranges = (dm.BlockDepthRanges || []).map(bdr => {
      const subs = [];
      (bdr.SubModules || []).forEach(sm => {
        const ty = sm['$type'] || '', bt = btype(sm.BlockType); if (!bt) return;
        if (ty.indexOf('StandardTerrainModule') >= 0) {
          subs.push({ kind: 'scatter', block: bt, height: rng(sm.HeightRange, [-1, 1]), depth: rng(sm.DepthRange, [0, 200]),
            pc: sm.PercentChance != null ? sm.PercentChance : 0.05, noiseFreq: sm.NoiseFrequency != null ? sm.NoiseFrequency : 3,
            noiseType: sm.NoiseType || 'Perlin', dist: sm.NoiseDistributionType || 'Bands' });
        } else if (ty.indexOf('DepositTerrainModule') >= 0) {
          subs.push({ kind: 'deposit', block: bt, spawnPc: sm.SpawnPercentChance != null ? sm.SpawnPercentChance : 0.01,
            depth: rng(sm.DepthRange, [0, 200]), depositDepth: rng(sm.DepositDepthRange, [0, 200]),
            count: rng(sm.BlocksCountRange, [1, 1]), weights: (sm.DirectionWeights && sm.DirectionWeights.length ? sm.DirectionWeights : [{ X: 1, Y: 1, Z: 1 }]),
            variance: sm.WeightVariance || { X: 0, Y: 0, Z: 0 } });
        }
      });
      return { block: btype(bdr.BlockType), min: bdr.Min | 0, max: Math.max(bdr.Min | 0, bdr.Max | 0),
        noiseFreq: bdr.NoiseFrequency != null ? bdr.NoiseFrequency : 25, subs };
    }).filter(r => r.block);
    biomes[name] = { name, ranges };
  });
  return biomes;
}

// ---- initialize noise seeds (reproduces InitModules' double-init) and keep the growth random ----
function initTerrain(terr, cfg) {
  const biomes = parseTerrain(terr);
  const fs = cfg.worldWidth / 72.0;
  const rand = new VC.CsRandom(cfg.seed);
  const order = Object.keys(biomes);
  function initPass() {
    for (const name of order) {
      const b = biomes[name];
      for (const r of b.ranges) r._depthSeed = rand.next();            // all depth-range perlin seeds first
      for (const r of b.ranges) for (const s of r.subs) s._seed = rand.next();   // then submodules, authored order
    }
  }
  initPass();   // pass 1: TerrainModule.Initialize walks children
  initPass();   // pass 2: InitModules recurses (the double-init quirk)
  for (const name of order) for (const r of biomes[name].ranges) {
    r._depthNoise = new VC.Perlin({ Frequency: r.noiseFreq * fs, Seed: r._depthSeed });
    for (const s of r.subs) if (s.kind === 'scatter') calibrateScatter(s, fs);
  }
  return { biomes, fs, cfg, _rand: rand, _deposits: null };   // _rand continues as the deposit growth random
}

// StandardTerrainModule.Initialize: build seamless noise, sample it to pick the value band for PercentChance.
function calibrateScatter(sc, fs) {
  const NoiseCtor = sc.noiseType === 'RidgedMulti' ? VC.RidgedMulti : VC.Perlin;
  sc._perlin = new NoiseCtor({ Frequency: sc.noiseFreq * fs, Seed: sc._seed });
  const step = 0.05 / fs, samples = [];
  for (let x = 0; x <= 1.0; x += step)
    for (let y = 0; y <= 1.0; y += step)
      for (let z = 0; z <= 1.0; z += step)
        samples.push(seamless(sc._perlin, fs, x, y, z));
  samples.sort((a, b) => a - b);
  const numValues = Math.min(Math.max(Math.round(sc.pc * samples.length), 0), samples.length - 1), mid = samples.length >> 1;
  if (sc.dist === 'Blobs') { sc._nMin = samples[0]; sc._nMax = samples[numValues]; }
  else { sc._nMin = samples[mid - (numValues >> 1)]; sc._nMax = samples[mid + (numValues >> 1)]; }
}

function vRound(x) { const f = Math.floor(x), d = x - f; if (d < 0.5) return f; if (d > 0.5) return f + 1; return (f % 2 === 0) ? f : f + 1; }
function selectBase(T, N, depth) {
  let last = N - 1;
  for (let i = N - 2; i >= 0; i--) {
    let skip = false;
    for (let j = i + 1; j < N; j++) { if (T[j] <= T[i]) { skip = true; break; } }
    if (skip) continue;
    if (depth <= T[i]) last = i; else break;
  }
  return last;
}
function heightToInt(grayByte, WL, MH) {
  const elev = (grayByte / 255) * 2 - 1;
  let ih = elev < 0 ? vRound((elev + 1) * WL) : WL + vRound(elev * (MH - WL));
  if (ih < 0) ih = 0; if (ih > MH) ih = MH;
  return ih;
}

// base rock + first matching scatter for map cell (x,z), y=0..intHeight (deposits overlaid later)
function generateColumn(ctx, x, z, intHeight) {
  const { biomes, fs, cfg } = ctx;
  const W = cfg.worldWidth * 10, MH = cfg.maxGenerationHeight, WL = cfg.waterLevel;
  const relX = x / W, relZ = z / W;
  const biome = biomes[ctx.biomeAt(x, z)];
  const out = new Array(intHeight + 1);
  if (!biome || biome.ranges.length === 0) { for (let y = 0; y <= intHeight; y++) out[y] = IMPENETRABLE; return out; }
  const ranges = biome.ranges, N = ranges.length, T = new Array(N);
  for (let i = 0; i < N; i++) { const nv = clamp01(ranges[i]._depthNoise.getValue(relX, 0, relZ) * 0.5 + 0.5); T[i] = vRound(ranges[i].min + nv * (ranges[i].max - ranges[i].min)); }
  for (let y = 0; y <= intHeight; y++) {
    if (y === 0) { out[y] = IMPENETRABLE; continue; }
    const depth = intHeight - y, height = y <= WL ? (y / WL) - 1.0 : (y - WL) / MH, relY = y / MH;
    const r = ranges[selectBase(T, N, depth)];
    let block = r.block;
    for (const s of r.subs) {
      if (s.kind !== 'scatter') continue;   // deposits handled by the precomputed overlay
      if (inRangeInc(height, s.height[0], s.height[1]) && inRangeInc(depth, s.depth[0], s.depth[1]) &&
          inRangeInc(seamless(s._perlin, fs, relX, relY, relZ), s._nMin, s._nMax)) { block = s.block; break; }
    }
    out[y] = block;
  }
  return out;
}

// ================= deposit (ore vein) global precompute =================
// min-heap with FIFO tie-break, mirroring the server's UniquePriorityQueue (+ per-item dedup set)
function Heap() { this.a = []; this.seq = 0; this.set = new Set(); }
Heap.prototype.push = function (item, pri) {
  if (this.set.has(item)) return false; this.set.add(item);
  const n = { item, pri, s: this.seq++ }; const a = this.a; a.push(n);
  let i = a.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (a[p].pri < a[i].pri || (a[p].pri === a[i].pri && a[p].s < a[i].s)) break; const t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
  return true;
};
Heap.prototype.pop = function () {
  const a = this.a; if (!a.length) return null; const top = a[0], last = a.pop();
  if (a.length) { a[0] = last; let i = 0; const n = a.length;
    for (;;) { let l = 2 * i + 1, rr = l + 1, m = i;
      if (l < n && (a[l].pri < a[m].pri || (a[l].pri === a[m].pri && a[l].s < a[m].s))) m = l;
      if (rr < n && (a[rr].pri < a[m].pri || (a[rr].pri === a[m].pri && a[rr].s < a[m].s))) m = rr;
      if (m === i) break; const t = a[m]; a[m] = a[i]; a[i] = t; i = m; } }
  this.set.delete(top.item); return top;
};
Heap.prototype.clear = function () { this.a.length = 0; this.set.clear(); };

function computeDeposits(ctx, grid, progress) {
  const { biomes, fs, cfg } = ctx;
  const W = cfg.worldWidth * 10, WL = cfg.waterLevel, MH = cfg.maxGenerationHeight;
  const rand = ctx._rand, gray = grid.gray, bIdx = grid.biome, names = grid.biomeNames;
  const CH = 10, nC = Math.floor(W / CH);
  progress = progress || (() => {});
  const pack = (x, y, z) => (y * W + z) * W + x;

  // deposit modules in traversal order (biome order x range order x sub order)
  const depMods = [];
  for (const bn of Object.keys(biomes)) for (const r of biomes[bn].ranges) {
    let last = -1; for (let i = 0; i < r.subs.length; i++) if (r.subs[i].kind === 'deposit') { last = i; r.subs[i]._seeds = []; depMods.push(r.subs[i]); }
    r._hasDeposit = last >= 0; r._scanTo = last + 1;   // scatters after the last deposit don't touch the random stream
  }
  if (!depMods.length) { ctx._deposits = new Map(); return ctx._deposits; }

  // ---- seeding: per 10x10 chunk, reproduce the chunk random stream ----
  for (let ccz = 0; ccz < nC; ccz++) {
    for (let ccx = 0; ccx < nC; ccx++) {
      const cr = new VC.CsRandom((Math.imul(ccx, cfg.seed) + ccz) | 0);
      for (let lx = 0; lx < CH; lx++) for (let lz = 0; lz < CH; lz++) {
        const wx = ccx * CH + lx, wz = ccz * CH + lz, ih = heightToInt(gray[wz * W + wx], WL, MH);
        const b = biomes[names[bIdx[wz * W + wx]]]; if (!b || !b.ranges.length) continue;
        const ranges = b.ranges, N = ranges.length, T = new Array(N), relX = wx / W, relZ = wz / W;
        for (let i = 0; i < N; i++) { const nv = clamp01(ranges[i]._depthNoise.getValue(relX, 0, relZ) * 0.5 + 0.5); T[i] = vRound(ranges[i].min + nv * (ranges[i].max - ranges[i].min)); }
        for (let y = Math.max(WL, ih); y >= 0; y--) {
          if (y > ih) continue;
          const depth = ih - y, r = ranges[selectBase(T, N, depth)];
          const needExtrude = (y >= WL && y === ih);
          if (!r._hasDeposit && !needExtrude) continue;   // this voxel consumes no chunk-random
          const height = y <= WL ? (y / WL) - 1.0 : (y - WL) / MH, relY = y / MH;
          let block = r.block;
          const scanTo = needExtrude ? r.subs.length : r._scanTo;   // full block only needed at the surface
          for (let si = 0; si < scanTo; si++) {
            const s = r.subs[si];
            if (s.kind === 'scatter') {
              if (inRangeInc(height, s.height[0], s.height[1]) && inRangeInc(depth, s.depth[0], s.depth[1]) &&
                  inRangeInc(seamless(s._perlin, fs, relX, relY, relZ), s._nMin, s._nMax)) { block = s.block; break; }
            } else if (inRangeInc(depth, s.depth[0], s.depth[1]) && y > 0) {
              if (cr.nextDouble() <= s.spawnPc) { s._seeds.push({ x: wx, y: y, z: wz, depth: depth }); block = s.block; break; }
            }
          }
          if (needExtrude && isMinable(block)) cr.nextDouble();   // surface extrude draw
        }
      }
    }
    progress('veins-seed', (ccz + 1) / nC);
  }

  // ---- spawner creation + global round-robin growth (shared `rand`, global dedup) ----
  const spawned = new Map();   // packed pos -> block type
  const invVar = (w, v) => (v + w) === 0 ? 0 : fr(v / fr(fr(v + w) * w));
  const rangeF = (lo, hi) => fr(lo + fr(fr(hi - lo) * fr(rand.nextDouble())));   // random.Range(float,float)
  function mkSpawner(dm, sp) {
    let N = vRound(rangeF(dm.count[0], dm.count[1])); if (N <= 0) return null;
    const w = dm.weights[rand.next(0, dm.weights.length)];
    const wx = w.X || 0, wy = w.Y || 0, wz = w.Z || 0, vv = dm.variance;
    const iw = { x: fr(1 / wx), y: fr(1 / wy), z: fr(1 / wz) };
    const iv = { x: invVar(wx, vv.X || 0), y: invVar(wy, vv.Y || 0), z: invVar(wz, vv.Z || 0) };
    const hiMax = sp.depth + sp.y - dm.depositDepth[0], hiMin = sp.depth + sp.y - dm.depositDepth[1];
    return { block: dm.block, N: N, iw: iw, iv: iv, hMin: hiMin, hMax: hiMax, q: new Heap() };
  }
  const gp = (pri, iw, iv) => fr(fr(pri + iw) - fr(fr(rand.nextDouble()) * iv));   // GetPriority
  function trySpawn(sp, x, y, z, pri) {
    const key = pack(x, y, z);
    if (sp.N > 0 && !spawned.has(key)) {
      spawned.set(key, sp.block); sp.N--;
      if (sp.N > 0) {
        sp.q.push(pack((x - 1 + W) % W, y, z), gp(pri, sp.iw.x, sp.iv.x));
        sp.q.push(pack((x + 1) % W, y, z), gp(pri, sp.iw.x, sp.iv.x));
        sp.q.push(pack(x, y, (z - 1 + W) % W), gp(pri, sp.iw.z, sp.iv.z));
        sp.q.push(pack(x, y, (z + 1) % W), gp(pri, sp.iw.z, sp.iv.z));
        if (y > 1) { const yy = y - 1; sp.q.push(pack(x, yy, z), yy >= sp.hMin ? gp(pri, sp.iw.y, sp.iv.y) : fr(pri + fr(sp.iw.y * 5))); }
        if (y + 1 < W) { const yy = y + 1; sp.q.push(pack(x, yy, z), yy <= sp.hMax ? gp(pri, sp.iw.y, sp.iv.y) : fr(pri + fr(sp.iw.y * 5))); }
      } else sp.q.clear();
      return true;
    }
    return false;
  }
  function trySpawnNext(sp) {
    let n; while ((n = sp.q.pop())) { const p = unpack(n.item); if (trySpawn(sp, p.x, p.y, p.z, n.pri)) return true; }
    return false;
  }
  function unpack(k) { const x = k % W; k = (k - x) / W; const z = k % W; const y = (k - z) / W; return { x, y, z }; }

  const active = [];
  for (const dm of depMods) {
    dm._seeds.sort((a, b) => (a.z - b.z) || (a.y - b.y) || (a.x - b.x));   // Vector3i order
    for (const sp of dm._seeds) { const s = mkSpawner(dm, sp); if (s && trySpawn(s, sp.x, sp.y, sp.z, 0)) active.push(s); }
  }
  let round = active, grown = 1;
  while (round.length) {
    const next = [];
    for (const s of round) if (trySpawnNext(s)) next.push(s);
    round = next; grown++;
    if ((grown & 15) === 0) progress('veins-grow', Math.min(0.99, grown / 400));
  }
  progress('veins-grow', 1);
  ctx._deposits = spawned;
  ctx._pack = pack;
  return spawned;
}

// ---- chunk generation + face-culled meshing (worker side) ----
function genChunkColumns(ctx, cx, cz, CHUNK) {
  const W = ctx.cfg.worldWidth * 10, WL = ctx.cfg.waterLevel, MH = ctx.cfg.maxGenerationHeight;
  const x0 = cx * CHUNK, z0 = cz * CHUNK, S = CHUNK + 2;
  const h = new Int16Array(S * S), cols = new Array(S * S);
  const dep = ctx._deposits, pack = ctx._pack;
  for (let lz = -1; lz <= CHUNK; lz++) {
    for (let lx = -1; lx <= CHUNK; lx++) {
      const wx = (((x0 + lx) % W) + W) % W, wz = (((z0 + lz) % W) + W) % W;
      const ih = heightToInt(ctx.grayAt(wx, wz), WL, MH), idx = (lz + 1) * S + (lx + 1);
      const col = generateColumn(ctx, wx, wz, ih);
      if (dep && dep.size) for (let y = 1; y <= ih; y++) { const b = dep.get(pack(wx, y, wz)); if (b) col[y] = b; }   // overlay veins
      h[idx] = ih; cols[idx] = col;
    }
  }
  return { S, x0, z0, CHUNK, h, cols };
}

function meshChunkFromCols(chunk, hiddenArr, sliceTop) {
  const { S, x0, z0, CHUNK, h, cols } = chunk;
  const hidden = new Set(hiddenArr || []);
  const cut = (sliceTop == null) ? Infinity : sliceTop;
  const at = (lx, lz) => (lz + 1) * S + (lx + 1);
  const visible = (lx, lz, y) => { const i = at(lx, lz); return y >= 0 && y <= h[i] && y <= cut && !hidden.has(cols[i][y]); };
  const palette = [], palIdx = Object.create(null);
  const idOf = t => { let i = palIdx[t]; if (i === undefined) { i = palette.length; palette.push(t); palIdx[t] = i; } return i; };
  const pos = [], nor = [], pal = [];
  function face(v, nx, ny, nz, id) {
    pos.push(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[0], v[1], v[2], v[6], v[7], v[8], v[9], v[10], v[11]);
    for (let i = 0; i < 6; i++) { nor.push(nx, ny, nz); pal.push(id); }
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    const z = z0 + lz;
    for (let lx = 0; lx < CHUNK; lx++) {
      const x = x0 + lx, ci = at(lx, lz), col = cols[ci], top = Math.min(h[ci], cut);
      for (let y = 0; y <= top; y++) {
        const t = col[y]; if (hidden.has(t)) continue; const id = idOf(t);
        if (!visible(lx, lz, y + 1))     face([x, y + 1, z + 1, x + 1, y + 1, z + 1, x + 1, y + 1, z, x, y + 1, z], 0, 1, 0, id);
        if (y > 0 && !visible(lx, lz, y - 1)) face([x, y, z, x + 1, y, z, x + 1, y, z + 1, x, y, z + 1], 0, -1, 0, id);
        if (!visible(lx - 1, lz, y))     face([x, y + 1, z, x, y + 1, z + 1, x, y, z + 1, x, y, z], -1, 0, 0, id);
        if (!visible(lx + 1, lz, y))     face([x + 1, y + 1, z + 1, x + 1, y + 1, z, x + 1, y, z, x + 1, y, z + 1], 1, 0, 0, id);
        if (!visible(lx, lz - 1, y))     face([x + 1, y + 1, z, x, y + 1, z, x, y, z, x + 1, y, z], 0, 0, -1, id);
        if (!visible(lx, lz + 1, y))     face([x, y + 1, z + 1, x + 1, y + 1, z + 1, x + 1, y, z + 1, x, y, z + 1], 0, 0, 1, id);
      }
    }
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), pal: new Uint16Array(pal), palette };
}

if (typeof module !== 'undefined') module.exports = { initTerrain, generateColumn, parseTerrain, heightToInt, selectBase, computeDeposits, bindVoxel, genChunkColumns, meshChunkFromCols, IMPENETRABLE };
