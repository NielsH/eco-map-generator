// Port of Eco.WorldGenerator.VoronoiWorldGenerator.Generate (surface map only).
// Depends on core.js (CsRandom, Perlin, RidgedMulti, ScaleBias, NQ) and geo.js.

let C, G;
if (typeof require !== 'undefined') { C = require('./core.js'); G = require('./geo.js'); }
function bind(core, geo) { C = core; G = geo; }

// ---- helpers ----
const csRound = x => { // .NET Math.Round default = banker's rounding (to even)
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return (f % 2 === 0) ? f : f + 1;
};
const cmpNum = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const f = Math.fround; // C# single-precision (float / PointF / MathF) semantics

// .NET List<T>.Sort(Comparison) == unstable IntrospectiveSort. Replicated so terraced-priority
// ties break the same way the server does (a stable sort would diverge).
function netSort(a, cmp) {
  const n = a.length;
  if (n > 1) introSort(a, 0, n - 1, 2 * (Math.floor(Math.log2(n)) + 1), cmp);
  return a;
}
function swp(a, i, j) { const t = a[i]; a[i] = a[j]; a[j] = t; }
function swapIfGreater(a, cmp, i, j) { if (i !== j && cmp(a[i], a[j]) > 0) swp(a, i, j); }
function introSort(a, lo, hi, depth, cmp) {
  while (hi > lo) {
    const size = hi - lo + 1;
    if (size <= 16) {
      if (size === 1) return;
      if (size === 2) { swapIfGreater(a, cmp, lo, hi); return; }
      if (size === 3) { swapIfGreater(a, cmp, lo, hi - 1); swapIfGreater(a, cmp, lo, hi); swapIfGreater(a, cmp, hi - 1, hi); return; }
      insertionSort(a, lo, hi, cmp); return;
    }
    if (depth === 0) { heapSort(a, lo, hi, cmp); return; }
    depth--;
    const p = partition(a, lo, hi, cmp);
    introSort(a, p + 1, hi, depth, cmp);
    hi = p - 1;
  }
}
function partition(a, lo, hi, cmp) {
  const mid = lo + ((hi - lo) >> 1);
  swapIfGreater(a, cmp, lo, mid); swapIfGreater(a, cmp, lo, hi); swapIfGreater(a, cmp, mid, hi);
  const pivot = a[mid];
  swp(a, mid, hi - 1);
  let left = lo, right = hi - 1;
  while (left < right) {
    while (cmp(a[++left], pivot) < 0);
    while (cmp(pivot, a[--right]) < 0);
    if (left >= right) break;
    swp(a, left, right);
  }
  if (left !== hi - 1) swp(a, left, hi - 1);
  return left;
}
function insertionSort(a, lo, hi, cmp) {
  for (let i = lo; i < hi; i++) { const t = a[i + 1]; let j = i; while (j >= lo && cmp(t, a[j]) < 0) { a[j + 1] = a[j]; j--; } a[j + 1] = t; }
}
function heapSort(a, lo, hi, cmp) {
  const n = hi - lo + 1;
  for (let i = n >> 1; i >= 1; i--) downHeap(a, lo, i, n, cmp);
  for (let i = n; i > 1; i--) { swp(a, lo, lo + i - 1); downHeap(a, lo, 1, i - 1, cmp); }
}
function downHeap(a, lo, i, n, cmp) {
  const d = a[lo + i - 1];
  while (i <= (n >> 1)) {
    let child = 2 * i;
    if (child < n && cmp(a[lo + child - 1], a[lo + child]) < 0) child++;
    if (!(cmp(d, a[lo + child - 1]) < 0)) break;
    a[lo + i - 1] = a[lo + child - 1]; i = child;
  }
  a[lo + i - 1] = d;
}

