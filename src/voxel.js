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
function csRound(x) { const f = Math.floor(x), d = x - f; if (d < 0.5) return f; if (d > 0.5) return f + 1; return (f % 2 === 0) ? f : f + 1; }

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
    T[i] = csRound(ranges[i].min + nv * (ranges[i].max - ranges[i].min));
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
  let ih = elev < 0 ? csRound((elev + 1) * WL) : WL + csRound(elev * (MH - WL));
  if (ih < 0) ih = 0; if (ih > MH) ih = MH;
  return ih;
}

if (typeof module !== 'undefined') module.exports = { initTerrain, generateColumn, parseTerrain, heightToInt, selectBase, bindVoxel, IMPENETRABLE };
