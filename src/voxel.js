// Per-voxel underground block generation — faithful port of Eco.WorldGenerator's
// TerrainGenerator + TerrainModules (base strata + scatter). Runs in the worker.
// Depends on core.js (Perlin, CsRandom). Ore veins (DepositTerrainModule) are added
// separately and are approximate; base rock + scatter here target seed parity.
//
// Seed model (verified against the server):
// - Terrain-module noise seeds come from `new Random(seed)` consumed by InitModules,
//   which initializes every module TWICE (a quirk we reproduce so seeds match): once via
//   TerrainModule.Initialize walking its children, then again as InitModules recurses.
// - Per-voxel randomness (deposits) is `new Random(chunkX*seed + chunkZ)` — per column,
//   order-independent, so chunks can be generated on demand.
// - FrequencyScale = WorldWidth / 72 (same as the surface).

let VC;
if (typeof require !== 'undefined') VC = require('./core.js');
function bindVoxel(core) { VC = core; }

const IMPENETRABLE = 'Eco.World.Blocks.ImpenetrableStoneBlock';   // server floor fallback
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const inRangeInc = (v, lo, hi) => v >= lo && v <= hi;

// SharpNoise/Eco SeamlessNoise.GetValue with extent = FrequencyScale (tiles across x-z).
function seamless(src, fs, x, y, z) {
  const ext = fs; x *= fs; z *= fs;
  const sw = src.getValue(x, y, z), se = src.getValue(x + ext, y, z);
  const nw = src.getValue(x, y, z + ext), ne = src.getValue(x + ext, y, z + ext);
  const xB = 1 - x / ext, zB = 1 - z / ext;
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(sw, se, xB), l(nw, ne, xB), zB);
}

// ---- parse the (dereferenced) TerrainModule tree into a compact, editable form ----
function parseTerrain(terr) {
  const btype = bt => (bt && bt.Type) ? bt.Type : '';
  const rng = (o, d) => o ? [o.min != null ? o.min : d[0], o.max != null ? o.max : d[1]] : d;
  const biomes = {};
  (terr.Modules || []).forEach(bm => {
    const name = bm.BiomeName; if (!name) return;
    const dm = bm.Module || {};
    const ranges = (dm.BlockDepthRanges || []).map(bdr => {
      const scatters = [], deposits = [];
      (bdr.SubModules || []).forEach(sm => {
        const ty = sm['$type'] || '', bt = btype(sm.BlockType); if (!bt) return;
        if (ty.indexOf('StandardTerrainModule') >= 0) {
          scatters.push({ block: bt, height: rng(sm.HeightRange, [-1, 1]), depth: rng(sm.DepthRange, [0, 200]),
            pc: sm.PercentChance != null ? sm.PercentChance : 0.05, noiseFreq: sm.NoiseFrequency != null ? sm.NoiseFrequency : 3,
            noiseType: sm.NoiseType || 'Perlin', dist: sm.NoiseDistributionType || 'Bands' });
        } else if (ty.indexOf('DepositTerrainModule') >= 0) {
          deposits.push({ block: bt, spawnPc: sm.SpawnPercentChance != null ? sm.SpawnPercentChance : 0.01,
            depth: rng(sm.DepthRange, [0, 200]), depositDepth: rng(sm.DepositDepthRange, [0, 200]),
            count: rng(sm.BlocksCountRange, [1, 1]), weights: sm.DirectionWeights || [{ X: 1, Y: 1, Z: 1 }], variance: sm.WeightVariance || { X: 0, Y: 0, Z: 0 } });
        }
      });
      return { block: btype(bdr.BlockType), min: bdr.Min | 0, max: Math.max(bdr.Min | 0, bdr.Max | 0),
        noiseFreq: bdr.NoiseFrequency != null ? bdr.NoiseFrequency : 25, scatters, deposits };
    }).filter(r => r.block);
    biomes[name] = { name, ranges };
  });
  return biomes;
}

// ---- initialize noise modules + seeds (reproduces InitModules' double-init) ----
// Returns a context usable by generateColumn().
function initTerrain(terr, cfg) {
  const biomes = parseTerrain(terr);
  const fs = cfg.worldWidth / 72.0;
  const rand = new VC.CsRandom(cfg.seed);
  const order = Object.keys(biomes);   // module order as authored

  // One initialization pass over every biome (assigns depth-range + submodule noise seeds).
  function initPass() {
    for (const name of order) {
      const b = biomes[name];
      // TerrainDepthModule.Initialize: a Perlin seed per BlockDepthRange, in range order
      for (const r of b.ranges) r._depthSeed = rand.next();
      // then submodules, in range order then submodule order
      for (const r of b.ranges) {
        for (const sc of r.scatters) sc._seed = rand.next();     // StandardTerrainModule.Initialize
        for (const dp of r.deposits) dp._seed = rand.next();     // DepositTerrainModule.Initialize
      }
    }
  }
  initPass();   // pass 1: TerrainModule.Initialize walks children
  initPass();   // pass 2: InitModules recurses — overwrites seeds, consumes more random (the quirk)

  // Build the actual noise modules from the (final, second-pass) seeds and calibrate scatters.
  for (const name of order) {
    for (const r of biomes[name].ranges) {
      r._depthNoise = new VC.Perlin({ Frequency: r.noiseFreq * fs, Seed: r._depthSeed });
      for (const sc of r.scatters) calibrateScatter(sc, fs);
    }
  }
  return { biomes, fs, cfg };
}