// ---- Biomes ----
function mkBiome(name, elev, temp, moist, color, badRange = 0, bad = null) {
  return { name, elev, temp, moist, color, badRange, bad, isLand: name !== 'Ocean' && name !== 'DeepOcean' };
}
const R = (min, max) => ({ min, max, get diff() { return max - min; }, get mid() { return (min + max) / 2; } });
const B = {};
B.DeepOcean  = mkBiome('DeepOcean',  R(-1, -0.4),    R(0, 0.4),  R(0, 1),    [70,130,180]);
B.Ocean      = mkBiome('Ocean',      R(-0.3,-0.05),  R(0.4,1),   R(0, 1),    [135,206,250]);
B.Coast      = mkBiome('Coast',      R(0.02,0.1),    R(0, 1),    R(0, 1),    [250,250,210]);
B.Grassland  = mkBiome('Grassland',  R(0.02,0.4),    R(0.4,0.8), R(0.3,0.5), [144,238,144]);
B.WarmForest = mkBiome('WarmForest', R(0.1,0.5),     R(0.5,0.8), R(0.5,0.6), [184,134,11]);
B.ColdForest = mkBiome('ColdForest', R(0.1,0.7),     R(0.2,0.5), R(0.5,0.6), [34,139,34],  3);
B.RainForest = mkBiome('RainForest', R(0.1,0.5),     R(0.6,0.8), R(0.7,1),   [32,178,170], 3);
B.Desert     = mkBiome('Desert',     R(0.02,0.2),    R(0.7,1),   R(0,0.3),   [244,164,96], 1);
B.Taiga      = mkBiome('Taiga',      R(0.3,1),       R(0.2,0.3), R(0.2,0.5), [107,142,35], 2);
B.Tundra     = mkBiome('Tundra',     R(0.4,1),       R(0.1,0.2), R(0,0.6),   [189,183,107],1);
B.Ice        = mkBiome('Ice',        R(0.6,1),       R(0,0.1),   R(0,0.6),   [255,255,255],1);
B.Wetland    = mkBiome('Wetland',    R(0.02,0.3),    R(0.4,0.6), R(0.6,0.8), [0,100,0],    3);
B.ColdCoast  = mkBiome('ColdCoast',  R(0.05,0.1),    R(0, 1),    R(0, 1),    [224,255,255]);
B.WarmCoast  = mkBiome('WarmCoast',  R(0.05,0.1),    R(0, 1),    R(0, 1),    [250,250,210]);
B.Steppe     = mkBiome('Steppe',     R(0.325,0.4),   R(0.4,0.8), R(0.3,0.5), [144,238,144]);
B.HighDesert = mkBiome('HighDesert', R(0.225,0.3),   R(0.7,1),   R(0,0.3),   [244,164,96]);
// bad-neighbor lists (set after all defined)
B.ColdForest.bad = [B.Coast, B.ColdCoast, B.WarmCoast];
B.RainForest.bad = [B.ColdForest];
B.Desert.bad     = [B.ColdForest, B.WarmForest, B.RainForest, B.Wetland];
B.Taiga.bad      = [B.Grassland];
B.Tundra.bad     = [B.Grassland];
B.Ice.bad        = [B.Grassland];
B.Wetland.bad    = [B.RainForest];

const isOcean = b => b === B.Ocean || b === B.DeepOcean;
const isLand = b => b != null && !isOcean(b);
const isGrassland = b => b === B.Grassland || b === B.Steppe;
const isDesert = b => b === B.Desert || b === B.HighDesert;
const canSpawnLake = b => isGrassland(b) || b === B.ColdForest || b === B.WarmForest || b === B.RainForest || b === B.Taiga || b === B.Wetland;

// ---- polygon adjacency helpers ----
function adjacentPolygons(polys, start, range) {
  // memoized per (range, start); topology is constant within one generate()
  const cache = polys._adjCache || (polys._adjCache = {});
  const byStart = cache[range] || (cache[range] = new Array(polys.length));
  if (byStart[start] !== undefined) return byStart[start];
  const all = new Set([start]);
  let pending = [start], next = [];
  for (let r = 1; r <= range; r++) {
    for (const pi of pending) for (const q of polys[pi].adjacent) if (!all.has(q)) { all.add(q); next.push(q); }
    pending = next; next = [];
  }
  all.delete(start);
  byStart[start] = all;
  return all;
}
// multi-source BFS: hop distance from every cell to the nearest cell failing `pred`
function distanceFieldTo(polys, pred) {
  const dist = new Int32Array(polys.length).fill(-1);
  let frontier = [];
  for (let i = 0; i < polys.length; i++) if (!pred(polys[i])) { dist[i] = 0; frontier.push(i); }
  let d = 0;
  while (frontier.length) {
    const nextF = [];
    for (const i of frontier) for (const a of polys[i].adjacent) if (dist[a] === -1) { dist[a] = d + 1; nextF.push(a); }
    frontier = nextF; d++;
  }
  return dist;
}
// distance to first polygon NOT matching predicate (matches DistanceTo semantics)
function distanceTo(polys, start, pred) {
  let distance = 0;
  const visited = new Set();
  let current = [start];
  do {
    for (const c of current) visited.add(c);
    const nextSet = new Set();
    for (const c of current) for (const a of polys[c].adjacent) if (!visited.has(a)) nextSet.add(a);
    current = [...nextSet];
    if (current.length === 0) return distance;
    distance++;
  } while (current.every(i => pred(polys[i])));
  return distance;
}
const distanceToOcean = (polys, start) => distanceTo(polys, start, p => isLand(p.biome));