// StandardTerrainModule.Initialize: build the seamless noise, then sample it to pick the
// value band that yields PercentChance coverage.
function calibrateScatter(sc, fs) {
  const NoiseCtor = sc.noiseType === 'RidgedMulti' ? VC.RidgedMulti : VC.Perlin;   // Billow≈Perlin fallback
  sc._perlin = new NoiseCtor({ Frequency: sc.noiseFreq * fs, Seed: sc._seed });
  const samplePrecision = 0.05 / fs;
  const samples = [];
  for (let x = 0; x <= 1.0; x += samplePrecision)
    for (let y = 0; y <= 1.0; y += samplePrecision)
      for (let z = 0; z <= 1.0; z += samplePrecision)
        samples.push(seamless(sc._perlin, fs, x, y, z));
  samples.sort((a, b) => a - b);
  const numValues = Math.min(Math.max(Math.round(sc.pc * samples.length), 0), samples.length - 1);
  const mid = samples.length >> 1;
  if (sc.dist === 'Blobs') { sc._nMin = samples[0]; sc._nMax = samples[numValues]; }
  else { sc._nMin = samples[mid - (numValues >> 1)]; sc._nMax = samples[mid + (numValues >> 1)]; }
}

// .NET Math.Round (banker's) — matches the server's depth-threshold rounding.
function vRound(x) { const f = Math.floor(x), d = x - f; if (d < 0.5) return f; if (d > 0.5) return f + 1; return (f % 2 === 0) ? f : f + 1; }

// TerrainDepthModule: which BlockDepthRange wins at `depth`, given the column's per-range thresholds.
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

// Generate the block-type column for map cell (x,z) from y=0..intHeight (inclusive).
// out[y] = block-type string. relX/relZ are the noise coords; per-column depth thresholds
// are computed once, then each voxel picks base rock + first matching scatter.
function generateColumn(ctx, x, z, intHeight) {
  const { biomes, fs, cfg } = ctx;
  const W = cfg.worldWidth * 10, MH = cfg.maxGenerationHeight, WL = cfg.waterLevel;
  const relX = x / W, relZ = z / W;
  const bname = ctx.biomeAt(x, z);
  const biome = biomes[bname];
  const out = new Array(intHeight + 1);
  if (!biome || biome.ranges.length === 0) { for (let y = 0; y <= intHeight; y++) out[y] = IMPENETRABLE; return out; }
  const ranges = biome.ranges, N = ranges.length;
  // per-column depth thresholds: round(min + clamp01(perlin*.5+.5) * (max-min))
  const T = new Array(N);
  for (let i = 0; i < N; i++) {
    const nv = clamp01(ranges[i]._depthNoise.getValue(relX, 0, relZ) * 0.5 + 0.5);
    T[i] = vRound(ranges[i].min + nv * (ranges[i].max - ranges[i].min));
  }
  for (let y = 0; y <= intHeight; y++) {
    if (y === 0) { out[y] = IMPENETRABLE; continue; }   // server: worldPos.y>0 required; floor is impenetrable-ish
    const depth = intHeight - y;
    const height = y <= WL ? (y / WL) - 1.0 : (y - WL) / MH;
    const relY = y / MH;
    const ri = selectBase(T, N, depth);
    const r = ranges[ri];
    let block = r.block;
    for (const sc of r.scatters) {
      if (inRangeInc(height, sc.height[0], sc.height[1]) && inRangeInc(depth, sc.depth[0], sc.depth[1]) &&
          inRangeInc(seamless(sc._perlin, fs, relX, relY, relZ), sc._nMin, sc._nMax)) { block = sc.block; break; }
    }
    out[y] = block;
  }
  return out;
}

// intHeight for a map cell from the (blurred) heightmap byte, matching TerrainGenerator.
function heightToInt(grayByte, WL, MH) {
  const elev = (grayByte / 255) * 2 - 1;
  let ih = elev < 0 ? vRound((elev + 1) * WL) : WL + vRound(elev * (MH - WL));
  if (ih < 0) ih = 0; if (ih > MH) ih = MH;
  return ih;
}

// ---- chunk generation + face-culled meshing (worker side) ----
// Generate the block columns for a chunk plus a 1-cell apron (for seamless border faces).
// Returns { S, x0, z0, h:Int16Array(S*S), cols:Array(S*S) of block-type[] }, all wrapped.
function genChunkColumns(ctx, cx, cz, CHUNK) {
  const W = ctx.cfg.worldWidth * 10, WL = ctx.cfg.waterLevel, MH = ctx.cfg.maxGenerationHeight;
  const x0 = cx * CHUNK, z0 = cz * CHUNK, S = CHUNK + 2;
  const h = new Int16Array(S * S), cols = new Array(S * S);
  for (let lz = -1; lz <= CHUNK; lz++) {
    for (let lx = -1; lx <= CHUNK; lx++) {
      const wx = (((x0 + lx) % W) + W) % W, wz = (((z0 + lz) % W) + W) % W;
      const ih = heightToInt(ctx.grayAt(wx, wz), WL, MH);
      const idx = (lz + 1) * S + (lx + 1);
      h[idx] = ih; cols[idx] = generateColumn(ctx, wx, wz, ih);
    }
  }
  return { S, x0, z0, CHUNK, h, cols };
}

// Face-cull mesh a generated chunk. hiddenArr = block types treated as air (so interiors show
// through). sliceTop = highest y to render (voxels above are treated as air, so the terrain is
// "cut" at that level and the exposed strata get top faces) — used for the descend-to-see cutaway.
// Returns interleaved geometry + a per-vertex palette index and the palette strings.
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

if (typeof module !== 'undefined') module.exports = { initTerrain, generateColumn, parseTerrain, heightToInt, selectBase, bindVoxel, genChunkColumns, meshChunkFromCols, IMPENETRABLE };