// ---- SeamlessNoise / FlatTerrace ----
class SeamlessNoise {
  constructor(source, freqScale) { this.source = source; this.fs = freqScale; }
  getValue(x, y, z) {
    const ext = this.fs;
    x *= this.fs; z *= this.fs;
    const sw = this.source.getValue(x, y, z);
    const se = this.source.getValue(x + ext, y, z);
    const nw = this.source.getValue(x, y, z + ext);
    const ne = this.source.getValue(x + ext, y, z + ext);
    const xB = 1.0 - x / ext, zB = 1.0 - z / ext;
    return lerp(lerp(sw, se, xB), lerp(nw, ne, xB), zB);
  }
}
class FlatTerrace {
  constructor(source, numTerraces) { this.source = source; this.n = numTerraces; }
  getValue(x, y, z) { return csRound(this.source.getValue(x, y, z) * this.n) / this.n; }
}

// ---- main generate ----
function generate(cfg, opts = {}) {
  const { Perlin, RidgedMulti, ScaleBias, CsRandom, NQ } = C;
  const worldSize = cfg.worldWidth * 10;      // VoxelSize.x = WorldWidth * Chunk.Size(10)
  const freqScale = cfg.worldWidth / 72.0;    // FrequencyScale
  const scaleMod = cfg.autoScale ? Math.pow(worldSize / 720.0, cfg.autoScaleExponent) : 1.0;
  const invScaleMod = 1.0 / scaleMod;
  const linScaleMod = cfg.autoScale ? worldSize / 720.0 : 1.0;
  const invLinScaleMod = 1.0 / linScaleMod;

  const rand = new CsRandom(cfg.seed);
  const progress = opts.progress || (() => {});

  // ---- Poisson + Voronoi ----
  const sites = G.poissonSamples(worldSize, worldSize, cfg.pointRadius, rand);
  const numpoints = sites.length;
  const offs = [[-worldSize,-worldSize],[0,-worldSize],[worldSize,-worldSize],[-worldSize,0],[worldSize,0],[-worldSize,worldSize],[0,worldSize],[worldSize,worldSize]];
  const all = sites.slice();
  for (const [ox, oy] of offs) for (let i = 0; i < numpoints; i++) all.push({ x: sites[i].x + ox, y: sites[i].y + oy });
  progress('voronoi');
  const xv = all.map(s => s.x), yv = all.map(s => s.y);
  let edges = new G.Voronoi(0.1).generateVoronoi(xv, yv, -worldSize, worldSize * 2, -worldSize, worldSize * 2);

  // prune outer edges (matches C#)
  const minBuf = -cfg.pointRadius * 2, maxBuf = worldSize + cfg.pointRadius * 2;
  edges = edges.filter(e => !(e.x1 < minBuf || e.x2 < minBuf || e.x1 > maxBuf || e.x2 > maxBuf || e.y1 < minBuf || e.y2 < minBuf || e.y1 > maxBuf || e.y2 > maxBuf));

  // build polygons
  const polys = new Array(numpoints);
  const edgesBySite = Array.from({ length: numpoints }, () => []);
  for (const e of edges) {
    if (e.site1 < numpoints) edgesBySite[e.site1].push(e);
    if (e.site2 < numpoints && e.site2 !== e.site1) edgesBySite[e.site2].push(e);
  }
  for (let i = 0; i < numpoints; i++) {
    const pts = [];
    const adjacent = new Set();
    for (const e of edgesBySite[i]) {
      if (e.site1 === i || e.site2 === i) {
        if (e.site1 !== i) adjacent.add(((e.site1 % numpoints) + numpoints) % numpoints);
        if (e.site2 !== i) adjacent.add(((e.site2 % numpoints) + numpoints) % numpoints);
        for (const P of [[f(e.x1), f(e.y1)], [f(e.x2), f(e.y2)]]) {   // C#: new PointF((float)edge.X1, ...)
          let tooClose = false;
          for (const q of pts) { const dx = f(P[0] - q.x), dy = f(P[1] - q.y); if (f(f(dx * dx) + f(dy * dy)) < f(0.001)) { tooClose = true; break; } }
          if (!tooClose) pts.push({ x: P[0], y: P[1] });
        }
      }
    }
    const cnt = pts.length;
    // Enumerable.Sum(float) accumulates in double then casts to float; center = (float)sum / count
    let sx = 0, sy = 0; for (const q of pts) { sx += q.x; sy += q.y; }
    const cx = f(f(sx) / cnt), cy = f(f(sy) / cnt);
    const ordered = pts.slice().sort((a, b) => cmpNum(Math.atan2(f(a.x - cx), f(a.y - cy)), Math.atan2(f(b.x - cx), f(b.y - cy))))
      .map(p => { const dx = f(p.x - cx), dy = f(p.y - cy); return { x: f(p.x + f(dx * 0.01)), y: f(p.y + f(dy * 0.01)) }; });
    polys[i] = {
      points: ordered, site: sites[i], center: { x: cx, y: cy }, adjacent: [...adjacent], index: i,
      maxElevation: 1, elevation: 0, temperature: 0, moisture: 0,
      _biome: B.DeepOcean, prevBiome: B.DeepOcean, hasRiver: false, hasLake: false,
      get biome() { return this._biome; },
      set biome(v) { this.prevBiome = this._biome; this._biome = v; },
    };
  }
  progress('biomes');

  // ---- config.Initialize (5 draws, order matters) ----
  const landPercent = f((cfg.landPercentRange.min * invScaleMod) + (rand.nextDouble() * (cfg.landPercentRange.max - cfg.landPercentRange.min) * invScaleMod));
  const numContinents = csRound((cfg.numContinentsRange.min * scaleMod) + (rand.nextDouble() * (cfg.numContinentsRange.max - cfg.numContinentsRange.min) * scaleMod));
  const numSmallIslands = csRound((cfg.numSmallIslandsRange.min * scaleMod) + (rand.nextDouble() * (cfg.numSmallIslandsRange.max - cfg.numSmallIslandsRange.min) * scaleMod));
  const numLakes = csRound((cfg.numLakesRange.min * scaleMod) + (rand.nextDouble() * (cfg.numLakesRange.max - cfg.numLakesRange.min) * scaleMod));
  const numRivers = csRound((cfg.numRiversRange.min * scaleMod) + (rand.nextDouble() * (cfg.numRiversRange.max - cfg.numRiversRange.min) * scaleMod));

  const islandPercent = cfg.islandWeight * landPercent;
  const continentPercent = landPercent - islandPercent;
  const pct = w => w * landPercent;
  const num = n => csRound(n * scaleMod);

  // prioritizer noises (Seed mutated live during placement)
  // C#: noise input is (float)Center.X / (int)WorldSize == float; prioritizer casts result to float
  const nx = p => f(p.center.x / worldSize), ny = p => f(p.center.y / worldSize);
  const landNoise = new Perlin({ Frequency: 0.5 * scaleMod, Quality: NQ.Best });
  const terracedLand = new FlatTerrace(new SeamlessNoise(landNoise, freqScale), 4);
  const landPri = p => f(terracedLand.getValue(nx(p), 0, ny(p)));
  const islandNoise = new Perlin({ Frequency: 1.0 * scaleMod, Quality: NQ.Best });
  const terracedIsland = new FlatTerrace(new SeamlessNoise(islandNoise, freqScale), 4);
  const islandPri = p => f(terracedIsland.getValue(nx(p), 0, ny(p)));
  const biomeNoise = new Perlin({ Frequency: 0.5 * scaleMod, Quality: NQ.Best });
  const terracedBiome = new FlatTerrace(new SeamlessNoise(biomeNoise, freqScale), 4);
  const biomePri = p => f(terracedBiome.getValue(nx(p), 0, ny(p)));

  // ---- BalanceBiome ----
  function balanceBiome(desiredPct, targetBiome, selector, prioritizer, contiguous = true) {
    const valid = polys.filter(selector);
    let source = null, priorityLookup = null;
    if (prioritizer == null) {
      if (valid.length) source = valid[rand.next(0, valid.length)];
    } else {
      priorityLookup = new Float64Array(polys.length);
      let highest = -Infinity;
      for (const p of valid) { const pr = prioritizer(p); priorityLookup[p.index] = prioritizer(p); if (pr > highest) { source = p; highest = pr; } }
    }
    if (source == null) return false;
    let fill = [];
    const visited = new Set([source]);
    if (!contiguous) { fill = valid.slice(); netSort(fill, (a, b) => cmpNum(priorityLookup[b.index], priorityLookup[a.index])); }
    else fill.push(source);
    let cur = 0;
    while (cur < desiredPct && fill.length > 0) {
      let selected;
      if (prioritizer == null) { const idx = rand.next(0, fill.length); selected = fill[idx]; fill.splice(idx, 1); }
      else { selected = fill[0]; fill.shift(); }
      selected.biome = targetBiome;
      cur += 1 / polys.length;
      const adj = selected.adjacent.map(i => polys[i]).filter(p => !visited.has(p) && selector(p));
      if (adj.length) { for (const a of adj) { fill.push(a); visited.add(a); } if (prioritizer != null) netSort(fill, (a, b) => cmpNum(priorityLookup[b.index], priorityLookup[a.index])); }
    }
    return true;
  }

  function getValidPositions(biome) {
    const s = new Set();
    for (const p of polys) {
      const nearby = adjacentPolygons(polys, p.index, biome.badRange);
      let ok = true;
      for (const id of nearby) if (biome.bad && biome.bad.includes(polys[id].biome)) { ok = false; break; }
      if (ok) s.add(p);
    }
    return s;
  }

  // ---- continents ----
  {
    let remaining = continentPercent;
    const approx = remaining / numContinents;
    let balanced;
    do {
      landNoise.Seed = rand.next();
      let landSize = Math.min(remaining, ((rand.nextDouble() * 1.5) + 0.5) * approx);
      if (numContinents === 1) landSize = remaining;
      const avoid = csRound(cfg.continentAvoidRange.min + rand.nextDouble() * (cfg.continentAvoidRange.max - cfg.continentAvoidRange.min));
      const validSet = new Set(polys.filter(p => {
        if (p.biome !== B.DeepOcean) return false;
        const nearby = adjacentPolygons(polys, p.index, avoid);
        let landCount = 0; for (const a of nearby) if (polys[a].biome === B.Grassland) landCount++;
        return landCount === 0;
      }));
      balanced = balanceBiome(landSize, null, p => validSet.has(p), landPri);
      for (const p of polys) if (p.biome == null) p.biome = B.Grassland;
      remaining -= landSize;
    } while (balanced && remaining > 0);
  }
  // ---- islands ----
  {
    let remaining = islandPercent;
    const approx = remaining / numSmallIslands;
    let balanced;
    do {
      islandNoise.Seed = rand.next();
      let landSize = Math.min(remaining, ((rand.nextDouble() * 1.5) + 0.5) * approx);
      if (numSmallIslands === 1) landSize = remaining;
      const avoid = csRound(cfg.islandAvoidRange.min + rand.nextDouble() * (cfg.islandAvoidRange.max - cfg.islandAvoidRange.min));
      const validSet = new Set(polys.filter(p => {
        if (p.biome !== B.DeepOcean) return false;
        const nearby = adjacentPolygons(polys, p.index, avoid);
        let landCount = 0; for (const a of nearby) if (polys[a].biome === B.Grassland) landCount++;
        return landCount === 0;
      }));
      balanced = balanceBiome(landSize, null, p => validSet.has(p), islandPri);
      for (const p of polys) if (p.biome == null) p.biome = B.Grassland;
      remaining -= landSize;
    } while (balanced && remaining > 0);
  }

  // coastline
  for (let w = 0; w < cfg.coastlineSize; w++) {
    const cl = polys.filter(p => p.biome === B.DeepOcean && p.adjacent.some(a => polys[a].biome !== B.DeepOcean));
    for (const p of cl) p.biome = B.Coast;
  }
  for (let w = 0; w < cfg.shallowOceanSize; w++) {
    const oc = polys.filter(p => p.biome === B.DeepOcean && p.adjacent.some(a => polys[a].biome !== B.DeepOcean));
    for (const p of oc) p.biome = B.Ocean;
  }
  {
    const bad = polys.filter(p => p.biome === B.Coast && [...adjacentPolygons(polys, p.index, cfg.coastlineSize)].every(a => isLand(polys[a].biome)));
    for (const p of bad) p.biome = B.Grassland;
  }

  // ---- GenerateBiome ----
  function generateBiome(target, placement, prioritizer, biomePct, numBiomes, validateLocation = true, contiguous = true) {
    if (numBiomes === 0 || biomePct < 0.001) return;
    let remaining = biomePct;
    const approx = biomePct / numBiomes;
    const counts = new Map();
    let balanced;
    do {
      biomeNoise.Seed = rand.next();
      const forestSize = Math.min(remaining, approx * ((rand.nextDouble() * 0.5) + 0.75));
      const validPositions = validateLocation ? getValidPositions(target) : null;
      balanced = balanceBiome(forestSize, target, p => p.biome === placement && (validPositions == null || validPositions.has(p)), prioritizer, contiguous);
      remaining = biomePct - (polys.filter(p => p.biome === target).length / polys.length);
      const newPolys = polys.filter(p => p.biome === target && !counts.has(p));
      if (newPolys.length > 0) { const c = newPolys.length / polys.length; for (const p of newPolys) counts.set(p, c); }
    } while (balanced && remaining > 0);
    // keep only numBiomes largest batches, revert rest
    const groups = new Map();
    for (const [poly, c] of counts) { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(poly); }
    const sortedKeys = [...groups.keys()].sort((a, b) => cmpNum(b, a));
    for (let i = numBiomes; i < sortedKeys.length; i++) for (const poly of groups.get(sortedKeys[i])) poly.biome = poly.prevBiome;
  }

  generateBiome(B.ColdForest, B.Grassland, biomePri, pct(cfg.coolForestWeight), num(cfg.numCoolForests));
  const taigaPri = p => distanceTo(polys, p.index, q => q.biome === B.ColdForest || q.biome === B.Taiga);
  generateBiome(B.Taiga, B.ColdForest, taigaPri, pct(cfg.taigaWeight), num(cfg.numTaigas));
  const tundraPri = p => distanceTo(polys, p.index, q => q.biome === B.Taiga || q.biome === B.Tundra);
  generateBiome(B.Tundra, B.Taiga, tundraPri, pct(cfg.tundraWeight), num(cfg.numTundras));
  const icePri = p => distanceTo(polys, p.index, q => q.biome === B.Tundra || q.biome === B.Taiga || q.biome === B.Ice || q.biome === B.Coast);
  generateBiome(B.Ice, B.Tundra, icePri, pct(cfg.iceWeight), num(cfg.numIces), true, false);
  generateBiome(B.WarmForest, B.Grassland, biomePri, pct(cfg.warmForestWeight), num(cfg.numWarmForests));
  generateBiome(B.RainForest, B.Grassland, biomePri, pct(cfg.rainforestWeight), num(cfg.numRainforests));
  generateBiome(B.Desert, B.Grassland, biomePri, pct(cfg.desertWeight), num(cfg.numDeserts));
  generateBiome(B.HighDesert, B.Desert, biomePri, pct(cfg.highDesertWeight), num(cfg.numHighDeserts), false, false);
  generateBiome(B.Steppe, B.Grassland, biomePri, pct(cfg.steppeWeight), num(cfg.numSteppes), false, false);
  const wetlandPri = p => distanceTo(polys, p.index, q => q.biome === B.WarmForest || q.biome === B.Wetland);
  generateBiome(B.Wetland, B.WarmForest, wetlandPri, pct(cfg.wetlandWeight), num(cfg.numWetlands));

  // cleanup isolated
  {
    const isolated = polys.filter(p => p.adjacent.filter(a => polys[a].biome === p.biome).length < 2);
    const result = new Map();
    for (const i of isolated) {
      const grp = new Map();
      for (const a of i.adjacent) { const b = polys[a].biome; grp.set(b, (grp.get(b) || 0) + 1); }
      let mostCommon = null, best = -1;
      for (const [b, c] of grp) if (c > best) { best = c; mostCommon = b; }
      if (i.biome !== B.Coast && mostCommon === B.Coast) continue;
      result.set(i, mostCommon);
    }
    for (const [k, v] of result) k.biome = v;
  }
  progress('elevation');

  // ---- elevation, temperature, moisture ----
  const distToOcean = distanceFieldTo(polys, p => isLand(p.biome)); // == distanceToOcean for all cells
  const invOceanDist = f(1 / cfg.maxElevationOceanDistance);
  for (const p of polys) if (isLand(p.biome)) {
    const d = distToOcean[p.index];
    p.maxElevation = clamp(f(Math.pow(f(d * invOceanDist), cfg.elevationPower)), 0, 1); // MathF.Pow
  }
  const elevMod = new RidgedMulti({ Seed: rand.next(), Frequency: 6 * invScaleMod });
  const elevationNoise = new SeamlessNoise(new ScaleBias({ Source0: elevMod, Scale: 0.5, Bias: 0.5 }), freqScale);
  const heightNoise = new SeamlessNoise(new Perlin({ Seed: rand.next(), Frequency: 10 * invScaleMod }), freqScale);
  const moistMod = new Perlin({ Seed: rand.next(), Frequency: 5 * invScaleMod });
  const moistureNoise = new SeamlessNoise(new ScaleBias({ Source0: moistMod, Scale: 0.5, Bias: 0.5 }), freqScale);
  const tempMod = new Perlin({ Seed: rand.next(), Frequency: 5 * invScaleMod });
  const temperatureNoise = new SeamlessNoise(new ScaleBias({ Source0: tempMod, Scale: 0.5, Bias: 0.5 }), freqScale);

  for (const p of polys) {
    const px = f(p.center.x / worldSize), py = f(p.center.y / worldSize);
    const eMod = f(elevationNoise.getValue(px, 0, py));
    const hMod = f(heightNoise.getValue(px, 0, py));
    const mMod = f(moistureNoise.getValue(px, 0, py));
    const tMod = f(temperatureNoise.getValue(px, 0, py));
    const avgElev = f(p.biome.elev.mid);
    const startElev = f(avgElev * eMod);
    const mod = f(hMod * f(p.biome.elev.diff * 0.5));
    const height = f(startElev + mod);
    p.temperature = f(p.biome.temp.min + f(tMod * p.biome.temp.diff));
    p.moisture = f(p.biome.moist.min + f(mMod * p.biome.moist.diff));
    p.elevation = isLand(p.biome) ? clamp(height, f(0.05), p.maxElevation) : clamp(height, -1, f(-0.05));
  }
  for (const p of polys) if (p.biome === B.Coast) {
    const nearby = [...adjacentPolygons(polys, p.index, cfg.coastlineSize)].map(i => polys[i]).filter(n => n.biome !== B.Coast && isLand(n.biome));
    if (nearby.length) { p.temperature = nearby.reduce((a, n) => a + n.temperature, 0) / nearby.length; p.moisture = nearby.reduce((a, n) => a + n.moisture, 0) / nearby.length; }
  }

  // ---- lakes ----
  {
    landNoise.Seed = rand.next();
    const originalBiomes = new Map(polys.map(p => [p, p.biome]));
    for (let i = 0; i < numLakes; i++) {
      biomeNoise.Seed = rand.next();
      const lakeSize = (cfg.lakeSizeRange.min * invLinScaleMod) + (rand.nextDouble() * (cfg.lakeSizeRange.max - cfg.lakeSizeRange.min) * invLinScaleMod);
      balanceBiome(lakeSize, null, p => {
        if (canSpawnLake(p.biome)) {
          const nearby = adjacentPolygons(polys, p.index, 4);
          for (const a of nearby) if (polys[a].hasLake || isOcean(polys[a].biome) || isDesert(polys[a].biome)) return false;
          return true;
        }
        return false;
      }, biomePri);
      const nearLakeTiles = polys.filter(p => p.biome != null && p.adjacent.filter(a => polys[a].biome == null).length >= 3);
      for (const p of nearLakeTiles) p.biome = null;
      const nearLake = polys.filter(p => p.adjacent.some(a => polys[a].biome == null) && p.biome != null);
      if (nearLake.length === 0) continue;
      const avg = nearLake.reduce((a, p) => a + p.elevation, 0) / nearLake.length;
      const lakeElev = avg - 0.01;
      for (const p of nearLake) if (p.elevation <= lakeElev) p.elevation = lakeElev + 0.01;
      for (const lake of polys.filter(p => p.biome == null)) { lake.elevation = lakeElev; lake.hasLake = true; lake.biome = originalBiomes.get(lake); }
    }
  }
  progress('rivers');

  // ---- rivers ----
  const rivers = riverPass(polys, rand, cfg, numRivers, distToOcean);

  // ---- coast warm/cold ----
  for (const p of polys) if (p.biome === B.Coast) { p.biome = p.temperature > 0.5 ? B.WarmCoast : B.ColdCoast; p.elevation = 0.01; }

  return { polys, rivers, worldSize, numContinents, numSmallIslands, numLakes, numRivers, landPercent };
}

// ---- river generation (port of the RIVERS section) ----
function riverPass(polys, rand, cfg, numRiversDesired, distToOcean) {
  const originalElevations = new Map(polys.map(p => [p, p.elevation]));
  const numRiverAttempts = 512;
  const allRivers = [];
  const startPositions = polys.filter(p => isLand(p.biome) && p.biome !== B.Ice)
    .map(p => ({ p, d: distToOcean[p.index] }))
    .sort((a, b) => cmpNum(b.d, a.d) || cmpNum(b.p.elevation, a.p.elevation))
    .map(x => x.p);
  for (let r = 0; r < numRiverAttempts; r++) {
    if (startPositions.length <= 0) break;
    const start = startPositions.shift();
    const river = [start];
    const currentRiver = new Set([start]);
    start.hasRiver = true;
    let current = start, backTrack = 0;
    while (current.biome !== B.Ocean) {
      if (river.length > 1) {
        const last = river[river.length - 2];
        if (last.hasLake && !current.hasLake) {
          const q = [last], vis = new Set([last]);
          while (q.length) { const entry = q.shift(); for (const a of entry.adjacent.map(i => polys[i]).filter(p => p.hasLake)) if (!vis.has(a)) { vis.add(a); q.push(a); } }
          for (const cell of vis) { cell.hasRiver = true; currentRiver.add(cell); }
        }
      }
      const nearbyWater = current.adjacent.filter(a =>
        !currentRiver.has(polys[a]) &&
        (polys[a].hasRiver || polys[a].hasLake ||
          (polys[a].biome === B.Coast && !isOcean(current.biome)) ||
          polys[a].biome === B.Ocean || polys[a].biome === B.DeepOcean));
      if (!current.hasLake && nearbyWater.length > 0) {
        current = polys[nearbyWater[rand.next(0, nearbyWater.length)]];
      } else {
        const avoid = cfg.riverCellAvoidance;
        const lower = current.adjacent.filter(a =>
          polys[a].biome !== B.Ice && polys[a].elevation <= current.elevation && !currentRiver.has(polys[a]) &&
          [...adjacentPolygons(polys, polys[a].index, avoid)].filter(ad => polys[ad].hasRiver).length <= avoid);
        if (lower.length === 0) {
          const available = current.adjacent.filter(a =>
            polys[a].biome !== B.Ice && !currentRiver.has(polys[a]) &&
            [...adjacentPolygons(polys, polys[a].index, avoid)].filter(ad => polys[ad].hasRiver).length <= avoid);
          if (available.length === 0) {
            for (let i = 0; i < backTrack; i++) {
              river.pop(); currentRiver.delete(current);
              const old = current; old.hasRiver = false;
              if (!old.hasLake) old.elevation = originalElevations.get(old);
              if (river.length === 0) break;
              current = river[river.length - 1];
            }
            backTrack++;
            if (river.length === 0) break;
            continue;
          }
          const lowest = polys[available.slice().sort((a, b) => cmpNum(Math.abs(current.elevation - polys[a].elevation), Math.abs(current.elevation - polys[b].elevation)))[0]];
          lowest.elevation = current.elevation;
          current = lowest;
        } else {
          const selection = polys[lower.slice().sort((a, b) => cmpNum(polys[b].elevation, polys[a].elevation))[0]];
          current = selection;
        }
      }
      river.push(current); currentRiver.add(current);
      if (current.hasRiver) break;
      current.hasRiver = true;
    }
    if (river.length !== 0) allRivers.push(river);
  }

  let numTaken = 0;
  const rivers = [];
  const ordered = allRivers.slice().sort((a, b) => cmpNum(b.length, a.length));
  if (ordered.length !== 0) {
    do {
      const river = ordered.shift();
      let segment = [river[0]];
      for (let i = 1; i < river.length; i++) {
        segment.push(river[i]);
        if (river[i].hasLake) {
          rivers.push(segment); segment = [];
          if (i < river.length - 1) {
            while (i < river.length - 1 && river[i + 1].hasLake) i++;
            if (i < river.length - 1) segment.push(river[i]);
          }
        }
      }
      if (segment.length > 0) rivers.push(segment);
      numTaken++;
    } while (numTaken < numRiversDesired && ordered.length > 0);
  }

  for (const p of polys) p.hasRiver = false;
  for (const cell of rivers.flat()) cell.hasRiver = true;
  for (const [poly, elev] of originalElevations) if (!poly.hasRiver) poly.elevation = elev;

  // river elevation cleanup (consumes rand.nextDouble)
  for (const river of rivers) {
    let segment = [river[0]];
    for (let i = 1; i < river.length; i++) {
      const polygon = river[i]; segment.push(polygon);
      if (i === river.length - 1 || polygon.hasLake || polygon.biome === B.Ocean) {
        const startElevation = segment[0].elevation;
        const endElevation = Math.max(0, segment[segment.length - 1].elevation);
        const maxChange = (startElevation - endElevation) / segment.length;
        let currentElevation = endElevation;
        for (let j = segment.length - 1; j >= 0; j--) {
          if (!(segment[j].hasLake || segment[j].biome === B.Ocean)) {
            if (segment[j].elevation < currentElevation) segment[j].elevation = currentElevation + (rand.nextDouble() * maxChange);
          }
          currentElevation = segment[j].elevation;
        }
        segment = [];
      }
    }
  }
  for (const p of polys) p.hasRiver = false;
  for (const cell of rivers.flat()) cell.hasRiver = true;

  // valley smoothing near water
  {
    const rlSet = new Set(polys.filter(p => p.hasRiver || p.hasLake));
    const nearWater = polys.filter(p => !p.hasRiver && !p.hasLake && p.biome !== B.Ocean && p.biome !== B.DeepOcean &&
      [...adjacentPolygons(polys, p.index, 3)].some(a => rlSet.has(polys[a])));
    for (let pass = 1; pass <= 4; pass++) {
      const smoothed = new Map();
      for (const p of nearWater) {
        const adj = [...adjacentPolygons(polys, p.index, pass * 2)].filter(i => isLand(polys[i].biome) && (polys[i].hasLake || polys[i].hasRiver));
        if (adj.length === 0) continue;
        const avgW = adj.reduce((a, i) => a + polys[i].elevation, 0) / adj.length;
        smoothed.set(p, p.elevation + (avgW - p.elevation) * 0.2);
      }
      for (const [k, v] of smoothed) {
        const wa = k.adjacent.filter(i => polys[i].hasRiver || polys[i].hasLake);
        if (wa.length) { const minE = 0.01 + Math.max(...wa.map(i => polys[i].elevation)); k.elevation = Math.max(minE, v); }
        else k.elevation = v;
      }
    }
  }
  return rivers;
}

if (typeof module !== 'undefined') module.exports = { generate, B, bind, isOcean, isLand, isGrassland, isDesert };
